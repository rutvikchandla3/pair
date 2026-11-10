import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { ComputeDriverId, NonNegativeInt, SandboxId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import {
  type BackendSandbox,
  ComputeDriver,
  type ComputeDriverCreateInput,
  type ComputeDriverCreateResult,
  ComputeDriverError,
  type ComputeDriverHealth,
  parseSandboxTags,
  type SandboxBootstrap,
} from "./ComputeDriver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ComputeDriverRegistry } from "./ComputeDriverRegistry.ts";

/**
 * What a contract stand-in runner posts to `<serverUrl>/hello` once booted. It reads
 * `/t3-sandbox/<sandboxId>/contract-marker` (null when absent), writes `g<generation>` there,
 * and only then posts, so a stop right after the hello cannot lose the write.
 */
export const StandInRunnerHello = Schema.Struct({
  sandboxId: SandboxId,
  generation: NonNegativeInt,
  enroll: Schema.String,
  marker: Schema.NullOr(Schema.String),
});
export type StandInRunnerHello = typeof StandInRunnerHello.Type;

export const STAND_IN_RUNNER_HELLO_PATH = "/hello";

export type FakeComputeCall =
  | {
      readonly _tag: "create";
      readonly input: ComputeDriverCreateInput;
      readonly reply: Deferred.Deferred<ComputeDriverCreateResult, ComputeDriverError>;
    }
  | {
      readonly _tag: "start";
      readonly driverRef: string;
      readonly bootstrap: SandboxBootstrap;
      readonly reply: Deferred.Deferred<void, ComputeDriverError>;
    }
  | {
      readonly _tag: "stop" | "destroy" | "deleteImage";
      readonly ref: string;
      readonly reply: Deferred.Deferred<void, ComputeDriverError>;
    }
  | {
      readonly _tag: "status";
      readonly driverRef: string;
      readonly reply: Deferred.Deferred<BackendSandbox, ComputeDriverError>;
    }
  | {
      readonly _tag: "list";
      readonly tags: Readonly<Record<string, string>>;
      readonly reply: Deferred.Deferred<ReadonlyArray<BackendSandbox>, ComputeDriverError>;
    }
  | {
      readonly _tag: "snapshot";
      readonly driverRef: string;
      readonly name: string;
      readonly reply: Deferred.Deferred<FakeSnapshot, ComputeDriverError>;
    }
  | {
      readonly _tag: "readImageFile";
      readonly imageRef: string;
      readonly path: string;
      readonly reply: Deferred.Deferred<Uint8Array | null | "whole-disk", ComputeDriverError>;
    }
  | {
      readonly _tag: "health";
      readonly reply: Deferred.Deferred<ComputeDriverHealth, ComputeDriverError>;
    };

export interface FakeSnapshot {
  readonly imageRef: string;
  readonly sizeBytes: number | null;
}

/** Every call waits on a `Deferred` the test completes or fails, so the test is the backend. */
export const make = Effect.fn("FakeComputeDriver.make")(function* (
  driverId: ComputeDriverId = ComputeDriverId.make("fake"),
  options: {
    readonly defaultRunningCap?: number;
    readonly sleepOnSettle?: boolean;
    readonly defaultIdleSleepMs?: number;
  } = {},
) {
  const calls = yield* Queue.unbounded<FakeComputeCall>();
  const ask = <A>(
    call: (reply: Deferred.Deferred<A, ComputeDriverError>) => FakeComputeCall,
  ): Effect.Effect<A, ComputeDriverError> =>
    Deferred.make<A, ComputeDriverError>().pipe(
      Effect.tap((reply) => Queue.offer(calls, call(reply))),
      Effect.flatMap(Deferred.await),
    );

  const driver = ComputeDriver.of({
    driverId,
    kind: "docker",
    capabilities: {
      persistentDisk: true,
      memoryOnStop: false,
      snapshot: false,
      imageBuild: "snapshot",
      maxSessionMs: null,
      diskRetentionDays: null,
      isolation: "container",
      egressRules: "none",
      regions: [],
      nestedDocker: false,
      sizes: [
        { size: "small", vcpus: 2, memoryGb: 4 },
        { size: "default", vcpus: 4, memoryGb: 8 },
        { size: "large", vcpus: 8, memoryGb: 16 },
      ],
      defaultRunningCap: options.defaultRunningCap ?? 20,
      sleepOnSettle: options.sleepOnSettle ?? true,
      defaultIdleSleepMs: options.defaultIdleSleepMs ?? 60 * 60_000,
    },
    create: Effect.fn("FakeComputeDriver.create")((input: ComputeDriverCreateInput) =>
      ask<ComputeDriverCreateResult>((reply) => ({ _tag: "create", input, reply })),
    ),
    start: Effect.fn("FakeComputeDriver.start")((driverRef: string, bootstrap: SandboxBootstrap) =>
      ask<void>((reply) => ({ _tag: "start", driverRef, bootstrap, reply })),
    ),
    stop: Effect.fn("FakeComputeDriver.stop")((ref: string) =>
      ask<void>((reply) => ({ _tag: "stop", ref, reply })),
    ),
    destroy: Effect.fn("FakeComputeDriver.destroy")((ref: string) =>
      ask<void>((reply) => ({ _tag: "destroy", ref, reply })),
    ),
    status: Effect.fn("FakeComputeDriver.status")((driverRef: string) =>
      ask<BackendSandbox>((reply) => ({ _tag: "status", driverRef, reply })),
    ),
    list: Effect.fn("FakeComputeDriver.list")((tags: Readonly<Record<string, string>>) =>
      ask<ReadonlyArray<BackendSandbox>>((reply) => ({ _tag: "list", tags, reply })),
    ),
    deleteImage: Effect.fn("FakeComputeDriver.deleteImage")((ref: string) =>
      ask<void>((reply) => ({ _tag: "deleteImage", ref, reply })),
    ),
    snapshot: Effect.fn("FakeComputeDriver.snapshot")((driverRef: string, name: string) =>
      ask<FakeSnapshot>((reply) => ({ _tag: "snapshot", driverRef, name, reply })),
    ),
    readImageFile: Effect.fn("FakeComputeDriver.readImageFile")((imageRef: string, path: string) =>
      ask<Uint8Array | null | "whole-disk">((reply) => ({
        _tag: "readImageFile",
        imageRef,
        path,
        reply,
      })),
    ),
    health: ask<ComputeDriverHealth>((reply) => ({ _tag: "health", reply })).pipe(
      Effect.withSpan("FakeComputeDriver.health"),
    ),
  });
  return { driver, calls: calls as Queue.Dequeue<FakeComputeCall> };
});

/** What the real registry reports: the cap in the driver's settings, else the driver's default. */
export const runningCapFromSettings = (
  settings: ServerSettingsService["Service"],
  fake: ComputeDriver["Service"],
) =>
  Effect.fn("FakeComputeDriverRegistry.runningCap")(function* (driverId: ComputeDriverId) {
    const config = (yield* settings.getSettings).sandbox?.drivers.find(
      (driver) => driver.id === driverId,
    );
    return config?.runningCap ?? fake.capabilities.defaultRunningCap;
  });

/** Every driver id resolves to `fake`, whatever settings say; only the cap reads them. */
export const layerRegistry = (fake: ComputeDriver["Service"]) =>
  Layer.effect(
    ComputeDriverRegistry,
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      return ComputeDriverRegistry.of({
        get: Effect.fn("FakeComputeDriverRegistry.get")(function* () {
          return yield* Effect.succeed(fake);
        }),
        list: Effect.succeed([fake]),
        runningCap: runningCapFromSettings(settings, fake),
      });
    }),
  );

