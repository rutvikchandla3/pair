import type { MemberId } from "@t3tools/contracts";

/** Agent events from a run, then actions another member took on the thread. */
export type ThreadNotificationKind =
  | "completion"
  | "failed"
  | "limited"
  | "approval"
  | "input"
  | "request"
  | "message"
  | "assigned"
  | "archived";

export interface ThreadNotificationEvent {
  readonly kind: ThreadNotificationKind;
  /** The member whose action this is: the message author, assigner or archiver. */
  readonly actorId: MemberId | null;
  /** The member who prompted the run an agent event belongs to. */
  readonly prompterId: MemberId | null;
  /** The thread's holder after the event. */
  readonly ownerId: MemberId | null;
}

export interface ThreadNotificationViewer {
  readonly memberId: MemberId | null;
  readonly teamMode: boolean;
}

/**
 * Who hears of a thread event. A single-member server hears every agent event and none of its
 * own actions. On a team server nobody hears their own action; agent events reach the prompter
 * and the owner, member actions reach the owner. Followers are neither, so they never hear.
 */
export function shouldNotifyMember(
  event: ThreadNotificationEvent,
  viewer: ThreadNotificationViewer,
): boolean {
  const isMemberAction =
    event.kind === "message" || event.kind === "assigned" || event.kind === "archived";
  if (!viewer.teamMode || viewer.memberId === null) return !isMemberAction;
  const me = viewer.memberId;
  if (event.actorId === me) return false;
  switch (event.kind) {
    case "completion":
    case "failed":
    case "limited":
    case "approval":
    case "input":
      return event.prompterId === me || event.ownerId === me;
    case "request":
    case "message":
    case "assigned":
    case "archived":
      return event.ownerId === me;
  }
}
