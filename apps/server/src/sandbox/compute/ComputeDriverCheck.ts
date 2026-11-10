import {
  SANDBOX_VM_DRIVER_KINDS,
  SandboxDriverCheckError,
  type SandboxDriverCheckInput,
  type SandboxDriverCheckResult,
  type SandboxDriverCheckStep,
  SandboxId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as ChildProcess from "effect/process/ChildProcess";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { SANDBOX_ROOT } from "../../workspaceHost/WorkspaceHost.ts";
import { WorkspaceHosts } from "../../workspaceHost/WorkspaceHosts.ts";
import { SandboxBootstrapSource } from "../lifecycle/SandboxBootstrapSource.ts";
import { RunnerHub } from "../runnerHub/RunnerHub.ts";
import { sandboxBackendName, sandboxTags } from "./ComputeDriver.ts";
import { ComputeDriverRegistry } from "./ComputeDriverRegistry.ts";

const CHECK_BOUND = "3 minutes";
const DISCARD_BOUND = "60 seconds";
const GENERATION = 1;

type Step = SandboxDriverCheckResult["steps"][number];

/** What the Test runs in the machine to reach the network. Only tests replace it. */
export const MachineNetworkProbe = Context.Reference<ChildProcess.Command>(
  "t3/sandbox/compute/ComputeDriverCheck/MachineNetworkProbe",
  {
    defaultValue: () =>
      ChildProcess.make(
        "curl",
        ["-sS", "-o", "/dev/null", "--max-time", "20", "https://github.com"],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      ),
  },
);

/** What the Test runs in the machine to see that its agent user can use `sudo`. Only tests replace it. */
export const MachineSudoProbe = Context.Reference<ChildProcess.Command>(
  "t3/sandbox/compute/ComputeDriverCheck/MachineSudoProbe",
  {
    defaultValue: () =>
      ChildProcess.make("sudo", ["-n", "true"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
  },
);

const SUDO_FAILURE =
  "Machines can't use sudo, which agents and setup scripts need. Under gVisor, add --allow-suid to its arguments (see Set up Docker in the Pair Cloud guide).";

const networkFailure = (curlExit: number) => {
  switch (curlExit) {
    case 6:
      return "The machine can't look up github.com. Allow outbound DNS (port 53) from this host; under gVisor, machines use 1.1.1.1 and 8.8.8.8.";
    case 7:
      return "The machine can't connect to github.com. Allow outbound HTTPS (port 443) from this host.";
    case 28:
      return "The machine timed out reaching github.com. Allow outbound DNS (port 53) and HTTPS (port 443) from this host.";
    default:
      return `The machine couldn't reach github.com (curl exit ${curlExit}).`;
  }
};

/**
 * Settings → Cloud's Test: boots a machine with no thread, so nothing is projected or counted
 * against caps (P16). Its runner's facts name no sandbox record, so `RunnerHubFacts` drops them.
 * A machine left by a crash carries the install tags and no sandbox record, so past the
 * reconciler's grace it turns restore mode on (SandboxReconciler `unrecorded`).
 */
export class ComputeDriverCheck extends Context.Service<
  ComputeDriverCheck,
  {
    readonly check: (
      input: SandboxDriverCheckInput,
    ) => Effect.Effect<SandboxDriverCheckResult, SandboxDriverCheckError>;
  }
>()("t3/sandbox/compute/ComputeDriverCheck") {}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const make = Effect.gen(function* () {
  const registry = yield* ComputeDriverRegistry;
  const settings = yield* ServerSettingsService;
  const bootstraps = yield* SandboxBootstrapSource;
  const hub = yield* RunnerHub;
  const hosts = yield* WorkspaceHosts;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const random = yield* SecureRandom.SecureRandom;

  const check = Effect.fn("ComputeDriverCheck.check")(function* ({
    driverId,
  }: SandboxDriverCheckInput) {
    const unavailable = (cause: unknown) =>
      new SandboxDriverCheckError({ driverId, reason: "unavailable", cause });
    const config = (yield* settings.getSettings.pipe(
      Effect.mapError(unavailable),
    )).sandbox?.drivers.find((entry) => entry.id === driverId);
    if (config === undefined) {
      return yield* new SandboxDriverCheckError({ driverId, reason: "not-configured" });
    }
    const driver = yield* registry.get(driverId).pipe(
      Effect.catchTags({
        ComputeDriverNotConfiguredError: () =>
          Effect.fail(new SandboxDriverCheckError({ driverId, reason: "not-configured" })),
        ServerSettingsError: (cause) => Effect.fail(unavailable(cause)),
      }),
    );
    const installId = yield* environment.getEnvironmentId;
    const sandboxId = SandboxId.make(`sbx_${toHex(yield* random.randomBytes(10))}`);
    const name = sandboxBackendName(installId, sandboxId, GENERATION);
    yield* Effect.annotateCurrentSpan({ driverId, sandboxId });

    const steps: Array<Step> = [];
    let current: { readonly step: SandboxDriverCheckStep; readonly startedAt: number } | undefined;
    let createAttempted = false;
    let driverRef: string | undefined;

    const record = Effect.fnUntraced(function* (
      step: SandboxDriverCheckStep,
      startedAt: number,
      ok: boolean,
      message: string | undefined,
    ) {
      const durationMs = Math.max(0, (yield* Clock.currentTimeMillis) - startedAt);
      steps.push({ step, ok, durationMs, ...(message === undefined ? {} : { message }) });
    });

    /** Times one step; a failure records its message and ends the check with `None`. */
    const run = Effect.fnUntraced(function* <A, E, R>(
      step: SandboxDriverCheckStep,
      effect: Effect.Effect<A, E, R>,
      messages: {
        readonly ok?: (value: A) => string | undefined;
        readonly failed: (error: E) => string;
      },
    ) {
      const startedAt = yield* Clock.currentTimeMillis;
      current = { step, startedAt };
      const result = yield* Effect.result(effect);
      current = undefined;
      if (result._tag === "Failure") {
        yield* record(step, startedAt, false, messages.failed(result.failure));
        return Option.none<A>();
      }
      yield* record(step, startedAt, true, messages.ok?.(result.success));
      return Option.some(result.success);
    });

    const image = driver.health.pipe(
      Effect.flatMap(({ baseImage }) =>
        baseImage === null || "digest" in baseImage
          ? Effect.succeed(baseImage)
          : Effect.fail(
              "pulling" in baseImage
                ? SANDBOX_VM_DRIVER_KINDS.has(driver.kind)
                  ? "The base image is still being built. Test again in a few minutes."
                  : "The base image is still downloading. Test again in a few minutes."
                : `Machine image not found. ${baseImage.hint}`,
            ),
      ),
    );

    const steady = Effect.gen(function* () {
      const resolved = yield* run("image", image, {
        ok: (info) => info?.ref,
        failed: (error) => (typeof error === "string" ? error : error.message),
      });
      if (Option.isNone(resolved)) return;
      createAttempted = true;
      const created = yield* run(
        "create",
        bootstraps.forGeneration({ sandboxId, generation: GENERATION, driverId }).pipe(
          Effect.flatMap((bootstrap) =>
            driver.create({
              name,
              sandboxId,
              generation: GENERATION,
              image: { type: "base" },
              size: config.size ?? "default",
              tags: sandboxTags({ installId, sandboxId, generation: GENERATION, driverId }),
              bootstrap,
            }),
          ),
        ),
        { failed: (error) => error.message },
      );
      if (Option.isNone(created)) return;
      driverRef = created.value.driverRef;
      const runner = yield* run("runner", hub.connection(sandboxId), {
        failed: () => "The machine's runner did not connect to this server.",
      });
      if (Option.isNone(runner)) return;
      // The sudo and network probes report inside `git`; see `SandboxDriverCheckStep`.
      const machine = Effect.gen(function* () {
        const gitFailed = "git --version did not run in the machine.";
        const host = yield* hosts
          .forPath(`${SANDBOX_ROOT}/${sandboxId}`)
          .pipe(Effect.mapError(() => gitFailed));
        const version = yield* host.spawner
          .string(ChildProcess.make("git", ["--version"], { stdin: "ignore", stderr: "ignore" }))
          .pipe(Effect.mapError(() => gitFailed));
        const sudoExit = yield* host.spawner
          .exitCode(yield* MachineSudoProbe)
          .pipe(Effect.mapError(() => SUDO_FAILURE));
        if (sudoExit !== 0) return yield* Effect.fail(SUDO_FAILURE);
        const curlExit = yield* host.spawner
          .exitCode(yield* MachineNetworkProbe)
          .pipe(Effect.mapError(() => "curl did not run in the machine."));
        if (curlExit !== 0) return yield* Effect.fail(networkFailure(curlExit));
        return version.trim();
      });
      yield* run("git", machine, { ok: (version) => version, failed: (message) => message });
    });

    // Destroying a missing machine succeeds, so a create that never answered is removed by name.
    const discard = driver.destroy(driverRef ?? name).pipe(
      Effect.retry({
        times: 2,
        schedule: Schedule.spaced("2 seconds"),
        while: (error) => error.retryable,
      }),
      Effect.ensuring(hub.revoke(sandboxId).pipe(Effect.ignore({ log: true }))),
    );

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const outcome = yield* restore(steady.pipe(Effect.timeoutOption(CHECK_BOUND))).pipe(
          Effect.exit,
        );
        if (outcome._tag === "Success" && Option.isNone(outcome.value) && current !== undefined) {
          yield* record(current.step, current.startedAt, false, "Timed out after 3 minutes.");
        }
        if (createAttempted) {
          // Its own fiber, so its bound still interrupts it while this one is uninterruptible.
          const discarded = yield* run("discard", discard, {
            failed: (error) => error.message,
          }).pipe(Effect.timeoutOption(DISCARD_BOUND), Effect.interruptible, Effect.forkDetach);
          const finished = yield* Fiber.join(discarded);
          if (Option.isNone(finished) && current !== undefined) {
            yield* record("discard", current.startedAt, false, "Timed out after 60 seconds.");
          }
        }
        if (outcome._tag === "Failure") return yield* Effect.failCause(outcome.cause);
        return { steps } satisfies SandboxDriverCheckResult;
      }),
    );
  });

  return ComputeDriverCheck.of({ check });
});

export const layer = Layer.effect(ComputeDriverCheck, make);
