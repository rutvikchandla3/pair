import {
  ComputeDriverId,
  type ComputeDriverKind,
  SandboxDriverInstance,
  type ServerSettings,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { ServerSettingsService } from "../../serverSettings.ts";
import type { ComputeDriver } from "./ComputeDriver.ts";

/** A removed driver instance (a project's default may still name it) or a kind with no factory. */
export class ComputeDriverNotConfiguredError extends Schema.TaggedError<ComputeDriverNotConfiguredError>()(
  "ComputeDriverNotConfiguredError",
  { driverId: ComputeDriverId },
) {
  override get message(): string {
    return `Compute driver ${this.driverId} is not configured.`;
  }
}

export class ComputeDriverRegistry extends Context.Service<
  ComputeDriverRegistry,
  {
    readonly get: (
      driverId: ComputeDriverId,
    ) => Effect.Effect<
      ComputeDriver["Service"],
      ComputeDriverNotConfiguredError | ServerSettingsError
    >;
    readonly list: Effect.Effect<ReadonlyArray<ComputeDriver["Service"]>, ServerSettingsError>;
  }
>()("t3/sandbox/compute/ComputeDriverRegistry") {}

/** The scope lives until the instance's config changes or it is removed. */
export type ComputeDriverFactory<K extends ComputeDriverKind, R = never> = (
  config: Extract<SandboxDriverInstance, { readonly kind: K }>,
) => Effect.Effect<ComputeDriver["Service"], never, Scope.Scope | R>;

type ComputeDriverFactories<R> = {
  readonly [K in ComputeDriverKind]?: ComputeDriverFactory<K, R>;
};

interface Entry {
  readonly config: SandboxDriverInstance;
  readonly driver: ComputeDriver["Service"];
  readonly scope: Scope.Closeable;
}

const sameConfig = Schema.toEquivalence(SandboxDriverInstance);

// One value per instance rather than a layer each: instances come and go with Settings at runtime.
const make = Effect.fn("ComputeDriverRegistry.make")(function* <R>(
  factories: ComputeDriverFactories<R>,
) {
  const settings = yield* ServerSettingsService;
  const context = yield* Effect.context<R>();
  const registryScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  // Only touched while holding `lock`.
  const entries = new Map<ComputeDriverId, Entry>();

  const build = Effect.fn("ComputeDriverRegistry.build")(function* (config: SandboxDriverInstance) {
    const factory = factories[config.kind];
    if (factory === undefined) return;
    const scope = yield* Scope.fork(registryScope);
    const driver = yield* factory(config).pipe(
      Scope.provide(scope),
      Effect.provideContext(context),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    entries.set(config.id, { config, driver, scope });
  });

  // Settings are read under the lock, so a slow caller can never apply an older snapshot.
  const sync = Effect.fn("ComputeDriverRegistry.sync")(function* () {
    const current: ServerSettings = yield* settings.getSettings;
    const configs = new Map(
      (current.sandbox?.drivers ?? []).map((config) => [config.id, config] as const),
    );
    for (const [driverId, entry] of entries) {
      const config = configs.get(driverId);
      if (config !== undefined && sameConfig(entry.config, config)) continue;
      entries.delete(driverId);
      // In-flight calls on the old driver fail `unavailable` once its resources close.
      yield* Scope.close(entry.scope, Exit.void);
    }
    for (const config of configs.values()) {
      if (!entries.has(config.id)) yield* build(config);
    }
  });

  const get = Effect.fn("ComputeDriverRegistry.get")(function* (driverId: ComputeDriverId) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        yield* sync();
        const entry = entries.get(driverId);
        if (entry === undefined) return yield* new ComputeDriverNotConfiguredError({ driverId });
        return entry.driver;
      }),
    );
  });

  const list = lock
    .withPermits(1)(
      Effect.gen(function* () {
        yield* sync();
        return Array.from(entries.values(), (entry) => entry.driver);
      }),
    )
    .pipe(Effect.withSpan("ComputeDriverRegistry.list"));

  return ComputeDriverRegistry.of({ get, list });
});

/** Needs `ServerSettingsService` plus whatever the factories need. */
export const layer = <R = never>(factories: ComputeDriverFactories<R>) =>
  Layer.effect(ComputeDriverRegistry, make(factories));