const socketPathOf = (serverUrl: string) =>
  serverUrl.startsWith("unix:") ? serverUrl.slice("unix:".length) : null;

// `unix:<path>` dials that socket, as the stand-in runner does.
const postStandInHello = Effect.fn("ComputeDriverTesting.postStandInHello")(
  function* (serverUrl: string, hello: StandInRunnerHello) {
    const base = socketPathOf(serverUrl) === null ? serverUrl : "http://runner";
    const request = yield* HttpClientRequest.post(new URL(STAND_IN_RUNNER_HELLO_PATH, base)).pipe(
      HttpClientRequest.schemaBodyJson(StandInRunnerHello)(hello),
    );
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    yield* client.execute(request);
  },
  (effect, serverUrl) => {
    const socketPath = socketPathOf(serverUrl);
    return effect.pipe(
      Effect.provide(
        NodeHttpClient.layerUndiciOptions(
          socketPath === null ? undefined : { connect: { socketPath } },
        ),
      ),
    );
  },
);

interface MemorySandbox {
  readonly name: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly createdAt: DateTime.Utc;
  running: boolean;
  bootedGeneration: number | null;
  /** The stand-in's `contract-marker` file on the sandbox's disk. */
  marker: string | null;
}

/**
 * Answers the fake's calls from an in-memory backend until the scope closes. The driver ref is
 * the name; create and start "boot" by posting a stand-in hello to `bootstrap.serverUrl`.
 */
