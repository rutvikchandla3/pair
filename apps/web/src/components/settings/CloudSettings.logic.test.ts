import { describe, expect, it } from "vite-plus/test";

import { dockerDriverFormError } from "./CloudSettings.logic";

describe("dockerDriverFormError", () => {
  it.each([
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
  ])("$name", ({ dockerHost, runnerUrl, refused }) => {
    expect(dockerDriverFormError({ label: "Docker", dockerHost, runnerUrl }) !== null).toBe(
      refused,
    );
  });
});
