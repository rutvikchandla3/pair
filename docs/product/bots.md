# Bots

Status: design v3, 2026-11-18. Replaces Chief of staff, which is removed.
Screens: [bots-prototype](./bots-prototype/README.md).

A **bot** is a named agent you keep. You give it a high-level **job** ("Make the sidebar drag
flicker go away", "Upgrade Effect to 3.12"). It starts coding **sessions** to do it, answers their
questions the way you would, and asks you only when it can't. Its **Briefing** says where every job
stands, so you never open a session to find out.

It is single-user. It is not a Space, a provider, or a voice assistant.

## Why Chief of staff didn't work, and what changes

| Chief of staff                                         | Bots                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| Voice first. You had to ask it what was going on.      | A **Briefing** that is always current. You read it; you don't ask.         |
| A generic chat thread with no notion of work.          | **Jobs** with a status, a headline, sessions and a report.                 |
| `delegate_task` only reached its own folder's project. | The server launches sessions in **any project**, each in its own worktree. |
| Saw questions only; nothing showed what it decided.    | Every answer it gives for you is a **Decision** you can see and correct.   |
| Memory was a file the agent wrote.                     | **Playbook**: your instructions, what it learned (with sources), limits.   |
| Every turn of the home thread notified you.            | Only **Asks** and finished jobs notify you.                                |

## Concepts

- **Bot.** A name, a colour (assigned), a one-line charter, and three models: **Brain** (thinks;
  default Claude · Opus 5.5 · High), **Worker** (implementation sessions; default Pi · DeepSeek
  V4.1 Flash) and **Reviewer** (review sessions; default Claude · Opus 5.5 · High). v1 designs for
  one bot; the data allows several, and **+** in the sidebar makes another.
- **Home thread.** Each bot is one ordinary T3 thread in a hidden project rooted at
  `<stateDir>/bots/<botId>/`. Everything the bot does happens in turns of that thread. Its persona is
  `AGENTS.md`, regenerated from the playbook on every change.
- **Job.** One piece of work you gave the bot: J-n, a title, your request, a stored status, a
  headline the bot keeps current, its sessions, its decisions, and a report when done. Stored status:
  `working → done | stopped`. **Needs you** is derived from an open Ask.
- **Session.** A thread the bot started for a job: a normal top-level thread you own (commits are
  yours), in the job's project, in a new worktree, on the Worker or Reviewer model. Its state is
  derived from the thread: Working, Waiting on Atlas, Done, Failed, Stopped, Paused until (usage
  limit), You took over. A working session with no new output for 30 minutes also says so.
- **Ask.** A question the bot raises to you, tied to a job: the question, why (two lines), up to
  three suggested answers, and the one it would pick. Answers: a suggestion (one click), your own
  words, or **Let Atlas decide** (recorded as a Decision citing "You let Atlas decide", so you can
  correct it). Own-words answers have a **Remember this** checkbox, off by default; after a one-click
  answer the answered card offers a **Remember this** button. Either way the bot saves a learned note
  and the exact note text shows on the answered Ask with **Edit** and **Remove note**. **Change
  answer** stays available; it sends the new answer to the bot, which acts on it.
- **Decision.** A question a session raised that the bot answered for you. One line each: the
  question, the answer, and the playbook line or note it cited. **Correct** opens a field; the
  correction goes to the bot, which re-steers the session if it's still running and offers to edit
  the cited note.
- **Playbook.** Your taste: **Instructions** (prose you write), **Learned** (notes with their
  source and how many decisions cited them), and **Check with me before** (merging a PR, pushing to
  a default branch, deleting code outside the job, migrations or deploys, adding a dependency,
  spending money). The bot raises an Ask instead of deciding these, and every session gets them as
  instructions. Sessions run with full access in their own worktree, so the Playbook says so: these
  are instructions, not locks.

## What the user sees

### Sidebar

**Bots** sits above Threads: one row per bot with its avatar and name. On the right, the Inbox-style
count of things that need you, else a static working glyph while any of its sessions run. Paused
bots show a pause glyph. A bot's home thread and sessions don't appear under Threads; they live on
its page, and ⌘K still finds them.

### Bot page

Header: avatar, name, charter, a muted summary ("5 jobs · 3 sessions working · 2 need you", always
equal to the rows below), tabs **Briefing · Chat · Playbook**, and ⋯ (**Pause**, **Settings**,
**Delete bot…**).

**Briefing**, the page you read instead of opening sessions:

1. **Needs you n.** Compact Ask cards (question and job on one line, why clamped to two lines,
   answers on one row). Also session requests the bot hasn't answered for 10 minutes, or at once
   while it's paused or its brain is offline: "Upgrade server has waited 11m · **Answer yourself**".
2. **Atlas decided 4 things since you last looked · Review.** One quiet line (counted since your
   last visit, `markSeen`); it expands to the decision rows. On mobile it opens the list read-only.
3. **In progress n.** One row per job: status glyph (an empty ring until the bot's first update),
   J-n, title, a dot when the headline changed since you last looked, the headline, a progress
   label, PR chips, "2m". The progress label is "2 of 3 sessions done", unless a session is in
   trouble: then it names the worst one in the warning colour ("Upgrade web quiet 34m", "Review
   paused until 14:00", "You took over", "Implement failed"). No models here. Click opens job
   detail.
4. **Done this week n**, collapsed, then **All jobs**.

The composer starts a job: "Give Atlas a job…", a project chip (default "Atlas picks"), **Start
job** (⌘↵). The job appears at once with the headline "Waiting for Atlas" until the bot's first
update.

**Job detail** (side panel): header with glyph, J-n, title, status pill and headline, ⋯ (**Stop
job…**, confirming "Stop J-13 and its 2 running sessions?"; **Reopen** on done or stopped jobs).
Then your request; **Sessions** ("on Pi · DeepSeek V4.1 Flash" said once), each with state, latest
line, PR with files and +/−, and **Open**; **Decided for you n**; a short timeline; and **Message
Atlas about this job**, which opens Chat with the job referenced.

**Report**, on a done job: what changed, evidence (tests run, captures), PRs, **Decided for you
n** (the bot's own decisions only), **You decided n** (your answers), open questions (hidden when
none), and **Next**, which can carry a **Start job** button with a
suggested request.

**Chat** is the home thread's chat view. Talk to it ("what's blocking?", "from now on add a
changeset"). Answering an Ask here resolves the Ask. Wake-ups show as quiet system rows.

**Playbook**: Instructions (prose editor), Learned, Check with me before. Everything autosaves
("Saved"); the bot sees it on its next turn.

**Settings** (⋯): name, charter, Brain, Worker, Reviewer.

### Taking over and handing back

If you type into a bot session, the bot stops steering it: the session row says **You took over ·
Hand back**, and its questions come to you. Hand back gives it to the bot again with a note of what
changed.

### Pause and delete

**Pause**: the bot takes no turns. Its sessions keep running; their questions come to your Inbox,
and Start job is disabled with "Atlas is paused · Resume". **Resume** wakes it once with what
happened meanwhile. **Delete bot…** confirms ("All 11 of its sessions move into Threads (3 are
still running and keep going)"), stops its home thread, and moves its sessions into Threads; jobs
and notes are deleted.

### Inbox and notifications

- Asks and escalated session requests appear in Inbox under **Needs you** with the bot's avatar,
  answerable in place on web, desktop and mobile.
- Notifications: a new Ask ("Atlas asks: per member or per token?"), an escalated request naming
  who waits ("Upgrade server is waiting on you (Atlas is paused)"), and a job finishing or stopping
  ("Atlas finished J-12 · #123"). Asks raised within a minute arrive as one notification. Bot turns
  and bot sessions never notify you.

### First run

The empty Bots page is an inline card: name (prefilled "Atlas"), what it's for, and a starting
playbook: **Default** (decides code details, checks with you before everything in the limits list)
or **Blank**. **Create Atlas** opens its Briefing with three example jobs you can click to start.

### Mobile

Inbox answers Asks. Bots tab → a bot's Briefing (Needs you, In progress, Done) with the job composer,
read-only job detail and report (where the finish notification lands), and Chat. Ask screens have a
send button for typed answers. Playbook and Settings stay on desktop and web in v1.

## How it behaves

1. **You start a job.** `bots.createJob` stores J-n and queues `New job J-n: <request>` into the
   home thread (with the project, if you picked one).
2. **The bot plans** with `bot_brief` (playbook, notes, limits, jobs, sessions, open asks), writes
   its headline with `bot_job_update`, and starts sessions with `bot_start_session`.
3. **Sessions run.** The server launches each through `ThreadLaunchService`: the job's project, a
   new worktree, the Worker or Reviewer model, full access, owner = you, and a task text that
   carries the relevant instructions and limits and asks for a closing report (what changed,
   evidence, open questions).
4. **The server wakes the bot** when a session finishes, fails, is interrupted, hits a usage limit,
   raises a question or approval, or has had no new output for 30 minutes (once per quiet stretch),
   and when you answer an Ask, change an answer, ask it to remember an answer, correct a
   decision, hand a session back, reopen a job, or resume. Wakes within 3 seconds are batched into
   one message; a wake whose request was answered meanwhile is dropped.
5. **The bot unblocks** with `bot_session_respond` when the playbook or a note covers the question
   and no limit applies, recording a Decision with its citation. Otherwise it raises an Ask with
   `bot_ask`. It follows up with `bot_session_message`. It may watch PRs its sessions open.
6. **You answer.** The server records the answer and queues it into the home thread. With
   **Remember this**, the bot saves a note with `bot_learn`, and the note's text shows on the Ask.
   If you answer in Chat, the bot resolves the Ask with `bot_ask_resolve`.
7. **The job finishes.** `bot_job_update` with `status: done` and a report. One notification.

A session that hits a usage limit shows **Paused until 14:00 · Retry now**; the bot is woken and may
move the work to another model. If the brain's provider is unavailable, the Briefing says "Atlas
can't think right now" with **Open Providers**, and session requests escalate at once.

## Architecture

- **Server: `apps/server/src/bots/`.** `BotService` (bots, jobs, asks, decisions, notes, the
  Briefing snapshot and its change stream), `BotHome` (hidden project and home thread, `AGENTS.md`),
  `BotSessions` (launch, link to the job, take over / hand back), `BotWatcher` (follows linked
  sessions, batches wakes, escalates stale requests to Inbox).
- **Storage:** one migration with `bots`, `bot_jobs`, `bot_sessions`, `bot_events` (timeline,
  decisions), `bot_asks`, `bot_notes`.
- **Wire:** `bots.*` RPCs in `packages/contracts`, guarded like other member mutations: subscribe,
  create, update, pause, resume, delete, createJob, stopJob, reopenJob, answerAsk, correctDecision,
  handBackSession, updateNote, deleteNote, markSeen. Session live state is derived on the client
  from thread shells it already has.
- **MCP tools** (`mcp/toolkits/bots/`), only for a bot's home thread: `bot_brief`,
  `bot_job_update`, `bot_start_session`, `bot_session_message`, `bot_session_respond`, `bot_ask`,
  `bot_ask_resolve`, `bot_learn`. Session tools refuse sessions that aren't the bot's or that you
  took over.
- **Quiet threads:** notifications and Inbox skip bot home threads and bot sessions, except for the
  escalations above.
- **Cloud-only servers:** bots are refused with a clear message until the home thread can run on a
  machine.

## Not in v1

Several bots designed as a team, bot-to-bot handoffs, schedules and standing duties ("keep CI
green"), voice, harness-enforced limits (later: the watcher flags a PR merged or a default branch moved without
an Ask, and a pre-push hook in bot worktrees refuses the default branch), per-role models beyond
Brain/Worker/Reviewer, Playbook and Settings on mobile.
