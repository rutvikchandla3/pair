// Every board. Open index.html#/<id>, or #/<id>/dark. index.html#/ lists them.

const S = {};

// ---------- 1. Before and after ----------

S.compare = {
  title: "1. The sidebar at team scale, before and after",
  w: 1440,
  h: 2080,
  render() {
    const note = (n, text) =>
      `<div class="row" style="align-items:flex-start;gap:10px;margin-bottom:14px"><span class="annot">${n}</span><div style="max-width:300px">${text}</div></div>`;
    return `<div class="board natural">
      <h1>The sidebar at team scale</h1>
      <div class="muted t14">Rutvik on Pair Cloud: 10 open tasks, 7 spaces, 12 threads of his own, 20 threads teammates share with him.</div>
      <div class="row" style="align-items:flex-start;gap:28px;margin-top:22px">
        <div><div class="w6" style="margin-bottom:8px">Today on feat/pair · <span data-count="before"></span> rows</div>
          <div id="before" class="card" style="overflow:hidden;width:264px">${sideBefore()}</div></div>
        <div style="padding-top:34px;width:330px">
          ${note(1, "<b>Assigned to me</b> lists every open task you own, one row each. 10 tasks, 10 rows.")}
          <div style="height:250px"></div>
          ${note(2, "The open space repeats <b>Seed role catalog</b>, already listed above, then its threads, and they show again under Threads.")}
          <div style="height:520px"></div>
          ${note(3, "<b>Team</b> is every thread shared with you: flat, newest first, with no grouping. At 20 it's a wall of avatars.")}
          <div style="height:40px"></div>
          ${note(4, "\"Needs you\" lives in four places: the Assigned count, a task sub-row, the Working shelf and unread Team rows.")}
        </div>
        <div><div class="w6" style="margin-bottom:8px">Proposed · <span data-count="after"></span> rows</div>
          <div id="after" class="card" style="overflow:hidden;width:264px">${sideNew({ sel: "inbox" })}</div></div>
        <div style="padding-top:34px;width:330px">
          ${note("A", "<b>Inbox</b> is the one place for what waits on you. Its indigo count is the only colored number in the sidebar.")}
          ${note("B", "<b>My tasks</b> and <b>Shared with you</b> are places: one row each, no count, no dot, whether they hold 10 things or 200. Inbox owns \"new\".")}
          ${note("C", "One row per space and no sub-rows. Its muted number is that space's share of the Inbox count (2 + 1 + 1 = 4 here); a grey dot means only an unread room. Five show, and the rest sit under <b>2 more</b>, archived ones below a sub-header.")}
          ${note("D", "<b>Threads</b> is T3 Code's own list, unchanged. A space glyph marks task threads; the branch glyph with avatars shows who has a branch of yours (Hanad on Seed role catalog).")}
          ${note("E", "A teammate's thread shows up only when you pin, follow or prompt it, with their avatar on the right (Kousik's Prompt builder). A follow from prompting ends at settle, or once your turn ended and you read it.")}
        </div>
      </div></div>`;
  },
  after() {
    for (const id of ["before", "after"]) {
      const n = document.querySelectorAll(`#${id} .srow, #${id} .sect, #${id} .search`).length;
      document.querySelector(`[data-count="${id}"]`).textContent = n;
    }
  },
};

// ---------- 2. Inbox ----------

function lrow(o) {
  return `<div class="lrow${o.focus ? " focus" : ""}${o.unread ? " unread" : ""}">
    <span class="lead">${o.lead}</span>
    <div class="grow"><div class="l1"><span class="ttl ell">${o.t}</span>${o.badge || ""}</div>${o.l2 ? `<div class="l2">${o.l2}</div>` : ""}</div>
    ${o.acts ? `<div class="acts">${o.acts}</div>` : ""}
    <span class="meta">${o.m || ""}</span></div>`;
}
const where = (space, task) =>
  `${ic("space", "s12")}<span class="ell">${space}${task ? ` <span class="mid">›</span> ${task}` : ""}</span>`;

S.inbox = {
  title: "2. Inbox: everything that waits on you",
  render() {
    const list = `
      <div class="ghead" style="margin-top:6px"><span>Needs you</span><span class="cnt">4</span></div>
      ${lrow({ focus: true, lead: act("approval", "s16"), t: 'Approve <span class="code">pnpm db:migrate</span>', l2: `${where("Question creation", "Seed role catalog")}<span class="mid">·</span>your thread`, m: "2m" })}
      ${lrow({ lead: act("answer", "s16"), t: "Keep the old push token for 24 hours?", l2: `${where("Mobile push", "Expo token refresh")}<span class="mid">·</span>your thread`, m: "9m" })}
      ${lrow({ lead: act("offer", "s16"), t: "Hanad offers 2 commits to Seed role catalog", l2: `${ic("branch", "s12")}from his branch Role fixtures v2<span class="mid">·</span>3 files <span class="add">+84</span> <span class="del">−12</span>`, m: "14m" })}
      ${lrow({ lead: ic("userplus", "s16 muted"), t: "Meera assigned you Trial banner copy", l2: `${where("Onboarding revamp")}<span class="mid">·</span>To do, not started`, m: "1h" })}
      <div class="ghead"><span>For you</span><span class="cnt">4</span></div>
      ${lrow({ unread: true, lead: ic("at", "s16 muted"), t: "Kousik mentioned you", l2: `${where("Question creation")}<span class="mid">·</span><span class="ell">“@Rutvik does difficulty belong in schema v2?”</span>`, m: "22m" })}
      ${lrow({ unread: true, lead: ic("pair", "s16 c-input"), t: "Pair replied to you", l2: `${where("Billing v3")}<span class="mid">·</span><span class="ell">“Proration rounds per line item, not per invoice…”</span>`, m: "40m" })}
      ${lrow({ unread: true, lead: av("ankur", { size: 16 }), t: "Ankur shared Perf budget for /questions", l2: `${ic("folder", "s12")}pair-fe<span class="mid">·</span>${act("working")}working`, m: "3h" })}
      ${lrow({ unread: true, lead: av("kousik", { size: 16 }), t: "Kousik added you to Billing v3", l2: `${where("Billing v3")}<span class="mid">·</span>4 members`, m: "5h" })}
      <div class="t12 faint" style="padding:16px 10px">j k move · ↵ open · e done · h snooze. An item leaves on its own once it's handled.</div>`;
    const preview = `
      <div class="top" style="gap:8px">${crumbs(["Question creation", "Seed role catalog"])}${statusChip("progress", "In progress")}<span class="grow"></span><span class="btn sm">Open thread ${ic("right", "s12")}</span></div>
      <div class="feed"><div class="feed-in" style="max-width:600px">
        <div class="umsg"><div class="who"><span class="w6">You</span><span class="t12 muted">10:58</span>${av("rutvik")}</div><div class="bubble">Seed the role catalog from roles.csv and run the migration.</div></div>
        <div class="amsg"><p>I added the seed script and a migration for the <span class="code">roles</span> table. The migration needs to run against the machine's database.</p>
          <div class="steps"><div class="row">${ic("file", "s12")}Edited <span class="mono">seed/roles.ts</span> <span class="add">+64</span></div><div class="row">${ic("file", "s12")}Created <span class="mono">migrations/0042_roles.sql</span></div></div></div>
        <div class="tcard" style="border-color:color-mix(in oklab,var(--warning-foreground) 35%,var(--border))">
          <div class="row">${act("approval", "s16")}<span class="w6">Run a command?</span><span class="grow"></span><span class="t12 muted">your turn</span></div>
          <div class="code" style="display:block;margin:10px 0;padding:8px 10px">pnpm db:migrate</div>
          <div class="row"><span class="btn sm primary">Approve</span><span class="btn sm">Always in this thread</span><span class="btn sm ghost">Decline</span><span class="grow"></span><span class="t12 faint">Answering here answers in the thread</span></div>
        </div>
      </div></div>`;
    return shell(
      sideNew({ sel: "inbox" }),
      `<div class="top"><span class="title">Inbox</span><span class="seg"><span class="on">All</span><span>Needs you</span><span>For you</span></span><span class="grow"></span><span class="btn sm ghost">${ic("snooze", "s12")}Snoozed 1</span></div>
      <div class="row" style="flex:1;align-items:stretch;min-height:0">
        <div style="flex:0 0 470px;border-right:1px solid var(--border);padding:6px 10px;overflow:hidden">${list}</div>
        <div class="col grow" style="min-height:0">${preview}</div>
      </div>`,
    );
  },
};

// ---------- 3. My tasks ----------

