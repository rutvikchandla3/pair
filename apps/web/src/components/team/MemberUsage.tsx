import type { EnvironmentId, MemberId, TeamUsageRow } from "@t3tools/contracts";
import { formatCount, formatTokens } from "@t3tools/shared/usageFormat";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { teamEnvironment, useIsTeamMode } from "~/state/team";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Floored to the minute so every member row that mounts together shares one request. */
function lastSevenDaysSince(): string {
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  return new Date(minute - WEEK_MS).toISOString();
}

const plural = (count: number, word: string) =>
  `${formatCount(count)} ${word}${count === 1 ? "" : "s"}`;

const summarize = (rows: ReadonlyArray<TeamUsageRow>) => {
  let turns = 0;
  let tokens = 0;
  for (const row of rows) {
    turns += row.turns;
    tokens += row.inputTokens + row.outputTokens;
  }
  return `${plural(turns, "turn")} · ${formatTokens(tokens)} tokens`;
};

/** A member's turns and tokens over the last 7 days, per provider instance. Team mode only. */
export function MemberUsage({
  environmentId,
  memberId,
}: {
  readonly environmentId: EnvironmentId;
  readonly memberId: MemberId;
}) {
  const isTeamMode = useIsTeamMode(environmentId);
  const [since] = useState(lastSevenDaysSince);
  const usage = useEnvironmentQuery(
    isTeamMode ? teamEnvironment.teamUsageAtom(environmentId, since) : null,
  );
  const providerInstances = useEnvironmentSettings(
    environmentId,
    (settings) => settings.providerInstances,
  );
  const [open, setOpen] = useState(false);
  const rows = usage.data?.rows.filter((row) => row.memberId === memberId) ?? [];
  if (rows.length === 0) return null;
  const unmeasured = rows.some((row) => row.unmeasuredTurns > 0);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger render={<Button size="micro" variant="ghost-muted" />}>
        Last 7 days: {summarize(rows)}
        <ChevronRightIcon aria-hidden className={cn(open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        <ul className="space-y-0.5 px-1.5 pt-1 text-xs text-muted-foreground">
          {rows.map((row) => (
            <li key={row.providerInstanceId}>
              {providerInstances[row.providerInstanceId]?.displayName ?? row.providerInstanceId}:{" "}
              {summarize([row])}
            </li>
          ))}
          {unmeasured ? <li>Some providers don&apos;t report tokens</li> : null}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  );
}
