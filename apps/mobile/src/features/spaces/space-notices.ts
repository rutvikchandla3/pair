import { useSyncExternalStore } from "react";

export interface SpaceUndoNotice {
  readonly title: string;
  readonly label: string;
  readonly undo: () => void;
}

let notice: SpaceUndoNotice | null = null;
let expiry: ReturnType<typeof setTimeout> | undefined;
// Spaces the viewer left on this device, so the room can say "You left" and offer the way back.
const left = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function dismissSpaceUndoNotice() {
  notice = null;
  clearTimeout(expiry);
  notify();
}

export function showSpaceUndoNotice(next: SpaceUndoNotice) {
  clearTimeout(expiry);
  notice = next;
  notify();
  expiry = setTimeout(dismissSpaceUndoNotice, 5_000);
}

export function useSpaceUndoNotice() {
  return useSyncExternalStore(subscribe, () => notice);
}

const leftKey = (environmentId: string, spaceId: string) => `${environmentId}:${spaceId}`;

export function markSpaceLeft(environmentId: string, spaceId: string, value: boolean) {
  if (value) left.add(leftKey(environmentId, spaceId));
  else left.delete(leftKey(environmentId, spaceId));
  notify();
}

export function useSpaceLeft(environmentId: string, spaceId: string) {
  return useSyncExternalStore(subscribe, () => left.has(leftKey(environmentId, spaceId)));
}
