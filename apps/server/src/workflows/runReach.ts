import type * as Effect from "effect/Effect";

import { viewerMayOpen, type ThreadViewer } from "../orchestration-v2/MemberThreadView.ts";
import type * as Workflows from "./Workflows.ts";

type RunDetail = Effect.Success<ReturnType<Workflows.Workflows["Service"]["get"]>>;

/**
 * Where thread access is enforced, a member reads a run through its threads: every thread its
 * agent steps ran in must open for them. A run that ran in none (a trigger, webhook or schedule
 * start) is for admins, who read everything.
 */
export const mayReadRun = (
  viewer: ThreadViewer | null,
  admin: boolean,
  detail: Pick<RunDetail, "steps">,
): boolean => {
  if (admin || viewer?.access === undefined) return true;
  const threadIds = detail.steps.flatMap((step) =>
    step.threadId !== null && step.environmentId === null ? [step.threadId] : [],
  );
  return threadIds.length > 0 && threadIds.every((threadId) => viewerMayOpen(viewer, threadId));
};
