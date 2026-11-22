import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe } from "@effect/vitest";
import {
  type Agent37SandboxDriver,
  ComputeDriverId,
  type EnvironmentId,
  SandboxId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeAgent37Api } from "./Agent37Api.ts";
import * as Agent37ApiFake from "./Agent37ApiTesting.ts";
import * as Agent37ComputeDriver from "./Agent37ComputeDriver.ts";
import { computeDriverContract, type StandInRunnerServer } from "./computeDriverContract.ts";
import { postStandInHello } from "./ComputeDriverTesting.ts";
import { nodeHttpClient } from "./vmHelpers.ts";

const config: Agent37SandboxDriver = {
  kind: "agent37",
  id: ComputeDriverId.make("agent37-contract"),
  label: "Contract Agent37",
  apiKey: "sk_live_contract",
  // The driver checks its own URL; each bootstrap carries the stand-in server's.
  runnerUrl: "https://pair.example.test",
};

/** The `NAME='value'` lines `vmBootstrapText` writes. */
const parseBootstrap = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((line) => /^([A-Z_]+)='(.*)'$/.exec(line))
      .filter((match) => match !== null)
      .map((match) => [match[1]!, match[2]!.replaceAll(`'\\''`, "'")]),
  );

/** What the boot script and the stand-in runner do with a delivered bootstrap. */
const standInBoot = (boot: Agent37ApiFake.FakeAgent37Boot) => {
  const bootstrap = parseBootstrap(boot.bootstrap);
  const hello = {
    sandboxId: SandboxId.make(bootstrap.PAIR_SANDBOX_ID ?? ""),
    generation: boot.generation,
    enroll: bootstrap.PAIR_RUNNER_ENROLL ?? "",
    marker: boot.instance.disk.marker,
  };
  boot.instance.disk.marker = `g${boot.generation}`;
  return postStandInHello(bootstrap.PAIR_RUNNER_URL ?? "", hello).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Fake machine hello failed", cause)),
  );
};

// The installs of one case share a workspace, as they would in a real one.
const fakes = new WeakMap<StandInRunnerServer, Agent37ApiFake.Agent37ApiFake>();

const makeFakeDriver = (installId: EnvironmentId, runner: StandInRunnerServer) =>
  Effect.gen(function* () {
    let fake = fakes.get(runner);
    if (fake === undefined) {
      fake = yield* Agent37ApiFake.make({ onBoot: standInBoot });
      fakes.set(runner, fake);
    }
    return yield* Agent37ComputeDriver.makeWithApi(config, installId, fake.api(), {
      cloudOnly: true,
      version: "1.2.3",
    });
  });

computeDriverContract("Agent37ComputeDriver", makeFakeDriver, {
  // An Agent37 machine cannot dial the test's socket, and the driver refuses `unix:`.
  listen: { host: "127.0.0.1", port: 0 },
});

/**
 * Against a real Agent37 workspace. `T3_TEST_AGENT37_RUNNER_URL` is a public https address its
 * machines reach, proxied to this host's `T3_TEST_AGENT37_LISTEN_PORT` (default: the URL's own
 * port). Machines boot stock `agent37-base`, so nothing is imported.
 */
describe.runIf(process.env.T3_TEST_AGENT37 === "1")("Agent37ComputeDriver on Agent37", () => {
  const runnerUrl = new URL(process.env.T3_TEST_AGENT37_RUNNER_URL ?? "https://127.0.0.1:0");
  const liveConfig: Agent37SandboxDriver = {
    ...config,
    apiKey: process.env.T3_TEST_AGENT37_API_KEY ?? "",
    runnerUrl: runnerUrl.origin,
  };

  computeDriverContract(
    "Agent37ComputeDriver",
    (installId) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const script = yield* fs.readFileString(
          path.join(import.meta.dirname, "testdata/stand-in-runner/agent37-guest.sh"),
        );
        const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
        // In the case's scope: a provided layer would close its connections once the driver is built.
        const client = yield* nodeHttpClient;
        return yield* Agent37ComputeDriver.makeWithApi(
          liveConfig,
          installId,
          makeAgent37Api(client, { apiKey: () => Effect.succeed(liveConfig.apiKey as string) }),
          {
            cloudOnly: true,
            version: "live",
            guest: {
              template: "agent37-base",
              command: (generation, bootstrapText) =>
                `sh -c ${quote(script)} agent37-guest ${generation} ${quote(bootstrapText)}`,
            },
          },
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
    {
      listen: {
        host: "0.0.0.0",
        port: Number(process.env.T3_TEST_AGENT37_LISTEN_PORT ?? runnerUrl.port),
      },
      url: runnerUrl.origin,
    },
  );
});
