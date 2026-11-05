import {
  ADMIN_SCOPES,
  type AuthEnvironmentScope,
  MEMBER_SCOPES,
  MemberId,
  type MemberRole,
  TeamError,
  type TeamInviteInput,
  type TeamLinkResult,
  type TeamMember,
  type TeamRemoveInput,
  type TeamSetRoleInput,
  type TeamSignInLinkInput,
  type TeamStreamEvent,
  type TeamUpdateInput,
  type TeamUpdateSelfInput,
  teamRoleScopes,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Members from "../persistence/Members.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TeamState from "./TeamState.ts";

export class TeamMembers extends Context.Service<
  TeamMembers,
  {
    /** Every member, removed ones included, oldest first. */
    readonly list: Effect.Effect<ReadonlyArray<TeamMember>>;
    readonly invite: (input: TeamInviteInput) => Effect.Effect<TeamLinkResult, TeamError>;
    /** A new one-time link that signs an existing member in on another device. */
    readonly signInLink: (input: TeamSignInLinkInput) => Effect.Effect<TeamLinkResult, TeamError>;
    readonly update: (input: TeamUpdateInput) => Effect.Effect<TeamMember, TeamError>;
    readonly updateSelf: (
      memberId: MemberId,
      input: TeamUpdateSelfInput,
    ) => Effect.Effect<TeamMember, TeamError>;
    /** Narrows or widens the member's live sessions; their sockets reconnect with the new scopes. */
    readonly setRole: (input: TeamSetRoleInput) => Effect.Effect<TeamMember, TeamError>;
    /** Revokes every session and unconsumed link the member has. */
    readonly remove: (input: TeamRemoveInput) => Effect.Effect<TeamMember, TeamError>;
    /** A snapshot, then each changed member. A removal is an upsert with `removedAt` set. */
    readonly streamChanges: Stream.Stream<TeamStreamEvent>;
  }
>()("t3/team/TeamMembers") {}

const OWNER_PLACEHOLDER_NAME = "Admin";
const GIT_NAME_TIMEOUT = Duration.seconds(5);
// Invites travel through chat, so they outlive the 5-minute device pairing default.
const MEMBER_LINK_TTL = Duration.hours(24);

/** A hue from the id, so every client renders a member in the same color. */
const memberColor = (id: MemberId): string => {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return `hsl(${hash % 360}, 60%, 50%)`;
};

const toTeamMember = (record: Members.MemberRecord): TeamMember => ({
  id: record.id,
  name: record.name,
  role: record.role,
  color: memberColor(record.id),
  ...(record.gitName === null ? {} : { gitName: record.gitName }),
  ...(record.gitEmail === null ? {} : { gitEmail: record.gitEmail }),
  isOwner: record.isOwner,
  createdAt: record.createdAt,
  removedAt: record.removedAt,
});

const roleTransform =
  (role: MemberRole) =>
  (scopes: ReadonlyArray<AuthEnvironmentScope>): ReadonlyArray<AuthEnvironmentScope> => {
    if (role === "member") {
      return scopes.filter((scope) => (MEMBER_SCOPES as ReadonlyArray<string>).includes(scope));
    }
    // Sessions deliberately narrowed below the member bundle, such as read-only MCP, stay so.
    if (!MEMBER_SCOPES.every((scope) => scopes.includes(scope))) return scopes;
    return [...new Set<AuthEnvironmentScope>([...scopes, ...ADMIN_SCOPES])];
  };

const internalError = (message: string) => (cause: unknown) =>
  Effect.logError(message, { cause }).pipe(
    Effect.andThen(Effect.fail(new TeamError({ reason: "internal", message }))),
  );

const make = Effect.gen(function* () {
  const repository = yield* Members.MemberRepository;
  const teamState = yield* TeamState.TeamState;
  const sessions = yield* SessionStore.SessionStore;
  const pairingLinks = yield* PairingGrantStore.PairingGrantStore;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const random = yield* SecureRandom.SecureRandom;
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<TeamMember>();

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const publish = (record: Members.MemberRecord) =>
    Ref.update(teamState.members, (current) => new Map(current).set(record.id, record)).pipe(
      Effect.andThen(PubSub.publish(changes, toTeamMember(record))),
      Effect.as(toTeamMember(record)),
    );

  const requireActive = Effect.fnUntraced(function* (memberId: MemberId) {
    const record = yield* repository
      .getById(memberId)
      .pipe(Effect.catch(internalError("Could not read the team member.")));
    if (Option.isNone(record)) {
      return yield* new TeamError({ reason: "not-found", message: "That member does not exist." });
    }
    if (record.value.removedAt !== null) {
      return yield* new TeamError({ reason: "removed", message: "That member was removed." });
    }
    return record.value;
  });

  const requireNotOwner = (record: Members.MemberRecord) =>
    record.isOwner
      ? Effect.fail(
          new TeamError({
            reason: "owner-immutable",
            message: "The server's owner cannot be removed or change role.",
          }),
        )
      : Effect.void;

  const issueLink = Effect.fnUntraced(function* (
    record: Members.MemberRecord,
    label: string,
    ttlMs?: number,
  ) {
    const link = yield* environmentAuth
      .createPairingLink({
        memberId: record.id,
        scopes: teamRoleScopes(record.role),
        subject: "one-time-token",
        label,
        ttl: ttlMs === undefined ? MEMBER_LINK_TTL : Duration.millis(ttlMs),
      })
      .pipe(
        Effect.catchTags({
          ManagedPolicyRefusedError: (error) =>
            Effect.fail(new TeamError({ reason: "policy-refused", message: error.message })),
        }),
        Effect.catchIf(
          EnvironmentAuth.isServerAuthInternalError,
          internalError("Could not create the member's link."),
        ),
      );
    return {
      member: toTeamMember(record),
      credential: {
        id: link.id,
        credential: link.credential,
        ...(link.label ? { label: link.label } : {}),
        expiresAt: link.expiresAt,
      },
    } satisfies TeamLinkResult;
  });

  const invite: TeamMembers["Service"]["invite"] = Effect.fn("TeamMembers.invite")(
    function* (input) {
      const id = MemberId.make(yield* random.uuidV4().pipe(Effect.orDie));
      const record: Members.MemberRecord = {
        id,
        name: input.name,
        role: input.role,
        gitName: null,
        gitEmail: null,
        isOwner: false,
        createdAt: yield* now,
        updatedAt: null,
        removedAt: null,
      };
      // A refused link leaves no member behind.
      const result = yield* repository
        .insert(record)
        .pipe(
          Effect.catch(internalError("Could not add the team member.")),
          Effect.andThen(issueLink(record, `Invite: ${input.name}`, input.ttlMs)),
          sql.withTransaction,
          Effect.catchTags({ SqlError: internalError("Could not add the team member.") }),
        );
      yield* publish(record);
      return result;
    },
  );

  const signInLink: TeamMembers["Service"]["signInLink"] = Effect.fn("TeamMembers.signInLink")(
    function* (input) {
      const record = yield* requireActive(input.memberId);
      return yield* issueLink(record, `Sign-in: ${record.name}`);
    },
  );

  const updateMember = Effect.fnUntraced(function* (
    memberId: MemberId,
    input: TeamUpdateSelfInput,
  ) {
    yield* requireActive(memberId);
    const updated = yield* repository
      .update({ id: memberId, ...input, updatedAt: yield* now })
      .pipe(Effect.catch(internalError("Could not update the team member.")));
    if (Option.isNone(updated)) {
      return yield* new TeamError({ reason: "not-found", message: "That member does not exist." });
    }
    return yield* publish(updated.value);
  });

  const update: TeamMembers["Service"]["update"] = Effect.fn("TeamMembers.update")(function* ({
    memberId,
    ...input
  }) {
    return yield* updateMember(memberId, input);
  });

  const updateSelf: TeamMembers["Service"]["updateSelf"] = Effect.fn("TeamMembers.updateSelf")(
    function* (memberId, input) {
      return yield* updateMember(memberId, input);
    },
  );

  const setRole: TeamMembers["Service"]["setRole"] = Effect.fn("TeamMembers.setRole")(
    function* (input) {
      const record = yield* requireActive(input.memberId);
      yield* requireNotOwner(record);
      if (record.role === input.role) return toTeamMember(record);
      const updated = yield* repository
        .setRole({ id: record.id, role: input.role, updatedAt: yield* now })
        .pipe(Effect.catch(internalError("Could not change the member's role.")));
      if (Option.isNone(updated)) {
        return yield* new TeamError({
          reason: "not-found",
          message: "That member does not exist.",
        });
      }
      yield* sessions
        .updateScopesForMember(record.id, roleTransform(input.role))
        .pipe(Effect.catch(internalError("Could not update the member's sessions.")));
      // An unused link minted for the old role would still grant it.
      if (input.role === "member") {
        yield* pairingLinks
          .revokeUnconsumedForMember(record.id)
          .pipe(Effect.catch(internalError("Could not revoke the member's links.")));
      }
      return yield* publish(updated.value);
    },
  );

  const remove: TeamMembers["Service"]["remove"] = Effect.fn("TeamMembers.remove")(
    function* (input) {
      const record = yield* requireActive(input.memberId);
      yield* requireNotOwner(record);
      const removed = yield* repository
        .markRemoved({ id: record.id, removedAt: yield* now })
        .pipe(Effect.catch(internalError("Could not remove the team member.")));
      if (Option.isNone(removed)) {
        return yield* new TeamError({ reason: "removed", message: "That member was removed." });
      }
      // Update the snapshot first so in-flight requests stop authenticating.
      const member = yield* publish(removed.value);
      yield* sessions
        .revokeForMember(record.id)
        .pipe(Effect.catch(internalError("Could not revoke the member's sessions.")));
      yield* pairingLinks
        .revokeUnconsumedForMember(record.id)
        .pipe(Effect.catch(internalError("Could not revoke the member's links.")));
      return member;
    },
  );

  // The CLI writes members directly, so a fresh listing rereads them.
  const list = teamState.reload.pipe(
    Effect.catch((cause) => Effect.logWarning("Could not reread the team members.", { cause })),
    Effect.andThen(Ref.get(teamState.members)),
    Effect.map((members) =>
      Array.from(members.values())
        .toSorted(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        )
        .map(toTeamMember),
    ),
  );

  const streamChanges: TeamMembers["Service"]["streamChanges"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before reading so no change falls between the snapshot and the tail.
      const subscription = yield* PubSub.subscribe(changes);
      const members = yield* list;
      return Stream.concat(
        Stream.make({ _tag: "snapshot", members } as const),
        Stream.fromSubscription(subscription).pipe(
          Stream.map((member) => ({ _tag: "upserted", member }) as const),
        ),
      );
    }),
  );

  const resolveOwnerName = Effect.gen(function* () {
    const gitName = yield* processRunner
      .run({
        command: "git",
        args: ["config", "--global", "--get", "user.name"],
        timeout: GIT_NAME_TIMEOUT,
      })
      .pipe(
        Effect.map((output) => (output.code === 0 ? output.stdout.trim() : "")),
        Effect.orElseSucceed(() => ""),
      );
    if (gitName.length > 0) return Option.some(gitName);
    const username = (yield* HostProcess.Username)?.trim() ?? "";
    return username.length > 0 ? Option.some(username) : Option.none<string>();
  });

  // Migration 080 creates the owner as a placeholder; name it once, never over a chosen name.
  yield* Effect.gen(function* () {
    const owner = yield* repository.getOwner();
    if (owner.name !== OWNER_PLACEHOLDER_NAME || owner.updatedAt !== null) return;
    const name = yield* resolveOwnerName;
    if (Option.isNone(name)) return;
    const renamed = yield* repository.update({
      id: owner.id,
      name: name.value,
      updatedAt: yield* now,
    });
    if (Option.isSome(renamed)) yield* publish(renamed.value);
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("Could not name the server's owner.", { cause })),
    Effect.withSpan("TeamMembers.nameOwner"),
  );

  return TeamMembers.of({
    list,
    invite,
    signInLink,
    update,
    updateSelf,
    setRole,
    remove,
    streamChanges,
  });
});

/** Requires a ProcessRunner, for reading git's user.name. */
export const layer = Layer.effect(TeamMembers, make);