S.tasks = {
  title: "3. My tasks: the open tasks you own, across spaces",
  render() {
    const sp = (n) => `<span class="chip ghost t12" style="height:20px">${ic("space", "s12")}${n}</span>`;
    const row = (s, t, space, l2, m, focus) =>
      lrow({ focus, lead: st(s), t, badge: "", l2, acts: sp(space), m });
    return shell(
      sideNew({ sel: "tasks" }),
      `<div class="top"><span class="title">My tasks</span><span class="muted">10 open</span><span class="grow"></span><span class="t12 muted">Group by</span><span class="seg"><span class="on">Status</span><span>Space</span></span></div>
      <div class="scroll"><div class="page">
        <div class="ghead" style="margin-top:0">${ic("down", "s12")}In progress<span class="cnt">4</span></div>
        ${row("progress", "Seed role catalog", "Question creation", `${act("approval")}<span class="c-input">Needs you</span><span class="mid">·</span>wants to run pnpm db:migrate<span class="mid">·</span>${stack(["hanad"], { size: 14 })} Hanad branched off`, "2m", true)}
        ${row("progress", "Expo token refresh", "Mobile push", `${act("answer")}<span class="c-input">Needs you</span><span class="mid">·</span>keep the old token for 24 hours?`, "9m")}
        ${row("progress", "Invoice PDF export", "Billing v3", `${act("working")}1 thread<span class="mid">·</span>working`, "now")}
        ${row("progress", "Search index for docs", "Docs site", "1 thread<span class='mid'>·</span>idle", "1h")}
        <div class="ghead">${ic("down", "s12")}In review<span class="cnt">2</span></div>
        ${row("review", "Question schema v2", "Question creation", `${ic("pr", "s12")}pair-be#482<span class="mid">·</span><span class="c-success">checks pass</span>`, "20m")}
        ${row("review", "Welcome checklist", "Onboarding revamp", `${ic("pr", "s12")}pair-fe#120<span class="mid">·</span>1 approval`, "3h")}
        <div class="ghead">${ic("down", "s12")}To do<span class="cnt">4</span></div>
        ${row("todo", "Trial banner copy", "Onboarding revamp", `${ic("userplus", "s12")}Assigned by Meera<span class="mid">·</span>not started`, "1h")}
        ${row("todo", "Proration edge cases", "Billing v3", "No threads yet", "2d")}
        ${row("todo", "Silent push on iOS 18", "Mobile push", `${ic("userplus", "s12")}Assigned by Priya<span class="mid">·</span>not started`, "3d")}
        ${row("todo", "Versioned API reference", "Docs site", "No threads yet", "6d")}
        <div class="ghead">${ic("right", "s12")}Done<span class="cnt">6</span></div>
        <div class="ghead" style="margin-top:6px">${ic("right", "s12")}Canceled<span class="cnt">1</span></div>
      </div></div>`,
    );
  },
};

// ---------- 4. Shared with you ----------

S.shared = {
  title: "4. Shared with you: threads shared with you by name, grouped by person",
  render() {
    const person = (id, count, open = true) =>
      `<div class="ghead">${ic(open ? "down" : "right", "s12")}${av(id, { size: 16, presence: true })}<span style="color:var(--foreground)">${M[id].n}</span><span class="cnt">${count}</span></div>`;
    const r = (t, l2, m, o = {}) => lrow({ t, l2, m, focus: o.focus, unread: o.unread, lead: "", badge: o.badge || "", acts: o.acts || "" });
    const proj = (n) => `${ic("folder", "s12")}${n}`;
    return shell(
      sideNew({ sel: "shared" }),
      `<div class="top"><span class="title">Shared with you</span><span class="muted">14 threads</span><span class="grow"></span><span class="t12 muted">Group by</span><span class="seg"><span class="on">Person</span><span>None</span></span></div>
      <div class="scroll"><div class="page">
        <div class="toolbar">
          <div class="search grow" style="margin:0;height:30px">${ic("search")}<span class="grow">Filter by title, branch or project</span></div>
          <span class="btn sm">Anyone ${ic("down", "s12")}</span><span class="btn sm">Not settled ${ic("down", "s12")}</span>
          <span class="btn sm"><span class="radio" style="width:12px;height:12px"></span>Include task threads</span>
        </div>
        ${person("ankur", 3)}
        ${r("Perf budget for /questions", `${proj("pair-fe")}<span class="mid">·</span>${act("working")}working`, "8m", { unread: true, badge: '<span class="t11 c-input">new</span>' })}
        ${r("CDN cache headers", `${proj("infra")}<span class="mid">·</span>${act("answer")}Needs Ankur`, "40m")}
        ${r("Image sizes spike", `${proj("pair-fe")}<span class="mid">·</span>idle`, "2d")}
        ${person("kousik", 4)}
        ${r("Fixture loader perf", `${proj("pair-be")}<span class="mid">·</span>${act("working")}working`, "1h", { focus: true, acts: `<span class="btn sm">${ic("eye", "s12")}Follow</span>` })}
        ${r("Retry budget for evals", `${proj("pair-be")}<span class="mid">·</span>idle`, "3h", { badge: `<span class="t11 muted row" style="gap:3px">${ic("eye", "s12")}Following</span>` })}
        ${r("Schema migration dry-run", `${proj("pair-be")}<span class="mid">·</span>idle`, "1d")}
        ${r("Seed data for demos", `${proj("pair-be")}<span class="mid">·</span>idle`, "4d")}
        ${person("hanad", 2)}
        ${r("Stripe sandbox setup", `${proj("billing-svc")}<span class="mid">·</span>idle`, "5h")}
        ${r("Local HTTPS for dev", `${proj("pair-fe")}<span class="mid">·</span>idle`, "2d")}
        ${person("meera", 2, false)}
        ${person("priya", 2, false)}
        ${person("tanvi", 1, false)}
      </div></div>`,
    );
  },
};

// ---------- 5. A space, with the new sidebar ----------

S.space = {
  title: "5. Inside a space: one selected row; tasks stay in the room's panel",
  render() {
    const ovRow = (s, t, who, l2, m, hl) =>
      `<div class="lrow${hl ? " focus" : ""}" style="padding:7px 8px"><span class="lead" style="height:18px">${st(s)}</span><div class="grow" style="min-width:0"><div class="l1"><span class="w5 ell">${t}</span></div><div class="l2" style="white-space:nowrap;overflow:hidden">${av(who, { size: 14 })}<span class="ell">${l2}</span></div></div><span class="meta">${m}</span></div>`;
    const gh = (n, c, open = true, first = false) =>
      `<div class="ghead" style="margin-top:${first ? 0 : 8}px">${n}<span class="cnt">${c}</span>${ic(open ? "down" : "right", "s12")}</div>`;
    const panel = `<aside class="panel"><div class="tabs"><span class="tab on">${ic("layers", "s12")}Overview</span><span class="tab">${ic("file", "s12")}Notes</span><span class="tab">${ic("plus", "s12")}</span><span class="grow"></span><button class="iconbtn">${ic("panel")}</button></div><div class="pbody">
      ${gh("Needs you", 1, true, true)}
      ${ovRow("progress", "Seed role catalog", "rutvik", '<span class="c-input">2 things need you</span> · an approval and an offer', "2m", true)}
      ${gh("In review", 1)}
      ${ovRow("review", "Question schema v2", "rutvik", "pair-be#482 · checks pass", "20m")}
      ${gh("In progress", 3)}
      ${ovRow("progress", "Sample role fixtures", "kousik", 'Kousik · <span class="c-error">Thread failed: fixtures.test.ts</span>', "1h")}
      ${ovRow("progress", "Preview renderer", "ankur", "Ankur · Needs Ankur · which image sizes?", "12m")}
      ${ovRow("progress", "Generate question from prompt", "kousik", "Kousik · 2 threads · 1 working", "4m")}
      ${gh("To do", 1)}
      ${ovRow("todo", "Difficulty tagging", "hanad", "Hanad · No threads yet · assigned by you", "44m")}
      ${gh("Done", 1, false)}${gh("Canceled", 1, false)}
      <div class="srow muted" style="margin-top:6px">${ic("plus")}New task</div>
    </div></aside>`;
    const msg = (who, time, body) =>
      `<div class="row" style="align-items:flex-start;gap:10px">${av(who, { size: 20 })}<div class="grow"><div class="row" style="gap:6px"><span class="w6">${who === "rutvik" ? "You" : M[who].n}</span><span class="t12 muted">${time}</span></div><div>${body}</div></div></div>`;
    const chip = (s, t) => `<span class="w5" style="display:inline-flex;align-items:center;gap:4px">${st(s, 12)}${t}</span>`;
    return shell(
      sideNew({ sel: "qc" }),
      `<div class="top"><span class="title">Question creation</span><span class="muted row" style="gap:5px">${ic("layers", "s12")}pair-fe, pair-be</span><span class="grow"></span>${stack(["rutvik", "kousik", "hanad", "ankur"], { size: 20 })}<button class="iconbtn">${ic("more")}</button></div>
      <div class="feed"><div class="feed-in">
        <div class="sys" style="text-align:center">Today</div>
        ${msg("kousik", "10:40", "Do we tag difficulty when the question is generated, or after review?")}
        ${msg("hanad", "10:42", "After review. The reviewer usually changes it anyway.")}
        <div class="sys">${ic("users", "s12")}Kousik moved ${chip("progress", "Generate question from prompt")} to In progress · 10:44</div>
        ${msg("rutvik", "11:05", '<span class="c-input">@pair</span> what did we decide on difficulty tagging, and is anything blocked?')}
        <div class="row" style="align-items:flex-start;gap:10px"><span class="av s20" style="--c:#4f46e5">${ic("pair", "s12")}</span><div class="grow"><div class="row" style="gap:6px"><span class="w6">Pair</span><span class="chip ghost t11" style="height:18px">Agent</span><span class="t12 muted">replying to you · 11:05</span></div>
          <div>Difficulty is tagged after review (Hanad, 10:42). One task is blocked: ${chip("progress", "Preview renderer")} is waiting on Ankur to choose image sizes.</div></div></div>
      </div></div>
      ${composer({ text: "Message the space · @ to mention Pair or a teammate", left: `<span class="t12 c-input row" style="gap:4px">${ic("pair", "s12")}@pair</span>` })}`,
      panel,
    );
  },
};

// ---------- Thread headers ----------

function threadTop(o) {
  return `<div class="top" style="min-height:60px;position:relative"><div class="col grow" style="gap:3px;min-width:0">
      <div class="row">${crumbs(o.crumbs)}${statusChip("progress", "In progress")}</div>
      <div class="row t12 muted" style="gap:6px;white-space:nowrap;overflow:hidden">${o.meta}</div></div>
    ${o.right}<button class="iconbtn">${ic("more")}</button>${o.popover || ""}</div>`;
}
const QC = ["Question creation", "Generate question from prompt"];

function promptBuilderFeed(o = {}) {
  return `
    <div class="sys">${ic("space", "s12")}${o.ownerView ? "You" : "Kousik"} started this thread on <span class="w5" style="display:inline-flex;align-items:center;gap:4px">${st("progress", 12)}Generate question from prompt</span> · Tue 10:36</div>
    <div class="umsg"><div class="who"><span class="w6">${o.ownerView ? "You" : "Kousik"}</span><span class="t12 muted">10:36</span>${av("kousik")}</div><div class="bubble">Take a role description and draft five interview questions in schema v2. Difficulty is tagged later, after review.</div></div>
    <div class="amsg"><div class="t12 muted row" style="margin-bottom:6px">${ic("right", "s12")}Worked for 3m 12s · 4 steps</div><p>The builder now returns five questions in schema v2, and validation lives in one function, <span class="code">validateQuestion</span>. The preview is running on the right.</p><div class="t12 muted row" style="gap:6px">${ic("diff", "s12")}2 files changed <span class="add">+49</span> <span class="del">−6</span> · View changes</div></div>
    ${o.extra || ""}`;
}

// ---------- 6. A teammate's shared thread ----------

S.viewer = {
  title: "6. Hanad opens Kousik's shared thread: the composer says where his words go, and offers Branch off",
  render() {
    const working = `
      <div class="umsg"><div class="who"><span class="w6">Kousik</span><span class="t12 muted">11:04</span>${av("kousik")}</div><div class="bubble">Now wire the preview to the new schema and add a loading state.</div></div>
      <div class="row t12 c-info" style="gap:6px">${act("working")}Working · 1m 04s</div>
      <div class="steps"><div class="row">${ic("search", "s12")}Read <span class="mono">Preview.tsx</span>, <span class="mono">schema.ts</span></div><div class="row">${ic("compose", "s12")}Edited <span class="mono">Preview.tsx</span> <span class="add">+22</span> <span class="del">−4</span></div><div class="row">${ic("term", "s12")}Running <span class="mono">pnpm test preview</span></div></div>`;
    return shell(
      sideNew({ viewer: "hanad", sel: "qc", skip: "Rationale per question" }),
      `${threadTop({
        crumbs: [...QC, "Prompt builder"],
        meta: `${act("working")}Working<span class="mid">·</span>${av("kousik", { size: 14 })}Kousik's thread<span class="mid">·</span>${ic("machine", "s12")}Kousik's machine<span class="mid">·</span>Opus 5.5`,
        right: `${stack(["kousik", "rutvik"], { size: 20 })}<span class="btn sm">${ic("eye", "s12")}Follow</span>`,
      })}
      <div class="feed"><div class="feed-in">${promptBuilderFeed({ extra: working })}</div></div>
      ${composer({
        text: "Message Kousik's agent",
        left: `<span class="t12 muted row" style="gap:5px">${ic("lock", "s12")}Opus 5.5 · Kousik's Claude</span>`,
        right: '<span class="t12 faint">↵ queue · ⌘↵ steer now</span>',
        sendCls: "off",
        below: `<div class="hintbar" style="margin:8px auto 0">${ic("room", "s12")}<span class="grow">Goes into Kousik's conversation, after his current turn.</span><span>Want to work on your own?</span><span class="linkbtn">${ic("branch", "s12")}Branch off</span></div>`,
      })}`,
      browserPanel("k7f2-3000.preview.pair.cloud/questions"),
    );
  },
};

// ---------- 7. The branch-off draft ----------

const DISCLOSE = "Shares Kousik's running database and services. Kousik, Rutvik and Ankur can open this machine and reach your Claude and GitHub sign-ins from its terminal. Machine time counts toward Kousik.";

function branchDraft(o = {}) {
  const f = (lab, val) => `<div class="field"><span class="lab">${lab}</span><div class="row" style="gap:8px;min-width:0">${val}</div></div>`;
  const newOn = o.runs === "new";
  const sameOff = o.runs === "failed";
  const opt = (on, off, icon, title, sub) =>
    `<div class="opt${on ? " on" : ""}${off ? " off" : ""}"><div class="row"><span class="radio"></span>${ic(icon, "s12 muted")}<span class="w5">${title}</span></div><div class="t12 muted" style="margin:2px 0 0 22px">${sub}</div></div>`;
  const sameSub = o.runs === "asleep" ? "Asleep · wakes when you start" : "Seconds · 1 thread working";
  const disclosure = newOn || sameOff
    ? `Its own database and services, on your machine time. Kousik, Rutvik and Ankur can open it and reach your Claude and GitHub sign-ins, as with any thread you share.`
    : DISCLOSE;
  const startFrom = o.startFromMenu
    ? `<span class="select grow" style="border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-soft)">${av("kousik", { size: 14 })}<span>Prompt builder, latest</span><span class="t12 muted">turn 7 · 2 min ago</span><span class="grow"></span>${ic("down", "s12 muted")}</span>`
    : `<span class="select grow">${av("kousik", { size: 14 })}<span>Prompt builder, latest</span><span class="t12 muted ell">turn 6 · 2 min ago · with 2 uncommitted files</span><span class="grow"></span>${ic("down", "s12 muted")}</span>`;
  const menu = o.startFromMenu
    ? `<div class="menu" style="left:118px;top:46px;width:470px">
        <div class="t12 muted w5" style="padding:6px 9px 2px">A thread on this task</div>
        <div class="mi on" style="align-items:center">${av("kousik", { size: 20 })}<div class="grow"><div class="w5">Prompt builder, latest</div><div class="t12 muted">Kousik · turn 7 · with Hanad's changes · runs on Kousik's machine</div></div>${ic("check", "s12")}</div>
        <div class="mi" style="align-items:center;padding-left:26px"><span class="faint" style="margin-left:-14px;width:10px">└</span>${av("hanad", { size: 20 })}<div class="grow"><div class="w5">Rationale per question</div><div class="t12 muted">Hanad · branch of Prompt builder · all applied</div></div></div>
        <div class="mi" style="align-items:center">${av("kousik", { size: 20 })}<div class="grow"><div class="w5">Eval fixtures</div><div class="t12 muted">Kousik · idle · its machine is asleep</div></div></div>
        <div class="msep"></div>
        <div class="t12 muted w5" style="padding:6px 9px 2px">A branch, on a new machine</div>
        <div class="mi" style="align-items:center">${ic("branch", "s16")}<div class="grow"><div class="w5 mono">main</div><div class="t12 muted">pair-fe and pair-be · the space's workspace</div></div></div>
      </div>`
    : "";
  const account = o.noAccount
    ? `<span class="chip">${ic("sparkle", "s12")}Opus 5.5</span><span class="chip" style="color:var(--muted-foreground)">No Claude account</span><span class="btn sm">Connect Claude</span>`
    : `<span class="chip">${ic("sparkle", "s12")}Opus 5.5</span><span class="chip">Your Claude</span>`;
  return `
    <div class="row" style="gap:10px;margin-bottom:4px">${ic("branch", "s18")}<span style="font-size:20px;font-weight:600">${o.title || "Branch off Prompt builder"}</span></div>
    <div class="muted" style="margin-bottom:16px">${o.sub || "Your own thread, branch and worktree, starting from what Kousik's agent has built so far. His conversation and files stay as they are."}</div>
    <div class="card" style="padding:10px 14px;position:relative;margin-bottom:12px">
      ${f("Start from", startFrom)}
      <div class="field" style="align-items:start;margin-top:4px"><span class="lab" style="padding-top:8px">Runs on</span><div class="col" style="gap:6px">
        <div class="opt2">${opt(!newOn && !sameOff, sameOff, "machine", sameOff ? "Kousik's machine" : "Kousik's machine", sameOff ? "Failed" : sameSub)}${opt(newOn || sameOff, false, "plus", "New machine", "About a minute · own database and services")}</div>
        <div class="t12 muted" style="line-height:1.5">${disclosure}</div></div></div>
      ${f("Branch", `<span class="select grow mono">${o.branch || "hanad/rationale-per-question"}</span>`)}
      <div class="field" style="align-items:start;margin-top:4px"><span class="lab" style="padding-top:2px">Context</span><div class="col" style="gap:2px"><div class="row" style="gap:8px"><span class="check">${ic("check")}</span><span>Start with a summary of Prompt builder's conversation</span></div><div class="t12 muted" style="margin-left:22px">Written on your account. It shows as your first message, and you can edit it.</div></div></div>
      ${menu}
    </div>
    <div class="composer" style="max-width:none"><div class="ph${o.prompt ? " typed" : ""}">${o.prompt || "What will you work on?"}</div>
      <div class="foot">${account}<span class="grow"></span><span class="t12 faint">Joins the task: Generate question from prompt</span><span class="btn primary sm"${o.noAccount ? ' style="opacity:.45"' : ""}>${ic("branch", "s12")}${o.cta || "Branch off"} <span style="opacity:.7">↵</span></span></div></div>`;
}

S.draft = {
  title: "7. Branch off opens a draft: start from Kousik's latest work, on his machine or a new one",
  render() {
    return shell(
      sideNew({ viewer: "hanad", draft: true, skip: "Rationale per question" }),
      `<div class="top">${crumbs([...QC, "New thread"])}<span class="grow"></span><button class="iconbtn">${ic("x")}</button></div>
      <div class="scroll" style="display:flex;align-items:flex-start;justify-content:center;padding-top:48px">
        <div style="width:660px">${branchDraft({ prompt: "Add a one-line rationale to each generated question. Keep it under 120 characters and show it under the question in the preview." })}</div>
      </div>`,
    );
  },
};

// ---------- 8. Working in your own branch ----------

function rationaleFeed() {
  return `
    <div class="sys">${ic("branch", "s12")}You branched off Kousik's <span class="w5" style="color:var(--foreground)">Prompt builder</span> at turn 6, with its 2 uncommitted files · on Kousik's machine · 11:12</div>
    <div class="umsg"><div class="who"><span class="w6">You</span><span class="t12 muted">11:12</span>${av("hanad")}</div><div class="bubble">Add a one-line rationale to each generated question. Keep it under 120 characters and show it under the question in the preview.</div></div>
    <div class="amsg"><div class="t12 muted row" style="margin-bottom:6px">${ic("right", "s12")}Worked for 4m 40s · 7 steps</div>
      <p>Each question now carries a <span class="code">rationale</span> of at most 120 characters. The builder asks for it in the same call, <span class="code">validateQuestion</span> checks its length, and your preview (port 3001) shows it under each question. I committed it in two commits on <span class="code">hanad/rationale-per-question</span>.</p>
      <div class="t12 muted row" style="gap:6px">${ic("diff", "s12")}3 files changed <span class="add">+84</span> <span class="del">−12</span> · View changes</div></div>`;
}

function rationaleTop(popover) {
  return threadTop({
    crumbs: [...QC, "Rationale per question"],
    meta: `Idle<span class="mid">·</span>${ic("machine", "s12")}Kousik's machine<span class="mid">·</span>${lineageChip("from Prompt builder · 2 to offer · 1 behind", { open: !!popover })}`,
    right: `${stack(["kousik"], { size: 20 })}<span class="btn sm soft">${ic("merge", "s12")}Offer to Kousik</span>`,
    popover,
  });
}

