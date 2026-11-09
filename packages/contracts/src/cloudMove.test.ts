import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CloudMoveContinuedInput,
  CloudMoveFailure,
  CloudMoveSeedHeaders,
  CloudStagingKey,
} from "./cloudMove.ts";

const isKey = Schema.is(CloudStagingKey);
const decodeFailure = Schema.decodeUnknownSync(CloudMoveFailure);
const isContinued = Schema.is(CloudMoveContinuedInput);
const decodeHeaders = Schema.decodeUnknownOption(CloudMoveSeedHeaders);
const oid = "a".repeat(40);
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
    { reason: "snapshot-missing", decoded: "snapshot-missing" },
    { reason: "from-a-newer-server", decoded: null },
  ])("CloudMoveFailure reads reason $reason as $decoded", ({ reason, decoded }) => {
    expect(decodeFailure({ reason, message: "No." })).toEqual({ reason: decoded, message: "No." });
  });

  it.each([
    {
      name: "a staging key and a short label",
      moveId: `mv_${hex}`,
      label: "Kim's Mac",
      valid: true,
    },
    {
      name: "a moveId that isn't a staging key",
      moveId: "move-1",
      label: "Kim's Mac",
      valid: false,
    },
    { name: "a 121-character label", moveId: `mv_${hex}`, label: "x".repeat(121), valid: false },
  ])("CloudMoveContinuedInput takes $name: $valid", ({ moveId, label, valid }) => {
    expect(
      isContinued({
        moveId,
        thread: { environmentId: "env-laptop", threadId: "thread-1" },
        environmentLabel: label,
        copy: false,
      }),
    ).toBe(valid);
  });

  it.each([
    { name: "without a snapshot", extra: {}, valid: true },
    {
      name: "with the snapshot pair",
      extra: { "t3-move-snapshot": "b".repeat(40), "t3-move-snapshot-at": "2026-11-09T14:02:00Z" },
      valid: true,
    },
    { name: "with a short head", extra: { "t3-move-head": "abc123" }, valid: false },
  ])("CloudMoveSeedHeaders decodes headers $name: $valid", ({ extra, valid }) => {
    const decoded = decodeHeaders({
      "t3-move-mode": "move",
      "t3-move-branch": "feature/work",
      "t3-move-origin": "github.com/acme/app",
      "t3-move-head": oid,
      // Node lowercases every header and passes the rest through.
      "content-type": "application/x-git-bundle",
      ...extra,
    });
    expect(decoded._tag === "Some").toBe(valid);
  });
});
