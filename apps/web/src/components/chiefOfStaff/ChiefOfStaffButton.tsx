import { CheckIcon, MicIcon, MicOffIcon, SquareIcon, XIcon } from "lucide-react";

import {
  isChiefOfStaffLive,
  type ChiefOfStaffPhase,
  type ChiefOfStaffWorkingItem,
} from "../../chiefOfStaff/chiefOfStaff.logic";
import {
  setChiefOfStaffMuted,
  startChiefOfStaff,
  stopChiefOfStaff,
  useChiefOfStaffStore,
} from "../../chiefOfStaff/session";
import { useChiefOfStaffTarget } from "../../chiefOfStaff/useChiefOfStaffTarget";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CHIEF_OF_STAFF_AVATAR_PIXELS, ChiefOfStaffAvatar } from "./ChiefOfStaffAvatar";

const PHASE_LABELS: Readonly<Record<ChiefOfStaffPhase, string>> = {
  idle: "Ready",
  starting: "Starting…",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  closed: "Ended",
};

export function useChiefOfStaffAvatarSettings() {
  return useClientSettings((settings) => ({
    look: settings.chiefOfStaffAvatarStyle,
    accentColor: settings.chiefOfStaffAvatarAccentColor,
    size: settings.chiefOfStaffAvatarSize,
  }));
}

/** The sidebar footer's voice button. Stays visible while a session runs, so it can always be stopped. */
export function ChiefOfStaffSidebarItem() {
  const target = useChiefOfStaffTarget();
  const phase = useChiefOfStaffStore((view) => view.phase);
  const message = useChiefOfStaffStore((view) => view.message);
  const avatar = useChiefOfStaffAvatarSettings();
  // A session that ended with something to say stays reachable until it is read.
  if (!target.available && !isChiefOfStaffLive(phase) && message === null) return null;
  const label = `Chief of staff: ${phase === "closed" && message !== null ? message : PHASE_LABELS[phase]}`;
  return (
    <SidebarMenuItem className="shrink-0">
      <Popover>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger render={<SidebarMenuButton aria-label={label} size="icon" />} />
            }
          >
            <ChiefOfStaffAvatar
              look={avatar.look}
              phase={phase}
              accentColor={avatar.accentColor}
              pixels={CHIEF_OF_STAFF_AVATAR_PIXELS[avatar.size]}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
        <PopoverPopup side="top" align="start" width="md" aria-label="Chief of staff">
          <ChiefOfStaffPanel />
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
}

function ChiefOfStaffPanel() {
  const view = useChiefOfStaffStore();
  const target = useChiefOfStaffTarget();
  const avatar = useChiefOfStaffAvatarSettings();
  const { environments } = useEnvironments();
  const live = isChiefOfStaffLive(view.phase);
  const environmentId = live ? view.environmentId : target.environmentId;
  const environmentLabel =
    target.environmentLabel === null
      ? null
      : (environments.find((environment) => environment.environmentId === environmentId)?.label ??
        null);
  const failed = view.phase === "closed" && view.closeReason === "failed";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <ChiefOfStaffAvatar
          look={avatar.look}
          phase={view.phase}
          accentColor={avatar.accentColor}
          pixels={CHIEF_OF_STAFF_AVATAR_PIXELS[avatar.size] * 2}
        />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm">Chief of staff</div>
          <div className="truncate text-muted-foreground text-xs">
            {PHASE_LABELS[view.phase]}
            {view.muted && live ? " · Muted" : null}
            {environmentLabel === null ? null : ` · ${environmentLabel}`}
          </div>
        </div>
      </div>

      {view.lines.length > 0 ? (
        <ul className="flex flex-col gap-1.5 text-sm">
          {view.lines.map((line) => (
            <li key={line.id} className={cn(!line.final && "text-muted-foreground")}>
              <span className="font-medium">{line.role === "user" ? "You" : "Chief"}: </span>
              {line.text}
            </li>
          ))}
        </ul>
      ) : live ? (
        <p className="text-muted-foreground text-sm">Say what you need. Transcripts show here.</p>
      ) : null}

      {view.working.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs">
          {view.working.map((item) => (
            <WorkingRow key={item.id} item={item} />
          ))}
        </ul>
      ) : null}

      {view.message === null ? null : (
        <p
          role={failed ? "alert" : undefined}
          className={cn(
            "text-sm",
            failed ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {view.message}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {live ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setChiefOfStaffMuted(!view.muted)}
              disabled={view.phase === "starting"}
            >
              {view.muted ? <MicIcon /> : <MicOffIcon />}
              {view.muted ? "Unmute" : "Mute"}
            </Button>
            <Button variant="destructive-outline" size="sm" onClick={stopChiefOfStaff}>
              <SquareIcon />
              Stop
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            disabled={!target.available || target.environmentId === null}
            onClick={() => {
              if (target.environmentId !== null) startChiefOfStaff(target.environmentId);
            }}
          >
            <MicIcon />
            {view.phase === "closed" ? "Start again" : "Start"}
          </Button>
        )}
      </div>
    </div>
  );
}

function WorkingRow({ item }: { item: ChiefOfStaffWorkingItem }) {
  return (
    <li className="flex items-center gap-1.5 text-muted-foreground">
      {item.status === "started" ? (
        <span className="size-1.5 shrink-0 animate-status-pulse rounded-full bg-current motion-reduce:animate-none" />
      ) : item.status === "completed" ? (
        <CheckIcon className="size-3 shrink-0" />
      ) : (
        <XIcon className="size-3 shrink-0 text-destructive-foreground" />
      )}
      <span className="truncate">
        {item.label}
        {item.status === "started" ? "…" : null}
      </span>
    </li>
  );
}
