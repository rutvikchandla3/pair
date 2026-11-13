import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { TeamClaudeKeySetInput } from "./teamClaudeKey.ts";

const secret = "sk-ant-fixture-not-a-key";
const decode = Schema.decodeUnknownExit(Schema.toCodecJson(TeamClaudeKeySetInput));

describe("Team Claude key contracts", () => {
  it("decodes the key as Redacted, which never prints it", () => {
    const exit = decode({ value: secret });
    expect(exit._tag).toBe("Success");
    const input = exit._tag === "Success" ? exit.value : null;
    expect(Redacted.value(input!.value)).toBe(secret);
    expect(`${JSON.stringify(input)} ${String(input!.value)}`).not.toContain("fixture");
  });

  it.each([{ value: [secret] }, { value: { key: secret } }, { key: secret }])(
    "fails without echoing the input",
    (input) => {
      const exit = decode(input);
      expect(exit._tag).toBe("Failure");
      expect(String(exit)).not.toContain("fixture");
    },
  );
});