S.lane = {
  title: "8. Hanad's branch: one quiet lineage chip in the header holds Update and Offer",
  render() {
    const pop = lineagePopover({
      style: "left:150px;top:54px;width:470px",
      title: "Prompt builder and its branches",
      rows: [
        { owner: "kousik", t: "Prompt builder", sub: "Kousik · kousik/prompt-builder · working", right: "1 turn behind" },
        { owner: "hanad", t: "Rationale per question", sub: "You · hanad/rationale-per-question", right: "2 commits to offer", here: true, child: true },
      ],
      actions: `<span class="btn sm">${ic("pull", "s12")}Update from Prompt builder</span><span class="btn sm soft">${ic("merge", "s12")}Offer to Kousik</span><span class="grow"></span>`,
      noBranchOff: true,
    });
    return shell(
      sideNew({ viewer: "hanad", sel: "Rationale per question" }),
      `${rationaleTop(pop)}
      <div class="feed"><div class="feed-in">${rationaleFeed()}</div></div>
      ${composer({ text: "Message your agent", left: `<span class="chip">${ic("sparkle", "s12")}Opus 5.5</span><span class="chip">Your Claude</span>`, sendCls: "off" })}`,
      browserPanel("k7f2-3001.preview.pair.cloud/questions"),
    );
  },
};

