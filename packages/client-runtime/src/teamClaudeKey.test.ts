import { describe, expect, it } from "vite-plus/test";
import type { MemberId, TeamClaudeKeyStatus, TeamMember } from "@t3tools/contracts";

import { teamAdmins, teamClaudeKeyStatusText } from "./teamClaudeKey.ts";

const member = (id: string, patch: Partial<TeamMember> = {}): TeamMember => ({
  id: id as MemberId,
  name: id,
  role: "member",
  color: "#000",
  isOwner: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  removedAt: null,
  ...patch,
});

describe("teamAdmins", () => {
  it("keeps active admins and the owner, by join order", () => {
    const admins = teamAdmins([
      member("late-admin", { role: "admin", createdAt: "2026-03-01T00:00:00.000Z" }),
      member("plain"),
      member("gone", { role: "admin", removedAt: "2026-04-01T00:00:00.000Z" }),
      member("owner", { isOwner: true, createdAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(admins.map((admin) => admin.id)).toEqual(["owner", "late-admin"]);
  });
});

describe("teamClaudeKeyStatusText", () => {
  const now = Date.parse("2026-11-13T12:00:00.000Z");
  const set = (lastUsedAt: string | null): TeamClaudeKeyStatus => ({
    state: "set",
    last4: "4f2a",
    addedBy: "rutvik" as MemberId,
    addedAt: "2026-11-13T09:00:00.000Z",
    lastUsedAt,
    activeSpaceCount: 2,
  });

  it.each([
    [{ state: "unset", activeSpaceCount: 0 } as const, "Not set"],
    [set(null), "Set · sk-ant-…4f2a · added by Rutvik, Nov 13"],
    [
      set("2026-11-13T11:59:40.000Z"),
      "Set · sk-ant-…4f2a · added by Rutvik, Nov 13 · last used just now",
    ],
    [
      set("2026-11-13T11:58:00.000Z"),
      "Set · sk-ant-…4f2a · added by Rutvik, Nov 13 · last used 2m ago",
    ],
    [
      set("2026-11-13T09:00:00.000Z"),
      "Set · sk-ant-…4f2a · added by Rutvik, Nov 13 · last used 3h ago",
    ],
    [
      set("2026-11-10T12:00:00.000Z"),
      "Set · sk-ant-…4f2a · added by Rutvik, Nov 13 · last used 3d ago",
    ],
  ])("%#", (status, text) => {
    expect(teamClaudeKeyStatusText(status, () => "Rutvik", now)).toBe(text);
  });
});
