import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe } from "@effect/vitest";
import {
  type BoatSandboxDriver,
  ComputeDriverId,
  type EnvironmentId,
  SandboxId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";
import * as Path from "effect/Path";

import { makeBoatApi } from "./BoatApi.ts";
import * as BoatApiFake from "./BoatApiTesting.ts";
import * as BoatComputeDriver from "./BoatComputeDriver.ts";
import { computeDriverContract, type StandInRunnerServer } from "./computeDriverContract.ts";
import { postStandInHello } from "./ComputeDriverTesting.ts";
import { vmBaseImageNames } from "./VmBaseImage.ts";
import {
  type SandboxProvisionTreeInfo,
  SandboxProvisionTreeUnavailableError,
} from "../image/SandboxProvisionTree.ts";

const config: BoatSandboxDriver = {
  kind: "boat",
  id: ComputeDriverId.make("boat-contract"),
  label: "Contract boat",
  apiKey: "boat_contract_key",
  // B7 checks the driver's URL; each bootstrap carries the stand-in server's own.
  runnerUrl: "https://pair.example.test",
};

/** The fake's base snapshot is named for this tree, so nothing builds one. */
const TREE: SandboxProvisionTreeInfo = {
  tarGzBase64: "",
  sha256: `c0ffee000000${"0".repeat(52)}`,
  pairVersion: "1.2.3",
  baseBuildScript: "#!/bin/bash\n",
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

/** What pair-boat-boot and the stand-in runner do with a delivered bootstrap. */
const standInBoot = (boot: BoatApiFake.FakeBoatBoot) => {
  const bootstrap = parseBootstrap(boot.bootstrap);
  const hello = {
    sandboxId: SandboxId.make(bootstrap.PAIR_SANDBOX_ID ?? ""),
    generation: boot.generation,
    enroll: bootstrap.PAIR_RUNNER_ENROLL ?? "",
    marker: boot.sandbox.disk.marker,
  };
  boot.sandbox.disk.marker = `g${boot.generation}`;
  return postStandInHello(bootstrap.PAIR_RUNNER_URL ?? "", hello).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Fake machine hello failed", cause)),
  );
};

// The installs of one case share an account, as they would in a real one.
const fakes = new WeakMap<StandInRunnerServer, BoatApiFake.BoatApiFake>();

const makeFakeDriver = (installId: EnvironmentId, runner: StandInRunnerServer) =>
  Effect.gen(function* () {
    let fake = fakes.get(runner);
    if (fake === undefined) {
      fake = yield* BoatApiFake.make({ onBoot: standInBoot });
      fakes.set(runner, fake);
    }
    fake.addSavedSnapshot({ name: vmBaseImageNames(installId, TREE.sha256).image });
    return yield* BoatComputeDriver.makeWithApi(config, installId, fake.api(), {
      cloudOnly: true,
      provisionTree: Effect.succeed(TREE),
    });
  });

computeDriverContract("BoatComputeDriver", makeFakeDriver, {
  // A boat machine cannot dial the test's socket, and the driver refuses `unix:`.
  listen: { host: "127.0.0.1", port: 0 },
});

/**
 * Against a real boat account. `T3_TEST_BOAT_RUNNER_URL` is a public https address proxied to
 * this host's port of the same number, which boat machines reach.
 */
describe.runIf(process.env.T3_TEST_BOAT === "1")("BoatComputeDriver on boat.dev", () => {
  const runnerUrl = new URL(process.env.T3_TEST_BOAT_RUNNER_URL ?? "https://127.0.0.1:0");
  const liveConfig: BoatSandboxDriver = {
    ...config,
    apiKey: process.env.T3_TEST_BOAT_API_KEY ?? "",
    runnerUrl: runnerUrl.origin,
  };

  computeDriverContract(
    "BoatComputeDriver",
    (installId) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const script = yield* fs.readFileString(
          path.join(import.meta.dirname, "testdata/stand-in-runner/boat-guest.sh"),
        );
        const quoted = `'${script.replaceAll("'", `'\\''`)}'`;
        const client = yield* HttpClient.HttpClient;
        return yield* BoatComputeDriver.makeWithApi(
          liveConfig,
          installId,
          makeBoatApi(client, { apiKey: () => Effect.succeed(liveConfig.apiKey as string) }),
          {
            cloudOnly: true,
            // Stock boat with no base image, so nothing builds one.
            provisionTree: Effect.fail(
              new SandboxProvisionTreeUnavailableError({ reason: "not-bundled" }),
            ),
            guest: { command: (generation) => `sh -c ${quoted} boat-guest ${generation}` },
          },
        );
      }).pipe(Effect.provide([NodeServices.layer, NodeHttpClient.layerUndici]), Effect.orDie),
    {
      listen: { host: "0.0.0.0", port: Number(runnerUrl.port) },
      url: runnerUrl.origin,
    },
  );
});
