import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe } from "@effect/vitest";
import {
  ComputeDriverId,
  type EnvironmentId,
  type GceSandboxDriver,
  SandboxId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";
import * as Path from "effect/Path";

import { computeDriverContract, type StandInRunnerServer } from "./computeDriverContract.ts";
import { postStandInHello } from "./ComputeDriverTesting.ts";
import { makeGceApi } from "./GceApi.ts";
import * as GceApiFake from "./GceApiTesting.ts";
import * as GceComputeDriver from "./GceComputeDriver.ts";
import { makeGceMetadata } from "./GceMetadata.ts";
import { SandboxProvisionTreeUnavailableError } from "../image/SandboxProvisionTree.ts";

const config: GceSandboxDriver = {
  kind: "gce",
  id: ComputeDriverId.make("gce-contract"),
  label: "Contract Compute Engine",
};

const ZONES = ["fake-zone-a", "fake-zone-b"];

// Both name their base image, so nothing builds one.
const noProvisionTree = Effect.fail(
  new SandboxProvisionTreeUnavailableError({ reason: "not-bundled" }),
);

/** The `NAME='value'` lines `vmBootstrapText` writes. */
const parseBootstrap = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((line) => /^([A-Z_]+)='(.*)'$/.exec(line))
      .filter((match) => match !== null)
      .map((match) => [match[1]!, match[2]!.replaceAll(`'\\''`, "'")]),
  );

/** What the stand-in runner does at boot, against the instance's metadata and disk. */
const standInBoot = (boot: GceApiFake.FakeGceBoot) => {
  const value = (key: string) => boot.metadata.find((item) => item.key === key)?.value ?? "";
  const bootstrap = parseBootstrap(value("pair-bootstrap"));
  const generation = Number(value("pair-generation"));
  const hello = {
    sandboxId: SandboxId.make(bootstrap.PAIR_SANDBOX_ID ?? ""),
    generation,
    enroll: bootstrap.PAIR_RUNNER_ENROLL ?? "",
    marker: boot.disk.marker,
  };
  boot.disk.marker = `g${generation}`;
  return postStandInHello(bootstrap.PAIR_RUNNER_URL ?? "", hello).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Fake machine hello failed", cause)),
  );
};

// The installs of one case share a project, as they would in a real one.
const fakes = new WeakMap<StandInRunnerServer, GceApiFake.GceApiFake>();

const makeFakeDriver = (installId: EnvironmentId, runner: StandInRunnerServer) =>
  Effect.gen(function* () {
    let fake = fakes.get(runner);
    if (fake === undefined) {
      fake = yield* GceApiFake.make({ onBoot: standInBoot });
      fakes.set(runner, fake);
    }
    const family = `pair-${installId.slice(0, 8)}-base`;
    yield* fake.addImage({ name: `${family}-contract`, family });
    return yield* GceComputeDriver.makeWithApi(
      { ...config, baseImage: `${family}-contract` },
      installId,
      fake.api,
      {
        cloudOnly: true,
        project: Effect.succeed(fake.project),
        zones: Effect.succeed(ZONES),
        provisionTree: noProvisionTree,
      },
    );
  });

computeDriverContract("GceComputeDriver", makeFakeDriver, {
  // A VM cannot dial the test's socket, and the driver refuses `unix:`.
  listen: { host: "127.0.0.1", port: 0 },
});

/**
 * Against a real project, from a Compute Engine VM whose service account may manage instances
 * there. `T3_TEST_RUNNER_URL` is this host's address on a port the new VMs reach.
 */
describe.runIf(process.env.T3_TEST_GCE === "1")("GceComputeDriver on Compute Engine", () => {
  const runnerUrl = new URL(process.env.T3_TEST_RUNNER_URL ?? "http://127.0.0.1:0");
  const realConfig: GceSandboxDriver = {
    ...config,
    zones: [process.env.T3_TEST_GCE_ZONE ?? ""],
    ...(process.env.T3_TEST_GCE_SUBNETWORK === undefined
      ? {}
      : { subnetwork: process.env.T3_TEST_GCE_SUBNETWORK }),
    baseImage: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
  };

  computeDriverContract(
    "GceComputeDriver",
    (installId) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const startupScript = yield* fs.readFileString(
          path.join(import.meta.dirname, "testdata/stand-in-runner/gce-startup.sh"),
        );
        const client = yield* HttpClient.HttpClient;
        const metadata = yield* makeGceMetadata(client);
        return yield* GceComputeDriver.makeWithApi(
          realConfig,
          installId,
          makeGceApi(client, metadata, metadata.projectId),
          {
            cloudOnly: true,
            project: metadata.projectId,
            zones: Effect.succeed(realConfig.zones ?? []),
            guest: { startupScript },
            provisionTree: noProvisionTree,
          },
        );
      }).pipe(Effect.provide([NodeServices.layer, NodeHttpClient.layerUndici]), Effect.orDie),
    {
      listen: { host: "0.0.0.0", port: Number(runnerUrl.port) },
      url: runnerUrl.origin,
    },
  );
});
