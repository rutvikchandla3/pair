import { describe, expect, it } from "vite-plus/test";

import {
  clearStashedReturnPath,
  readStashedReturnPath,
  safeReturnPath,
  stashReturnPath,
} from "./authReturnPath";

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

describe("safeReturnPath", () => {
  it.each([
    ["/env-1/thread-1", "/env-1/thread-1"],
    ["/settings/team?tab=members#top", "/settings/team?tab=members#top"],
    ["//evil.test", null],
    ["//evil.test/threads/e/t", null],
    ["/\\evil.test", null],
    ["https://evil.test/env-1/thread-1", null],
    ["javascript:alert(1)", null],
    ["env-1/thread-1", null],
    ["/pair", null],
    ["/pair?next=/a", null],
    ["/pair/", null],
    ["/pairing", "/pairing"],
    ["/a\nb", null],
    ["", null],
    [undefined, null],
    [42, null],
  ])("%j -> %j", (value, expected) => {
    expect(safeReturnPath(value)).toBe(expected);
  });
});

describe("stashed return path", () => {
  it("is read back until it expires after ten minutes, then dropped", () => {
    const storage = memoryStorage();
    stashReturnPath("/env-1/thread-1", 1_000, storage);
    expect(readStashedReturnPath(1_000 + 10 * 60 * 1000 - 1, storage)).toBe("/env-1/thread-1");
    expect(readStashedReturnPath(1_000 + 10 * 60 * 1000, storage)).toBeNull();
    expect(storage.length).toBe(0);
  });

  it("revalidates what it reads and ignores garbage", () => {
    const storage = memoryStorage();
    stashReturnPath("//evil.test", 0, storage);
    expect(readStashedReturnPath(1, storage)).toBeNull();
    storage.setItem("t3code:pair-return-path", "{not json");
    expect(readStashedReturnPath(1, storage)).toBeNull();
  });

  it("clears, and survives storage that throws or is missing", () => {
    const storage = memoryStorage();
    stashReturnPath("/a", 0, storage);
    clearStashedReturnPath(storage);
    expect(readStashedReturnPath(1, storage)).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(() => stashReturnPath("/a", 0, broken)).not.toThrow();
    expect(readStashedReturnPath(1, broken)).toBeNull();
    expect(readStashedReturnPath(1, null)).toBeNull();
  });
});