export const answerFromMemory: (
  calls: Queue.Dequeue<FakeComputeCall>,
) => Effect.Effect<never, never, Scope.Scope> = Effect.fn("FakeComputeDriver.answerFromMemory")(
  function* (calls: Queue.Dequeue<FakeComputeCall>) {
    const sandboxes = new Map<string, MemorySandbox>();
    const failure = (
      operation: ComputeDriverError["operation"],
      reason: ComputeDriverError["reason"],
    ) =>
      new ComputeDriverError({
        driverId: ComputeDriverId.make("fake"),
        operation,
        reason,
        retryable: false,
      });

    const boot = Effect.fn("FakeComputeDriver.boot")(function* (
      sandbox: MemorySandbox,
      bootstrap: SandboxBootstrap,
    ) {
      const hello = {
        sandboxId: bootstrap.sandboxId,
        generation: bootstrap.generation,
        enroll: Redacted.value(bootstrap.enrollmentSecret),
        marker: sandbox.marker,
      };
      sandbox.running = true;
      sandbox.bootedGeneration = bootstrap.generation;
      sandbox.marker = `g${bootstrap.generation}`;
      yield* postStandInHello(bootstrap.serverUrl, hello).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Fake sandbox hello failed", cause)),
        Effect.forkScoped,
      );
    });

    const view = (driverRef: string, sandbox: MemorySandbox): BackendSandbox => ({
      driverRef,
      name: sandbox.name,
      sandboxId: parseSandboxTags(sandbox.tags)?.sandboxId ?? null,
      status: sandbox.running ? "running" : "stopped",
      createdAt: sandbox.createdAt,
    });

    const answer = Effect.fn("FakeComputeDriver.answer")(function* (call: FakeComputeCall) {
      switch (call._tag) {
        case "create": {
          const { input } = call;
          const existing = sandboxes.get(input.name);
          if (existing === undefined) {
            const sandbox: MemorySandbox = {
              name: input.name,
              tags: input.tags,
              createdAt: yield* DateTime.now,
              running: false,
              bootedGeneration: null,
              marker: null,
            };
            sandboxes.set(input.name, sandbox);
            yield* boot(sandbox, input.bootstrap);
          } else if (
            existing.tags["pair.sandbox"] !== input.tags["pair.sandbox"] ||
            existing.tags["pair.generation"] !== input.tags["pair.generation"]
          ) {
            return yield* Deferred.fail(call.reply, failure("create", "conflict"));
          } else if (!existing.running) {
            yield* boot(existing, input.bootstrap);
          }
          return yield* Deferred.succeed(call.reply, { driverRef: input.name, baseImage: null });
        }
        case "start": {
          const sandbox = sandboxes.get(call.driverRef);
          if (sandbox === undefined) {
            return yield* Deferred.fail(call.reply, failure("start", "not-found"));
          }
          // A replayed start must not restart a runner of the same generation.
          if (!sandbox.running || sandbox.bootedGeneration !== call.bootstrap.generation) {
            yield* boot(sandbox, call.bootstrap);
          }
          return yield* Deferred.succeed(call.reply, undefined);
        }
        case "stop": {
          const sandbox = sandboxes.get(call.ref);
          if (sandbox === undefined) {
            return yield* Deferred.fail(call.reply, failure("stop", "not-found"));
          }
          sandbox.running = false;
          return yield* Deferred.succeed(call.reply, undefined);
        }
        case "destroy":
          sandboxes.delete(call.ref);
          return yield* Deferred.succeed(call.reply, undefined);
        case "deleteImage":
          return yield* Deferred.succeed(call.reply, undefined);
        case "snapshot":
          return sandboxes.has(call.driverRef)
            ? yield* Deferred.succeed(call.reply, {
                imageRef: `fake-image:${call.name}`,
                sizeBytes: null,
              })
            : yield* Deferred.fail(call.reply, failure("snapshot", "not-found"));
        // Memory keeps every write, like a whole-disk snapshot.
        case "readImageFile":
          return yield* Deferred.succeed(call.reply, "whole-disk");
        case "status": {
          const sandbox = sandboxes.get(call.driverRef);
          const missing: BackendSandbox = {
            driverRef: call.driverRef,
            name: call.driverRef,
            sandboxId: null,
            status: "missing",
            createdAt: yield* DateTime.now,
          };
          return yield* Deferred.succeed(
            call.reply,
            sandbox === undefined ? missing : view(call.driverRef, sandbox),
          );
        }
        case "list": {
          const matches = Array.from(sandboxes.entries())
            .filter(([, sandbox]) =>
              Object.entries(call.tags).every(([key, value]) => sandbox.tags[key] === value),
            )
            .map(([driverRef, sandbox]) => view(driverRef, sandbox));
          return yield* Deferred.succeed(call.reply, matches);
        }
        case "health":
          return yield* Deferred.succeed(call.reply, {
            isolation: "container",
            privateNetworkBlock: {
              applied: false,
              reason: "The in-memory backend has no network.",
            },
            baseImage: null,
          });
      }
    });

    return yield* Queue.take(calls).pipe(Effect.flatMap(answer), Effect.forever);
  },
);
