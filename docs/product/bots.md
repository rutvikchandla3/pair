# Bots

Status: design v4 (chat-first), 2026-11-18, with character and a chat that never waits,
2026-11-19. Replaces v3's Briefing design.
Screens: [bots-chat-prototype](./bots-chat-prototype/README.md).

> "It is a single chat where someone can continuously write stuff and the bot handles everything
> async." The user, rejecting v3's Briefing / Chat / Playbook tabs.

A **bot** is a named agent you keep. It is **one chat**. You write to it the way you'd write to a
person who runs your work: "fix the sidebar flicker", "also rate-limit the threads API", "what's
left?", "stop that one". It starts coding **sessions** in your projects, keeps them moving, answers
their questions the way you would, and writes to you in the same chat when something is done or
needs you. You never open a session to find out what's going on, and you never fill in a form to
give it work.

It is single-user. It is not a Space, a provider, or a voice assistant.

## Rules

1. **The chat is the product.** The bot page is the bot's home thread rendered by T3's own
   `ChatView`: T3's timeline, T3's composer, T3's model chip, T3's queue-while-running behaviour. No
   custom composer, no job form, no tabs.
2. **Work goes in by typing.** The bot turns your message into jobs itself.
3. **Everything comes back into the chat.** Pair's wake-ups label T3's turn folds; the bot's reply
   follows. Questions, finished work and problems all arrive as messages.
4. **The bot's sessions are one click away**, as T3 thread links in its messages and nested under
   the bot in the sidebar.
5. **Memory is visible.** What it learned is listed in a Memory panel, and talking to it edits the
   same list.
6. **The chat never waits on the bot.** The bot never does work in its own turn, however small.
   Every product we looked at (OpenBot, Grok Bot, Capy, Claude Projects) runs one front-agent turn
   at a time; they feel responsive because that turn is short. So is this one: plan, start
   sessions, reply.

## What the user sees

### Sidebar

**Bots** sits above Threads. Each bot row has two lines: the face, the name, and under it the
status line (its role when nothing is running), with a count of the bot's open questions for you
on the right. The face shows state (see Character), so there is no separate working glyph.

Only the bot you're in (its page, or one of its sessions) lists its sessions under its row, one
row each with a state glyph. The needs-you glyph
appears only on a session the bot has asked you about (`bot_ask`); a session waiting on the bot
shows as working. Once a job is done or stopped, its sessions show the job's state, even when
their threads are archived. Sessions that need you, working or failed come first, then sessions
finished in the last 24 hours, newest first. Older ones collapse into "N earlier", which expands in
place. A session row opens the real thread. Bot sessions don't also appear under Threads.

**Archive job** (on a finished job's row, where its time sits on hover) clears a done or stopped
job: all of its sessions move behind the same disclosure, under "Archived" ("Archived" alone when
nothing is earlier), with **Unarchive job** in the same place. A toast offers Undo. Archiving
doesn't touch the threads or wake the bot; the bot can do the same with `bot_job_update`
(`archived`) when you ask it to clear finished work. Reopening a job, or a question from the bot
on it, brings it back to the list; so does a follow-up from the bot to one of the job's sessions
(`bot_session_message` reopens a done job, as `bot_job_update` with `status: working` does). A
session whose thread is archived, here or on its cloud, moves under "Archived" too, keeping the state its last run left, even while its job is open.

### Bot page

**Header**, one line: face, name (its role as a tooltip), a live status line, **Memory**, and ⋯
(**Pause**, **Models…**, **Edit bot…**, **Delete bot…**). The status line names sessions, never job ids: "1 session working ·
nothing needs you", "Rate limit threads API needs you", "2 questions for you". When something needs
you it is a button that scrolls the chat to the oldest open question.

**Body**: the home thread's `ChatView`, unchanged, composer included, with the placeholder "Message
Atlas". The model chip shows the bot's brain.

What the chat holds:

- **Your messages**: work, follow-ups, questions, preferences. Several requests in one message
  become several jobs. While the bot is mid-turn, T3's composer queues your message the way it does
  in any thread, and your message goes ahead of any queued wake-ups.
- **Wake-ups as fold labels.** A wake-up is not its own row. It becomes the label of that turn's T3
  fold, the row that otherwise says "Worked for 6s ›": "Rate limit threads API is waiting · 10:44 ›",
  "Sidebar drag flicker finished · 10:52 ›". Expanding a fold shows the wake-up text and the tool
  calls, as T3 does today.
- **Quiet turns merge.** Back-to-back wake turns merge into one fold, "Atlas handled 4 updates ·
  10:02–10:40 ›", only when in each of them the bot wrote no message and called none of `bot_ask`,
  `bot_job_update` (done, failed or stopped), `bot_learn` or `bot_forget`. Those always stay their
  own turn with a visible reply.
- **Nothing done in your name hides.** A memory answer (`bot_session_respond` with a citation) needs
  no message, but the fold label says it: "Sidebar drag flicker asked a question · answered from
  memory · 10:38 ›", or in a merged fold "Atlas handled 4 updates · answered 1 from memory ·
  10:02–10:40 ›". Expanding it shows the question, the answer, and the memory it quoted.
- **The bot's replies**, in plain prose:
  - Starting work: "On it, both in **pair**: [Sidebar drag flicker] and [Rate limit threads API]."
    The bracketed names are `t3-thread://` links, which T3 renders as live thread chips with the
    session's state. Work outside any project: "On it, on this machine: [Add pgAdmin login to
    .zshrc]."
  - Needing you: "**Rate limit threads API needs you:** per member or per API token? … I'd pick per
    member." One question per message, named by session. You answer in the composer, in your own
    words.
  - Saving memory: "Saved to memory: 'Rate limits are per member unless I say otherwise.'" "Forget
    that" removes it.
  - Finishing: "**Sidebar drag flicker is done.**" what changed in a sentence or two, the evidence (tests and their
    results, PR links), and what's yours to do (merging).
  - Catching up: when you write after a gap of an hour or more, the reply opens with a short
    catch-up (what finished, what needs you, what's still running, how many questions it answered
    from memory) before answering you. It is the same single reply, not a separate message.
  - Taking over: "You've taken [Rate limit threads API]; I've stopped steering it. Say 'hand it
    back' to return it." Once, when you first type in that session.
  - Routine wake-ups get no message. No "working on it".

