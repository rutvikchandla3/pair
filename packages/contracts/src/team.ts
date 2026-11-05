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

export const TeamMember = Schema.Struct({
  id: MemberId,
  name: TrimmedNonEmptyString,
  role: MemberRole,
  /** A hue derived from the id on the server, so every client renders the same color. */
  color: Schema.String,
  gitName: Schema.optionalKey(TrimmedNonEmptyString),
  gitEmail: Schema.optionalKey(TrimmedNonEmptyString),
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
  ttlMs: Schema.optionalKey(PositiveInt),
});
export type TeamInviteInput = typeof TeamInviteInput.Type;

export const TeamSignInLinkInput = Schema.Struct({ memberId: MemberId });
export type TeamSignInLinkInput = typeof TeamSignInLinkInput.Type;

export const TeamUpdateSelfInput = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  gitName: Schema.optionalKey(TrimmedNonEmptyString),
  gitEmail: Schema.optionalKey(TrimmedNonEmptyString),
});
export type TeamUpdateSelfInput = typeof TeamUpdateSelfInput.Type;

export const TeamUpdateInput = Schema.Struct({
  memberId: MemberId,
  ...TeamUpdateSelfInput.fields,
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
