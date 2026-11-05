const STASH_KEY = "t3code:pair-return-path";
const STASH_TTL_MS = 10 * 60 * 1000;

/** A same-origin app path to come back to after pairing; anything else, and /pair itself, is null. */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  // Browsers read a leading "/\" like "//", and control characters can hide a host.
  if (value.startsWith("//") || value.startsWith("/\\") || /[\u0000-\u001f\u007f]/.test(value)) {
    return null;
  }
  const base = "http://return-path.invalid";
  if (!URL.canParse(value, base)) return null;
  const url = new URL(value, base);
  if (url.origin !== base || url.pathname === "/pair" || url.pathname.startsWith("/pair/")) {
    return null;
  }
  return value;
}

function stashStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Sign-in links usually open in a new tab, which never saw the `next` the old tab did. */
export function stashReturnPath(
  path: string,
  now = Date.now(),
  storage: Storage | null = stashStorage(),
): void {
  try {
    storage?.setItem(STASH_KEY, JSON.stringify({ path, expiresAt: now + STASH_TTL_MS }));
  } catch {}
}

export function readStashedReturnPath(
  now = Date.now(),
  storage: Storage | null = stashStorage(),
): string | null {
  try {
    const raw = storage?.getItem(STASH_KEY);
    if (!raw) return null;
    const stash: unknown = JSON.parse(raw);
    if (
      typeof stash === "object" &&
      stash !== null &&
      "path" in stash &&
      "expiresAt" in stash &&
      typeof stash.expiresAt === "number" &&
      stash.expiresAt > now
    ) {
      return safeReturnPath(stash.path);
    }
    storage?.removeItem(STASH_KEY);
  } catch {}
  return null;
}

export function clearStashedReturnPath(storage: Storage | null = stashStorage()): void {
  try {
    storage?.removeItem(STASH_KEY);
  } catch {}
}
