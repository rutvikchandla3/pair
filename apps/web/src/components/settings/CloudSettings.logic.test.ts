import {
  ComputeDriverId,
  type ComputeDriverKind,
  type GceSandboxDriver,
  type SandboxDriverInstance,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  dockerDriverFormError,
  type GceDriverForm,
  gceDriverFormError,
  gceDriverFromForm,
  nextDriverId,
} from "./CloudSettings.logic";

describe("dockerDriverFormError", () => {
  it.each<{
    readonly name: string;
    readonly dockerHost?: string;
    readonly runnerUrl?: string;
    readonly runningCap?: string;
    readonly refused: boolean;
  }>([
    { name: "the local socket", dockerHost: "", runnerUrl: "", refused: false },
    {
      name: "a local unix socket",
      dockerHost: "unix:///run/docker.sock",
      runnerUrl: "",
      refused: false,
    },
    {
      name: "a remote host without a runner URL",
      dockerHost: "tcp://10.0.0.5:2376",
      runnerUrl: "",
      refused: true,
    },
    {
      name: "a remote host with a runner URL",
      dockerHost: "tcp://10.0.0.5:2376",
      runnerUrl: "https://team.example:3773",
      refused: false,
    },
    {
      name: "ssh, which the driver cannot dial",
      dockerHost: "ssh://box",
      runnerUrl: "https://x",
      refused: true,
    },
    {
      name: "a runner URL that is not http",
      dockerHost: "tcp://10.0.0.5:2376",
      runnerUrl: "ws://team.example",
      refused: true,
    },
    { name: "the default cap", runningCap: "", refused: false },
    { name: "a cap of 30", runningCap: "30", refused: false },
    { name: "a cap of 0", runningCap: "0", refused: true },
    { name: "a fractional cap", runningCap: "2.5", refused: true },
  ])("$name", ({ dockerHost = "", runnerUrl = "", runningCap = "", refused }) => {
    expect(
      dockerDriverFormError({ label: "Docker", dockerHost, runnerUrl, runningCap }) !== null,
    ).toBe(refused);
  });
});

describe("gceDriverFormError", () => {
  const blank: GceDriverForm = {
    label: "Google Cloud",
    project: "",
    zones: "",
    subnetwork: "",
    runnerUrl: "",
    size: "default",
    runningCap: "",
  };
  it.each<{
    readonly name: string;
    readonly form: Partial<GceDriverForm>;
    readonly refused: boolean;
  }>([
    { name: "the server VM's own project and zone", form: {}, refused: false },
    {
      name: "a project, zones in order and a subnetwork",
      form: {
        project: "vm-provider",
        zones: "asia-south1-a, asia-south1-b",
        subnetwork: "regions/asia-south1/subnetworks/pair-machines",
      },
      refused: false,
    },
    {
      name: "a subnetwork's self link",
      form: {
        subnetwork:
          "https://www.googleapis.com/compute/v1/projects/p/regions/asia-south1/subnetworks/m",
      },
      refused: false,
    },
    { name: "no name", form: { label: " " }, refused: true },
    { name: "a project ID too short", form: { project: "abc" }, refused: true },
    { name: "a project name, not its ID", form: { project: "My Project" }, refused: true },
    { name: "a region instead of a zone", form: { zones: "asia-south1" }, refused: true },
    { name: "one bad zone among good ones", form: { zones: "asia-south1-a, Asia" }, refused: true },
    { name: "a bare subnetwork name", form: { subnetwork: "pair-machines" }, refused: true },
    { name: "a runner URL that is not http", form: { runnerUrl: "ws://10.0.0.2" }, refused: true },
    { name: "a cap of 0", form: { runningCap: "0" }, refused: true },
  ])("$name", ({ form, refused }) => {
    expect(gceDriverFormError({ ...blank, ...form }) !== null).toBe(refused);
  });
});

describe("gceDriverFromForm", () => {
  it("keeps the keys the form does not show and drops the ones it cleared", () => {
    const id = ComputeDriverId.make("gce");
    const initial: GceSandboxDriver = {
      kind: "gce",
      id,
      label: "Google Cloud",
      project: "vm-provider",
      zones: ["asia-south1-a"],
      runnerUrl: "http://10.0.0.2:3774",
      kmsKey: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
      networkTags: ["pair-machine"],
      machineTypes: { large: "e2-standard-16" },
      diskGb: 100,
    };
    expect(
      gceDriverFromForm(initial, id, {
        label: "Mumbai",
        project: "",
        zones: "asia-south1-b, asia-south1-c",
        subnetwork: "",
        runnerUrl: "",
        size: "large",
        runningCap: "8",
      }),
    ).toEqual({
      kind: "gce",
      id,
      label: "Mumbai",
      zones: ["asia-south1-b", "asia-south1-c"],
      size: "large",
      runningCap: 8,
      kmsKey: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
      networkTags: ["pair-machine"],
      machineTypes: { large: "e2-standard-16" },
      diskGb: 100,
    });
  });
});

describe("nextDriverId", () => {
  const docker = { kind: "docker", id: ComputeDriverId.make("docker"), label: "D" } as const;
  const gce = { kind: "gce", id: ComputeDriverId.make("gce"), label: "G" } as const;
  it.each<{
    readonly name: string;
    readonly drivers: ReadonlyArray<SandboxDriverInstance>;
    readonly kind: ComputeDriverKind;
    readonly expected: string;
  }>([
    { name: "the first Docker driver", drivers: [], kind: "docker", expected: "docker" },
    {
      name: "a second Docker driver",
      drivers: [docker, gce],
      kind: "docker",
      expected: "docker-2",
    },
    { name: "the first gce driver beside Docker", drivers: [docker], kind: "gce", expected: "gce" },
    { name: "a second gce driver", drivers: [docker, gce], kind: "gce", expected: "gce-2" },
  ])("$name", ({ drivers, kind, expected }) => {
    expect(nextDriverId(drivers, kind)).toBe(expected);
  });
});
