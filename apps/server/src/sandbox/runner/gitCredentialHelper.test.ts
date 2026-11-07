import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";

import {
  formatGitCredentialAnswer,
  parseGitCredentialInput,
  parseRemoteRepository,
} from "./gitCredentialHelper.ts";

describe("git credential helper", () => {
  it.each([
    [
      "protocol, host and path up to the blank line",
      "protocol=https\nhost=github.com\npath=org/repo.git\n\nhost=ignored\n",
      { protocol: "https", host: "github.com", path: "org/repo.git" },
    ],
    [
      "no path without credential.useHttpPath; unknown keys dropped",
      "capability[]=authtype\nprotocol=https\nhost=github.com\n",
      { protocol: "https", host: "github.com" },
    ],
    ["values keep their own '='", "protocol=https\nhost=a=b\n", { protocol: "https", host: "a=b" }],
  ])("parses %s", (_name, input, expected) => {
    expect(parseGitCredentialInput(input)).toEqual(expected);
  });

  it.each([
    [
      "a refusal as quit=1, so git neither prompts nor asks another helper",
      {
        _tag: "Refused",
        code: "github-credential-missing",
        message: "Connect GitHub to push: Settings → Team, your row.",
      } as const,
      { stdout: "quit=1\n", stderr: "Connect GitHub to push: Settings → Team, your row.\n" },
    ],
    [
      "username, password and the expiry in epoch seconds",
      {
        _tag: "Credential",
        username: "x-access-token",
        password: Redacted.make("ghs_secret"),
        expiresAt: DateTime.makeUnsafe("2026-11-07T13:00:00.500Z"),
      } as const,
      {
        stdout: "username=x-access-token\npassword=ghs_secret\npassword_expiry_utc=1794056400\n",
        stderr: "",
      },
    ],
    [
      "no expiry for a member's own token",
      {
        _tag: "Credential",
        username: "x-access-token",
        password: Redacted.make("ghu_member"),
        expiresAt: null,
      } as const,
      { stdout: "username=x-access-token\npassword=ghu_member\n", stderr: "" },
    ],
  ])("prints %s", (_name, answer, expected) => {
    expect(formatGitCredentialAnswer(answer)).toEqual(expected);
  });

  it.each([
    ["https://github.com/Org/Repo.git\n", { host: "github.com", path: "Org/Repo.git" }],
    ["https://x-access-token@github.com/org/repo", { host: "github.com", path: "org/repo.git" }],
    ["git@github.com:org/repo.git", { host: "github.com", path: "org/repo.git" }],
    ["ssh://git@GitHub.com/org/repo.git", { host: "github.com", path: "org/repo.git" }],
    ["https://gitlab.com/group/sub/repo.git", null],
    ["/srv/repo.git", null],
  ])("reads the gh shim's repository from %s", (remoteUrl, expected) => {
    expect(parseRemoteRepository(remoteUrl)).toEqual(expected);
  });
});
