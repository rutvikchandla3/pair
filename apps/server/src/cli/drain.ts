import { type ServerDrainStatus, WS_METHODS } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  DurationFromString,
  resolveCliAuthConfig,
} from "./config.ts";
import { connectLiveServer } from "./liveServer.ts";

export class CliDrainError extends Schema.TaggedError<CliDrainError>()("CliDrainError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const turns = (count: number) => `${count} ${count === 1 ? "turn" : "turns"}`;

const timeoutFlag = Flag.String("timeout").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("How long running turns get to finish, for example `15m`."),
  Flag.withDefault(Duration.minutes(15)),
);

const cancelFlag = Flag.Boolean("cancel").pipe(
  Flag.withDescription("End the drain, which starts the turns and machines it held."),
  Flag.withDefault(false),
);

const runDrain = Effect.fn("cli.drain.run")(function* (
  flags: CliAuthLocationFlags & { readonly timeout: Duration.Duration; readonly cancel: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  yield* Effect.gen(function* () {
    const live = yield* connectLiveServer(config.serverRuntimeStatePath, "t3 drain cli");
    if (Option.isNone(live)) {
      return yield* new CliDrainError({ reason: "No Pair server is running from this directory." });
    }
    const { client, origin } = live.value;
    const failed = (error: { readonly message: string }) =>
      new CliDrainError({ reason: `The server at ${origin} refused: ${error.message}` });

    if (flags.cancel) {
      yield* client[WS_METHODS.serverCancelDrain]({}).pipe(Effect.mapError(failed));
      return yield* Console.log("Drain cancelled. Held turns start now.");
    }

    const last = yield* Ref.make<ServerDrainStatus | null>(null);
    const finished = yield* client[WS_METHODS.serverDrain]({}).pipe(
      Stream.runForEach((status) =>
        Ref.set(last, status).pipe(
          Effect.andThen(Console.log(`Draining: ${turns(status.runningTurns)} running`)),
        ),
      ),
      Effect.mapError(failed),
      Effect.timeoutOption(flags.timeout),
    );
    const running = (yield* Ref.get(last))?.runningTurns ?? 0;
    if (Option.isNone(finished)) {
      return yield* Console.log(
        `${turns(running)} still running; they continue after the restart.`,
      );
    }
    // The stream ends early only when someone cancels the drain.
    if (running > 0) return yield* new CliDrainError({ reason: "The drain was cancelled." });
    yield* Console.log("No turns running. New turns wait until the server restarts.");
  }).pipe(
    Effect.scoped,
    Effect.provide(EnvironmentAuth.layerRuntime.pipe(Layer.provide(ServerConfig.layer(config)))),
  );
});

export const drainCommand = Command.make("drain", {
  ...authLocationFlags,
  timeout: timeoutFlag,
  cancel: cancelFlag,
}).pipe(
  Command.withDescription(
    "Before an upgrade, hold new Pair Cloud turns and machine starts, and wait for running turns to finish.",
  ),
  Command.withHandler((flags) => runDrain(flags)),
);