// ---------- 9. Offer ----------

function offerDialog(conflict) {
  const commit = (sha, msg) =>
    `<div class="row" style="gap:8px">${av("hanad", { size: 14 })}<span class="mono muted">${sha}</span><span class="grow ell">${msg}</span></div>`;
  return `<div class="backdrop"><div class="dialog" style="width:540px">
    <div class="dh"><h2>Offer your changes to Prompt builder</h2><div class="muted" style="margin-top:4px">Kousik sees them in his thread and chooses <b>Apply</b> or <b>Decline</b>. Apply writes your changes into his files between his turns, and his next commit of them credits you.</div></div>
    <div class="db">
      <div class="t12 muted w5" style="margin:6px 0">2 commits · 3 files · <span class="add">+84</span> <span class="del">−12</span></div>
      <div class="col" style="gap:5px;margin-bottom:8px">${commit("a1b2c3d", "Add a rationale to the Question schema")}${commit("e4f5a6b", "Show the rationale under each question")}</div>
      <div class="card" style="padding:9px 11px;min-height:52px;margin-bottom:10px">Adds a one-line rationale to each question. Schema gains <span class="code">rationale?: string</span>.</div>
      ${
        conflict
          ? `<div class="errline">${ic("alert", "s12")}<span>Prompt builder changed <span class="mono">src/schema.ts</span> since you branched (Kousik's turn 7).</span></div><div class="t12 muted" style="margin:4px 0 0 18px">Update from Prompt builder first. You or your agent resolve it in your branch, and Kousik's files are never touched.</div>`
          : `<div class="okline">${ic("check", "s12")}<span>Applies cleanly on Prompt builder's latest checkpoint (turn 7), uncommitted work included</span></div><div class="t12 muted" style="margin:4px 0 0 18px">Kousik sees only your lines: the diff starts from your last update of his work.</div>`
      }
    </div>
    <div class="df"><span class="t12 muted grow">${conflict ? "Nothing is offered until it applies cleanly." : "You can withdraw it until Kousik applies it."}</span><span class="btn">Cancel</span>${
      conflict
        ? `<span class="btn primary">${ic("pull", "s12")}Update from Prompt builder</span>`
        : `<span class="btn primary">${ic("merge", "s12")}Offer to Kousik</span>`
    }</div>
  </div></div>`;
}

S.offer = {
  title: "9a. Offer to Kousik: your commits, authored by you; Kousik decides",
  render() {
    return shell(
      sideNew({ viewer: "hanad", sel: "Rationale per question" }),
      `${rationaleTop()}<div class="feed"><div class="feed-in">${rationaleFeed()}</div></div>${composer({ text: "Message your agent", sendCls: "off" })}`,
      browserPanel("k7f2-3001.preview.pair.cloud/questions"),
      offerDialog(false),
    );
  },
};
S["offer-conflict"] = {
  title: "9b. An offer that would conflict isn't sent: update first, in your own branch",
  render() {
    return shell(
      sideNew({ viewer: "hanad", sel: "Rationale per question" }),
      `${rationaleTop()}<div class="feed"><div class="feed-in">${rationaleFeed()}</div></div>${composer({ text: "Message your agent", sendCls: "off" })}`,
      browserPanel("k7f2-3001.preview.pair.cloud/questions"),
      offerDialog(true),
    );
  },
};

// ---------- 10. The owner applies ----------

function offerCard(o = {}) {
  const commit = (sha, msg) =>
    `<div class="row" style="gap:8px;font-size:12.5px">${av("hanad", { size: 14 })}<span class="mono muted">${sha}</span><span class="grow ell">${msg}</span></div>`;
  const acts = o.readonly
    ? `<span class="t12 muted row" style="gap:5px">${ic("clock", "s12")}Waiting for Kousik</span><span class="grow"></span><span class="btn sm ghost">View changes</span>`
    : o.running
      ? `<span class="btn sm primary">Apply when this turn ends</span><span class="btn sm">View changes</span><span class="btn sm ghost">Decline</span>`
      : `<span class="btn sm primary">${ic("merge", "s12")}Apply</span><span class="btn sm">View changes</span><span class="btn sm ghost">Decline</span>`;
  const status = o.readonly
    ? "Applies cleanly"
    : o.running
      ? "Applies cleanly now · checked again when this turn ends"
      : "Applies cleanly · your agent is idle, so it applies now";
  return `<div class="tcard accent">
    <div class="row">${act("offer", "s16")}${av("hanad", { size: 16 })}<span><span class="w6">Hanad</span> offers 2 commits from <span class="w5">Rationale per question</span></span><span class="grow"></span><span class="t12 muted">11:41</span></div>
    <div style="margin:8px 0 8px 24px">“Adds a one-line rationale to each question. Schema gains <span class="code">rationale?: string</span>.”</div>
    <div class="col" style="gap:4px;margin:0 0 8px 24px">${commit("a1b2c3d", "Add a rationale to the Question schema")}${commit("e4f5a6b", "Show the rationale under each question")}</div>
    <div class="t12 muted" style="margin:0 0 8px 24px">3 files · <span class="add">+84</span> <span class="del">−12</span></div>
    <div class="okline" style="margin:0 0 ${o.readonly ? 10 : 4}px 24px">${ic("check", "s12")}<span>${status}</span></div>
    ${o.readonly ? "" : `<div class="t12 muted" style="margin:0 0 10px 24px">Writes his changes into your files, uncommitted, next to your own work. Your next commit of them credits Hanad.</div>`}
    <div class="row" style="gap:6px;margin-left:24px">${acts}</div>
  </div>`;
}

S.apply = {
  title: "10. Kousik gets Hanad's offer as a card in his thread, and applies it between turns",
  render() {
    const diffPanel = `<aside class="panel wide">${panelTabs("Changes")}<div class="pbody">
      <div class="row" style="margin-bottom:8px"><span class="seg"><span>This thread</span><span class="on">Offered by Hanad · 2 commits</span></span><span class="grow"></span><span class="t12 muted">only his lines</span></div>
      <div class="diff" style="margin-bottom:10px"><div class="fh">${ic("file", "s12")}src/schema.ts<span class="grow"></span><span class="add">+2</span><span class="del">−0</span></div>
        <div class="ln">  export const Question = Schema.Struct({</div><div class="ln">    prompt: Schema.String,</div><div class="ln">    kind: QuestionKind,</div><div class="ln">    minutes: Schema.Number,</div><div class="ln a">+   rationale: Schema.optional(Rationale),</div><div class="ln">  });</div></div>
      <div class="diff"><div class="fh">${ic("file", "s12")}src/rationale.ts<span class="chip ghost t11" style="height:18px">new</span><span class="grow"></span><span class="add">+38</span></div>
        <div class="ln a">+ /** One sentence on why this question fits the role. */</div><div class="ln a">+ export const Rationale = Schema.String.pipe(Schema.maxLength(120));</div><div class="ln a">+</div><div class="ln a">+ export const rationaleFor = (role: Role, q: Draft) =></div><div class="ln a">+   truncate(q.rationale ?? defaultRationale(role, q), 120);</div></div>
    </div></aside>`;
    return shell(
      sideNew({ viewer: "kousik", sel: "Prompt builder" }),
      `${threadTop({
        crumbs: [...QC, "Prompt builder"],
        meta: `Idle<span class="mid">·</span>${ic("machine", "s12")}Your machine<span class="mid">·</span>${lineageChip("1 branch · 1 offer", { offer: true, avs: ["hanad"] })}`,
        right: `${stack(["hanad", "rutvik"], { size: 20 })}<span class="btn sm">${ic("share", "s12")}Share</span>`,
      })}
      <div class="feed"><div class="feed-in">
        <div class="umsg"><div class="who"><span class="w6">You</span><span class="t12 muted">11:04</span>${av("kousik")}</div><div class="bubble">Now wire the preview to the new schema and add a loading state.</div></div>
        <div class="amsg"><div class="t12 muted row" style="margin-bottom:6px">${ic("right", "s12")}Worked for 2m 10s · 5 steps</div><p>The preview reads schema v2 and shows a skeleton while questions load. Tests pass.</p><div class="t12 muted row" style="gap:6px">${ic("diff", "s12")}2 files changed <span class="add">+31</span> <span class="del">−8</span> · View changes</div></div>
        ${offerCard()}
      </div></div>
      ${composer({ text: "Message your agent", left: `<span class="chip">${ic("sparkle", "s12")}Opus 5.5</span><span class="chip">Your Claude</span>`, sendCls: "off" })}`,
      diffPanel,
    );
  },
};

// ---------- 11. Every state ----------

const box = (title, body, w = 640) =>
  `<div style="width:${w}px"><div class="t12 muted w6" style="margin:0 0 6px 2px;text-transform:uppercase;letter-spacing:.04em">${title}</div><div class="card" style="padding:14px 16px;display:flex;flex-direction:column;gap:10px">${body}</div></div>`;
const sysr = (html) => `<div class="sys">${html}</div>`;
const dlg = (title, body, btns) =>
  `<div class="dialog" style="width:100%;box-shadow:none"><div class="dh"><h2>${title}</h2></div><div class="db muted">${body}</div><div class="df">${btns}</div></div>`;

S.states = {
  title: "11. Every state of Branch off, Update, Offer and Apply, with each way back",
  w: 1440,
  h: 1880,
  render() {
    const fg = (t) => `<span class="w5" style="color:var(--foreground)">${t}</span>`;
    return `<div class="board"><h1>Branch off, Update, Offer and Apply in every state</h1><div class="muted t14" style="margin-bottom:20px">Quiet one-line rows in the threads involved, never in the room. Each way in has a way back.</div>
      <div class="row" style="align-items:flex-start;gap:28px;flex-wrap:wrap">
        ${box("In Kousik's Prompt builder", [
          sysr(`${ic("branch", "s12")}Hanad branched off this thread → ${fg("Rationale per question")} · 11:12`),
          offerCard({ running: true }),
          sysr(`${ic("merge", "s12")}You applied Hanad's changes from Rationale per question · 3 files · 11:43 · <span class="linkbtn">${ic("undo", "s12")}Revert Hanad's changes</span>`),
          sysr(`${ic("file", "s12")}Your agent was told: Hanad's changes were applied to your files. Credit him when you commit them.`),
          sysr(`${ic("check", "s12")}Committed “Show a rationale under each question” · <span class="mono">Co-authored-by: Hanad</span> · 12:02`),
          sysr(`${ic("x", "s12")}You declined Hanad's 2 commits · 11:43`),
          sysr(`${ic("x", "s12")}Hanad withdrew his offer · 11:44`),
        ].join(""))}
        ${box("In Hanad's Rationale per question", [
          sysr(`${ic("branch", "s12")}You branched off Kousik's Prompt builder at turn 6, with its 2 uncommitted files · 11:12`),
          sysr(`${ic("pull", "s12")}Updated from Prompt builder · turn 7, 2 files · 11:30 · <span class="linkbtn">${ic("undo", "s12")}Undo update</span> <span class="faint">until your next turn</span>`),
          sysr(`${ic("clock", "s12 c-warning")}Updating from Prompt builder · <span class="mono">src/schema.ts</span> has conflict markers · <span class="linkbtn">Abort update</span>`),
          sysr(`${ic("file", "s12")}Your agent was told: an update is in progress, <span class="mono">src/schema.ts</span> has conflict markers; don't abort or stash it`),
          sysr(`${ic("merge", "s12")}You offered 2 commits to Prompt builder · waiting for Kousik · <span class="linkbtn">Withdraw</span>`),
          sysr(`${ic("check", "s12 c-success")}Kousik applied your changes · 11:43`),
          sysr(`${ic("x", "s12")}Kousik declined · 11:43 · <span class="linkbtn">Offer again</span>`),
          sysr(`${ic("alert", "s12 c-error")}Prompt builder changed since: turn 8 touched src/schema.ts. Your offer came back · <span class="linkbtn">Update and offer again</span>`),
          sysr(`${ic("merge", "s12")}You updated your offer · it replaces the open one · 11:52`),
          sysr(`${ic("clock", "s12")}Your offer is waiting · Prompt builder is archived`),
          sysr(`${ic("undo", "s12")}Kousik reverted your applied changes. You still have them here, and can offer them again.`),
          sysr(`${ic("undo", "s12")}Kousik reverted your applied changes, and this Update removed them here too · <span class="linkbtn">Bring them back</span>`),
        ].join(""))}
        ${box("The chip when the source changes hands or disappears", [
          `<div class="row" style="gap:10px;flex-wrap:wrap">${lineageChip("from a thread you can't open")}<span class="t12 muted">Removed from its sharing: Update stops, offers are withdrawn, the branch stays yours.</span></div>`,
          `<div class="row" style="gap:10px;flex-wrap:wrap">${lineageChip("from a deleted thread")}<span class="t12 muted">Source deleted: offers withdrawn, the branch carries on.</span></div>`,
          `<div class="row" style="gap:10px;flex-wrap:wrap">${lineageChip("from Prompt builder · archived")}<span class="t12 muted">Source archived: offers wait until it's unarchived.</span></div>`,
          sysr(`${ic("merge", "s12 c-input")}<b style="color:var(--foreground)">Hanad's agent</b> offers 2 commits from Rationale per question · 12:05 · agents' offers are labelled`),
        ].join(""))}
        ${box("Rutvik, who can open the machine but owns neither thread", offerCard({ readonly: true }))}
        ${box("⋯ on someone else's cloud thread", `<div class="card" style="padding:4px;width:300px;box-shadow:var(--shadow-lg)">
            <div class="mi on">${ic("branch")}<div class="grow"><div class="w5">Branch off…</div><div class="t12 muted">Your own branch, from Kousik's latest</div></div></div>
            <div class="mi">${ic("room")}<div class="grow"><div class="w5">Side chat</div><div class="t12 muted">Ask without changing anything</div></div></div>
            <div class="msep"></div>
            <div class="mi">${ic("eye")}<span>Follow</span></div><div class="mi">${ic("ext")}<span>Copy link</span></div><div class="mi">${ic("pull")}<span>Continue locally</span></div>
            <div class="mi" style="opacity:.5">${ic("share")}<span>Share… (owner only)</span></div><div class="mi" style="opacity:.5">${ic("userplus")}<span>Assign to… (owner only)</span></div></div>
          <div class="t12 muted">Fork stays the owner's tool. It reuses the owner's checkout, which is the trap Branch off avoids.</div>`)}
        ${box("Reverting to a turn across an Apply", dlg("Revert Prompt builder to turn 8?", "This also discards <b>Hanad's applied changes</b> (3 files). His branch keeps them, and he can offer them again.", '<span class="btn">Cancel</span><span class="btn danger">Revert</span>'))}
        ${box("How a lineage ships", [
          `<div class="row" style="gap:8px;flex-wrap:wrap">${lineageChip("Prompt builder shipped in pair-be#482 · 2 commits not in it")}<span class="btn sm">Start from main with them</span><span class="btn sm ghost">Settle</span></div>`,
          `<div class="row" style="gap:8px;flex-wrap:wrap">${lineageChip("Prompt builder is settled · 2 commits not in it")}<span class="btn sm">Start from main with them</span><span class="btn sm ghost">Settle</span></div>`,
          `<div class="row" style="gap:8px;flex-wrap:wrap">${lineageChip("from Prompt builder · all applied")}<span class="btn sm ghost">Settle</span></div>`,
          `<div class="card" style="padding:4px;width:360px;box-shadow:var(--shadow-lg)"><div class="mi on">${ic("merge")}<div class="grow"><div class="w5">Offer to Kousik</div><div class="t12 muted">2 commits</div></div></div><div class="msep"></div><div class="mi">${ic("push")}<div class="grow"><div class="w5">Push…</div><div class="t12 muted">Prompt builder's pull request ships this work. Pushing also includes Kousik's unpushed work, authored as him.</div></div></div><div class="mi">${ic("pr")}<span>Create PR…</span></div></div>`,
        ].join(""))}
        ${box("Settling, sleeping or discarding a machine that holds someone else's branch", dlg("Discard Kousik's machine?", "Hanad's <b>Rationale per question</b> is on this machine too. His agent stops. His work up to his last turn is kept, and his next message offers him a new machine of his own.", '<span class="btn">Cancel</span><span class="btn danger">Discard machine</span>'))}
        ${box("A branch on someone else's machine wants a wider audience", `<div class="row" style="gap:8px"><span class="btn sm" style="opacity:.5">${ic("share", "s12")}Share</span><span class="t12 muted">On Kousik's machine, sharing follows his list.</span></div>${dlg("Move to your own machine?", "<b>Rationale per question</b> continues on a new machine from its latest turn, with its conversation and lineage. Then you can share it or add it to another task.", '<span class="btn">Cancel</span><span class="btn primary">Move to my own machine</span>')}`)}
        ${box("Removing Hanad from the machine's sharing", dlg("Remove Hanad?", "Hanad has 1 thread on this machine, <b>Rationale per question</b>, and will lose access to it.", '<span class="btn">Cancel</span><span class="btn">Move it to Hanad\'s own machine first</span><span class="btn danger">Remove</span>'))}
        ${box("A busy machine", `<div class="opt2" style="width:100%"><div class="opt"><div class="row"><span class="radio"></span>${ic("machine", "s12 muted")}<span class="w5">Kousik's machine</span><span class="grow"></span><span class="t12 muted">3 working</span></div></div><div class="opt on"><div class="row"><span class="radio"></span>${ic("plus", "s12 muted")}<span class="w5">New machine</span><span class="grow"></span><span class="t12 muted">about a minute</span></div></div></div><div class="t12 muted row" style="gap:5px">${ic("cpu", "s12")}<span>Kousik's machine has 3 threads working on 4 vCPU, so New machine is selected. You can still pick his.</span></div><div class="t12 muted">Its own database and services, on your machine time. Kousik, Rutvik and Ankur can open it and reach your Claude and GitHub sign-ins, as with any thread you share.</div>`)}
      </div></div>`;
  },
};

// ---------- 12. The task page and Start a thread ----------

S.task = {
  title: "12. A task lists threads by lineage; Start a thread opens the same draft",
  render() {
    const trow = (who, t, l2, m, child) =>
      `<div class="lrow" style="padding:6px 8px;${child ? "margin-left:22px" : ""}">${child ? '<span class="faint" style="margin:2px -4px 0 -14px">└</span>' : ""}${av(who, { size: 16 })}<div class="grow"><div class="l1"><span class="w5">${t}</span></div><div class="l2">${l2}</div></div><span class="meta">${m}</span></div>`;
    return shell(
      sideNew({ sel: "qc" }),
      `<div class="top">${crumbs(QC)}<span class="grow"></span><button class="iconbtn">${ic("more")}</button></div>
      <div class="row" style="flex:1;align-items:stretch;min-height:0">
      <div class="scroll" style="flex:0 0 520px;border-right:1px solid var(--border)"><div style="padding:18px 28px">
        <div style="font-size:20px;font-weight:600;margin:0 0 8px">Generate question from prompt</div>
        <div class="row t12" style="gap:12px;margin-bottom:14px">${statusChip("progress", "In progress")}<span class="row" style="gap:5px">${av("kousik", { size: 14 })}Kousik</span><span class="muted">Created by you · Nov 10</span></div>
        <div class="muted" style="margin-bottom:18px">Take a role description and draft five interview questions in schema v2. Difficulty is tagged later, after review.</div>
        <div class="w6" style="margin-bottom:6px">Threads</div>
        ${trow("kousik", "Prompt builder", `${act("working")}working<span class="mid">·</span>Kousik's machine`, "4m")}
        ${trow("hanad", "Rationale per question", `${ic("branch", "s12")}branch<span class="mid">·</span>applied 11:43<span class="mid">·</span>Kousik's machine`, "2m", true)}
        ${trow("kousik", "Eval fixtures", "idle<span class='mid'>·</span>its own machine, asleep", "3h")}
        <div class="row" style="gap:8px;margin-top:10px"><span class="btn sm" style="border-color:var(--primary)">${ic("plus", "s12")}Start a thread</span><span class="btn sm ghost">Add existing thread</span></div>
      </div></div>
      <div class="scroll" style="padding:28px 32px;background:var(--muted)">
        <div class="t12 muted" style="margin-bottom:12px">Start a thread opens the same draft. It starts fresh from the space's base by default; the task's threads are listed under it:</div>
        ${taskDraft()}
      </div></div>`,
    );
  },
};

function taskDraft() {
  const f = (lab, val) => `<div class="field"><span class="lab">${lab}</span><div class="row" style="gap:8px;min-width:0">${val}</div></div>`;
  return `
    <div class="row" style="gap:10px;margin-bottom:4px">${ic("plus", "s18")}<span style="font-size:20px;font-weight:600">New thread on Generate question from prompt</span></div>
    <div class="muted" style="margin-bottom:16px">A fresh start from the space's base, on a new machine. Pick a thread below to build on it instead.</div>
    <div class="card" style="padding:10px 14px;position:relative;margin-bottom:12px">
      ${f("Start from", `<span class="select grow" style="border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-soft)">${ic("branch", "s12 muted")}<span class="mono">main</span><span class="t12 muted">pair-fe and pair-be</span><span class="grow"></span>${ic("down", "s12 muted")}</span>`)}
      ${f("Runs on", `<span>${ic("plus", "s12 muted")} New machine</span><span class="t12 muted">about a minute</span>`)}
      ${f("Branch", `<span class="select grow mono">rutvik/question-eval-hooks</span>`)}
      <div class="menu" style="left:118px;top:46px;width:470px">
        <div class="mi on" style="align-items:center">${ic("branch", "s16")}<div class="grow"><div class="w5 mono">main</div><div class="t12 muted">The space's base · a new machine</div></div>${ic("check", "s12")}</div>
        <div class="msep"></div>
        <div class="t12 muted w5" style="padding:6px 9px 2px">Or build on a thread on this task</div>
        <div class="mi" style="align-items:center">${av("kousik", { size: 20 })}<div class="grow"><div class="w5">Prompt builder, latest</div><div class="t12 muted">Kousik · turn 7 · switches to Branch off</div></div></div>
        <div class="mi" style="align-items:center;padding-left:26px"><span class="faint" style="margin-left:-14px;width:10px">└</span>${av("hanad", { size: 20 })}<div class="grow"><div class="w5">Rationale per question</div><div class="t12 muted">Hanad · branch of Prompt builder · all applied</div></div></div>
        <div class="mi" style="align-items:center">${av("kousik", { size: 20 })}<div class="grow"><div class="w5">Eval fixtures</div><div class="t12 muted">Kousik · idle · its machine is asleep</div></div></div>
      </div>
    </div>
    <div class="composer" style="max-width:none"><div class="ph">Take a role description and draft five interview questions in schema v2…</div>
      <div class="foot"><span class="chip">${ic("sparkle", "s12")}Opus 5.5</span><span class="chip">Your Claude</span><span class="grow"></span><span class="btn primary sm">Start <span style="opacity:.7">↵</span></span></div></div>`;
}

// ---------- 9c. A conflicted Update ----------

S.update = {
  title: "9c. Update shows what it will bring first, and asks how to resolve a conflict",
  render() {
    const dialog = `<div class="backdrop"><div class="dialog" style="width:540px">
      <div class="dh"><h2>Update from Prompt builder</h2><div class="muted" style="margin-top:4px">3 files changed on Prompt builder since your last Update. <b>1 conflicts with yours.</b></div></div>
      <div class="db">
        <div class="files" style="margin-top:4px">
          <div class="row">${ic("file", "s12 muted")}<span class="mono grow">src/Preview.tsx</span><span class="t12 muted">merges cleanly</span></div>
          <div class="row">${ic("file", "s12 muted")}<span class="mono grow">src/loading.tsx</span><span class="t12 muted">merges cleanly</span></div>
          <div class="row">${ic("alert", "s12 c-error")}<span class="mono grow">src/schema.ts</span><span class="t12 c-error">conflicts with your edit</span></div>
        </div>
        <div class="col" style="gap:8px;margin-top:6px">
          <div class="opt on"><div class="row"><span class="radio"></span><span class="w5">Update and let my agent resolve it</span></div><div class="t12 muted" style="margin:2px 0 0 22px">Starts one turn on your Claude account to resolve <span class="mono">src/schema.ts</span>, then commits.</div></div>
          <div class="opt"><div class="row"><span class="radio"></span><span class="w5">Update and resolve it myself</span></div><div class="t12 muted" style="margin:2px 0 0 22px">Leaves conflict markers in your worktree. Kousik's files are never touched.</div></div>
        </div>
      </div>
      <div class="df"><span class="t12 muted grow">You can abort until it's resolved.</span><span class="btn">Cancel</span><span class="btn primary">${ic("pull", "s12")}Update</span></div></div></div>`;
    return shell(
      sideNew({ viewer: "hanad", sel: "Rationale per question" }),
      `${rationaleTop()}<div class="feed"><div class="feed-in">${rationaleFeed()}</div></div>${composer({ text: "Message your agent", sendCls: "off" })}`,
      browserPanel("k7f2-3001.preview.pair.cloud/questions"),
      dialog,
    );
  },
};

