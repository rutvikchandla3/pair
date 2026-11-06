import { describe, expect, it } from "vite-plus/test";

import { restorePemLineBreaks } from "./GitHubAppKeySettings.logic";

describe("restorePemLineBreaks", () => {
  it.each([
    [
      "-----BEGIN RSA PRIVATE KEY-----MIIEow+/AB==-----END RSA PRIVATE KEY-----",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow+/AB==\n-----END RSA PRIVATE KEY-----",
    ],
    [
      "  -----BEGIN RSA PRIVATE KEY-----\nMIIE\now==\n-----END RSA PRIVATE KEY-----\n",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\now==\n-----END RSA PRIVATE KEY-----",
    ],
    ["not a key ", "not a key"],
  ])("restores %j", (pasted, expected) => {
    expect(restorePemLineBreaks(pasted)).toBe(expected);
  });
});
