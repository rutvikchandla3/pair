import type { MemberId, TeamImageBuild } from "@t3tools/contracts";

import { teamImageFinishedMessage } from "./teamImageBuildMessage.ts";

/** Agent events from a run, then actions another member took on the thread. */
export type ThreadNotificationKind =
  | "completion"
  | "failed"
  | "limited"
  | "machine-failed"
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
    case "machine-failed":
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

/** The notification's title; its body is the thread title. Web and Pair-sent push share it. */
export function threadNotificationTitle(
  kind: ThreadNotificationKind,
  archiverName: string | null,
): string {
  switch (kind) {
    case "completion":
      return "Thread completed";
    case "failed":
      return "Thread failed";
    case "limited":
      return "Usage limit reached";
    case "machine-failed":
      return "Machine failed";
    case "approval":
      return "Approval needed";
    case "input":
      return "Input needed";
    case "request":
      return "Guest request";
    case "message":
      return "New message";
    case "assigned":
      return "Assigned to you";
    case "archived":
      return `Archived by ${archiverName ?? "another member"}`;
  }
}

/** The machines screen on mobile (its linking path), where a build push opens. */
export const TEAM_IMAGE_DEEP_LINK = "/settings/machines";

/**
 * A finished build's push, or null for a build that was only cancelled. Its recipients are chosen
 * by the server, so it skips `shouldNotifyMember`; it carries the number and phase, never log text.
 */
export function teamImageBuildNotification(
  build: Pick<TeamImageBuild, "id" | "number" | "status" | "failure" | "activateOnSuccess">,
): { readonly title: string; readonly body: string } | null {
  const body = teamImageFinishedMessage(build, build.activateOnSuccess ? build.id : null);
  return body === null ? null : { title: "Team image", body };
}
