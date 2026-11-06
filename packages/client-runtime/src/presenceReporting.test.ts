import {
  PRESENCE_IDLE_AFTER_MS,
  PRESENCE_TYPING_REFRESH_MS,
  PRESENCE_TYPING_TTL_MS,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_PRESENCE_REPORTER,
  stepAppPresence,
  stepPresenceReporter,
  type PresenceReporterSignal,
  type PresenceReporterState,
} from "./presenceReporting.ts";

const threadX = ThreadId.make("thread-x");
const threadY = ThreadId.make("thread-y");
const NOW = 1_000_000;

const together: PresenceReporterState = { ...INITIAL_PRESENCE_REPORTER, others: true };
const onX: PresenceReporterState = { ...together, viewingThreadId: threadX };
const typingOnX: PresenceReporterState = { ...onX, typingSentAt: NOW };

describe("stepPresenceReporter", () => {
  it.each<{
    readonly name: string;
    readonly state: PresenceReporterState;
    readonly signal: PresenceReporterSignal;
    readonly now?: number;
    readonly report: unknown;
    readonly next?: Partial<PresenceReporterState>;
  }>([
    {
      name: "silent while alone: viewing",
      state: INITIAL_PRESENCE_REPORTER,
      signal: { type: "viewing", threadId: threadX },
      report: undefined,
      next: { viewingThreadId: threadX },
    },
    {
      name: "silent while alone: idle",
      state: INITIAL_PRESENCE_REPORTER,
      signal: { type: "idleCheck", lastInputAt: NOW - PRESENCE_IDLE_AFTER_MS },
      report: undefined,
      next: { idle: true },
    },
    {
      name: "silent while alone: input",
      state: { ...INITIAL_PRESENCE_REPORTER, idle: true },
      signal: { type: "input" },
      report: undefined,
      next: { idle: false },
    },
    {
      name: "silent while alone: keystroke",
      state: { ...INITIAL_PRESENCE_REPORTER, viewingThreadId: threadX },
      signal: { type: "keystroke", threadId: threadX },
      report: undefined,
      next: { typingSentAt: null },
    },
    {
      name: "full state on flip",
      state: { ...INITIAL_PRESENCE_REPORTER, viewingThreadId: threadX, idle: true },
      signal: { type: "others", others: true },
      report: { viewingThreadId: threadX, idle: true },
      next: { others: true },
    },
    {
      name: "full state on flip, even at the defaults",
      state: INITIAL_PRESENCE_REPORTER,
      signal: { type: "others", others: true },
      report: { viewingThreadId: null, idle: false },
      next: { others: true },
    },
    {
      name: "left alone: silent, and typing is forgotten",
      state: typingOnX,
      signal: { type: "others", others: false },
      report: undefined,
      next: { others: false, typingSentAt: null },
    },
    {
      name: "viewing change reports the thread and drops typing",
      state: typingOnX,
      signal: { type: "viewing", threadId: threadY },
      report: { viewingThreadId: threadY },
      next: { viewingThreadId: threadY, typingSentAt: null },
    },
    {
      name: "leaving every thread reports null",
      state: onX,
      signal: { type: "viewing", threadId: null },
      report: { viewingThreadId: null },
      next: { viewingThreadId: null },
    },
    {
      name: "same thread again sends nothing",
      state: onX,
      signal: { type: "viewing", threadId: threadX },
      report: undefined,
    },
    {
      name: "first keystroke reports typing",
      state: onX,
      signal: { type: "keystroke", threadId: threadX },
      report: { typing: true },
      next: { typingSentAt: NOW },
    },
    {
      name: "keystrokes inside the refresh window send nothing",
      state: typingOnX,
      signal: { type: "keystroke", threadId: threadX },
      now: NOW + PRESENCE_TYPING_REFRESH_MS - 1,
      report: undefined,
    },
    {
      name: "a keystroke after the refresh window repeats typing",
      state: typingOnX,
      signal: { type: "keystroke", threadId: threadX },
      now: NOW + PRESENCE_TYPING_REFRESH_MS,
      report: { typing: true },
      next: { typingSentAt: NOW + PRESENCE_TYPING_REFRESH_MS },
    },
    {
      name: "a keystroke in a thread not being viewed sends nothing",
      state: onX,
      signal: { type: "keystroke", threadId: threadY },
      report: undefined,
    },
    {
      name: "sent clears typing",
      state: typingOnX,
      signal: { type: "sent" },
      now: NOW + 1,
      report: { typing: false },
      next: { typingSentAt: null },
    },
    {
      name: "sent after the server expired typing sends nothing",
      state: typingOnX,
      signal: { type: "sent" },
      now: NOW + PRESENCE_TYPING_TTL_MS,
      report: undefined,
      next: { typingSentAt: null },
    },
    {
      name: "sent while not typing sends nothing",
      state: onX,
      signal: { type: "sent" },
      report: undefined,
    },
    {
      name: "idle after ten minutes without input",
      state: onX,
      signal: { type: "idleCheck", lastInputAt: NOW - PRESENCE_IDLE_AFTER_MS },
      report: { idle: true },
      next: { idle: true },
    },
    {
      name: "not idle before ten minutes",
      state: onX,
      signal: { type: "idleCheck", lastInputAt: NOW - PRESENCE_IDLE_AFTER_MS + 1 },
      report: undefined,
    },
    {
      name: "already idle sends nothing",
      state: { ...onX, idle: true },
      signal: { type: "idleCheck", lastInputAt: 0 },
      report: undefined,
    },
    {
      name: "input while idle reports active",
      state: { ...onX, idle: true },
      signal: { type: "input" },
      report: { idle: false },
      next: { idle: false },
    },
    {
      name: "input while active sends nothing",
      state: onX,
      signal: { type: "input" },
      report: undefined,
    },
  ])("$name", ({ state, signal, now = NOW, report, next }) => {
    const step = stepPresenceReporter(state, signal, now);
    expect(step.report).toEqual(report);
    expect(step.state).toEqual({ ...state, ...next });
  });
});

describe("stepAppPresence", () => {
  it.each<{
    readonly name: string;
    readonly state: PresenceReporterState;
    readonly appState: "active" | "background" | "inactive";
    readonly threadId: ThreadId | null;
    readonly report: unknown;
    readonly next?: Partial<PresenceReporterState>;
  }>([
    {
      name: "background leaves the thread and goes idle",
      state: typingOnX,
      appState: "background",
      threadId: threadX,
      report: { viewingThreadId: null, idle: true },
      next: { viewingThreadId: null, idle: true, typingSentAt: null },
    },
    {
      name: "foreground views the routed thread and is active again",
      state: { ...together, idle: true },
      appState: "active",
      threadId: threadX,
      report: { viewingThreadId: threadX, idle: false },
      next: { viewingThreadId: threadX, idle: false },
    },
    {
      name: "inactive (app switcher) still views the thread",
      state: onX,
      appState: "inactive",
      threadId: threadX,
      report: undefined,
    },
    {
      name: "silent while alone, but remembers for the flip",
      state: INITIAL_PRESENCE_REPORTER,
      appState: "background",
      threadId: threadX,
      report: undefined,
      next: { idle: true },
    },
  ])("$name", ({ state, appState, threadId, report, next }) => {
    const step = stepAppPresence(state, { appState, threadId }, NOW);
    expect(step.report).toEqual(report);
    expect(step.state).toEqual({ ...state, ...next });
  });
});
