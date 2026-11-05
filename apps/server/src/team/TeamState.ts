import { MemberId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { MemberRepositoryError } from "../persistence/Errors.ts";
import * as Members from "../persistence/Members.ts";

/** The member snapshot auth reads on every request, without depending on team management. */
export class TeamState extends Context.Service<
  TeamState,
  {
    readonly ownerId: MemberId;
    /** Every member by id, removed ones included. Mutations write it after the database. */
    readonly members: Ref.Ref<ReadonlyMap<MemberId, Members.MemberRecord>>;
    /** More than one member has not been removed. */
    readonly isTeamMode: Effect.Effect<boolean>;
    /** Rereads the members first when the id is unknown, since the CLI writes them directly. */
    readonly isActive: (memberId: MemberId) => Effect.Effect<boolean, MemberRepositoryError>;
    readonly reload: Effect.Effect<void, MemberRepositoryError>;
    /** Undefined, meaning the server's own identity, unless an active member set a git email. */
    readonly gitAuthorFor: (memberId: MemberId) => Effect.Effect<GitAuthor | undefined>;
  }
>()("t3/team/TeamState") {}

export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

const gitAuthorFor =
  (members: Ref.Ref<ReadonlyMap<MemberId, Members.MemberRecord>>) => (memberId: MemberId) =>
    Ref.get(members).pipe(
      Effect.map((current): GitAuthor | undefined => {
        const member = current.get(memberId);
        if (member === undefined || member.removedAt !== null || member.gitEmail === null) {
          return undefined;
        }
        return { name: member.gitName ?? member.name, email: member.gitEmail };
      }),
    );

const byId = (records: ReadonlyArray<Members.MemberRecord>) =>
  new Map(records.map((record) => [record.id, record] as const));

const isTeamMode = (members: Ref.Ref<ReadonlyMap<MemberId, Members.MemberRecord>>) =>
  Ref.get(members).pipe(
    Effect.map((current) => {
      let active = 0;
      for (const member of current.values()) if (member.removedAt === null) active += 1;
      return active > 1;
    }),
  );

const makeTeamState = Effect.gen(function* () {
  const repository = yield* Members.MemberRepository;
  const owner = yield* repository.getOwner();
  const members = yield* Ref.make<ReadonlyMap<MemberId, Members.MemberRecord>>(
    byId(yield* repository.list()),
  );

  const reload = repository.list().pipe(
    Effect.flatMap((latest) => Ref.set(members, byId(latest))),
    Effect.withSpan("TeamState.reload"),
  );

  // Checked on every authenticated request, inside its authenticate span.
  const isActive = Effect.fnUntraced(function* (memberId: MemberId) {
    if (!(yield* Ref.get(members)).has(memberId)) yield* reload;
    const member = (yield* Ref.get(members)).get(memberId);
    return member !== undefined && member.removedAt === null;
  });

  return TeamState.of({
    ownerId: owner.id,
    members,
    isTeamMode: isTeamMode(members),
    isActive,
    reload,
    gitAuthorFor: gitAuthorFor(members),
  });
});

export const layer = Layer.effect(TeamState, makeTeamState).pipe(Layer.provideMerge(Members.layer));

const TEST_OWNER: Members.MemberRecord = {
  id: MemberId.make("member-owner"),
  name: "Owner",
  role: "admin",
  gitName: null,
  gitEmail: null,
  isOwner: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  removedAt: null,
};

/** A fixed member set with no repository behind it; the first owner record is the owner. */
export const layerTest = (records: ReadonlyArray<Members.MemberRecord> = [TEST_OWNER]) =>
  Layer.effect(
    TeamState,
    Effect.gen(function* () {
      const members = yield* Ref.make<ReadonlyMap<MemberId, Members.MemberRecord>>(byId(records));
      const owner = records.find((record) => record.isOwner) ?? TEST_OWNER;
      return TeamState.of({
        ownerId: owner.id,
        members,
        isTeamMode: isTeamMode(members),
        isActive: Effect.fnUntraced(function* (memberId: MemberId) {
          return (yield* Ref.get(members)).get(memberId)?.removedAt === null;
        }),
        reload: Effect.void,
        gitAuthorFor: gitAuthorFor(members),
      });
    }),
  );
