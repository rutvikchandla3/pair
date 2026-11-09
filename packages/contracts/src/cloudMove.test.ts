import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { CloudMoveFailure, CloudStagingKey } from "./cloudMove.ts";

const isKey = Schema.is(CloudStagingKey);
const decodeFailure = Schema.decodeUnknownSync(CloudMoveFailure);
const hex = "0123456789abcdef0123456789abcdef";

describe("cloud move contracts", () => {
  it.each([
    { name: "mv_ and 32 lowercase hex", value: `mv_${hex}`, valid: true },
    { name: "uppercase hex", value: `mv_${hex.toUpperCase()}`, valid: false },
    { name: "31 digits", value: `mv_${hex.slice(1)}`, valid: false },
    { name: "33 digits", value: `mv_${hex}0`, valid: false },
    { name: "a parent segment", value: "mv_../x", valid: false },
    { name: "a slash", value: `mv_${hex.slice(0, 16)}/${hex.slice(17)}`, valid: false },
    { name: "an inner space", value: `mv_${hex.slice(0, 16)} ${hex.slice(17)}`, valid: false },
  ])("CloudStagingKey takes $name: $valid", ({ value, valid }) => {
    expect(isKey(value)).toBe(valid);
  });

  it.each([
    { reason: "missing-prerequisite", decoded: "missing-prerequisite" },
    { reason: "from-a-newer-server", decoded: null },
  ])("CloudMoveFailure reads reason $reason as $decoded", ({ reason, decoded }) => {
    expect(decodeFailure({ reason, message: "No." })).toEqual({ reason: decoded, message: "No." });
  });
});
