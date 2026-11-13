import {
  IsoDateTime,
  MemberId,
  TeamClaudeKeyError,
  type TeamClaudeKeyStatus,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TeamState } from "./TeamState.ts";

const SECRET = "team-claude-key";
const MAX_KEY_CHARS = 512;
const ANTHROPIC_VERSION = "2023-06-01";
const TEAM_CLAUDE_DEFAULT_BASE_URL = "https://api.anthropic.com";
/** `lastUsedAt` reaches subscribers at most this often; it is in memory only. */
const LAST_USED_PUBLISH_MS = 60_000;

export class SpaceAgentKeyMissingError extends Schema.TaggedError<SpaceAgentKeyMissingError>()(
  "SpaceAgentKeyMissingError",
  {},
) {}

export interface TeamClaudeEndpoint {
  readonly apiKey: Redacted.Redacted<string>;
  readonly baseUrl: string;
}

/** The one key `@pair` replies with. Its value never leaves the server. */
export class TeamClaudeKey extends Context.Service<
  TeamClaudeKey,
  {
    readonly status: Effect.Effect<TeamClaudeKeyStatus>;
    /** Each status after the current one. */
    readonly changes: Stream.Stream<TeamClaudeKeyStatus>;
    readonly set: (
      actorId: MemberId,
      value: Redacted.Redacted<string>,
    ) => Effect.Effect<TeamClaudeKeyStatus, TeamClaudeKeyError>;
    readonly remove: (actorId: MemberId) => Effect.Effect<TeamClaudeKeyStatus, TeamClaudeKeyError>;
    /** The only reader of the key. Marks it used. */
    readonly endpoint: Effect.Effect<TeamClaudeEndpoint, SpaceAgentKeyMissingError>;
  }
>()("t3/team/TeamClaudeKey") {}

const Stored = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("set"),
    value: Schema.String,
    baseUrl: Schema.optionalKey(Schema.String),
    last4: Schema.String,
    addedBy: MemberId,
    addedAt: IsoDateTime,
  }),
  Schema.Struct({ state: Schema.Literal("removed") }),
]);
type Stored = typeof Stored.Type;
const StoredJson = Schema.fromJsonString(Stored);
const decodeStored = Schema.decodeUnknownOption(StoredJson);
const encodeStored = Schema.encodeSync(StoredJson);

const refusal = (reason: TeamClaudeKeyError["reason"], message: string) =>
  new TeamClaudeKeyError({ reason, message });

/**
 * Before the key had its own home, `@pair` read it from the first enabled server-owned
 * `claudeAgent` instance's `ANTHROPIC_API_KEY` (and `ANTHROPIC_BASE_URL`). Imported once.
 */
