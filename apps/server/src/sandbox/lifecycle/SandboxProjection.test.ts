import { describe, expect, it } from "@effect/vitest";
import {
  ComputeDriverId,
  MemberId,
  type OrchestrationV2Sandbox,
  ProjectId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { usageIntervalChange } from "./SandboxProjection.ts";

const at = DateTime.makeUnsafe("2026-11-06T12:00:00.000Z");
const owner = ThreadId.make("thread:owner");
const member = MemberId.make("member:owner");
const driverId = ComputeDriverId.make("docker");
const record: OrchestrationV2Sandbox = {
  id: SandboxId.make("sbx_0123456789abcdef0123"),
  projectId: ProjectId.make("project:sandbox"),
  ownerThreadId: owner,
  ownerMemberId: member,
  driverId,
  size: "default",
  state: "provisioning",
  generation: 1,
  driverRef: null,
  admission: null,
  runnerLostAt: null,
  sleepReason: null,
  failure: null,
  createdAt: at,
  updatedAt: at,
};
const openRow = { threadId: owner, memberId: member, driverId, size: "default" as const };
const reopened = (next: Partial<OrchestrationV2Sandbox>) => ({
  threadId: next.ownerThreadId ?? owner,
  memberId: next.ownerMemberId === undefined ? member : next.ownerMemberId,
  driverId,
  size: next.size ?? "default",
});

describe("usageIntervalChange", () => {
  it.each([
    { name: "provisioning opens", open: null, next: {}, close: false, opens: true },
    {
      name: "waiting for admission opens nothing",
      open: null,
      next: { admission: { reason: "team-cap" as const, since: at } },
      close: false,
      opens: false,
    },
    {
      name: "admission set closes",
      open: openRow,
      next: { admission: { reason: "team-cap" as const, since: at } },
      close: true,
      opens: false,
    },
    {
      name: "ready keeps the row",
      open: openRow,
      next: { state: "ready" as const },
      close: false,
      opens: false,
    },
    {
      name: "adopt closes and opens for the new owner",
      open: openRow,
      next: { state: "ready" as const, ownerThreadId: ThreadId.make("thread:fork") },
      close: true,
      opens: true,
    },
    {
      name: "reassign closes and opens for the new member",
      open: openRow,
      next: { state: "ready" as const, ownerMemberId: MemberId.make("member:other") },
      close: true,
      opens: true,
    },
    {
      name: "failed closes",
      open: openRow,
      next: { state: "failed" as const },
      close: true,
      opens: false,
    },
    {
      name: "sleeping closes",
      open: openRow,
      next: { state: "sleeping" as const },
      close: true,
      opens: false,
    },
    {
      name: "destroyed closes",
      open: openRow,
      next: { state: "destroyed" as const },
      close: true,
      opens: false,
    },
    {
      name: "waking reopens",
      open: null,
      next: { state: "waking" as const },
      close: false,
      opens: true,
    },
    {
      name: "a replayed record changes nothing",
      open: openRow,
      next: {},
      close: false,
      opens: false,
    },
    {
      name: "a replayed stop changes nothing",
      open: null,
      next: { state: "sleeping" as const },
      close: false,
      opens: false,
    },
  ])("$name", ({ open, next, close, opens }) => {
    expect(usageIntervalChange(open, { ...record, ...next })).toEqual({
      close,
      open: opens ? reopened(next) : null,
    });
  });
});
