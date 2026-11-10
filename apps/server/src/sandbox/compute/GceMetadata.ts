import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { GceApiError } from "./GceApi.ts";

const METADATA_ORIGIN = "http://metadata.google.internal/computeMetadata/v1";
/** A token is refreshed this long before Google says it expires. */
const TOKEN_MARGIN_MS = 60_000;

/** The server VM's own identity: the driver's only credential source. */
export interface GceMetadata {
  /** The default service account's OAuth token, cached until a minute before it expires. */
  readonly accessToken: Effect.Effect<Redacted.Redacted<string>, GceApiError>;
  readonly projectId: Effect.Effect<string, GceApiError>;
  /** The zone's name, e.g. `asia-south1-a`. */
  readonly zone: Effect.Effect<string, GceApiError>;
}

const TokenResponse = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number });
const decodeToken = Schema.decodeUnknownEffect(TokenResponse);

/** Remembers the first success; a failure is tried again on the next read. */
const cachedSuccess = <A, E>(effect: Effect.Effect<A, E>) =>
  Ref.make<A | undefined>(undefined).pipe(
    Effect.map((cache) =>
      Effect.gen(function* () {
        const cached = yield* Ref.get(cache);
        if (cached !== undefined) return cached;
        const next = yield* effect;
        yield* Ref.set(cache, next);
        return next;
      }),
    ),
  );

export const makeGceMetadata = Effect.fn("GceMetadata.make")(function* (
  client: HttpClient.HttpClient,
) {
  const read = Effect.fn("GceMetadata.read")(function* (path: string) {
    const endpoint = `GET /computeMetadata/v1/${path}`;
    const response = yield* client
      .execute(
        HttpClientRequest.get(`${METADATA_ORIGIN}/${path}`).pipe(
          HttpClientRequest.setHeader("Metadata-Flavor", "Google"),
        ),
      )
      .pipe(Effect.mapError(() => new GceApiError({ endpoint, failure: "transport" })));
    if (response.status !== 200) {
      return yield* new GceApiError({ endpoint, failure: "status", status: response.status });
    }
    return { endpoint, response };
  });

  const text = (path: string) =>
    read(path).pipe(
      Effect.flatMap(({ endpoint, response }) =>
        response.text.pipe(
          Effect.mapError(() => new GceApiError({ endpoint, failure: "response" })),
        ),
      ),
      Effect.map((value) => value.trim()),
    );

  const fetchToken = read("instance/service-accounts/default/token").pipe(
    Effect.flatMap(({ endpoint, response }) =>
      response.json.pipe(
        Effect.flatMap(decodeToken),
        // The body is the token: neither it nor a decode error that could quote it is kept.
        Effect.mapError(() => new GceApiError({ endpoint, failure: "response" })),
      ),
    ),
  );

  const token = yield* Ref.make<
    { readonly value: Redacted.Redacted<string>; readonly refreshAt: number } | undefined
  >(undefined);

  const accessToken = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(token);
    if (cached !== undefined && now < cached.refreshAt) return cached.value;
    const fetched = yield* fetchToken;
    const value = Redacted.make(fetched.access_token);
    yield* Ref.set(token, { value, refreshAt: now + fetched.expires_in * 1000 - TOKEN_MARGIN_MS });
    return value;
  }).pipe(Effect.withSpan("GceMetadata.accessToken"));

  const projectId = yield* cachedSuccess(text("project/project-id"));
  // `projects/<number>/zones/<zone>`.
  const zone = yield* cachedSuccess(
    text("instance/zone").pipe(Effect.map((value) => value.slice(value.lastIndexOf("/") + 1))),
  );

  return { accessToken, projectId, zone } satisfies GceMetadata;
});
