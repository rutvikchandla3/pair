import { useEnvironmentQuery } from "../../state/query";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useThreadSelection } from "../../state/use-thread-selection";
import { vcsEnvironment } from "../../state/vcs";
import { useThreadGitMenuDefinition } from "../threads/ThreadGitControls";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReviewSectionItem } from "./reviewModel";
import type { AppBarMenuItem, AppBarMenu } from "../../components/ui/AppBar.types";
import type { AppSymbolName } from "../../components/ui/AppSymbol";

interface ReviewHeaderPresentation {
  readonly title: string;
  readonly subtitle: string;
  readonly gitMenu: AppBarMenu | null;
  readonly menuIcon: AppSymbolName;
  readonly refreshAction?: AppBarMenuItem;
}

export function useReviewHeaderPresentation(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly subtitle: string;
  readonly androidSubtitle: string;
  /** The folder whose git status the menu shows; null for a workspace thread. */
  readonly selectedThreadCwd: string | null;
  readonly selectedSection: ReviewSectionItem | null;
  readonly onRefresh: () => Promise<void>;
}): ReviewHeaderPresentation {
  const { selectedThread } = useThreadSelection();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  // A workspace thread's menu acts on its selected repository.
  const statusCwd = gitActions.workspace === null ? props.selectedThreadCwd : gitActions.gitCwd;
  const gitStatusQuery = useEnvironmentQuery(
    selectedThread !== null && statusCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: statusCwd },
        })
      : null,
  );
  // Selection-based git hooks apply only to reviews of the selected thread.
  const gitMenuAvailable =
    selectedThread !== null && String(selectedThread.id) === String(props.threadId);
  const gitMenu = useThreadGitMenuDefinition({
    environmentId: props.environmentId,
    threadId: props.threadId,
    currentBranch: selectedThread?.branch ?? null,
    gitStatus: gitStatusQuery.data,
    gitOperationLabel: gitState.gitOperationLabel,
    workspace: gitActions.workspace,
    onPull: gitActions.onPullSelectedThreadBranch,
    onRunAction: gitActions.onRunSelectedThreadGitAction,
  });
  return {
    title: props.title,
    subtitle: props.subtitle,
    menuIcon: "ellipsis",
    gitMenu: gitMenuAvailable ? gitMenu : null,
  };
}
