import { expect, it } from "@effect/vitest";
import { EnvironmentId, MemberId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { CHIEF_OF_STAFF_MCP_LABEL, ChiefOfStaffClients, chiefOfStaffCaller } from "./caller.ts";

const environmentId = EnvironmentId.make("environment:cos-caller");
const member = MemberId.make("member-a");
const homeThread = ThreadId.make("thread:home-a");
const homeThreads = new Map<string, string>([[String(homeThread), String(member)]]);

const base: McpInvocationScope = {
  environmentId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "cos-caller",
  thread: {
    threadId: homeThread,
    providerSessionId: "provider:cos-caller",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};

const withClient = (client: McpInvocationScope["client"]): McpInvocationScope => ({
  ...base,
  thread: undefined,
  client,
});

const withThread = (threadId: ThreadId): McpInvocationScope => ({
  ...base,
  thread: { ...base.thread!, threadId },
});

it("recognizes a session the voice relay issued", () => {
  ChiefOfStaffClients.add("session:voice");
  try {
    expect(
      chiefOfStaffCaller(
        withClient({
          sessionId: "session:voice",
          label: CHIEF_OF_STAFF_MCP_LABEL,
          access: "full-access",
          memberId: member,
        }),
        new Map(),
      ),
    ).toEqual({ via: "voice", memberId: member });
  } finally {
    ChiefOfStaffClients.remove("session:voice");
  }
});

it("recognizes an issued session with no member", () => {
  ChiefOfStaffClients.add("session:voice");
  try {
    expect(
      chiefOfStaffCaller(
        withClient({
          sessionId: "session:voice",
          label: CHIEF_OF_STAFF_MCP_LABEL,
          access: "full-access",
        }),
        new Map(),
      ),
    ).toEqual({ via: "voice" });
  } finally {
    ChiefOfStaffClients.remove("session:voice");
  }
});

it("does not trust a lookalike label on an unissued session", () => {
  expect(
    chiefOfStaffCaller(
      withClient({
        sessionId: "session:lookalike",
        label: CHIEF_OF_STAFF_MCP_LABEL,
        access: "full-access",
        memberId: member,
      }),
      homeThreads,
    ),
  ).toBeUndefined();
});

it("does not recognize another client label", () => {
  expect(
    chiefOfStaffCaller(
      withClient({
        sessionId: "session:other",
        label: "Claude Code",
        access: "full-access",
        memberId: member,
      }),
      homeThreads,
    ),
  ).toBeUndefined();
});

it("recognizes a home thread through the index", () => {
  expect(chiefOfStaffCaller(withThread(homeThread), homeThreads)).toEqual({
    via: "home-thread",
    memberId: member,
    threadId: homeThread,
  });
});

it("does not recognize an ordinary thread", () => {
  expect(
    chiefOfStaffCaller(withThread(ThreadId.make("thread:ordinary")), homeThreads),
  ).toBeUndefined();
});

it("recognizes an issued session over a home thread", () => {
  ChiefOfStaffClients.add("session:voice");
  try {
    const scope: McpInvocationScope = {
      ...withThread(homeThread),
      client: {
        sessionId: "session:voice",
        label: CHIEF_OF_STAFF_MCP_LABEL,
        access: "full-access",
        memberId: member,
      },
    };
    expect(chiefOfStaffCaller(scope, homeThreads)).toEqual({ via: "voice", memberId: member });
  } finally {
    ChiefOfStaffClients.remove("session:voice");
  }
});
