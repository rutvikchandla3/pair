import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { TeamMember, TeamUpdateSelfInput } from "./team.ts";

const decodeMember = Schema.decodeUnknownSync(TeamMember);
const decodeUpdateSelf = Schema.decodeUnknownSync(TeamUpdateSelfInput);

const member = {
  id: "member-bob",
  name: "Bob",
  role: "member",
  color: "hsl(10, 60%, 50%)",
  isOwner: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  removedAt: null,
};

describe("team contracts", () => {
  it("decodes members from servers that predate GitHub links, and with one", () => {
    expect(decodeMember(member)).not.toHaveProperty("github");
    expect(decodeMember({ ...member, github: { login: "bob", connected: false } }).github).toEqual({
      login: "bob",
      connected: false,
    });
  });

  it("never lets a member set their own GitHub login", () => {
    expect(decodeUpdateSelf({ name: "Bob", githubLogin: "alice" })).toEqual({ name: "Bob" });
  });
});
