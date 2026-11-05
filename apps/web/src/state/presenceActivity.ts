import { isPresenceIdle } from "@t3tools/client-runtime/presence-reporting";
import { PRESENCE_IDLE_AFTER_MS } from "@t3tools/contracts";

export type PresenceActivitySignal =
  | { readonly type: "input" }
  | { readonly type: "idleCheck"; readonly lastInputAt: number };

type Listener = (signal: PresenceActivitySignal) => void;

// No pointermove: it fires every frame while the mouse moves.
const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
const INPUT_SIGNAL: PresenceActivitySignal = { type: "input" };

const listeners = new Set<Listener>();
let lastInputAt = 0;
let idle = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleIdleCheck() {
  idleTimer = setTimeout(checkIdle, Math.max(0, lastInputAt + PRESENCE_IDLE_AFTER_MS - Date.now()));
}

// Input only moves `lastInputAt`; the one timer re-arms itself for the remainder when it fires.
function checkIdle() {
  if (!isPresenceIdle(lastInputAt, Date.now())) {
    scheduleIdleCheck();
    return;
  }
  idleTimer = undefined;
  idle = true;
  const signal: PresenceActivitySignal = { type: "idleCheck", lastInputAt };
  for (const listener of listeners) listener(signal);
}

function handleInput() {
  lastInputAt = Date.now();
  if (!idle) return;
  idle = false;
  scheduleIdleCheck();
  for (const listener of listeners) listener(INPUT_SIGNAL);
}

/** One set of passive input listeners and one idle timer, shared by every environment. */
export function subscribePresenceActivity(listener: Listener): () => void {
  if (listeners.size === 0) {
    lastInputAt = Date.now();
    idle = false;
    for (const type of INPUT_EVENTS) {
      window.addEventListener(type, handleInput, { capture: true, passive: true });
    }
    scheduleIdleCheck();
  }
  listeners.add(listener);
  if (idle) listener({ type: "idleCheck", lastInputAt });
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    for (const type of INPUT_EVENTS) {
      window.removeEventListener(type, handleInput, { capture: true });
    }
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };
}
