import { MemberId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { PairBuilderPerson } from "../auth/PairBuilderIngress.ts";
import * as Members from "../persistence/Members.ts";
import * as TeamState from "./TeamState.ts";

export class PairBuilderMemberRemovedError extends Schema.TaggedError<PairBuilderMemberRemovedError>()(
  "PairBuilderMemberRemovedError",
  { memberId: MemberId },
) {
  override get message(): string {
    return "This Pair Builder user was removed from the team.";
  }
}

export class PairBuilderMemberWriteError extends Schema.TaggedError<PairBuilderMemberWriteError>()(
  "PairBuilderMemberWriteError",
  {
    operation: Schema.Literals(["reload", "create", "rename"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the Pair Builder user's team member.`;
  }
}

/** Team members for Pair Builder users, in host mode, bound by the Builder's user id. */
export class PairBuilderMembers extends Context.Service<
  PairBuilderMembers,
  {
    /**
     * The member bound to the Builder user, added as a `member` on first sight and renamed to
     * follow the Builder. A removed member stays removed.
     */
    readonly resolve: (
      person: PairBuilderPerson,
    ) => Effect.Effect<
      Members.MemberRecord,
      PairBuilderMemberRemovedError | PairBuilderMemberWriteError
    >;
  }
>()("t3/team/PairBuilderMembers") {}

const make = Effect.gen(function* () {
  const repository = yield* Members.MemberRepository;
  const teamState = yield* TeamState.TeamState;
  const random = yield* SecureRandom.SecureRandom;
  // Two first requests from one person must not both insert them.
  const creation = yield* Semaphore.make(1);

  const find = (builderUserId: string) =>
    Ref.get(teamState.members).pipe(
      Effect.map((members) =>
        Array.from(members.values()).find((member) => member.pairBuilderUserId === builderUserId),
      ),
    );

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  // Runs inside every ingress request's authenticate span.
  const settle = Effect.fnUntraced(function* (
    record: Members.MemberRecord,
    person: PairBuilderPerson,
  ) {
    if (record.removedAt !== null) {
      return yield* new PairBuilderMemberRemovedError({ memberId: record.id });
    }
    if (record.name === person.name) return record;
    const renamed = yield* repository
      .update({ id: record.id, name: person.name, updatedAt: yield* now })
      .pipe(
        Effect.mapError((cause) => new PairBuilderMemberWriteError({ operation: "rename", cause })),
      );
    if (Option.isNone(renamed)) {
      return yield* new PairBuilderMemberRemovedError({ memberId: record.id });
    }
    yield* teamState.publish(renamed.value);
    return renamed.value;
  });

  const create = Effect.fn("PairBuilderMembers.create")(function* (person: PairBuilderPerson) {
    // The CLI writes members directly, so one may exist that the snapshot has not seen.
    yield* teamState.reload.pipe(
      Effect.mapError((cause) => new PairBuilderMemberWriteError({ operation: "reload", cause })),
    );
    const existing = yield* find(person.id);
    if (existing !== undefined) return yield* settle(existing, person);
    const record: Members.MemberRecord = {
      id: MemberId.make(yield* random.uuidV4().pipe(Effect.orDie)),
      name: person.name,
      role: "member",
      gitName: null,
      gitEmail: null,
      isOwner: false,
      createdAt: yield* now,
      updatedAt: null,
      removedAt: null,
      pairBuilderUserId: person.id,
    };
    yield* repository
      .insert(record)
      .pipe(
        Effect.mapError((cause) => new PairBuilderMemberWriteError({ operation: "create", cause })),
      );
    yield* teamState.publish(record);
    yield* Effect.logInfo("Added a Pair Builder user to the team.", { memberId: record.id });
    return record;
  }, creation.withPermits(1));

  const resolve: PairBuilderMembers["Service"]["resolve"] = Effect.fnUntraced(function* (person) {
    const known = yield* find(person.id);
    return known === undefined ? yield* create(person) : yield* settle(known, person);
  });

  return PairBuilderMembers.of({ resolve });
});

export const layer = Layer.effect(PairBuilderMembers, make);
