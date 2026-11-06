import * as Schema from "effect/Schema";

import {
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  type AuthGrantScope,
  AuthPairingCredentialResult,
  AuthProvidersManageScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSettingsWriteScope,
  AuthStandardClientScopes,
} from "./auth.ts";
import { IsoDateTime, MemberId, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MemberRole = Schema.Literals(["admin", "member"]);
export type MemberRole = typeof MemberRole.Type;

/** A GitHub account bound to a member; `connected` is false once its token stops working. */
export const TeamMemberGitHub = Schema.Struct({
  login: TrimmedNonEmptyString,
  connected: Schema.Boolean,
});
export type TeamMemberGitHub = typeof TeamMemberGitHub.Type;

export const TeamMember = Schema.Struct({
  id: MemberId,
  name: TrimmedNonEmptyString,
  role: MemberRole,
  /** A hue derived from the id on the server, so every client renders the same color. */
  color: Schema.String,
  gitName: Schema.optionalKey(TrimmedNonEmptyString),
  gitEmail: Schema.optionalKey(TrimmedNonEmptyString),
  /** Absent until the member connects GitHub or an admin sets their GitHub username. */
  github: Schema.optionalKey(TeamMemberGitHub),
  isOwner: Schema.Boolean,
  createdAt: IsoDateTime,
  removedAt: Schema.NullOr(IsoDateTime),
});
export type TeamMember = typeof TeamMember.Type;

/** A removal is an upsert with `removedAt` set. */
export const TeamStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", { members: Schema.Array(TeamMember) }),
  Schema.TaggedStruct("upserted", { member: TeamMember }),
]);
export type TeamStreamEvent = typeof TeamStreamEvent.Type;

export const TeamInviteInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  role: MemberRole,
  gitEmail: Schema.optionalKey(TrimmedNonEmptyString),
  ttlMs: Schema.optionalKey(PositiveInt),
});
export type TeamInviteInput = typeof TeamInviteInput.Type;

export const TeamSignInLinkInput = Schema.Struct({ memberId: MemberId });
export type TeamSignInLinkInput = typeof TeamSignInLinkInput.Type;

/** A `null` git field clears it, so the member's commits fall back to the server identity. */
export const TeamUpdateSelfInput = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  gitName: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  gitEmail: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type TeamUpdateSelfInput = typeof TeamUpdateSelfInput.Type;

/**
 * `githubLogin` is admin-only: members bind GitHub to themselves only through the device flow. A
 * changed login drops the old binding and token; `null` clears both.
 */
export const TeamUpdateInput = Schema.Struct({
  memberId: MemberId,
  ...TeamUpdateSelfInput.fields,
  githubLogin: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type TeamUpdateInput = typeof TeamUpdateInput.Type;

export const TeamSetRoleInput = Schema.Struct({ memberId: MemberId, role: MemberRole });
export type TeamSetRoleInput = typeof TeamSetRoleInput.Type;

export const TeamRemoveInput = Schema.Struct({ memberId: MemberId });
export type TeamRemoveInput = typeof TeamRemoveInput.Type;

export const TeamLinkResult = Schema.Struct({
  member: TeamMember,
  credential: AuthPairingCredentialResult,
});
export type TeamLinkResult = typeof TeamLinkResult.Type;

export class TeamError extends Schema.TaggedError<TeamError>()("TeamError", {
  reason: Schema.Literals([
    "not-found",
    "owner-immutable",
    "removed",
    "not-a-member",
    "policy-refused",
    "internal",
  ]),
  message: Schema.String,
}) {}

export const ADMIN_SCOPES: ReadonlyArray<AuthGrantScope> = AuthStandardClientScopes;

const adminOnlyScopes = new Set<AuthGrantScope>([
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthAccessWriteScope,
  AuthRelayWriteScope,
  // Only the owner's cloud account can use T3 Connect.
  AuthRelayReadScope,
  AuthEnvironmentMaintainScope,
]);

export const MEMBER_SCOPES: ReadonlyArray<AuthGrantScope> = ADMIN_SCOPES.filter(
  (scope) => !adminOnlyScopes.has(scope),
);

export const teamRoleScopes = (role: MemberRole): ReadonlyArray<AuthGrantScope> =>
  role === "admin" ? ADMIN_SCOPES : MEMBER_SCOPES;
