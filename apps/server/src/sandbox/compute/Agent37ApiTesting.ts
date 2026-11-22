import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Schema from "effect/Schema";

import { AGENT37_ORIGIN, type Agent37Api, makeAgent37Api } from "./Agent37Api.ts";

/** What a stand-in runner keeps on a machine's disk; a fork copies it. */
export interface FakeAgent37Disk {
  marker: string | null;
}

export interface FakeAgent37Instance {
  readonly id: string;
  readonly name: string;
  status: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly template: string;
  readonly type: string;
  readonly region: string;
  readonly resources: { readonly cpu: number; readonly memory: number; readonly disk: number };
  readonly mountPath: string;
  readonly created: number;
  /** The runner state the boot script keeps; a container boot clears it. */
  generation: string | null;
  token: boolean;
  readonly disk: FakeAgent37Disk;
  /** While set, `get` leaves `status` as it is; otherwise each `get` moves it on first. */
  held: boolean;
}

export interface FakeAgent37Template {
  readonly name: string;
  readonly imageRef: string;
  /** Null while the copy into private storage runs. */
  imageDigest: string | null;
  readonly entrypoint: ReadonlyArray<string> | null;
}

export interface FakeAgent37Request {
  readonly method: string;
  /** Under the API origin, e.g. `/instances/ab12cd34ef/start`. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** One bootstrap hand-off: what the stand-in runner reads from the machine. */
export interface FakeAgent37Boot {
  readonly instance: FakeAgent37Instance;
  readonly bootstrap: string;
  readonly generation: number;
}

export interface FakeAgent37Failure {
  readonly status: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;
}

export interface Agent37ApiFake {
  readonly client: HttpClient.HttpClient;
  readonly api: () => Agent37Api;
  readonly requests: ReadonlyArray<FakeAgent37Request>;
  readonly instance: (idOrName: string) => FakeAgent37Instance | undefined;
  readonly instances: () => ReadonlyArray<FakeAgent37Instance>;
  readonly putInstance: (input: {
    readonly name: string;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly status?: string;
    readonly template?: string;
  }) => FakeAgent37Instance;
  readonly template: (name: string) => FakeAgent37Template | undefined;
  readonly addTemplate: (input: {
    readonly name: string;
    readonly imageRef: string;
    readonly imageDigest?: string | null;
  }) => FakeAgent37Template;
  /** The next request to `<METHOD> <template>`, e.g. `POST /instances/{id}/start`, fails so. */
  readonly failNext: (route: string, failure: FakeAgent37Failure) => void;
  readonly count: (route: string) => number;
  /** How much the next `GET /billing` reports. */
  billing: { balance: number; pastDue: boolean };
}

const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeEffect(JsonText);

const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
/** What `deliveryCommand` writes: the generation and the base64 bootstrap. */
const DELIVERY = /^set -eu; g=(\d+); .* printf %s '([A-Za-z0-9+/=]*)' \| base64 -d /;

/** The next status a `get` reads when nothing holds the instance. */
const NEXT_STATUS: Readonly<Record<string, string>> = {
  provisioning: "running",
  starting: "running",
  stopping: "stopped",
};

/** The route template of a path, as `Agent37ApiError.endpoint` names it. */
const routeOf = (method: string, path: string) =>
  `${method} ${path
    .replace(/^\/instances\/[^/]+/, "/instances/{id}")
    .replace(/^\/templates\/[^/]+/, "/templates/{name}")}`;

/**
 * An in-process fake of the Agent37 endpoints the driver calls, behind a real `HttpClient`, so
 * `Agent37Api` itself runs under test. Statuses move on with each `get` and no clock, so a
 * driver's poll never waits on real time; a held instance keeps its status.
 */
export const make = Effect.fn("Agent37ApiTesting.make")(
  (
    options: {
      readonly onBoot?: (boot: FakeAgent37Boot) => Effect.Effect<void>;
      /** Runs as each request arrives, before it is answered: a test's sync point. */
      readonly onRequest?: (request: FakeAgent37Request) => Effect.Effect<void>;
      /** The status a create or fork answers with; Agent37 answers `running`. */
      readonly createStatus?: string;
      /** Image refs a template create refuses as unpullable. */
      readonly unpullable?: ReadonlyArray<string>;
    } = {},
  ) =>
    Effect.sync(() => {
      const instances = new Map<string, FakeAgent37Instance>();
      const templates = new Map<string, FakeAgent37Template>();
      const failures = new Map<string, Array<FakeAgent37Failure>>();
      const requests: Array<FakeAgent37Request> = [];
      let sequence = 0;
      // One second per resource, so order is stable and nothing reads the clock.
      const now = () => 1_790_000_000 + sequence++;
      const newId = () => {
        let id = "";
        let value = 1_000_000 + sequence++;
        for (let index = 0; index < 10; index++) {
          id += ID_CHARS[value % ID_CHARS.length];
          value = Math.floor(value / ID_CHARS.length);
        }
        return id;
      };

      const find = (idOrName: string) =>
        instances.get(idOrName) ??
        Array.from(instances.values()).find((instance) => instance.name === idOrName);

      /** A container boot: the boot script clears the last boot's runner state. */
      const boot = (instance: FakeAgent37Instance) => {
        instance.generation = null;
        instance.token = false;
      };

      const putInstance: Agent37ApiFake["putInstance"] = (input) => {
        const instance: FakeAgent37Instance = {
          id: newId(),
          name: input.name,
          status: input.status ?? "running",
          metadata: input.metadata,
          template: input.template ?? "agent37-base",
          type: "default",
          region: "us",
          resources: { cpu: 2, memory: 4, disk: 12 },
          mountPath: "/t3-sandbox",
          created: now(),
          generation: null,
          token: false,
          disk: { marker: null },
          held: false,
        };
        instances.set(instance.id, instance);
        return instance;
      };

      const addTemplate: Agent37ApiFake["addTemplate"] = (input) => {
        const template: FakeAgent37Template = {
          name: input.name,
          imageRef: input.imageRef,
          imageDigest:
            input.imageDigest === undefined
              ? `sha256:${String(sequence++).padStart(64, "0")}`
              : input.imageDigest,
          entrypoint: null,
        };
        templates.set(template.name, template);
        return template;
      };

      const view = (instance: FakeAgent37Instance) => ({
        id: instance.id,
        status: instance.status,
        status_reason: null,
        name: instance.name,
        metadata: instance.metadata,
        template: instance.template,
        type: instance.type,
        region: instance.region,
        mount_path: instance.mountPath,
        resources: instance.resources,
        url: `https://${instance.id}.agent37.app`,
        auto_sleep: false,
        past_due: false,
        created: instance.created,
      });
      const templateView = (template: FakeAgent37Template) => ({
        name: template.name,
        scope: "workspace",
        agents: [],
        revision: 1,
        image_ref: template.imageRef,
        ...(template.imageDigest === null ? {} : { image_digest: template.imageDigest }),
        default_port: null,
        entrypoint: template.entrypoint,
      });

      type Answer = { readonly status: number; readonly body: unknown };
      const fail = (status: number, code: string): Answer => ({
        status,
        body: { error: { code, message: code } },
      });
      const ok = (body: unknown, status = 200): Answer => ({ status, body });

      const handle = Effect.fn("Agent37ApiTesting.handle")(function* (
        method: string,
        path: string,
        body: unknown,
      ) {
        const json = (body ?? {}) as Record<string, unknown>;
        const parts = path
          .split("/")
          .filter((part) => part !== "")
          .map(decodeURIComponent);

        if (parts[0] === "billing" && method === "GET") {
          return ok({
            balance_usd: fake.billing.balance,
            tier: 1,
            memory_limit_gb: 40,
            instance_limit: 10,
            auto_top_up: null,
            past_due: fake.billing.pastDue,
          });
        }

        if (parts[0] === "templates") {
          const name = parts[1];
          if (name === undefined && method === "GET") {
            return ok({ data: Array.from(templates.values()).map(templateView) });
          }
          if (name === undefined && method === "POST") {
            const target = String(json.name ?? "");
            if (templates.has(target)) return fail(409, "template_conflict");
            const imageRef = String(json.image_ref ?? "");
            if ((options.unpullable ?? []).includes(imageRef)) return fail(400, "invalid_request");
            const template: FakeAgent37Template = {
              ...addTemplate({ name: target, imageRef }),
              entrypoint: Array.isArray(json.entrypoint) ? json.entrypoint.map(String) : null,
            };
            templates.set(target, template);
            return ok(templateView(template), 201);
          }
          const template = name === undefined ? undefined : templates.get(name);
          if (template === undefined) return fail(404, "not_found");
          if (method === "GET") return ok(templateView(template));
          if (method === "DELETE") {
            templates.delete(template.name);
            return ok({ name: template.name, deleted: true });
          }
        }

        if (parts[0] === "instances" && parts.length === 1) {
          if (method === "POST") {
            const template = String(json.template ?? "agent37-base");
            if (!template.startsWith("agent37-") && templates.get(template)?.imageDigest == null) {
              return fail(400, "invalid_request");
            }
            const type = String(json.type ?? "default");
            const region = String(json.region ?? "us");
            if (region !== "us" && type === "default") return fail(400, "invalid_request");
            const instance: FakeAgent37Instance = {
              ...putInstance({
                name: String(json.name ?? ""),
                metadata: (json.metadata ?? {}) as Record<string, unknown>,
                status: options.createStatus ?? "running",
                template,
              }),
              type,
              region,
              resources: json.resources as FakeAgent37Instance["resources"],
              mountPath: String(json.mount_path ?? "/root"),
            };
            instances.set(instance.id, instance);
            return ok(view(instance), 201);
          }
          return ok({
            data: Array.from(instances.values())
              .toSorted((a, b) => b.created - a.created)
              .map(view),
          });
        }

        if (parts[0] === "instances" && parts[1] !== undefined) {
          const instance = instances.get(parts[1]);
          if (instance === undefined) return fail(404, "not_found");
          const action = parts[2];
          if (action === undefined && method === "GET") {
            if (!instance.held) instance.status = NEXT_STATUS[instance.status] ?? instance.status;
            return ok(view(instance));
          }
          if (action === undefined && method === "DELETE") {
            instances.delete(instance.id);
            return ok({ id: instance.id, deleted: true });
          }
          if (action === "stop" && method === "POST") {
            if (instance.status === "running" || instance.status === "sleeping") {
              instance.status = "stopped";
            }
            if (instance.status !== "stopped") return fail(400, "invalid_request");
            return ok({ id: instance.id, status: "stopped" });
          }
          if (action === "start" && method === "POST") {
            if (["stopped", "sleeping", "failed"].includes(instance.status)) {
              instance.status = "running";
              boot(instance);
            }
            if (instance.status !== "running") return fail(400, "invalid_request");
            return ok({ id: instance.id, status: "running" });
          }
          if (action === "fork" && method === "POST") {
            if (!["running", "stopped", "sleeping"].includes(instance.status)) {
              return fail(400, "invalid_request");
            }
            const resources = (json.resources ??
              instance.resources) as FakeAgent37Instance["resources"];
            if (resources.disk < instance.resources.disk) return fail(400, "invalid_request");
            const fork: FakeAgent37Instance = {
              ...putInstance({
                name: String(json.name ?? instance.name),
                metadata: (json.metadata ?? instance.metadata) as Record<string, unknown>,
                status: options.createStatus ?? "running",
                template: instance.template,
              }),
              type: instance.type,
              region: instance.region,
              resources,
              mountPath: instance.mountPath,
              disk: { marker: instance.disk.marker },
            };
            instances.set(fork.id, fork);
            return ok(view(fork), 201);
          }
          if (action === "exec" && method === "POST") {
            if (instance.status !== "running") return fail(400, "invalid_request");
            if (json.user !== "root") {
              return ok({ exit_code: 1, stdout: "", stderr: "pair-agent37: not root\n" });
            }
            const delivery = DELIVERY.exec(String(json.command ?? ""));
            if (delivery === null) {
              return ok({ exit_code: 127, stdout: "", stderr: "sh: unknown command\n" });
            }
            const generation = delivery[1] ?? "";
            // A runner of this generation that enrolled is kept.
            if (instance.generation === generation && instance.token) {
              return ok({ exit_code: 0, stdout: "", stderr: "" });
            }
            instance.generation = generation;
            instance.token = true;
            if (options.onBoot !== undefined) {
              yield* options.onBoot({
                instance,
                bootstrap: Buffer.from(delivery[2] ?? "", "base64").toString("utf8"),
                generation: Number(generation),
              });
            }
            return ok({ exit_code: 0, stdout: "", stderr: "", truncated: false });
          }
          return fail(404, "not_found");
        }

        return fail(404, "not_found");
      });

      const client = HttpClient.make((request, url) =>
        Effect.gen(function* () {
          const path = url.pathname.slice(new URL(AGENT37_ORIGIN).pathname.length);
          const body =
            request.body._tag === "Uint8Array"
              ? yield* decodeJson(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie)
              : undefined;
          const headers = Object.fromEntries(
            Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
          );
          const recorded: FakeAgent37Request = { method: request.method, path, headers, body };
          requests.push(recorded);
          if (options.onRequest !== undefined) yield* options.onRequest(recorded);
          const injected = failures.get(routeOf(request.method, path))?.shift();
          const answer =
            injected !== undefined
              ? fail(injected.status, injected.code ?? "injected")
              : yield* handle(request.method, path, body);
          const responseHeaders: Record<string, string> =
            injected?.retryAfterSeconds === undefined
              ? {}
              : { "retry-after": String(injected.retryAfterSeconds) };
          return HttpClientResponse.fromWeb(
            request,
            Response.json(answer.body, { status: answer.status, headers: responseHeaders }),
          );
        }),
      );

      const fake: Agent37ApiFake = {
        client,
        api: () => makeAgent37Api(client, { apiKey: () => Effect.succeed("sk_live_test") }),
        requests,
        instance: find,
        instances: () => Array.from(instances.values()),
        putInstance,
        template: (name) => templates.get(name),
        addTemplate,
        failNext: (route, failure) => {
          const queue = failures.get(route) ?? [];
          queue.push(failure);
          failures.set(route, queue);
        },
        count: (route) =>
          requests.filter((request) => routeOf(request.method, request.path) === route).length,
        billing: { balance: 10, pastDue: false },
      };
      return fake;
    }),
);
