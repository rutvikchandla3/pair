import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { IsoDateTime, MemberId, TrimmedNonEmptyString } from "./baseSchemas.ts";
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

  it("keeps a member's GitHub source decodable by older clients and by this one", () => {
    // The member schema before `source`, frozen to expose compatibility regressions.
    const decodePrevious = Schema.decodeUnknownSync(
      Schema.Struct({
        id: MemberId,
        name: TrimmedNonEmptyString,
        role: Schema.Literals(["admin", "member"]),
        color: Schema.String,
        github: Schema.optionalKey(
          Schema.Struct({ login: TrimmedNonEmptyString, connected: Schema.Boolean }),
        ),
        isOwner: Schema.Boolean,
        createdAt: IsoDateTime,
        removedAt: Schema.NullOr(IsoDateTime),
      }),
    );
    const withToken = { ...member, github: { login: "bob", connected: true, source: "token" } };

    expect(decodePrevious(withToken).github).toEqual({ login: "bob", connected: true });
    expect(decodeMember(withToken).github?.source).toBe("token");
    const later = decodeMember({
      ...member,
      github: { login: "bob", connected: true, source: "x" },
    });
    expect(later.github).toEqual({ login: "bob", connected: true });
  });

  it("never lets a member set their own GitHub login", () => {
    expect(decodeUpdateSelf({ name: "Bob", githubLogin: "alice" })).toEqual({ name: "Bob" });
  });
});
