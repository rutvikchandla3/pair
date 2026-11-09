import { describe, expect, it } from "vite-plus/test";

import { dockerDriverFormError } from "./CloudSettings.logic";

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