S.resolving = {
  title: "9d. While an Update's conflict is open, one row is pinned above the composer",
  render() {
    const extra = `
      <div class="sys">${ic("pull", "s12")}Updating from Prompt builder · turn 8, 3 files · 1 conflict · 12:10</div>
      <div class="umsg"><div class="who"><span class="w6">You</span><span class="t12 muted">12:11</span>${av("hanad")}</div><div class="bubble">Keep Kousik's minutes range and my rationale field; both belong in the schema.</div></div>`;
    return shell(
      sideNew({ viewer: "hanad", sel: "Rationale per question" }),
      `${threadTop({
        crumbs: [...QC, "Rationale per question"],
        meta: `Idle<span class="mid">·</span>${ic("machine", "s12")}Kousik's machine<span class="mid">·</span>${lineageChip("from Prompt builder · updating")}`,
        right: `${stack(["kousik"], { size: 20 })}<span class="btn sm soft" style="opacity:.45">${ic("merge", "s12")}Offer to Kousik</span>`,
      })}
      <div class="feed"><div class="feed-in">${rationaleFeed()}${extra}</div></div>
      ${composer({
        above: `<div class="syncbar" style="background:var(--warning-surface);border-color:color-mix(in oklab,var(--warning-foreground) 30%,var(--border))">${ic("clock", "s12 c-warning")}<span class="grow">Resolving update from Prompt builder · <span class="mono">src/schema.ts</span> has conflict markers</span><span class="btn sm ghost">Open file</span><span class="btn sm">Abort update</span></div>`,
        text: "Message your agent",
        left: `<span class="chip">${ic("sparkle", "s12")}Opus 5.5</span><span class="chip">Your Claude</span>`,
        sendCls: "off",
      })}`,
      browserPanel("k7f2-3001.preview.pair.cloud/questions"),
    );
  },
};

// ---------- 13. Empty and unavailable ----------

S.empty = {
  title: "13. Empty and unavailable states",
  w: 1440,
  h: 700,
  render() {
    const e = (icon, title, body) =>
      `<div class="empty">${ic(icon, "s18")}<div class="w6" style="color:var(--foreground);margin:8px 0 4px">${title}</div><div class="t12">${body}</div></div>`;
    return `<div class="board"><h1>Empty and unavailable states</h1><div class="muted t14" style="margin-bottom:20px">Every page says what belongs there; every blocked Branch off says why and what to do instead.</div>
      <div class="row" style="align-items:flex-start;gap:28px;flex-wrap:wrap">
        ${box("Inbox, nothing waiting", e("inbox", "Nothing needs you", "Approvals, questions, assigned tasks and offers to your threads show up here."), 420)}
        ${box("My tasks, none open", e("tasks", "No open tasks", "Tasks you own in any space show up here, by status."), 420)}
        ${box("Shared with you, nothing yet", e("users", "Nothing is shared with you by name", "Your spaces' threads are in each space. ⌘K finds any thread you can open."), 420)}
        ${box("Branch off: Kousik's machine is asleep", `<div class="opt2"><div class="opt on"><div class="row"><span class="radio"></span>${ic("moon", "s12 muted")}<span class="w5">Kousik's machine</span><span class="grow"></span><span class="t12 muted">asleep</span></div></div><div class="opt"><div class="row"><span class="radio"></span>${ic("plus", "s12 muted")}<span class="w5">New machine</span><span class="grow"></span><span class="t12 muted">about a minute</span></div></div></div><div class="t12 muted">Asleep: it wakes when you start, in about 20 seconds.</div><div class="t12 muted">${DISCLOSE}</div>`, 640)}
        ${box("Branch off: Kousik's machine failed", `<div class="opt2"><div class="opt off"><div class="row"><span class="radio"></span>${ic("alert", "s12 c-error")}<span class="w5">Kousik's machine</span><span class="grow"></span><span class="t12 muted">failed</span></div></div><div class="opt on"><div class="row"><span class="radio"></span>${ic("plus", "s12 muted")}<span class="w5">New machine</span><span class="grow"></span><span class="t12 muted">about a minute</span></div></div></div><div class="t12 muted row" style="gap:5px">${ic("alert", "s12")}<span>Kousik's machine failed, so only New machine is offered. It starts from Prompt builder's last turn.</span></div><div class="t12 muted">Its own database and services, on your machine time. Kousik, Rutvik and Ankur can open it and reach your Claude and GitHub sign-ins, as with any thread you share.</div>`, 640)}
        ${box("Branch off: no Claude account yet", `<div class="row" style="gap:6px"><span class="chip">${ic("sparkle", "s12")}Opus 5.5</span><span class="chip" style="color:var(--muted-foreground)">No Claude account</span><span class="btn sm">Connect Claude</span><span class="grow"></span><span class="btn primary sm" style="opacity:.45">${ic("branch", "s12")}Branch off</span></div><div class="t12 muted">A branch runs on your own account, never on Kousik's.</div>`, 640)}
        ${box("A branch without your GitHub connected", `<div class="row" style="gap:8px">${ic("alert", "s12 muted")}<span class="grow">Update and Offer work. Pushing and pull requests need your GitHub.</span><span class="btn sm">Connect GitHub</span></div>`, 640)}
      </div></div>`;
  },
};

// ---------- 14. Mobile ----------

S.mobile = {
  title: "14. Mobile: Home, Inbox, Branch off, Update, the lineage pill and Apply",
  w: 1800,
  h: 1900,
  render() {
    const status = (dark) => `<div class="status"${dark ? ' style="color:#fff"' : ""}><span>9:41</span><span>●●● ▮</span></div>`;
    const row = (lead, t, right = "", cls = "") =>
      `<div class="row ${cls}" style="height:44px;padding:0 16px;border-bottom:1px solid var(--border);gap:12px">${lead}<span class="grow ell" style="font-size:15px">${t}</span>${right}</div>`;
    const nav = (title, sub, extra = "") =>
      `<div class="row" style="padding:2px 12px 8px;gap:10px;border-bottom:1px solid var(--border)">${ic("back", "s18")}<div class="grow col" style="align-items:center;min-width:0"><span class="w6 ell" style="font-size:15px">${title}</span><span class="t12 muted row" style="gap:4px">${sub}</span></div>${ic("more", "s18")}</div>${extra}`;
    const home = `<div class="phone">${status()}
      <div class="row" style="padding:4px 16px 10px"><span style="font-size:28px;font-weight:700" class="grow">Home</span>${ic("search", "s18")}${ic("compose", "s18")}</div>
      ${row(ic("inbox", "s16"), "Inbox", '<span class="pill">4</span>')}
      ${row(ic("tasks", "s16"), "My tasks")}
      ${row(ic("share", "s16"), "Shared with you")}
      <div class="t12 muted w6" style="padding:14px 16px 6px">SPACES</div>
      ${row(ic("space", "s16"), "Question creation", '<span class="muted">2</span>')}
      ${row(ic("space", "s16"), "Onboarding revamp", '<span class="muted">1</span>')}
      ${row(ic("space", "s16"), "Billing v3", '<span class="dot" style="background:var(--faint)"></span>')}
      ${row(ic("space", "s16"), "Mobile push", '<span class="muted">1</span>')}
      ${row(ic("space", "s16"), "Docs site")}
      ${row(ic("right", "s16 muted"), '<span class="muted">2 more</span>')}
      <div class="t12 muted w6" style="padding:14px 16px 6px">THREADS</div>
      ${row(ic("space", "s12 faint"), "Seed role catalog", act("approval", "s16"))}
      ${row(ic("space", "s12 faint"), "Expo token refresh", act("answer", "s16"))}
      </div>`;
    const inbox = `<div class="phone">${status()}
      <div class="row" style="padding:4px 16px 8px"><span style="font-size:28px;font-weight:700" class="grow">Inbox</span><span class="t12 muted">4 need you</span></div>
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);background:var(--accent)">
        <div class="row" style="gap:10px">${act("approval", "s16")}<span class="w6 grow">Approve <span class="code">pnpm db:migrate</span></span><span class="t12 muted">2m</span></div>
        <div class="t12 muted" style="margin:3px 0 10px 26px">Question creation › Seed role catalog</div>
        <div class="row" style="gap:8px;margin-left:26px"><span class="btn primary" style="height:34px;padding:0 16px">Approve</span><span class="btn" style="height:34px">Decline</span></div></div>
      ${[
        [act("answer", "s16"), "Keep the old push token for 24 hours?", "Mobile push › Expo token refresh", "9m"],
        [act("offer", "s16"), "Hanad offers 2 commits to Seed role catalog", "from Role fixtures v2", "14m"],
        [ic("userplus", "s16 muted"), "Meera assigned you Trial banner copy", "Onboarding revamp · not started", "1h"],
      ]
        .map(([l, t, s, m]) => `<div style="padding:11px 16px;border-bottom:1px solid var(--border)"><div class="row" style="gap:10px">${l}<span class="grow ell">${t}</span><span class="t12 muted">${m}</span></div><div class="t12 muted ell" style="margin:2px 0 0 26px">${s}</div></div>`)
        .join("")}
      <div class="t12 muted w6" style="padding:14px 16px 6px">FOR YOU</div>
      <div style="padding:11px 16px;border-bottom:1px solid var(--border)"><div class="row" style="gap:10px">${ic("at", "s16 muted")}<span class="grow w6">Kousik mentioned you</span><span class="t12 muted">22m</span></div><div class="t12 muted ell" style="margin:2px 0 0 26px">“@Rutvik does difficulty belong in schema v2?”</div></div>
      </div>`;
    const viewer = `<div class="phone">${status()}
      ${nav("Prompt builder", `${av("kousik", { size: 14 })}Kousik's thread · ${act("working")}Working`)}
      <div style="padding:10px 14px;display:flex;flex-direction:column;gap:12px;flex:1">
        <div class="umsg" style="max-width:85%"><div class="bubble">Now wire the preview to the new schema and add a loading state.</div></div>
        <div class="row t12 c-info" style="gap:6px">${act("working")}Working · 1m 04s</div>
        <div class="steps"><div class="row">${ic("compose", "s12")}Edited <span class="mono">Preview.tsx</span></div><div class="row">${ic("term", "s12")}Running <span class="mono">pnpm test</span></div></div>
      </div>
      <div style="padding:8px 12px 28px;border-top:1px solid var(--border)">
        <div class="t12 muted row" style="gap:6px;margin-bottom:8px"><span class="grow">Goes into Kousik's conversation</span><span class="linkbtn">${ic("branch", "s12")}Branch off</span></div>
        <div class="row" style="border:1px solid var(--border);border-radius:20px;height:40px;padding:0 6px 0 14px"><span class="grow muted">Message Kousik's agent</span><span class="send off">${ic("up")}</span></div></div></div>`;
    const sheet = `<div class="phone" style="background:var(--overlay)">${status(true)}
      <div class="sheet" style="height:700px;padding:0 16px 24px"><div class="grabber"></div>
        <div class="row" style="margin:6px 0 4px">${ic("branch", "s18")}<span class="w6 grow" style="font-size:17px">Branch off Prompt builder</span>${ic("x", "s18 muted")}</div>
        <div class="muted" style="margin-bottom:10px">Your own branch, from Kousik's latest work. His conversation and files stay as they are.</div>
        <div class="row" style="height:44px;border-bottom:1px solid var(--border)"><span class="muted" style="width:92px">Start from</span><span class="grow ell">Latest · turn 6 · 2 uncommitted</span>${ic("right", "s12 muted")}</div>
        <div class="muted" style="margin:10px 0 6px">Runs on</div>
        <div class="col" style="gap:6px"><div class="opt on"><div class="row"><span class="radio"></span><span class="w5">Kousik's machine</span></div><div class="t12 muted" style="margin:2px 0 0 22px">Seconds · 1 thread working</div></div><div class="opt"><div class="row"><span class="radio"></span><span class="w5">New machine</span></div><div class="t12 muted" style="margin:2px 0 0 22px">About a minute · own database and services</div></div></div>
        <div class="t12 muted" style="margin:6px 0 4px;line-height:1.45">${DISCLOSE}</div>
        <div class="row" style="height:44px;border-bottom:1px solid var(--border)"><span class="muted" style="width:92px">Model</span><span class="grow ell">Opus 5.5 · Your Claude</span>${ic("right", "s12 muted")}</div>
        <div class="card" style="padding:10px 12px;margin:12px 0;min-height:64px">Add a one-line rationale to each generated question…</div>
        <span class="btn primary" style="width:100%;justify-content:center;height:44px;font-size:15px;border-radius:12px">${ic("branch", "s16")}Branch off</span>
      </div></div>`;
    const lane = `<div class="phone">${status()}
      ${nav("Rationale per question", `${ic("branch", "s12")}Your branch · Idle`)}
      <div class="row" style="padding:8px 12px;gap:8px"><span class="lchip" style="height:26px">${ic("branch", "s12")}from Prompt builder · 2 to offer · 1 behind ${ic("down", "s12")}</span></div>
      <div style="padding:6px 14px;display:flex;flex-direction:column;gap:12px;flex:1">
        <div class="sys">${ic("branch", "s12")}Branched off Prompt builder at turn 6</div>
        <div class="umsg" style="max-width:85%"><div class="bubble">Add a one-line rationale to each generated question.</div></div>
        <div class="amsg" style="font-size:13px">Each question now carries a rationale of at most 120 characters, committed in two commits.</div>
      </div>
      <div style="padding:8px 12px 28px;border-top:1px solid var(--border)">
        <div class="row" style="gap:8px;margin-bottom:8px"><span class="btn" style="height:34px">${ic("pull", "s12")}Update</span><span class="btn soft" style="height:34px">${ic("merge", "s12")}Offer to Kousik</span></div>
        <div class="row" style="border:1px solid var(--border);border-radius:20px;height:40px;padding:0 6px 0 14px"><span class="grow muted">Message your agent</span><span class="send off">${ic("up")}</span></div></div></div>`;
    const apply = `<div class="phone">${status()}
      ${nav("Prompt builder", `${av("kousik", { size: 14 })}Your thread · Idle`)}
      <div class="row" style="padding:8px 12px;gap:8px"><span class="lchip offer" style="height:26px">${ic("merge", "s12")}${stack(["hanad"], { size: 14 })}1 branch · 1 offer ${ic("down", "s12")}</span></div>
      <div style="padding:6px 12px;display:flex;flex-direction:column;gap:12px;flex:1">
        <div class="amsg" style="font-size:13px">The preview reads schema v2 and shows a skeleton while questions load.</div>
        <div class="tcard accent" style="padding:12px">
          <div class="row" style="gap:8px">${act("offer", "s16")}<span><b>Hanad</b> offers 2 commits</span><span class="grow"></span><span class="t12 muted">11:41</span></div>
          <div class="t12 muted" style="margin:4px 0 6px 24px">from Rationale per question · 3 files <span class="add">+84</span> <span class="del">−12</span></div>
          <div style="margin:0 0 8px 24px;font-size:13px">“Adds a one-line rationale to each question.”</div>
          <div class="okline" style="margin:0 0 4px 24px">${ic("check", "s12")}Applies cleanly</div><div class="t12 muted" style="margin:0 0 10px 24px">Into your files, uncommitted. Your next commit credits Hanad.</div>
          <div class="row" style="gap:8px;margin-left:24px"><span class="btn primary" style="height:34px;padding:0 16px">Apply</span><span class="btn" style="height:34px">Changes</span><span class="btn ghost" style="height:34px">Decline</span></div></div>
      </div>
      <div style="padding:8px 12px 28px;border-top:1px solid var(--border)"><div class="row" style="border:1px solid var(--border);border-radius:20px;height:40px;padding:0 6px 0 14px"><span class="grow muted">Message your agent</span><span class="send off">${ic("up")}</span></div></div></div>`;
    const updateSheet = `<div class="phone" style="background:var(--overlay)">${status(true)}
      <div class="sheet" style="height:560px;padding:0 16px 24px"><div class="grabber"></div>
        <div class="row" style="margin:6px 0 4px">${ic("pull", "s18")}<span class="w6 grow" style="font-size:17px">Update from Prompt builder</span>${ic("x", "s18 muted")}</div>
        <div class="muted" style="margin-bottom:10px">3 files changed since your last Update. <b>1 conflicts with yours.</b></div>
        <div class="files"><div class="row">${ic("file", "s12 muted")}<span class="mono grow">src/Preview.tsx</span><span class="t12 muted">clean</span></div><div class="row">${ic("file", "s12 muted")}<span class="mono grow">src/loading.tsx</span><span class="t12 muted">clean</span></div><div class="row">${ic("alert", "s12 c-error")}<span class="mono grow">src/schema.ts</span><span class="t12 c-error">conflicts</span></div></div>
        <div class="col" style="gap:6px;margin:6px 0 14px"><div class="opt on"><div class="row"><span class="radio"></span><span class="w5">Let my agent resolve it</span></div><div class="t12 muted" style="margin:2px 0 0 22px">One turn on your Claude account</div></div><div class="opt"><div class="row"><span class="radio"></span><span class="w5">Resolve it myself</span></div><div class="t12 muted" style="margin:2px 0 0 22px">Leaves conflict markers in your worktree</div></div></div>
        <span class="btn primary" style="width:100%;justify-content:center;height:44px;font-size:15px;border-radius:12px">${ic("pull", "s16")}Update</span>
      </div></div>`;
    const resolving = `<div class="phone">${status()}
      ${nav("Rationale per question", `${ic("branch", "s12")}Your branch · Idle`)}
      <div class="row" style="padding:8px 12px;gap:8px"><span class="lchip" style="height:26px">${ic("branch", "s12")}from Prompt builder · updating ${ic("down", "s12")}</span></div>
      <div style="padding:6px 14px;display:flex;flex-direction:column;gap:12px;flex:1">
        <div class="sys">${ic("pull", "s12")}Updating from Prompt builder · 1 conflict</div>
        <div class="umsg" style="max-width:85%"><div class="bubble">Keep Kousik's minutes range and my rationale field.</div></div>
      </div>
      <div style="padding:8px 12px 28px;border-top:1px solid var(--border)">
        <div class="row" style="gap:8px;margin-bottom:8px;padding:8px 10px;border-radius:10px;background:var(--warning-surface)">${ic("clock", "s12 c-warning")}<span class="grow t12">Resolving update · <span class="mono">src/schema.ts</span></span><span class="btn sm">Abort</span></div>
        <div class="row" style="border:1px solid var(--border);border-radius:20px;height:40px;padding:0 6px 0 14px"><span class="grow muted">Message your agent</span><span class="send off">${ic("up")}</span></div></div></div>`;
    return `<div class="board"><h1>Mobile</h1><div class="muted t14" style="margin-bottom:20px">Home keeps the sidebar's order and caps. Inbox approves in place. Branch off and Update open sheets, a branch's lineage is a pill under the title, an open update pins one row, and offers apply from the card.</div>
      <div class="row" style="gap:36px;align-items:flex-start;justify-content:center;margin-bottom:40px">${home}${inbox}${viewer}${sheet}</div>
      <div class="row" style="gap:36px;align-items:flex-start;justify-content:center">${lane}${updateSheet}${resolving}${apply}</div></div>`;
  },
};

// ---------- Router ----------

function render() {
  const [, id = "", theme] = (location.hash || "#/").split("/");
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  const root = document.getElementById("root");
  const screen = S[id];
  if (!screen) {
    root.innerHTML = `<div class="board"><h1>Spaces redesign prototype</h1><div class="muted t14" style="margin-bottom:18px">A calm sidebar, and building together with Branch off. The spec is ../spaces-redesign.md.</div>
      ${Object.entries(S)
        .map(
          ([k, s]) =>
            `<div style="margin:6px 0"><a class="linkbtn" href="#/${k}">${s.title}</a> <span class="muted t12">· <a href="#/${k}/dark">dark</a></span></div>`,
        )
        .join("")}</div>`;
    return;
  }
  document.title = screen.title;
  root.innerHTML = screen.render();
  if (screen.after) screen.after();
}
window.addEventListener("hashchange", render);
window.addEventListener("DOMContentLoaded", render);
