import {
  CommandId,
  type MemberId,
  OrchestratorMcpFailure,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ChiefOfStaffHome } from "./ChiefOfStaffHome.ts";
import type { AuditConfirmation } from "./ChiefOfStaffAudit.ts";

/** Long enough for a person to notice the card, short enough not to hold a provider forever. */
const CONFIRMATION_TIMEOUT = Duration.minutes(10);
const POLL_INTERVAL = Duration.millis(500);

/**
 * A risky Chief of staff call waits on a card in the member's home thread. The card is the
 * existing secret-request card: `declined` denies, `saved` allows, and no answer times out.
 */
export class ChiefOfStaffConfirmation extends Context.Service<
  ChiefOfStaffConfirmation,
  {
    readonly confirm: (input: {
      readonly via: "voice" | "home-thread";
      readonly memberId?: MemberId;
      readonly threadId?: ThreadId;
      readonly tool: string;
      readonly summary: string;
    }) => Effect.Effect<AuditConfirmation, OrchestratorMcpFailure>;
  }
>()("t3/chiefOfStaff/ChiefOfStaffConfirmation") {}

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const home = yield* ChiefOfStaffHome;
  const random = yield* SecureRandom.SecureRandom;

  /** The run whose card this is: the home thread's newest active turn. */
  const activeRunOf = Effect.fn("ChiefOfStaffConfirmation.activeRunOf")(function* (
    threadId: ThreadId,
  ) {
    const records = yield* threads
      .getThreadRecords(threadId, ["runs"], { messageRoles: [] })
      .pipe(
        Effect.mapError((cause) =>
          denied(`Unable to read Chief of staff's chat thread: ${String(cause)}`),
        ),
      );
    const run = ThreadManagementService.latestActiveRun({ runs: records.runs });
    return run !== undefined && run.rootNodeId !== null
      ? { run, nodeId: run.rootNodeId }
      : undefined;
  });

  const waitForAnswer = Effect.fn("ChiefOfStaffConfirmation.waitForAnswer")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
  }) {
    const window = yield* Effect.gen(function* () {
      while (true) {
        const records = yield* threads
          .getThreadRecords(input.threadId, ["runs", "turnItems"], {
            turnItemTypes: ["secret_request"],
            messageRoles: [],
          })
          .pipe(
            Effect.mapError((cause) =>
              denied(`Unable to read the confirmation card: ${String(cause)}`),
            ),
          );
        const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
        if (item?.type === "secret_request" && item.secretStatus !== "pending") {
          return item.secretStatus;
        }
        const run = records.runs.find((candidate) => candidate.id === item?.runId);
        if (run !== undefined && ThreadManagementService.isTerminalRunStatus(run.status)) {
          return "cancelled" as const;
        }
        yield* Effect.sleep(POLL_INTERVAL);
      }
    }).pipe(Effect.timeoutOption(CONFIRMATION_TIMEOUT));
    return Option.isSome(window) ? window.value : ("timed_out" as const);
  });

  const confirm: ChiefOfStaffConfirmation["Service"]["confirm"] = Effect.fn(
    "ChiefOfStaffConfirmation.confirm",
  )(function* (input) {
    const threadId =
      input.threadId ??
      (input.memberId === undefined ? undefined : yield* home.homeThreadId(input.memberId));
    if (threadId === undefined) {
      return yield* denied("Chief of staff has no chat thread to ask you in yet.");
    }
    const active = yield* activeRunOf(threadId);
    if (active === undefined) {
      return yield* denied(
        "Chief of staff is not in a turn right now, so the card cannot be answered. Try again while it is working.",
      );
    }
    const turnItemId = TurnItemId.make(
      `turn-item:confirmation:${threadId}:${yield* random.uuidV4()}`,
    );
    const label = `Allow Chief of staff to ${input.tool}?`;
    const reason = `${input.summary}\nType "allow" and save to approve, or Decline to refuse.`;
    yield* threads
      .dispatch({
        type: "secret_request.record",
        commandId: CommandId.make(`confirmation:${turnItemId}:pending`),
        threadId,
        runId: active.run.id,
        nodeId: active.nodeId,
        turnItemId,
        label,
        reason,
        placeholder: "allow",
        secretStatus: "pending",
      })
      .pipe(
        Effect.mapError((cause) => denied(`Could not show the approval card: ${String(cause)}`)),
      );
    const status = yield* waitForAnswer({ threadId, turnItemId });
    if (status === "saved") return "allowed" as const;
    if (status === "declined") return "denied" as const;
    // `cancelled` (the run ended) and `timed_out` both mean the person never decided.
    yield* threads
      .dispatch({
        type: "secret_request.record",
        commandId: CommandId.make(`confirmation:${turnItemId}:cancelled`),
        threadId,
        runId: active.run.id,
        nodeId: active.nodeId,
        turnItemId,
        label,
        reason,
        placeholder: "allow",
        secretStatus: "cancelled",
      })
      .pipe(Effect.ignore);
    return "timeout" as const;
  });

  return ChiefOfStaffConfirmation.of({ confirm });
});

export const layer = Layer.effect(ChiefOfStaffConfirmation, make);