**Memory** (right panel, toggled from the header): **Instructions** (prose you write; the bot reads
it every turn), **Learned** (notes with their source, **Edit**, **Forget**), **Check with me
before** (merging a PR, pushing to a default branch, deleting code outside the job, migrations or
deploys, adding a dependency, spending money). Sessions run with full access in their own worktree,
so these are instructions, not locks, and the panel says so.

### A new bot

**+** in the Bots header (also the Bots page, the empty sidebar row and the command palette) opens
**New bot**, prefilled: the next free name (Atlas, Nova, …) selected, an unused face, no role,
Crisp. Enter creates it and opens its empty chat: its face, a one-line greeting in its voice ("Atlas
here. What should I take on?"), its role, then T3's composer. Your first message is its first job.
⋯ → **Edit bot…** opens the same dialog. On mobile, **+** creates at once with the same defaults.

### Character

Capy's Captains and Grok Bot give their agents character with a face, a name and a role line,
not a personality form. Bots do the same, and keep tone small.

- **Face**: a non-human SVG, one of four shapes (each with its own eyes) in one of five colours.
  Pair assigns the least-used colour, then the least-used shape, so a few bots never look alike;
  Edit bot changes it. Shape and colour carry identity at 16px. No mouth and no expressions; the
  pose is the bot's state: it loops (breathe, glance, blink, hop) while the bot or any session
  works, looks up when it has a question for you, and closes its eyes when paused. Every other
  face is still, so a list of idle bots never repaints, and reduced motion keeps all of them still.
- **Picture**: Edit bot can swap the face for any GIF, PNG, JPEG or WebP up to 10 MB, and switch
  back. In lists an animated picture holds its first frame and plays only while the bot works or
  on hover; the bot's own header and empty chat play it.
- **Role**: one line under its name (the charter). The bot reads it as its job, so it describes
  the bot, never "I" or "my".
- **Voice**: **Crisp** (default: results first, fewest words) or **Candid** (the same, plus its
  own call in one sentence). Tone only: questions, fold labels, status lines, job reports and
  session tasks are plain in both, and neither voice writes longer, uses emoji or flatters.
  Anything more personal goes in Memory → Instructions. We cut warmer and joking voices: Codex and
  Claude retired similar presets, and warm modes drift into filler and sycophancy.

### Sessions

A session is a normal top-level thread you own, on the Worker model (doing the work) or Reviewer
model (review), rendered by the unchanged thread screen. A git project gives it its own worktree; a
folder that isn't a git repository runs in place; work outside any project (this machine's
dotfiles, a database, a website) runs in a scratch folder under **No project**.
Its composer placeholder reads "Message this session (Atlas steps back)". There is no Take over
button: sending a message there takes it over, and the bot posts once in its chat. Answering the
session's pending approval or question inside the thread does not take it over.

### Inbox and notifications

- Inbox gets the bot's questions ("Per member or per API token? · Atlas · Rate limit threads API")
  and finished jobs ("Sidebar drag flicker is done · Atlas · PR #612"). Both open the bot's chat
  scrolled to that message.
- Notifications: a question for you, a finished or stopped job, and a session request nobody has
  answered for 10 minutes (or at once while the bot is paused). Everything else is quiet: bot turns
  and bot sessions never notify you.

### Pause and delete

**Pause**: the bot takes no turns; its sessions keep running and their questions come to your
Inbox. The composer stays usable; messages wait for **Resume**, which wakes the bot once with what
happened meanwhile. **Delete bot…** confirms, stops the home thread, and moves its sessions into
Threads.

### Mobile

