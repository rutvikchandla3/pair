import type { SpaceViewer } from "@t3tools/client-runtime/spaces";
import { type InboxItem, MemberId, SpaceId, SpaceTaskId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { InboxList, InboxSnoozedList } from "./InboxPage";

const ME = MemberId.make("member-me");
const KOUSIK = MemberId.make("member-kousik");
const VIEWER: SpaceViewer = {
  memberId: ME,
  nameOf: (id) => (id === KOUSIK ? "Kousik" : "Someone"),
};

const ITEMS: ReadonlyArray<InboxItem> = [
  // The server sends newest first across both groups; Needs you still lists first.
  {
    id: "mention:1",
    group: "for-you",
    reason: "mention",
    at: "2026-11-15T10:05:00.000Z",
    actorId: KOUSIK,
    spaceId: SpaceId.make("spc_00000000000000000001"),
    spaceName: "Question creation",
    excerpt: "@me does difficulty belong in the schema?",
  },
  {
    id: "approval:thread-1:request-1",
    group: "needs-you",
    reason: "approval",
    at: "2026-11-15T10:04:00.000Z",
    actorId: null,
    threadId: ThreadId.make("thread-1"),
    threadTitle: "Seed role catalog",
    threadOwnerId: ME,
    excerpt: "pnpm db:migrate",
  },
  {
    id: "task:assigned:1",
    group: "needs-you",
    reason: "task-assigned",
    at: "2026-11-15T09:00:00.000Z",
    actorId: KOUSIK,
    spaceId: SpaceId.make("spc_00000000000000000001"),
    spaceName: "Question creation",
    taskId: SpaceTaskId.make("stk_00000000000000000001"),
    taskTitle: "Trial banner copy",
  },
];

function Harness(props: {
  readonly onOpen: (item: InboxItem) => void;
  readonly onDone: (item: InboxItem) => void;
}) {
  const [selectedId, setSelectedId] = useState<string>("approval:thread-1:request-1");
  return (
    <InboxList
      items={ITEMS}
      selectedId={selectedId}
      needsYouCount={2}
      viewer={VIEWER}
      onSelect={setSelectedId}
      onOpen={props.onOpen}
      onDone={props.onDone}
      onSnooze={() => undefined}
    />
  );
}

describe("InboxList", () => {
  it("j and k move, Enter opens, and e marks only a For you item done", async () => {
    const onOpen = vi.fn();
    const onDone = vi.fn();
    await using screen = await render(<Harness onOpen={onOpen} onDone={onDone} />);
    const options = screen.getByRole("option");
    const selectedTitle = () =>
      options.elements().find((option) => option.getAttribute("aria-selected") === "true")
        ?.textContent;

    expect(options.elements().map((option) => option.textContent)).toEqual([
      expect.stringContaining("Approve `pnpm db:migrate`"),
      expect.stringContaining("Kousik assigned you Trial banner copy"),
      expect.stringContaining("Kousik mentioned you"),
    ]);
    (screen.getByRole("listbox", { name: "Inbox" }).element() as HTMLElement).focus();

    await userEvent.keyboard("e");
    expect(onDone).not.toHaveBeenCalled();

    await userEvent.keyboard("j");
    await vi.waitFor(() => expect(selectedTitle()).toContain("Trial banner copy"));
    await userEvent.keyboard("j");
    await vi.waitFor(() => expect(selectedTitle()).toContain("mentioned you"));
    // Held at the end.
    await userEvent.keyboard("j");
    await vi.waitFor(() => expect(selectedTitle()).toContain("mentioned you"));

    await userEvent.keyboard("e");
    expect(onDone).toHaveBeenCalledExactlyOnceWith(ITEMS[0]);

    await userEvent.keyboard("k");
    await vi.waitFor(() => expect(selectedTitle()).toContain("Trial banner copy"));
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ITEMS[2]);
  });
});

describe("InboxSnoozedList", () => {
  it("lists each snoozed task with Unsnooze", async () => {
    const onUnsnooze = vi.fn();
    const snoozed: InboxItem = { ...ITEMS[2]!, snoozedUntil: "2999-01-01T09:00:00.000Z" };
    await using screen = await render(
      <InboxSnoozedList
        items={[snoozed]}
        viewer={VIEWER}
        onOpen={() => undefined}
        onUnsnooze={onUnsnooze}
      />,
    );
    await expect.element(screen.getByText("Kousik assigned you Trial banner copy")).toBeVisible();
    await expect.element(screen.getByText(/Wakes in \d+d/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Unsnooze" }));
    expect(onUnsnooze).toHaveBeenCalledExactlyOnceWith(snoozed);
  });
});
