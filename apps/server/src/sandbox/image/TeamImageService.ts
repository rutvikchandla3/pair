import {
  CommandId,
  type ComputeDriverId,
  EventId,
  type MemberId,
  SandboxId,
  type TeamImageBuild,
  TeamImageBuildId,
  type TeamImageBuildLogChunk,
  TeamImageError,
  type TeamImageRecipeRevision,
  type TeamImageSaveRecipeInput,
  type TeamImageSnapshot,
  type TeamImageStartBuildInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../../config.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TeamState from "../../team/TeamState.ts";
import * as SandboxAdmission from "../lifecycle/SandboxAdmission.ts";
import * as LiveTeamImageBuild from "./LiveTeamImageBuild.ts";
import {
  decideTeamImageCommand,
  isLiveTeamImageBuild,
  type TeamImageCommand,
  TeamImageEvent,
  type TeamImageState,
} from "./TeamImageCommands.ts";
import * as TeamImageBuildLog from "./TeamImageBuildLog.ts";
import { DEFAULT_KEEP_SUCCEEDED } from "./TeamImageCollection.ts";
import * as TeamImageStore from "./TeamImageStore.ts";

/** The snapshot's history: the newest builds, plus the active one when it is older. */
const RECENT_BUILDS = 20;

/** A build reached succeeded, failed or cancelled; 4.18 and 4.21 tell the recipients. */
export interface TeamImageBuildFinished {
  readonly build: TeamImageBuild;
  readonly recipients: ReadonlyArray<MemberId>;
}

export type TeamImageDispatchError =
  | TeamImageError
  | TeamImageStore.TeamImageStoreError
  | EventSink.EventSinkV2Error
  | CommandReceiptStore.CommandReceiptStoreV2Error;

/** The team image's one writer: every command goes through `dispatch`, one at a time. */
export class TeamImageService extends Context.Service<
  TeamImageService,
  {
    /** The events it committed; none for a replayed command id or a step that changes nothing. */
    readonly dispatch: (
      command: TeamImageCommand,
    ) => Effect.Effect<ReadonlyArray<TeamImageEvent>, TeamImageDispatchError>;
    readonly snapshot: Effect.Effect<TeamImageSnapshot, TeamImageError>;
    /** The snapshot, then a new one after each committed command. */
    readonly changes: Stream.Stream<TeamImageSnapshot, TeamImageError>;
    readonly saveRecipe: (input: {
      readonly actorId: MemberId;
      readonly input: TeamImageSaveRecipeInput;
    }) => Effect.Effect<TeamImageRecipeRevision, TeamImageError>;
    /** Takes a machine slot like a session; refused rather than queued when none is free. */
    readonly startBuild: (input: {
      readonly actorId: MemberId;
      readonly input: TeamImageStartBuildInput;
    }) => Effect.Effect<TeamImageBuild, TeamImageError>;
    readonly cancelBuild: (input: {
      readonly actorId: MemberId;
      readonly imageBuildId: TeamImageBuildId;
    }) => Effect.Effect<void, TeamImageError>;
    /** What new sandboxes boot from; never waits for a running build, and an older build is the rollback. */
    readonly activateBuild: (input: {
      readonly actorId: MemberId;
      readonly imageBuildId: TeamImageBuildId;
    }) => Effect.Effect<void, TeamImageError>;
    /** Each build that ends from here on, with who should hear of it. */
    readonly buildFinished: Stream.Stream<TeamImageBuildFinished>;
    readonly readRecipeRevision: (
      revision: number,
    ) => Effect.Effect<TeamImageRecipeRevision, TeamImageError>;
    /** The log so far, then its lines while the build runs, then `done`. */
    readonly subscribeBuildLog: (
      imageBuildId: TeamImageBuildId,
    ) => Stream.Stream<TeamImageBuildLogChunk, TeamImageError>;
  }
>()("t3/sandbox/image/TeamImageService") {}

const encodeEvent = Schema.encodeSync(Schema.toCodecJson(TeamImageEvent));
const TeamImageErrorJson = Schema.fromJsonString(TeamImageError);
const encodeError = Schema.encodeSync(TeamImageErrorJson);
const decodeError = Schema.decodeUnknownOption(TeamImageErrorJson);

const isTeamImageError = Schema.is(TeamImageError);

const refusal = (reason: TeamImageError["reason"], message: string) =>
  new TeamImageError({ reason, message });

/** Storage failures are not something a client can act on, so they surface as defects. */
const onlyTeamImageErrors = <A, R>(effect: Effect.Effect<A, TeamImageDispatchError, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is Exclude<TeamImageDispatchError, TeamImageError> => !isTeamImageError(error),
      Effect.die,
    ),
  );

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const make = Effect.gen(function* () {
  const store = yield* TeamImageStore.TeamImageStore;
  const eventSink = yield* EventSink.EventSinkV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const liveBuild = yield* LiveTeamImageBuild.LiveTeamImageBuild;
  const admission = yield* SandboxAdmission.SandboxAdmission;
  const settings = yield* ServerSettings.ServerSettingsService;
  const teamState = yield* TeamState.TeamState;
  const random = yield* SecureRandom.SecureRandom;
  const buildLog = yield* TeamImageBuildLog.TeamImageBuildLog;
  const { cloudOnly } = yield* ServerConfig.ServerConfig;
  const lock = yield* Semaphore.make(1);
  const version = yield* SubscriptionRef.make(0);
  const finished = yield* PubSub.unbounded<TeamImageBuildFinished>();

  const seeded = yield* store.liveBuild.pipe(Effect.orDie);
  yield* liveBuild.set(
    seeded === null ? null : { imageBuildId: seeded.build.id, driverId: seeded.build.driverId },
  );

  const randomHex = random.randomBytes(10).pipe(Effect.map(toHex));
  const freshCommandId = (type: TeamImageCommand["type"]) =>
    randomHex.pipe(Effect.map((hex) => CommandId.make(`server:${type}:${hex}`)));

  const readState = Effect.fnUntraced(function* (command: TeamImageCommand) {
    const { activeBuildId, nextBuildNumber } = yield* store.state;
    const latest = yield* store.latestRevision;
    const named =
      command.type === "team-image.recipe.save" || command.type === "team-image.build.request"
        ? Option.none()
        : yield* store.build(command.imageBuildId);
    return {
      latestRevision: latest?.revision ?? null,
      activeBuildId,
      nextBuildNumber,
      liveBuild: yield* store.liveBuild,
      build: Option.getOrNull(named),
    } satisfies TeamImageState;
  });

  const fromReceipt = (receipt: CommandReceiptStore.TeamImageCommandReceiptV2) =>
    receipt.status === "accepted"
      ? Effect.succeed([])
      : Effect.fail(
          Option.getOrElse(decodeError(receipt.error), () =>
            refusal(null, receipt.error ?? "The command was refused."),
          ),
        );

  const isActiveAdmin = Effect.fnUntraced(function* (memberId: MemberId) {
    if (!(yield* teamState.isTeamMode)) return true;
    const member = (yield* Ref.get(teamState.members)).get(memberId);
    return member?.role === "admin" && member.removedAt === null;
  });

  // Decision #10: an agent's build is announced to the admins among its run's authors.
  const recipientsOf = Effect.fnUntraced(function* (
    build: TeamImageBuild,
    cancelledBy: MemberId | null,
  ) {
    const { requestedBy } = build;
    const candidates =
      requestedBy.kind === "member"
        ? [requestedBy.memberId]
        : yield* Effect.filter(requestedBy.authorIds, isActiveAdmin);
    return candidates.filter((memberId) => memberId !== cancelledBy);
  });

  const publish = Effect.fnUntraced(function* (
    command: TeamImageCommand,
    events: ReadonlyArray<TeamImageEvent>,
  ) {
    const ends =
      command.type === "team-image.build.captured" ||
      command.type === "team-image.build.fail" ||
      command.type === "team-image.build.cancel";
    for (const event of events) {
      if (event.type !== "team-image.build-updated") continue;
      const { build } = event;
      if (isLiveTeamImageBuild(build.status)) {
        yield* liveBuild.set({ imageBuildId: build.id, driverId: build.driverId });
      } else if ((yield* liveBuild.current)?.imageBuildId === build.id) {
        yield* liveBuild.set(null);
      }
      if (ends && !isLiveTeamImageBuild(build.status)) {
        const cancelledBy = command.type === "team-image.build.cancel" ? command.by : null;
        yield* PubSub.publish(finished, {
          build,
          recipients: yield* recipientsOf(build, cancelledBy),
        });
      }
    }
    yield* SubscriptionRef.update(version, (current) => current + 1);
  });

  const dispatch = Effect.fn("TeamImageService.dispatch")(function* (command: TeamImageCommand) {
    const replayed = yield* receipts.getTeamImageByCommandId(command.commandId);
    if (Option.isSome(replayed)) return yield* fromReceipt(replayed.value);
    const now = yield* DateTime.now;
    const decided = decideTeamImageCommand(yield* readState(command), command, now);
    if (Result.isFailure(decided)) {
      yield* eventSink.commitRejectedTeamImageCommand({
        commandId: command.commandId,
        commandType: command.type,
        rejectedAt: now,
        error: encodeError(decided.failure),
      });
      return yield* decided.failure;
    }
    const { events, effects, cancelUnsettledEffects } = decided.success;
    if (events.length === 0 && effects.length === 0) return [];
    const committed = yield* eventSink.commitTeamImageCommand({
      commandId: command.commandId,
      commandType: command.type,
      acceptedAt: now,
      events: events.map((event, index) => ({
        eventId: EventId.make(`event:${command.commandId}:${index}`),
        type: event.type,
        occurredAt: DateTime.formatIso(now),
        payload: encodeEvent(event),
      })),
      effects: effects.map((request) => ({
        id: `effect:${command.commandId}:${request.type}`,
        commandId: command.commandId,
        request,
      })),
      ...(cancelUnsettledEffects === undefined ? {} : { cancelUnsettledEffects }),
      apply: () => store.apply(events),
    });
    if (!committed.committed) return yield* fromReceipt(committed.receipt);
    yield* publish(command, events);
    return events;
  });

  const lockedDispatch = (command: TeamImageCommand) => lock.withPermits(1)(dispatch(command));

  const ensureAvailable = cloudOnly
    ? Effect.void
    : Effect.fail(refusal("not-available", "Team images need a Pair Cloud server."));

  const ensureAdmin = Effect.fnUntraced(function* (actorId: MemberId) {
    if (!(yield* teamState.isTeamMode)) return;
    const actor = (yield* Ref.get(teamState.members)).get(actorId);
    if (actor?.role === "admin" && actor.removedAt === null) return;
    return yield* refusal("not-admin", "Only an admin can change the team image.");
  });

  const settingsNow = settings.getSettings.pipe(Effect.orDie);

  const buildDriver = Effect.fnUntraced(function* () {
    const sandbox = (yield* settingsNow).sandbox;
    const driver =
      sandbox?.drivers.find((candidate) => candidate.id === sandbox.defaultDriverId) ??
      sandbox?.drivers[0];
    if (driver === undefined) {
      return yield* refusal("not-available", "Add a machine driver in Compute before building.");
    }
    return driver.id satisfies ComputeDriverId;
  });

  const snapshot = Effect.gen(function* () {
    yield* ensureAvailable;
    const { activeBuildId } = yield* store.state;
    const recent = yield* store.recentBuilds(RECENT_BUILDS);
    const active =
      activeBuildId === null || recent.some((build) => build.id === activeBuildId)
        ? Option.none()
        : yield* store.build(activeBuildId);
    return {
      recipe: yield* store.latestRevision,
      activeBuildId,
      builds: Option.isSome(active) ? [...recent, active.value.build] : recent,
      proposals: [],
      keepSucceeded:
        (yield* settingsNow).sandbox?.teamImage?.keepSucceeded ?? DEFAULT_KEEP_SUCCEEDED,
    } satisfies TeamImageSnapshot;
  }).pipe(onlyTeamImageErrors, Effect.withSpan("TeamImageService.snapshot"));

  const saveRecipe: TeamImageService["Service"]["saveRecipe"] = Effect.fn(
    "TeamImageService.saveRecipe",
  )(function* ({ actorId, input }) {
    yield* ensureAvailable;
    yield* ensureAdmin(actorId);
    const events = yield* lockedDispatch({
      type: "team-image.recipe.save",
      commandId: yield* freshCommandId("team-image.recipe.save"),
      baseRevision: input.baseRevision,
      recipe: input.recipe,
      savedBy: { kind: "member", memberId: actorId },
    });
    const saved = events.find((event) => event.type === "team-image.recipe-saved");
    if (saved === undefined) return yield* Effect.die("A recipe save committed no revision.");
    return saved.revision;
  }, onlyTeamImageErrors);

  const startBuild: TeamImageService["Service"]["startBuild"] = Effect.fn(
    "TeamImageService.startBuild",
  )(function* ({ actorId, input }) {
    yield* ensureAvailable;
    yield* ensureAdmin(actorId);
    const driverId = yield* buildDriver();
    const imageBuildId = TeamImageBuildId.make(`tib_${yield* randomHex}`);
    const machineSandboxId = SandboxId.make(`sbx_${yield* randomHex}`);
    // Admission's lock is always taken before the service's.
    const events = yield* admission.withLock(
      Effect.gen(function* () {
        // A running build is refused by the decider with its own reason, not as a full cap.
        if ((yield* liveBuild.current) === null) {
          const slots = yield* admission.snapshot(driverId).pipe(Effect.orDie);
          if (slots.draining) {
            return yield* refusal(
              "draining",
              "Pair Cloud is draining before an upgrade. Build after it restarts.",
            );
          }
          if (slots.running + slots.waiting >= slots.cap) {
            return yield* refusal(
              "no-capacity",
              "Every machine is in use. Build when one frees up, or raise the limit in Compute.",
            );
          }
        }
        const committed = yield* lockedDispatch({
          type: "team-image.build.request",
          commandId: CommandId.make(`server:team-image.build.request:${imageBuildId}`),
          imageBuildId,
          machineSandboxId,
          recipeRevision: input.recipeRevision,
          driverId,
          requestedBy: { kind: "member", memberId: actorId },
          // A build from the page goes live when it succeeds; 4.19's agent builds pass false.
          activateOnSuccess: true,
        });
        yield* admission.takeStart;
        return committed;
      }),
    );
    const requested = events.find((event) => event.type === "team-image.build-updated");
    if (requested === undefined) return yield* Effect.die("A build request committed no build.");
    return requested.build;
  }, onlyTeamImageErrors);

  const cancelBuild: TeamImageService["Service"]["cancelBuild"] = Effect.fn(
    "TeamImageService.cancelBuild",
  )(function* ({ actorId, imageBuildId }) {
    yield* ensureAvailable;
    yield* ensureAdmin(actorId);
    yield* lockedDispatch({
      type: "team-image.build.cancel",
      commandId: yield* freshCommandId("team-image.build.cancel"),
      imageBuildId,
      by: actorId,
    });
  }, onlyTeamImageErrors);

  const activateBuild: TeamImageService["Service"]["activateBuild"] = Effect.fn(
    "TeamImageService.activateBuild",
  )(function* ({ actorId, imageBuildId }) {
    yield* ensureAvailable;
    yield* ensureAdmin(actorId);
    yield* lockedDispatch({
      type: "team-image.build.activate",
      commandId: yield* freshCommandId("team-image.build.activate"),
      imageBuildId,
      by: actorId,
    });
  }, onlyTeamImageErrors);

  const readRecipeRevision: TeamImageService["Service"]["readRecipeRevision"] = Effect.fn(
    "TeamImageService.readRecipeRevision",
  )(function* (revision) {
    yield* ensureAvailable;
    const found = yield* store.readRevision(revision);
    if (Option.isNone(found)) {
      return yield* refusal("not-found", `Recipe revision ${revision} does not exist.`);
    }
    return found.value;
  }, onlyTeamImageErrors);

  const subscribeBuildLog: TeamImageService["Service"]["subscribeBuildLog"] = (imageBuildId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* ensureAvailable;
        const record = yield* store.build(imageBuildId);
        if (Option.isNone(record)) {
          return yield* refusal("not-found", "That build does not exist.");
        }
        const { number } = record.value.build;
        // A live build's writer opens once its program starts; wait for it or for the end.
        yield* Effect.raceFirst(
          buildLog.whenOpen(number),
          liveBuild.changes.pipe(
            Stream.filter((live) => live?.imageBuildId !== imageBuildId),
            Stream.runHead,
          ),
        );
        return buildLog.read(number).pipe(Stream.orDie);
      }).pipe(onlyTeamImageErrors),
    ).pipe(Stream.withSpan("TeamImageService.subscribeBuildLog"));

  // A restart ends the program and the runner wait; queued and capturing builds replay safely.
  if (
    seeded !== null &&
    (seeded.build.status === "launching" || seeded.build.status === "running")
  ) {
    yield* lockedDispatch({
      type: "team-image.build.fail",
      commandId: CommandId.make(`server:team-image.build.interrupted:${seeded.build.id}`),
      imageBuildId: seeded.build.id,
      failure: {
        phase: "interrupted",
        detail: "Pair Cloud restarted during this build.",
        logTail: [],
      },
    }).pipe(Effect.orDie);
  }

  return TeamImageService.of({
    dispatch: lockedDispatch,
    snapshot,
    changes: SubscriptionRef.changes(version).pipe(Stream.mapEffect(() => snapshot)),
    saveRecipe,
    startBuild,
    cancelBuild,
    activateBuild,
    buildFinished: Stream.fromPubSub(finished),
    readRecipeRevision,
    subscribeBuildLog,
  });
});

export const layer = Layer.effect(TeamImageService, make);