The Bots tab lists bots with their faces (posed and animated as on desktop, pictures included)
and sessions nested, with the same "N earlier" and
"Archived" disclosure; long-press a finished job's row for **Archive job** or **Unarchive job**. A
bot's second line is its status, or its role when nothing is running. Tapping a bot opens its chat in the normal
mobile thread screen and composer, with the status line under the name in the header (tapping it
jumps to the open question); tapping a session opens that thread. No Memory button: Memory is on
desktop and web in v1, and so is Edit bot.

## How it behaves

**One message per turn.** T3 folds hide every assistant message in a turn except the last, so the
bot writes at most one message per turn, at the end, after its tool calls (a persona rule). Quiet
turns write none. `BotWatcher` puts at most one wake that needs a decision from you into a batch;
the next one waits for the following turn, which starts right after. So a turn carries at most one
question, and that question is the visible message.

1. **You write.** The message lands in the home thread like any message.
2. **The bot plans** with `bot_brief` (memory, voice, limits, projects, open jobs and their
   sessions' live state, open questions). It calls `bot_brief` every turn, so its state comes from
   the server, not from chat history. The home thread never compacts: once its provider session
   passes 150k tokens of context (`T3CODE_BOT_SESSION_TOKEN_BUDGET`; 0 starts every turn fresh),
   or is about to go cold with more than 50k, the bot gets one turn to save notes, and its next
   turn starts a fresh session seeded with its brief and the chat's last 30 messages. For new work it calls
   `bot_job_create` (title, request, and a project unless the work is outside one) and
   `bot_start_session` for each independent piece, replies with the session links, and ends the
   turn. It never waits on a session in its turn.
3. **Sessions run.** The server launches each through `ThreadLaunchService`: the project (or the
   scratch project), a new worktree for a git project, the Worker or Reviewer model, full access,
   owner = you, and a task text carrying the relevant instructions, limits and the closing-report
   format.
4. **The server wakes the bot** when a session finishes, fails, hits a usage limit, raises a
   question or approval, or goes quiet for 30 minutes, and on resume and hand-back. Wakes within 3
   seconds are batched into one message, with at most one wake that needs a decision from you per
   batch (see "One message per turn").
5. **The bot unblocks** with `bot_session_respond` when memory covers the question and no limit
   applies (recorded as a decision with its citation, and shown in the fold label, "answered from
   memory"). Otherwise it asks you in chat and records the question with `bot_ask`, which drives
   the needs-you count, Inbox and the notification. `bot_ask` stores the home thread's current turn id; the header
   button, Inbox items and notifications scroll the chat to that turn's last message. Your reply
   resolves it (`bot_ask_resolve`).
6. **It finishes the job** with `bot_job_update` (`status: done`, report) and posts the report in
   chat. One notification.

## Architecture

Unchanged from v3 except where noted.

- **Server: `apps/server/src/bots/`.** `BotService` (bots, jobs, asks, decisions, notes, snapshot
  and change stream), `BotHome` (hidden project, home thread, `AGENTS.md` persona), `BotSessions`
  (launch, link to job, take over / hand back), `BotWatcher` (follows sessions, batches wakes,
  escalates stale requests).
- **MCP tools** for the home thread only: `bot_brief`, **`bot_job_create` (new)**,
  `bot_job_update`, `bot_start_session` (now also returns the session's `t3-thread://` link),
  `bot_session_message`, `bot_session_respond`, `bot_ask`, `bot_ask_resolve`, `bot_learn`,
  **`bot_forget` (new)**, and `bot_recall`, which searches what the brief no longer shows: the
  chat's earlier messages, every job's request and report, answered Asks and all notes.
- **Persona** rewritten for chat-first: the chat is the only screen; never do the work yourself
  (anything that runs a command, edits a file, browses or logs in is a session, sorted by the kind
  of work, not its size, since models judge "small" differently); turn requests into jobs; link
  sessions; ask in chat; short replies in the bot's voice; nothing on routine wakes.
- **Enforcement**: `BotHome` writes `.claude/settings.json` into the bot's home folder, denying
  Bash, Edit, Write, NotebookEdit, WebFetch, WebSearch and subagents. Claude applies deny rules
  even in bypassPermissions, so a Claude brain can't work in its own turn. Other providers' brains
  have only the persona's rule.
- **Guard**: in a home-thread turn that called `bot_ask`, `deriveTurnFolds` never hides the
  assistant message containing the question, even if the model wrote it before more tool calls.
- **Web**: the bot route renders header + `ChatView` + Memory panel. Removed: Briefing, job panel,
  report, Ask cards, decision rows, job composer, first-run card, tabs. Sidebar nests sessions under
  the bot. In the home thread, `deriveTurnFolds` labels wake turns from the wake text, merges quiet
  runs, and counts memory answers. Thread link chips gain the linked thread's live state glyph.
- **Wake text** names sessions only, never job numbers (`BotWatcher` today writes `J-<n>`).
- **Inbox** items for bot questions and finished jobs deep-link to the bot's chat.
- **Mobile**: bot opens its home thread in the standard thread screen; Bots tab nests sessions.

## Not in v1

Several bots working as a team, schedules and standing duties ("keep CI green"), speech,
harness-enforced limits, Memory on mobile.
