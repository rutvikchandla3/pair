import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";

import { formatGitCredentialOutput, parseGitCredentialInput } from "./gitCredentialHelper.ts";

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
    ["nothing for no credential", null, ""],
    [
      "username, password and the expiry in epoch seconds",
      {
        username: "x-access-token",
        password: Redacted.make("ghs_secret"),
        expiresAt: DateTime.makeUnsafe("2026-11-07T13:00:00.500Z"),
      },
      "username=x-access-token\npassword=ghs_secret\npassword_expiry_utc=1794056400\n",
    ],
  ])("prints %s", (_name, credential, expected) => {
    expect(formatGitCredentialOutput({ version: 1, credential })).toBe(expected);
  });
});
