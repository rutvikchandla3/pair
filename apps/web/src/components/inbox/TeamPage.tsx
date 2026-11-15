import type { ReactNode } from "react";

import { isElectron } from "../../env";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

/** Inbox, My tasks and Shared with you: a header row, then the page in the main column. */
export function TeamPage(props: {
  readonly title: string;
  /** Muted text after the title: "10 open". */
  readonly meta?: ReactNode;
  /** Controls next to the title: the Inbox's group switch. */
  readonly controls?: ReactNode;
  /** Controls at the header's end. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, props.title)}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <h1 className="shrink-0 font-semibold text-sm">{props.title}</h1>
          {props.meta === undefined ? null : (
            <span className="truncate text-muted-foreground text-sm">{props.meta}</span>
          )}
          {props.controls}
          <div className="ml-auto flex shrink-0 items-center gap-2">{props.actions}</div>
        </WorkspacePageHeader>
        {props.children}
      </div>
    </SidebarInset>
  );
}
