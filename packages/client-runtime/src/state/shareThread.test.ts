import {
  MemberId,
  ProviderDriverKind,
  ProviderInstanceId,
  SANDBOX_ACCESS_MEMBER_LIMIT,
  SandboxId,
  ThreadId,
  type TeamMember,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyShareChange,
  exceedsShareCap,
  removalWarning,
  PRIVATE_RUN_SHARE,
  runShareControl,
  shareCandidates,
  shareMachineContext,
  shareTrustSentence,
  visibleShareAccess,
  type PendingShare,
  type ShareAccess,
} from "./shareThread.ts";
import type { TeamMembers } from "./team.ts";

const createdAt = "2036-04-07T00:00:00.000Z" as TeamMember["createdAt"];
const member = (id: string, name: string, extra: Partial<TeamMember> = {}): TeamMember => ({
  id: MemberId.make(id),
  name,
  role: "member",
  color: "hsl(0, 60%, 50%)",
  isOwner: false,
  createdAt,
  removedAt: null,
  ...extra,
});
const rutvik = member("rutvik", "Rutvik Chandla");
const ada = member("ada", "Ada Lovelace", {
  github: { login: "countess", connected: true, source: "token" },
});
const grace = member("grace", "Grace Hopper");
const gone = member("gone", "Alan Turing", { removedAt: createdAt });
const members: TeamMembers = new Map([rutvik, ada, grace, gone].map((m) => [m.id, m]));

describe("shareCandidates", () => {
  it.each([
    ["everyone the owner can add", "", [], ["Ada Lovelace", "Grace Hopper"]],
    ["a name", "hop", [], ["Grace Hopper"]],
    ["a GitHub username", "COUNT", [], ["Ada Lovelace"]],
    ["not someone already listed", "", [ada.id], ["Grace Hopper"]],
    ["not the owner or a removed member", "r", [], ["Grace Hopper"]],
  ] as const)("matches %s", (_name, query, listed, expected) => {
    expect(
      shareCandidates(members, { ownerId: rutvik.id, listed, query }).map((m) => m.name),
    ).toEqual(expected);
  });
});

describe("visibleShareAccess", () => {
  const server: ShareAccess = { audience: "members", memberIds: [] };
  const withAda = applyShareChange(server, { kind: "add", memberIds: [ada.id] });
  const withBoth = applyShareChange(withAda, { kind: "add", memberIds: [grace.id, ada.id] });
  const pending = (access: ShareAccess, confirmed: boolean, id = 1): PendingShare => ({
    id,
    access,
    confirmed,
  });

  it("shows a change at once, and keeps it until the shell catches up", () => {
    expect(visibleShareAccess(server, [pending(withAda, false)])).toEqual(withAda);
    // Confirmed before the shell's update arrives: still shown, not flicked back.
    expect(visibleShareAccess(server, [pending(withAda, true)])).toEqual(withAda);
    expect(visibleShareAccess(withAda, [pending(withAda, true)])).toEqual(withAda);
    expect(withBoth.memberIds).toEqual([ada.id, grace.id]);
  });

  it("rolls back to the shell when the only change is refused", () => {
    // The dialog drops a refused change from its list; the shell's value shows again.
    expect(visibleShareAccess(server, [])).toEqual(server);
  });

  it("shows the newest change while an older one settles", () => {
    const list = [pending(withAda, true, 1), pending(withBoth, false, 2)];
    expect(visibleShareAccess(withAda, list)).toEqual(withBoth);
    const removed = applyShareChange(withBoth, { kind: "remove", memberId: ada.id });
    // Once the shell shows a later confirmed change, earlier ones no longer apply.
    expect(
      visibleShareAccess(removed, [
        pending(withAda, true, 1),
        pending(withBoth, true, 2),
        pending(removed, true, 3),
      ]),
    ).toEqual(removed);
  });

  it("keeps the list when everyone on the team can open it", () => {
    expect(applyShareChange(withAda, { kind: "audience", audience: "team" })).toEqual({
      audience: "team",
      memberIds: [ada.id],
    });
  });
});

describe("exceedsShareCap", () => {
  const people = (count: number): ShareAccess => ({
    audience: "members",
    memberIds: Array.from({ length: count }, (_, index) => MemberId.make(`m${index}`)),
  });
  it.each([
    [SANDBOX_ACCESS_MEMBER_LIMIT, false],
    [SANDBOX_ACCESS_MEMBER_LIMIT + 1, true],
  ])("%i people: %s", (count, expected) => {
    expect(exceedsShareCap(people(count))).toBe(expected);
  });
});

