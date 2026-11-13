import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Schema from "effect/Schema";

import { BOAT_ORIGIN, type BoatApi, makeBoatApi } from "./BoatApi.ts";

/** What a stand-in runner keeps on a machine's disk; a saved snapshot copies it. */
export interface FakeBoatDisk {
  marker: string | null;
}

export interface FakeBoatSandbox {
  readonly id: string;
  readonly name: string;
  state: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly type: string;
  readonly from: string | null;
  readonly createdAt: string;
  health: "ok" | "degraded";
  dataExpiredAt: string | null;
  setupStatus: string | null;
  /** By absolute path, as the driver and the guest write them. */
  readonly files: Map<string, string>;
  readonly disk: FakeBoatDisk;
  /** While set, `get` leaves `state` as it is; otherwise each `get` moves it one step on. */
  held: boolean;
}

export interface FakeBoatSavedSnapshot {
  readonly name: string;
  status: "saving" | "ready" | "failed";
  readonly sourceSandboxId: string;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly sizeBytes: number;
  /** By path relative to the root. `base-image`: a stock file boat does not store. */
  readonly files: Map<string, string | "base-image">;
  readonly disk: FakeBoatDisk;
}

export interface FakeBoatRequest {
  readonly method: string;
  /** Under the API origin, e.g. `/sandboxes/bx_abcdefgh/resume`. */
  readonly path: string;
  readonly query: ReadonlyArray<readonly [string, string]>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** One delivery command: what the stand-in guest reads from the machine. */
export interface FakeBoatBoot {
  readonly sandbox: FakeBoatSandbox;
  readonly bootstrap: string;
  readonly generation: number;
}

export interface FakeBoatFailure {
  readonly status: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;
}

export interface BoatApiFake {
  readonly client: HttpClient.HttpClient;
  readonly api: (options?: { readonly organization?: string }) => BoatApi;
  readonly requests: ReadonlyArray<FakeBoatRequest>;
  readonly sandbox: (idOrName: string) => FakeBoatSandbox | undefined;
  readonly sandboxes: () => ReadonlyArray<FakeBoatSandbox>;
  readonly putSandbox: (input: {
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly state?: string;
  }) => FakeBoatSandbox;
  readonly savedSnapshot: (name: string) => FakeBoatSavedSnapshot | undefined;
  readonly addSavedSnapshot: (input: {
    readonly name: string;
    readonly status?: FakeBoatSavedSnapshot["status"];
    readonly sourceSandboxId?: string;
    readonly files?: Readonly<Record<string, string | "base-image">>;
  }) => FakeBoatSavedSnapshot;
  /** The next request to `<METHOD> <template>`, e.g. `POST /sandboxes/{id}/resume`, fails so. */
  readonly failNext: (route: string, failure: FakeBoatFailure) => void;
  readonly count: (route: string) => number;
}

const JsonText = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(JsonText);
const decodeJson = Schema.decodeEffect(JsonText);

const SANDBOX_ID_CHARS = "23456789abcdefghjkmnpqrstuvwxyz";
const BOOT_COMMAND = /^sudo \/usr\/local\/bin\/pair-boat-boot (\d+)$/;
const BOOTSTRAP_PATH = "/tmp/pair-boot/bootstrap.env";

/** The next state a `get` reads when nothing holds the sandbox. */
const NEXT_STATE: Readonly<Record<string, string>> = {
  init: "provisioning",
  provisioning: "ready",
  provisioned: "ready",
  cloning: "ready",
  archiving: "archived",
};

/** The route template of a path, as `BoatApiError.endpoint` names it. */
const routeOf = (method: string, path: string) =>
  `${method} ${path
    .replace(/^\/sandboxes\/[^/]+/, "/sandboxes/{id}")
    .replace(/^\/saved-snapshots\/[^/]+/, "/saved-snapshots/{name}")
    .replace(/^\/snapshots\/[^/]+/, "/snapshots/{id}")}`;

/**
 * An in-process fake of the boat API endpoints the driver calls, behind a real `HttpClient`, so
 * `BoatApi` itself runs under test. States move on with each `get` and no clock, so a driver's
 * poll never waits on real time; a held sandbox keeps its state.
 */
export const make = Effect.fn("BoatApiTesting.make")(
  (
    options: {
      readonly onBoot?: (boot: FakeBoatBoot) => Effect.Effect<void>;
      readonly pageSize?: number;
      readonly unavailableTypes?: ReadonlyArray<string>;
    } = {},
  ) =>
    Effect.sync(() => {
      const sandboxes = new Map<string, FakeBoatSandbox>();
      const savedSnapshots = new Map<string, FakeBoatSavedSnapshot>();
      const idempotency = new Map<string, { readonly body: string; readonly id: string }>();
      const failures = new Map<string, Array<FakeBoatFailure>>();
      const requests: Array<FakeBoatRequest> = [];
      let sequence = 0;
      // A fixed day, one second per resource, so order is stable and nothing reads the clock.
      const now = () => {
        const second = sequence++;
        const pad = (value: number) => String(value).padStart(2, "0");
        return `2026-11-13T${pad(Math.floor(second / 3600) % 24)}:${pad(Math.floor(second / 60) % 60)}:${pad(second % 60)}.000Z`;
      };
      const newId = () => {
        let suffix = "";
        let value = sequence++;
        for (let index = 0; index < 8; index++) {
          suffix += SANDBOX_ID_CHARS[value % SANDBOX_ID_CHARS.length];
          value = Math.floor(value / SANDBOX_ID_CHARS.length);
        }
        return `bx_${suffix}`;
      };

      const find = (idOrName: string) =>
        sandboxes.get(idOrName) ??
        Array.from(sandboxes.values()).find((sandbox) => sandbox.name === idOrName);

      const putSandbox: BoatApiFake["putSandbox"] = (input) => {
        const sandbox: FakeBoatSandbox = {
          id: newId(),
          name: input.name,
          state: input.state ?? "ready",
          labels: input.labels,
          type: "default",
          from: null,
          createdAt: now(),
          health: "ok",
          dataExpiredAt: null,
          setupStatus: null,
          files: new Map(),
          disk: { marker: null },
          held: false,
        };
        sandboxes.set(sandbox.id, sandbox);
        return sandbox;
      };

      const addSavedSnapshot: BoatApiFake["addSavedSnapshot"] = (input) => {
        const snapshot: FakeBoatSavedSnapshot = {
          name: input.name,
          status: input.status ?? "ready",
          sourceSandboxId: input.sourceSandboxId ?? "bx_seeded0",
          snapshotId: `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
          createdAt: now(),
          sizeBytes: 1024,
          files: new Map(Object.entries(input.files ?? {})),
          disk: { marker: null },
        };
        savedSnapshots.set(snapshot.name, snapshot);
        return snapshot;
      };

      const view = (sandbox: FakeBoatSandbox) => ({
        id: sandbox.id,
        name: sandbox.name,
        state: sandbox.state,
        labels: sandbox.labels,
        health: sandbox.health,
        dataExpiredAt: sandbox.dataExpiredAt,
        setupStatus: sandbox.setupStatus,
        createdAt: sandbox.createdAt,
        type: sandbox.type,
      });
      const snapshotView = (snapshot: FakeBoatSavedSnapshot) => ({
        name: snapshot.name,
        status: snapshot.status,
        sourceSandboxId: snapshot.sourceSandboxId,
        createdAt: snapshot.createdAt,
        sizeBytes: snapshot.sizeBytes,
        ...(snapshot.status === "ready" ? { snapshotId: snapshot.snapshotId } : {}),
      });

      type Answer = { readonly status: number; readonly body?: unknown; readonly bytes?: string };
      const fail = (status: number, code: string): Answer => ({
        status,
        body: {
          ok: false,
          status,
          code,
          message: code,
          error: { code, status },
          requestId: "req_fake",
        },
      });
      const ok = (body: unknown, status = 200): Answer => ({
        status,
        body: { ok: true, ...(body as object) },
      });

      const handle = Effect.fn("BoatApiTesting.handle")(function* (
        method: string,
        path: string,
        query: URLSearchParams,
        headers: Readonly<Record<string, string>>,
        body: unknown,
      ) {
        const json = (body ?? {}) as Record<string, unknown>;
        const parts = path
          .split("/")
          .filter((part) => part !== "")
          .map(decodeURIComponent);

        if (parts[0] === "limits" && method === "GET") {
          return ok({
            machineTypes: ["small", "default", "large", "xlarge"].map((type) => ({
              type,
              available: !(options.unavailableTypes ?? []).includes(type),
              reason: null,
            })),
          });
        }

        if (parts[0] === "sandboxes" && parts.length === 1) {
          if (method === "POST") {
            const key = headers["idempotency-key"];
            const text = encodeJson(body);
            const replay = key === undefined ? undefined : idempotency.get(key);
            if (replay !== undefined) {
              if (replay.body !== text) return fail(409, "idempotency_key_reused");
              const existing = sandboxes.get(replay.id);
              return existing === undefined
                ? fail(404, "not_found")
                : ok({ type: "sandbox.created", sandbox: view(existing) }, 202);
            }
            const from = typeof json.from === "string" ? json.from : null;
            const source = from === null ? undefined : savedSnapshots.get(from);
            if (from !== null && source?.status !== "ready") return fail(404, "not_found");
            const sandbox: FakeBoatSandbox = {
              ...putSandbox({
                name: String(json.name ?? ""),
                labels: (json.labels ?? {}) as Record<string, string>,
                state: "provisioning",
              }),
              type: String(json.type ?? "default"),
              from,
              setupStatus: typeof json.setupScript === "string" ? "running" : null,
            };
            sandbox.disk.marker = source?.disk.marker ?? null;
            for (const file of (json.files ?? []) as ReadonlyArray<{
              path: string;
              content: string;
            }>) {
              sandbox.files.set(file.path, file.content);
            }
            sandboxes.set(sandbox.id, sandbox);
            if (key !== undefined) idempotency.set(key, { body: text, id: sandbox.id });
            return ok({ type: "sandbox.created", sandbox: view(sandbox) }, 202);
          }
          const states = (query.get("state") ?? "ready,idle,running").split(",");
          const labels = query.getAll("label").map((label) => label.split("="));
          const name = query.get("name");
          const matching = Array.from(sandboxes.values()).filter(
            (sandbox) =>
              states.includes(sandbox.state) &&
              (name === null || sandbox.name === name) &&
              labels.every(([labelKey, value]) => sandbox.labels[labelKey ?? ""] === value),
          );
          const start = Number(query.get("cursor") ?? "0");
          const size = options.pageSize ?? 100;
          const page = matching.slice(start, start + size);
          const next = start + size < matching.length ? String(start + size) : null;
          return ok({
            sandboxes: page.map(view),
            pageInfo: { nextCursor: next, hasMore: next !== null },
          });
        }

        if (parts[0] === "sandboxes" && parts[1] !== undefined) {
          const sandbox = sandboxes.get(parts[1]);
          if (sandbox === undefined) return fail(404, "not_found");
          const action = parts[2];
          if (action === undefined && method === "GET") {
            const shown = view(sandbox);
            if (!sandbox.held) sandbox.state = NEXT_STATE[sandbox.state] ?? sandbox.state;
            return ok({ type: "sandbox.info", sandbox: shown });
          }
          if (action === undefined && method === "DELETE") {
            if (headers["x-ascii-confirm-delete"] !== sandbox.id)
              return fail(409, "confirm_required");
            sandboxes.delete(sandbox.id);
            return ok({ type: "sandbox.deleting" }, 202);
          }
          if (action === "stop" && method === "POST") {
            if (sandbox.state === "archived") return ok({ status: "archived" });
            if (sandbox.state !== "archiving") sandbox.state = "archiving";
            return ok({ status: "archiving" }, 202);
          }
          if (action === "resume" && method === "POST") {
            if (sandbox.dataExpiredAt !== null) return fail(409, "snapshot_data_expired");
            if (sandbox.state === "archiving" && sandbox.held) return fail(409, "sandbox_stopping");
            sandbox.state = "provisioning";
            // A resumed machine boots from its disk: /tmp is not snapshotted.
            for (const file of Array.from(sandbox.files.keys())) {
              if (file.startsWith("/tmp/")) sandbox.files.delete(file);
            }
            return ok({ status: "resuming" }, 202);
          }
          if (action === "files" && method === "PUT") {
            sandbox.files.set(String(json.path), String(json.content));
            return ok({ type: "file.written" });
          }
          if (action === "files" && method === "GET") {
            const content = sandbox.files.get(query.get("path") ?? "");
            return content === undefined
              ? fail(404, "not_found")
              : ok({ type: "file.read", content, encoding: "utf8" });
          }
          if (action === "commands" && method === "POST") {
            const command = String(json.command ?? "");
            const boot = BOOT_COMMAND.exec(command);
            if (boot === null) {
              return ok({ exitCode: 127, stdout: "", stderr: "unknown command" });
            }
            const bootstrap = sandbox.files.get(BOOTSTRAP_PATH);
            if (bootstrap === undefined) {
              return ok({ exitCode: 1, stdout: "", stderr: "pair-boat-boot: no bootstrap\n" });
            }
            sandbox.files.delete(BOOTSTRAP_PATH);
            if (options.onBoot !== undefined) {
              yield* options.onBoot({ sandbox, bootstrap, generation: Number(boot[1]) });
            }
            return ok({ exitCode: 0, stdout: "", stderr: "" });
          }
          return fail(404, "not_found");
        }

        if (parts[0] === "saved-snapshots") {
          const name = parts[1];
          if (name === undefined && method === "GET") {
            const prefix = query.get("namePrefix") ?? "";
            return ok({
              snapshots: Array.from(savedSnapshots.values())
                .filter((snapshot) => snapshot.name.startsWith(prefix))
                .map(snapshotView),
            });
          }
          if (name === undefined && method === "POST") {
            const source = sandboxes.get(String(json.sandboxId));
            if (source === undefined) return fail(404, "not_found");
            const target = String(json.name);
            if (savedSnapshots.get(target)?.status === "saving")
              return fail(409, "save_in_progress");
            const saved = addSavedSnapshot({
              name: target,
              status: "saving",
              sourceSandboxId: source.id,
            });
            saved.disk.marker = source.disk.marker;
            return ok({ status: "saving", snapshot: snapshotView(saved) }, 202);
          }
          const snapshot = name === undefined ? undefined : savedSnapshots.get(name);
          if (snapshot === undefined) return fail(404, "not_found");
          if (method === "GET") {
            const shown = snapshotView(snapshot);
            if (snapshot.status === "saving") snapshot.status = "ready";
            return ok({ snapshot: shown });
          }
          if (method === "DELETE") {
            savedSnapshots.delete(snapshot.name);
            return ok({ type: "snapshot.saved.deleted" });
          }
        }

        if (parts[0] === "snapshots" && parts[2] === "files" && method === "GET") {
          const snapshot = Array.from(savedSnapshots.values()).find(
            (entry) => entry.snapshotId === parts[1],
          );
          const file = snapshot?.files.get(query.get("path") ?? "");
          if (file === "base-image") return fail(409, "base_image_file");
          if (file === undefined) return fail(404, "not_found");
          return { status: 200, bytes: file };
        }

        return fail(404, "not_found");
      });

      const client = HttpClient.make((request, url) =>
        Effect.gen(function* () {
          const path = url.pathname.slice(new URL(BOAT_ORIGIN).pathname.length);
          const body =
            request.body._tag === "Uint8Array"
              ? yield* decodeJson(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie)
              : undefined;
          const headers = Object.fromEntries(
            Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
          );
          requests.push({
            method: request.method,
            path,
            query: Array.from(url.searchParams.entries()),
            headers,
            body,
          });
          const queued = failures.get(routeOf(request.method, path));
          const injected = queued?.shift();
          const answer =
            injected !== undefined
              ? {
                  ...fail(injected.status, injected.code ?? "injected"),
                  ...(injected.retryAfterSeconds === undefined
                    ? {}
                    : { retryAfter: injected.retryAfterSeconds }),
                }
              : yield* handle(request.method, path, url.searchParams, headers, body);
          const responseHeaders: Record<string, string> =
            "retryAfter" in answer ? { "retry-after": String(answer.retryAfter) } : {};
          return HttpClientResponse.fromWeb(
            request,
            answer.bytes !== undefined
              ? new Response(answer.bytes, { status: answer.status, headers: responseHeaders })
              : Response.json(answer.body, { status: answer.status, headers: responseHeaders }),
          );
        }),
      );

      return {
        client,
        api: (apiOptions = {}) =>
          makeBoatApi(client, {
            apiKey: () => Effect.succeed("boat_test_key"),
            ...(apiOptions.organization === undefined
              ? {}
              : { organization: apiOptions.organization }),
          }),
        requests,
        sandbox: find,
        sandboxes: () => Array.from(sandboxes.values()),
        putSandbox,
        savedSnapshot: (name) => savedSnapshots.get(name),
        addSavedSnapshot,
        failNext: (route, failure) => {
          const queue = failures.get(route) ?? [];
          queue.push(failure);
          failures.set(route, queue);
        },
        count: (route) =>
          requests.filter((request) => routeOf(request.method, request.path) === route).length,
      } satisfies BoatApiFake;
    }),
);