const readLegacyEndpoint = Effect.fn("TeamClaudeKey.readLegacyEndpoint")(function* (
  settingsService: ServerSettings.ServerSettingsService["Service"],
  resolver: Option.Option<SecretResolver.SecretResolver["Service"]>,
) {
  const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => undefined));
  const instances = Object.entries(settings?.providerInstances ?? {}).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [, instance] of instances) {
    if (instance.driver !== "claudeAgent") continue;
    if (instance.ownerMemberId !== undefined || instance.enabled === false) continue;
    const variable = instance.environment?.find((entry) => entry.name === "ANTHROPIC_API_KEY");
    if (variable === undefined) continue;
    let apiKey: string | undefined;
    if (typeof variable.value === "string") {
      apiKey = variable.value;
    } else if (Option.isSome(resolver)) {
      [apiKey] = yield* resolver.value
        .read([variable.value])
        .pipe(Effect.orElseSucceed(() => [undefined]));
    }
    if (apiKey === undefined || apiKey.trim().length === 0) continue;
    const baseUrl = instance.environment?.find((entry) => entry.name === "ANTHROPIC_BASE_URL");
    return Option.some({
      value: apiKey.trim(),
      baseUrl:
        typeof baseUrl?.value === "string" && baseUrl.value.trim().length > 0
          ? baseUrl.value.trim()
          : undefined,
    });
  }
  return Option.none();
});

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const team = yield* TeamState;
  const http = yield* HttpClient.HttpClient;
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const resolver = yield* Effect.serviceOption(SecretResolver.SecretResolver);

  const version = yield* SubscriptionRef.make(0);
  const lastUsedAt = yield* Ref.make<string | null>(null);
  const lastPublishedMs = yield* Ref.make(Number.NEGATIVE_INFINITY);
  const bump = SubscriptionRef.update(version, (current) => current + 1);

  const readStored = secrets
    .get(SECRET)
    .pipe(
      Effect.map(Option.flatMap((bytes) => decodeStored(new TextDecoder().decode(bytes)))),
      Effect.orDie,
    );
  const writeStored = (stored: Stored) =>
    secrets.set(SECRET, new TextEncoder().encode(encodeStored(stored))).pipe(Effect.orDie);

  const activeSpaceCount = sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_v2_projection_spaces WHERE archived_at IS NULL
  `.pipe(
    Effect.map((rows) => Number(rows[0]?.count ?? 0)),
    Effect.orDie,
  );

  const status: TeamClaudeKey["Service"]["status"] = Effect.gen(function* () {
    const stored = yield* readStored;
    const count = yield* activeSpaceCount;
    if (Option.isNone(stored) || stored.value.state !== "set") {
      return { state: "unset" as const, activeSpaceCount: count };
    }
    const { last4, addedBy, addedAt } = stored.value;
    return {
      state: "set" as const,
      last4,
      addedBy,
      addedAt,
      lastUsedAt: yield* Ref.get(lastUsedAt),
      activeSpaceCount: count,
    };
  }).pipe(Effect.withSpan("TeamClaudeKey.status"));

  const ensureAdmin = Effect.fnUntraced(function* (actorId: MemberId) {
    if (!(yield* team.isTeamMode)) return;
    const member = (yield* Ref.get(team.members)).get(actorId);
    if (member?.role === "admin" && member.removedAt === null) return;
    return yield* refusal("not-admin", "Only an admin can change the Team Claude key.");
  });

  const check = Effect.fn("TeamClaudeKey.check")(function* (apiKey: string, baseUrl: string) {
    const response = yield* http
      .execute(
        HttpClientRequest.get(`${baseUrl.replace(/\/+$/u, "")}/v1/models`).pipe(
          HttpClientRequest.setHeaders({
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          }),
        ),
      )
      .pipe(
        Effect.timeout("10 seconds"),
        Effect.mapError(() => refusal("unreachable", "Couldn't reach Anthropic. Try again.")),
      );
    if (response.status === 200) return;
    if (response.status === 401 || response.status === 403) {
      return yield* refusal("rejected", "Anthropic rejected this key");
    }
    return yield* refusal("unreachable", "Couldn't reach Anthropic. Try again.");
  });

  const set: TeamClaudeKey["Service"]["set"] = Effect.fn("TeamClaudeKey.set")(
    function* (actorId, value) {
      yield* ensureAdmin(actorId);
      const key = Redacted.value(value).trim();
      if (key.length === 0 || key.length > MAX_KEY_CHARS) {
        return yield* refusal("invalid", "That doesn't look like an Anthropic API key.");
      }
      const previous = yield* readStored;
      // A replaced key keeps the gateway the imported one used.
      const baseUrl =
        Option.isSome(previous) && previous.value.state === "set"
          ? previous.value.baseUrl
          : undefined;
      yield* check(key, baseUrl ?? TEAM_CLAUDE_DEFAULT_BASE_URL);
      yield* writeStored({
        state: "set",
        value: key,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        last4: key.slice(-4),
        addedBy: actorId,
        addedAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* Ref.set(lastUsedAt, null);
      yield* bump;
      return yield* status;
    },
  );

  const remove: TeamClaudeKey["Service"]["remove"] = Effect.fn("TeamClaudeKey.remove")(
    function* (actorId) {
      yield* ensureAdmin(actorId);
      yield* writeStored({ state: "removed" });
      yield* Ref.set(lastUsedAt, null);
      yield* bump;
      return yield* status;
    },
  );

  const endpoint: TeamClaudeKey["Service"]["endpoint"] = Effect.gen(function* () {
    const stored = yield* readStored;
    if (Option.isNone(stored) || stored.value.state !== "set") {
      return yield* new SpaceAgentKeyMissingError();
    }
    const now = yield* DateTime.now;
    yield* Ref.set(lastUsedAt, DateTime.formatIso(now));
    if (now.epochMilliseconds - (yield* Ref.get(lastPublishedMs)) >= LAST_USED_PUBLISH_MS) {
      yield* Ref.set(lastPublishedMs, now.epochMilliseconds);
      yield* bump;
    }
    return {
      apiKey: Redacted.make(stored.value.value),
      baseUrl: stored.value.baseUrl ?? TEAM_CLAUDE_DEFAULT_BASE_URL,
    };
  }).pipe(Effect.withSpan("TeamClaudeKey.endpoint"));

  // Absent, never "removed": an admin's Remove is not undone by a restart.
  if (Option.isNone(yield* readStored)) {
    const legacy = yield* readLegacyEndpoint(settings, resolver);
    if (Option.isSome(legacy)) {
      yield* writeStored({
        state: "set",
        value: legacy.value.value,
        ...(legacy.value.baseUrl === undefined ? {} : { baseUrl: legacy.value.baseUrl }),
        last4: legacy.value.value.slice(-4),
        addedBy: team.ownerId,
        addedAt: DateTime.formatIso(yield* DateTime.now),
      });
    }
  }

  return TeamClaudeKey.of({
    status,
    changes: SubscriptionRef.changes(version).pipe(
      Stream.drop(1),
      Stream.mapEffect(() => status),
    ),
    set,
    remove,
    endpoint,
  });
});

export const layer = Layer.effect(TeamClaudeKey, make);