describe("removalWarning", () => {
  const shared: ShareAccess = { audience: "members", memberIds: [ada.id, grace.id] };
  it.each([
    ["owns nothing on the machine", shared, [rutvik.id, grace.id], null],
    [
      "owns a fork",
      shared,
      [rutvik.id, ada.id],
      "Ada Lovelace has a thread on this machine and will lose access to it too.",
    ],
    [
      "owns two",
      shared,
      [ada.id, null, ada.id],
      "Ada Lovelace has 2 threads on this machine and will lose access to them too.",
    ],
    ["keeps access through Everyone", { ...shared, audience: "team" }, [ada.id], null],
  ] as const)("%s", (_name, access, threadOwnerIds, expected) => {
    expect(removalWarning({ access, member: ada, threadOwnerIds })).toBe(expected);
  });
});

describe("shareTrustSentence", () => {
  const base = {
    audience: "members" as const,
    teamName: "Acme",
    ownAccountProvider: null,
    relatedCount: 0,
  };
  it.each([
    [
      "people added, team account",
      base,
      "People you add can prompt this thread and use its terminal. That reaches the provider sign-in and git token on its machine.",
    ],
    [
      "the owner's own account and two side chats",
      { ...base, ownAccountProvider: "Claude", relatedCount: 2 },
      "People you add can prompt this thread and use its terminal. That reaches your Claude sign-in and git token on its machine. Sharing also covers its 2 side chats and forks.",
    ],
    [
      "Everyone with one fork",
      { ...base, audience: "team" as const, relatedCount: 1 },
      "Everyone on Acme can open this thread, including people who join later. They can prompt this thread and use its terminal. That reaches the provider sign-in and git token on its machine. Sharing also covers its side chat or fork.",
    ],
  ])("%s", (_name, input, expected) => {
    expect(shareTrustSentence(input)).toBe(expected);
  });
});

describe("shareMachineContext", () => {
  const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");
  const instanceId = ProviderInstanceId.make("claude");
  const thread = (id: string, ownerId: string | null, onBox = true) => ({
    id: ThreadId.make(id),
    sandboxId: onBox ? sandboxId : undefined,
    ownerId: ownerId === null ? null : MemberId.make(ownerId),
    providerInstanceId: instanceId,
  });
  const threads = [thread("t1", "rutvik"), thread("t2", "ada"), thread("t3", null, false)];
  const instances = (ownerMemberId: MemberId) => ({
    [instanceId]: { driver: ProviderDriverKind.make("claudeAgent"), ownerMemberId },
  });

  it("counts the other threads on the machine and names the owner's own account", () => {
    expect(
      shareMachineContext({
        threads,
        sandboxId,
        ownerThreadId: ThreadId.make("t1"),
        ownerId: rutvik.id,
        providerInstances: instances(rutvik.id),
      }),
    ).toEqual({ relatedThreadOwnerIds: [ada.id], ownAccountProvider: "Claude" });
  });

  it("names no provider when the account belongs to someone else", () => {
    expect(
      shareMachineContext({
        threads,
        sandboxId,
        ownerThreadId: ThreadId.make("t1"),
        ownerId: rutvik.id,
        providerInstances: instances(ada.id),
      }).ownAccountProvider,
    ).toBeNull();
  });
});

describe("runShareControl", () => {
  const owner = member("server-owner", "Server Owner", { isOwner: true });
  const team: TeamMembers = new Map([owner, rutvik, ada].map((m) => [m.id, m]));
  const base = { cloudLaunch: true, members: team, me: rutvik.id, task: null, bound: false };
  const task = (extra: { createdByMemberId?: MemberId; access?: object }) =>
    extra as unknown as NonNullable<Parameters<typeof runShareControl>[0]["task"]>;

  it("starts a new task private, and its creator can change it", () => {
    expect(runShareControl(base)).toEqual({
      access: PRIVATE_RUN_SHARE,
      creatorId: rutvik.id,
      canEdit: true,
    });
  });

  it.each([
    ["not on Pair Cloud", { cloudLaunch: false }],
    ["on a server with one member", { members: new Map([[rutvik.id, rutvik]]) }],
    ["on a task that continues a thread", { bound: true }],
    [
      "for an audience from a newer server",
      { task: task({ createdByMemberId: rutvik.id, access: { audience: null, memberIds: [] } }) },
    ],
  ])("is hidden %s", (_name, override) => {
    expect(runShareControl({ ...base, ...override })).toBeNull();
  });

  it("reads a task from before as everyone, whose creator is the server's owner", () => {
    expect(runShareControl({ ...base, task: task({}), me: rutvik.id })).toEqual({
      access: { audience: "team", memberIds: [] },
      creatorId: owner.id,
      canEdit: false,
    });
    expect(runShareControl({ ...base, task: task({}), me: owner.id })?.canEdit).toBe(true);
  });

  it("lets only the recorded creator change a task's audience", () => {
    const stored = task({
      createdByMemberId: ada.id,
      access: { audience: "members", memberIds: [rutvik.id] },
    });
    expect(runShareControl({ ...base, task: stored, me: ada.id })).toMatchObject({
      access: { audience: "members", memberIds: [rutvik.id] },
      canEdit: true,
    });
    expect(runShareControl({ ...base, task: stored, me: owner.id })?.canEdit).toBe(false);
  });
});
