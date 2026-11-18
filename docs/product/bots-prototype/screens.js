// Every board. Open index.html#/<id>, or #/<id>/dark. index.html#/ lists them.
// One moment for every board: Tuesday 10:55, Rutvik's Mac, one bot (Atlas).

const S = {};

// ---------- Cast ----------

const BOT = { n: "Atlas", c: "#4f46e5", charter: "Ships my Pair work end to end" };

function botAv(size = 20) {
  const fs = size <= 16 ? 9 : size <= 20 ? 10.5 : size <= 28 ? 13 : 17;
  return `<span class="av" style="--c:${BOT.c};width:${size}px;height:${size}px;font-size:${fs}px;border-radius:${Math.round(size * 0.32)}px" title="${BOT.n}">${BOT.n[0]}</span>`;
}

const WORKER = "Pi · DeepSeek V4.1 Flash";
const REVIEWER = "Claude · Opus 5.5 · High";

// Session state glyphs, derived from the thread.
function sess(kind, cls = "s12") {
  switch (kind) {
    case "working":
      return act("working", cls);
    case "bot":
      return ic("ask", `${cls} c-info`);
    case "you":
      return ic("ask", `${cls} c-input`);
    case "done":
      return ic("check", `${cls} c-success`);
    case "failed":
      return ic("alert", `${cls} c-error`);
    case "paused":
      return ic("clock", `${cls} c-warning`);
    case "stopped":
      return ic("x", `${cls} muted`);
    case "took":
      return ic("users", `${cls} muted`);
  }
  return "";
}

function jobGlyph(s, size = 14) {
  if (s === "needs") return ic("ask", `s${size >= 16 ? 16 : 14} c-input`);
  if (s === "working") return st("progress", size);
  if (s === "new") return st("todo", size);
  if (s === "done") return st("done", size);
  if (s === "stopped") return st("canceled", size);
  return "";
}

const pause = (cls = "s12") =>
  `<svg class="ic ${cls} muted" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`;

const pr = (n, extra = "") =>
  `<span class="chip ghost t11" style="height:18px;gap:3px;padding:0 6px">${ic("pr", "s12")}#${n}${extra}</span>`;

// ---------- Sidebar ----------

function sideBots(o = {}) {
  const sel = o.sel;
  const top = `
  <div class="side-top">
    <span class="brand">Pair</span>
    <span class="envchip">This Mac ${ic("down", "s12")}</span>
    <span class="grow"></span>
    <button class="iconbtn" title="New thread">${ic("compose")}</button>
  </div>`;
  const inbox = o.inbox ?? 3;
  const fixed = `
    <div class="search">${ic("search")}<span class="grow">Search</span><span class="kbd">⌘K</span></div>
    <div class="srow${sel === "inbox" ? " sel" : ""}">${ic("inbox")}<span class="grow">Inbox</span>${inbox ? `<span class="pill">${inbox}</span>` : ""}</div>`;
  const right = o.paused
    ? pause()
    : o.botNeeds === 0
      ? act("working")
      : `<span class="pill">${o.botNeeds ?? 2}</span>`;
  const bot = o.noBot
    ? `<div class="srow${sel === "bots" ? " sel" : ""} muted" style="gap:8px">${ic("plus", "s12")}<span class="grow">New bot</span></div>`
    : `<div class="srow${sel === "atlas" ? " sel" : ""}" style="gap:8px">${botAv(16)}<span class="grow ell">${BOT.n}</span>${right}</div>`;
  const threads = [
    { t: "Fix sidebar drag flicker", m: "2d" },
    { t: "Release checklist 0.1.8", m: "5h" },
    { t: "Pi model picker search", m: "1d" },
    { t: "Notes on cloud handoff", m: "3d" },
  ]
    .map((t) => sideRowThread(t, false))
    .join("");
  return `<aside class="side">${top}<div class="side-body">${fixed}
    <div class="sect"><span class="grow">Bots</span>${ic("plus")}</div>${bot}
    <div class="sect"><span class="grow">Threads</span>${ic("filter")}</div>
    ${threads}
    <div class="sect">${ic("right")}<span class="grow">Snoozed</span><span class="tnum">1</span></div>
    <div class="sect" style="margin-top:0">${ic("right")}<span class="grow">Settled</span></div>
  </div></aside>`;
}

// ---------- Bot header ----------

function botTop(o = {}) {
  const tabs = ["Briefing", "Chat", "Playbook"]
    .map((t) => `<span class="${t === (o.tab || "Briefing") ? "on" : ""}">${t}</span>`)
    .join("");
  const summary =
    o.summary ??
    `5 jobs<span class="mid">·</span>3 sessions working<span class="mid">·</span>2 need you`;
  return `<div class="top" style="min-height:64px;gap:12px;position:relative">
    ${botAv(32)}
    <div class="col grow" style="gap:2px;min-width:0">
      <div class="row" style="gap:8px"><span class="title">${BOT.n}</span><span class="t12 muted ell">${BOT.charter}</span></div>
      <div class="row t12 muted" style="gap:6px;white-space:nowrap">${summary}</div>
    </div>
    <span class="seg">${tabs}</span>
    <button class="iconbtn"${o.menu ? ' style="background:var(--accent)"' : ""}>${ic("more")}</button>
    ${o.menu || ""}
  </div>`;
}

// ---------- Ask card (compact) ----------

function askCard(o) {
  const opts = o.opts.map((x) => `<span class="btn sm">${x}</span>`).join("");
  return `<div class="tcard" style="padding:10px 12px;margin-top:6px">
    <div class="row" style="gap:8px">
      ${ic("ask", "s14 c-input")}
      <span class="w6 ell grow">${o.q}</span>
      <span class="t12 muted row" style="gap:5px;white-space:nowrap">${o.noJob ? "" : `J-${o.job} · ${o.jobTitle}<span class="mid">·</span>`}${o.age}</span>
    </div>
    <div class="muted" style="margin:3px 0 0 22px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${o.why}</div>
    <div class="row" style="gap:6px;margin:8px 0 0 22px;flex-wrap:wrap">
      ${opts}
      <span class="t12 faint" style="margin-left:2px">Atlas would pick <span class="muted">${o.pick}</span></span>
      <span class="row" style="gap:6px;margin-left:auto"><span class="btn sm ghost">Answer…</span><span class="btn sm ghost">Let Atlas decide</span></span>
    </div>
  </div>`;
}

function escalated(o) {
  return `<div class="tcard" style="padding:10px 12px;margin-top:6px">
    <div class="row" style="gap:8px">
      ${sess("bot", "s14")}
      <span class="w6 ell grow">${o.t}</span>
      <span class="t12 muted row" style="gap:5px;white-space:nowrap">J-${o.job} · ${o.jobTitle}<span class="mid">·</span>${o.age}</span>
    </div>
    <div class="muted" style="margin:3px 0 0 22px">${o.why}</div>
    <div class="row" style="gap:6px;margin:8px 0 0 22px"><span class="btn sm">Answer yourself</span><span class="btn sm ghost">Open session</span></div>
  </div>`;
}

// ---------- Job rows ----------

function jobRow(j, o = {}) {
  const prs = (j.prs || []).map((n) => pr(n)).join("");
  return `<div class="lrow${o.focus ? " focus" : ""}" style="padding:8px 10px;align-items:center">
      <span class="lead">${jobGlyph(j.status)}</span>
      <div class="grow" style="min-width:0">
        <div class="l1"><span class="faint t12 tnum" style="width:32px;flex:none">J-${j.n}</span><span class="w5 ell">${j.t}</span>${j.fresh ? '<span class="dot" style="background:var(--input-foreground)"></span>' : ""}</div>
        <div class="l2"><span style="width:32px;flex:none"></span><span class="ell">${j.h}</span></div>
      </div>
      <span class="t12 ${j.warn ? "c-warning" : "muted"}" style="white-space:nowrap">${j.progress || ""}</span>
      <span class="row" style="gap:4px;min-width:56px;justify-content:flex-end">${prs}</span>
      <span class="meta" style="width:28px;text-align:right">${j.m}</span>
    </div>`;
}

const JOBS = {
  j14: {
    n: 14,
    t: "Sidebar drag flicker",
    status: "working",
    fresh: true,
    h: "Fix is up as #612; a review session is checking it",
    progress: "1 of 2 sessions done",
    prs: [612],
    m: "2m",
  },
  j13: {
    n: 13,
    t: "Upgrade Effect to 3.12",
    status: "working",
    h: "Server resumed after a decision; Atlas asked web for a status",
    progress: "Upgrade web quiet 34m",
    warn: true,
    prs: [609],
    m: "1m",
  },
  j12: {
    n: 12,
    t: "Mobile push opt-in copy",
    status: "new",
    h: "Waiting for Atlas",
    progress: "",
    prs: [],
    m: "now",
  },
  j11: {
    n: 11,
    t: "Flaky snapshot test in ThreadTerminalDrawer",
    status: "done",
    h: "Merged #604 · the test waits on the terminal's ready event",
    prs: [604],
    m: "2h",
  },
  j10: {
    n: 10,
    t: "Release notes for pair.33",
    status: "done",
    h: "Posted to the release",
    prs: [],
    m: "5h",
  },
  j9: {
    n: 9,
    t: "Try Bun for the dev runner",
    status: "stopped",
    h: "Stopped by you · 2 sessions stopped",
    prs: [],
    m: "1d",
  },
};

const gh = (n, c, o = {}) =>
  `<div class="ghead" style="margin-top:${o.first ? 0 : 14}px">${o.closed ? ic("right", "s12") : ""}<span>${n}</span><span class="cnt">${c}</span>${o.right ? `<span class="grow"></span>${o.right}` : ""}</div>`;

const ASK_15 = {
  q: "Rate-limit per member or per API token?",
  job: 15,
  jobTitle: "Rate-limit the threads API",
  age: "4m",
  why: "Your playbook doesn't say. Per member also caps outside agents that use your tokens; per token lets one member run several agents at full speed.",
  opts: ["Per member", "Per token", "Both, tighter per token"],
  pick: "Per member",
};
const ASK_16 = {
  q: "Delete the V1 state.sqlite copy path?",
  job: 16,
  jobTitle: "Drop the V1 state.sqlite copy",
  age: "12m",
  why: 'You check deletions outside the job. This removes <span class="code">copyLegacyState</span> and its test; installs older than pair.20 still run it once on upgrade.',
  opts: ["Delete it", "Keep it one more release"],
  pick: "Keep it one more release",
};

const DECISIONS = [
  {
    s: "Upgrade server",
    q: "Keep the deprecated Layer.mock helpers, or move the tests?",
    a: "Move the tests",
    cite: "Instructions: “Don't keep deprecated APIs alive in tests”",
    m: "1m",
  },
  {
    s: "Fix drag flicker",
    q: "Pointer capture on the row, or touch-action on the list?",
    a: "Pointer capture on the row",
    cite: "Note: “Fix the cause, not the symptom”",
    m: "24m",
  },
  {
    s: "Upgrade web",
    q: "Update the 3 failing snapshots?",
    a: "No; fix the types first",
    cite: "Note: “Snapshots change only with a reason”",
    m: "40m",
  },
  {
    s: "Research: existing limiter",
    q: "Read-only, or prototype a limiter?",
    a: "Read-only",
    cite: "Instructions: “Ask me about product decisions”",
    m: "52m",
  },
];

function decisionRow(d, o = {}) {
  return `<div class="row" style="gap:8px;padding:5px 10px;font-size:12.5px;align-items:flex-start">
    ${ic("check", "s12 muted")}
    <div class="grow" style="min-width:0"><div class="${o.wrap ? "" : "ell"}"><span class="muted">${d.s}:</span> ${d.q} <span class="mid">→</span> <span class="w5">${d.a}</span></div>
    <div class="t12 faint${o.wrap ? "" : " ell"}">${d.cite}${o.wrap && !o.correcting ? ' <span class="mid">·</span> <span class="linkbtn t12">Correct</span>' : ""}</div>${o.correcting ? `<div class="row" style="gap:6px;margin-top:6px"><span class="select grow" style="height:28px">Use touch-action; pointer capture breaks the iPad drag</span><span class="btn sm primary">Send to Atlas</span><span class="btn sm ghost">Cancel</span></div>` : ""}</div>
    ${o.correcting || o.wrap ? "" : '<span class="linkbtn t12">Correct</span>'}
    <span class="t12 faint" style="width:26px;text-align:right">${d.m}</span>
  </div>`;
}

function briefingBody(o = {}) {
  const decided = o.decisionsOpen
    ? `${gh("Decided for you", "4 since you last looked", { right: '<span class="linkbtn t12">Hide</span>' })}${DECISIONS.map((d, i) => decisionRow(d, { correcting: o.correcting && i === 1 })).join("")}`
    : `<div class="row t12 muted" style="gap:6px;padding:10px 10px 0">${ic("check", "s12")}Atlas decided 4 things since you last looked<span class="mid">·</span><span class="linkbtn t12">Review</span></div>`;
  return `<div class="feed" style="padding-top:16px;padding-bottom:120px"><div class="feed-in" style="max-width:${o.narrow ? 660 : 820}px">
    ${gh("Needs you", 2, { first: true })}
    ${askCard(ASK_15)}
    ${askCard(ASK_16)}
    ${decided}
    ${gh("In progress", 3)}
    ${jobRow(JOBS.j14, { focus: o.focus === 14 })}
    ${jobRow(JOBS.j13, { focus: o.focus === 13 })}
    ${jobRow(JOBS.j12)}
    ${gh("Done this week", 3, { closed: true, right: '<span class="linkbtn t12">All jobs</span>' })}
  </div></div>`;
}

function jobComposer(o = {}) {
  return composer({
    text: o.text || "Give Atlas a job…",
    typed: o.typed,
    left: `<span class="chip ghost t12">${ic("folder", "s12")}${o.project || "Atlas picks the project"}${ic("down", "s12")}</span>`,
    right: `<span class="t12 faint" style="margin-right:6px">${o.hint || "Start job · ⌘↵"}</span>`,
    sendCls: o.sendCls,
  });
}

S.briefing = {
  title: "1. Briefing: what needs you, what Atlas decided, where each job stands",
  render() {
    return shell(sideBots({ sel: "atlas" }), `${botTop()}${briefingBody()}${jobComposer()}`);
  },
};

S.decisions = {
  title: "2. Decided for you, expanded, with one being corrected",
  render() {
    return shell(
      sideBots({ sel: "atlas" }),
      `${botTop()}${briefingBody({ decisionsOpen: true, correcting: true })}${jobComposer()}`,
    );
  },
};

// ---------- 3. Job detail ----------

function sessRow(s) {
  return `<div class="row" style="gap:8px;padding:6px 0;align-items:flex-start">
    <span style="margin-top:2px">${sess(s.state)}</span>
    <div class="grow" style="min-width:0">
      <div class="row" style="gap:6px"><span class="w5 ell">${s.t}</span>${s.pr ? pr(s.pr, s.diff ? ` <span class="faint">·</span> ${s.diff}` : "") : ""}</div>
      <div class="t12 ${s.warn ? "c-warning" : "muted"} ell">${s.line}</div>
    </div>
    ${s.action || '<span class="btn sm ghost">Open</span>'}
  </div>`;
}

function tl(icon, html, time) {
  return `<div class="row" style="gap:10px;align-items:flex-start;padding:4px 0">
    <span style="width:14px;display:inline-flex;justify-content:center;margin-top:2px">${icon}</span>
    <div class="grow t12" style="min-width:0">${html}</div>
    <span class="t12 faint" style="white-space:nowrap">${time}</span></div>`;
}

function panelHead(o) {
  return `<div style="padding:12px 16px 10px;border-bottom:1px solid var(--border)">
    <div class="row" style="gap:8px">${jobGlyph(o.status)}<span class="faint t12 tnum">J-${o.n}</span><span class="w6 ell grow">${o.t}</span><span class="chip ghost t11" style="height:20px">${o.pill}</span><button class="iconbtn">${ic("more")}</button><button class="iconbtn">${ic("x")}</button></div>
    <div class="t12 muted" style="margin:3px 0 0 22px">${o.h}</div>
  </div>`;
}

function jobPanel(o = {}) {
  return `<aside class="panel wide" style="position:relative">${panelHead({ status: "working", n: 13, t: "Upgrade Effect to 3.12", pill: "Working", h: JOBS.j13.h })}
  <div class="pbody" style="padding:12px 16px;overflow:hidden">
    <div class="t12 muted" style="margin-bottom:4px">You asked · yesterday 18:02</div>
    <div class="card" style="padding:8px 11px">Upgrade Effect to 3.12 across the repo. Keep the diff boring; one PR per package is fine.</div>
    <div class="row" style="margin:14px 0 2px"><span class="t12 muted w5 grow">Sessions · 1 of 3 done</span><span class="t12 faint">on ${WORKER}</span></div>
    ${sessRow({ state: "done", t: "Upgrade contracts + shared", pr: 609, diff: '14 files <span class="add">+212</span> <span class="del">−198</span>', line: "Typecheck clean; vp test passed" })}
    ${sessRow({ state: "working", t: "Upgrade server", line: "Resumed after Atlas answered · migrating 6 Layer.mock tests" })}
    ${sessRow({ state: "working", t: "Upgrade web", line: "No new output for 34m · last: fixing 7 type errors", warn: true })}
    <div class="row" style="margin:14px 0 2px"><span class="t12 muted w5 grow">Decided for you · 2</span></div>
    ${decisionRow(DECISIONS[0], { wrap: true })}
    ${decisionRow(DECISIONS[2], { wrap: true })}
    <div class="t12 muted w5" style="margin:14px 0 2px">Timeline</div>
    ${tl(sess("working"), "Upgrade web has had no new output for 30m; Atlas asked it for a status", "4m")}
    ${tl(ic("check", "s12 c-success"), "Upgrade contracts + shared finished · #609, checks passing", "31m")}
    ${tl(ic("plus", "s12 muted"), "Started 3 sessions", "52m")}
  </div>
  <div style="border-top:1px solid var(--border);padding:10px 12px"><span class="btn sm" style="width:100%;justify-content:center">${ic("room", "s12")}Message Atlas about this job</span></div>
  ${o.menu ? `<div class="menu" style="position:absolute;top:44px;right:44px;width:220px"><div class="mi">${ic("room", "s12")}Message Atlas about J-13</div><div class="msep"></div><div class="mi" style="color:var(--destructive)">${ic("x", "s12")}Stop job…</div></div>` : ""}
  </aside>`;
}

S.job = {
  title: "3. Job detail: sessions in one list, the decisions behind them, a stall called out",
  render() {
    return shell(
      sideBots({ sel: "atlas" }),
      `${botTop()}${briefingBody({ focus: 13, narrow: true })}${jobComposer()}`,
      jobPanel(),
    );
  },
};

S.stop = {
  title: "4. Stop job confirms what it stops; Reopen is the way back",
  render() {
    const dialog = `<div class="dialog" style="width:440px">
      <div class="dh" style="padding-bottom:8px"><h2>Stop J-13 and its 2 running sessions?</h2></div>
      <div class="db"><div class="muted">Upgrade server and Upgrade web stop where they are. Their worktrees and #609 stay. You can reopen the job later and Atlas picks it up from there.</div></div>
      <div class="df"><span class="btn ghost">Cancel</span><span class="btn danger">Stop job</span></div></div>`;
    return shell(
      sideBots({ sel: "atlas" }),
      `${botTop()}${briefingBody({ focus: 13, narrow: true })}${jobComposer()}`,
      jobPanel(),
      `<div class="backdrop" style="z-index:20"></div><div style="position:absolute;inset:0;z-index:21;display:flex;align-items:center;justify-content:center">${dialog}</div>`,
    );
  },
};

// ---------- 5. Report ----------

function reportPanel() {
  return `<aside class="panel wide">${panelHead({ status: "done", n: 11, t: "Flaky snapshot test in ThreadTerminalDrawer", pill: "Done", h: "Merged #604 · 2h ago" })}
  <div class="pbody" style="padding:12px 16px">
    <div class="t12 muted w5" style="margin:2px 0 4px">What changed</div>
    <div>The drawer test raced the terminal's first paint. It now waits on the <span class="code">ready</span> event, and the snapshot no longer includes the cursor blink.</div>
    <div class="t12 muted w5" style="margin:14px 0 4px">Evidence</div>
    <div class="col" style="gap:4px">
      <div class="row" style="gap:7px">${ic("term", "s12 muted")}<span class="mono t12">vp test run ThreadTerminalDrawer</span><span class="t12 c-success">passed 50 of 50 runs</span></div>
      <div class="row" style="gap:7px">${pr(604)}<span class="t12 muted">2 files <span class="add">+18</span> <span class="del">−9</span> · checks passed · merged by you</span></div>
    </div>
    <div class="t12 muted w5" style="margin:14px 0 2px">You decided · 1</div>
    <div class="row t12" style="gap:8px;padding:4px 10px">${ic("ask", "s12 c-input")}<span class="grow">Retry the test, or fix the race? <span class="mid">→</span> <span class="w5">Fix the race. Never add retries.</span></span></div>
    <div class="t12 muted w5" style="margin:14px 0 4px">Next</div>
    <div class="card" style="padding:9px 11px"><div>Two other drawer tests use the same pattern.</div><div class="row" style="gap:8px;margin-top:8px"><span class="btn sm">${ic("plus", "s12")}Start job: Fix the other two drawer tests</span></div></div>
    <div class="t12 muted w5" style="margin:14px 0 2px">Timeline</div>
    ${tl(ic("check", "s12 c-success"), "You merged #604", "2h")}
    ${tl(ic("sparkle", "s12 c-input"), "Saved a note from your answer: “Flaky UI tests wait on an event, never a timeout.”", "3h")}
    ${tl(ic("ask", "s12 c-input"), "Asked you: retry or fix? · You: “Fix the race. Never add retries.”", "3h")}
    ${tl(ic("plus", "s12 muted"), "Started Fix flake", "4h")}
  </div></aside>`;
}

S.report = {
  title: "5. A finished job: one report shape, decisions included, Next as a button",
  render() {
    return shell(
      sideBots({ sel: "atlas" }),
      `${botTop()}${briefingBody({ narrow: true })}${jobComposer()}`,
      reportPanel(),
    );
  },
};

// ---------- 6. Answered ask ----------

S.answered = {
  title: "6. After you answer: the exact note it saved, Edit, Remove note, Change answer",
  render() {
    const answered = `<div class="tcard" style="padding:10px 12px;margin-top:6px">
      <div class="row" style="gap:8px">${ic("check", "s14 c-success")}<span class="w6 ell grow">Rate-limit per member or per API token?</span><span class="t12 muted">J-15 · Rate-limit the threads API<span class="mid"> · </span>now</span></div>
      <div style="margin:3px 0 0 22px">You picked <span class="w5">Per member</span>. Atlas is continuing.</div>
      <div class="row" style="gap:10px;margin:8px 0 0 22px"><span class="btn sm">${ic("sparkle", "s12 c-input")}Remember this</span><span class="linkbtn t12">Change answer</span><span class="grow"></span><span class="t12 faint">Moves out of Needs you next time you open Atlas</span></div>
    </div>`;
    const answering = `<div class="tcard" style="padding:10px 12px;margin-top:6px">
      <div class="row" style="gap:8px">${ic("ask", "s14 c-input")}<span class="w6 ell grow">Delete the V1 state.sqlite copy path?</span><span class="t12 muted">J-16 · Drop the V1 state.sqlite copy<span class="mid"> · </span>12m</span></div>
      <div class="muted" style="margin:3px 0 0 22px">${ASK_16.why}</div>
      <div style="margin:8px 0 0 22px"><div class="select" style="height:auto;min-height:56px;padding:8px 10px;white-space:normal;align-items:flex-start">Keep it until pair.40, then delete. Never delete upgrade paths in the same release as a schema change.</div>
      <div class="row" style="gap:8px;margin-top:8px"><span class="row t12" style="gap:5px"><span class="check on">${ic("check", "s12")}</span>Remember this</span><span class="grow"></span><span class="btn sm ghost">Cancel</span><span class="btn sm primary">Answer</span></div></div>
    </div>`;
    return shell(
      sideBots({ sel: "atlas", botNeeds: 1, inbox: 2 }),
      `${botTop({ summary: `5 jobs<span class="mid">·</span>3 sessions working<span class="mid">·</span>1 needs you` })}<div class="feed" style="padding-top:16px"><div class="feed-in" style="max-width:820px">
        ${gh("Needs you", 1, { first: true })}${answering}${answered}
        <div class="row t12 muted" style="gap:6px;padding:10px 10px 0">${ic("check", "s12")}Atlas decided 4 things since you last looked<span class="mid">·</span><span class="linkbtn t12">Review</span></div>
        ${gh("In progress", 3)}${jobRow(JOBS.j14)}${jobRow(JOBS.j13)}${jobRow(JOBS.j12)}
      </div></div>${jobComposer()}`,
    );
  },
};

// ---------- 7. Playbook ----------

S.playbook = {
  title:
    "7. Playbook: your taste in prose, what it learned and how often it used it, honest limits",
  render() {
    const sec = (t, sub, body, right = "") =>
      `<div style="margin-top:22px"><div class="row"><span class="w6 t14 grow">${t}</span>${right}</div><div class="t12 muted" style="margin:2px 0 8px">${sub}</div>${body}</div>`;
    const learned = [
      ["PRs that touch packages/ include a changeset.", "From Chat · today", "not cited yet"],
      [
        "Flaky UI tests wait on an event, never a timeout.",
        "From your answer on J-11 · Mon",
        "cited by 2 decisions",
      ],
      [
        "Fix the cause, not the symptom.",
        "From your answer on J-7 · last week",
        "cited by 5 decisions",
      ],
      ["Snapshots change only with a reason.", "From Chat · last week", "cited by 1 decision"],
    ]
      .map(
        ([t, s, c]) =>
          `<div class="row" style="gap:10px;padding:8px 12px;border-top:1px solid var(--border)">${ic("sparkle", "s12 c-input")}<div class="grow"><div>${t}</div><div class="t12 muted">${s}<span class="mid"> · </span>${c}</div></div><span class="btn sm ghost muted">Edit</span><span class="btn sm ghost muted">Remove</span></div>`,
      )
      .join("")
      .replace("border-top:1px solid var(--border)", "");
    const limits = [
      ["Merging a pull request", true],
      ["Pushing to a default branch", true],
      ["Deleting code outside the job", true],
      ["Running migrations or deploys", true],
      ["Adding a dependency", false],
      ["Anything that spends money", true],
    ]
      .map(
        ([t, on]) =>
          `<div class="row" style="gap:8px;padding:4px 0"><span class="check${on ? " on" : ""}">${on ? ic("check", "s12") : ""}</span>${t}</div>`,
      )
      .join("");
    return shell(
      sideBots({ sel: "atlas" }),
      `${botTop({ tab: "Playbook" })}<div class="feed"><div class="feed-in" style="max-width:720px">
        ${sec("Instructions", "Your taste and standing orders. Atlas reads them before every turn.", `<div class="card" style="padding:12px 14px;line-height:1.6">Work in the pair repo unless I name another. One PR per concern, and keep diffs boring.<br><br>Tests use vitest through <span class="code">vp test</span>. Don't keep deprecated APIs alive in tests; migrate them. Run <span class="code">vp run check:changed</span> before a PR, and attach a before/after capture for UI changes.<br><br>Decide code details yourself. Ask me about product copy and anything a user would notice.</div>`, '<span class="t12 faint">Saved</span>')}
        ${sec("Learned", "Notes Atlas saved from your answers and from Chat.", `<div class="card" style="padding:0">${learned}</div>`)}
        ${sec("Check with me before", "Atlas asks you instead of deciding these, and tells every session to stop and ask.", `<div>${limits}</div><div class="row t12 muted" style="gap:6px;margin-top:8px;padding:8px 10px;border-radius:7px;background:var(--muted)">${ic("alert", "s12")}Sessions run with full access in their own worktree, so these are instructions, not locks.</div>`)}
        <div style="height:24px"></div>
      </div></div>`,
    );
  },
};

// ---------- 8. Settings and the bot menu ----------

S.settings = {
  title: "8. ⋯ menu and Settings: Pause, Delete, and the three models",
  render() {
    const menu = `<div class="menu" style="position:absolute;top:52px;right:14px;width:200px;z-index:5"><div class="mi">${pause()}Pause Atlas</div><div class="mi">${ic("cpu", "s12")}Settings</div><div class="msep"></div><div class="mi" style="color:var(--destructive)">${ic("x", "s12")}Delete bot…</div></div>`;
    const model = (role, m, note) =>
      `<div class="field" style="grid-template-columns:110px 1fr"><div class="lab">${role}</div><div><span class="select" style="height:30px;display:flex;align-items:center">${m}<span class="grow"></span>${ic("down", "s12")}</span><div class="t11 faint" style="margin-top:3px">${note}</div></div></div>`;
    const dialog = `<div class="dialog" style="width:500px">
      <div class="dh" style="padding-bottom:8px"><h2>Atlas settings</h2></div>
      <div class="db col" style="gap:10px">
        <div class="field" style="grid-template-columns:110px 1fr"><div class="lab">Name</div><span class="select" style="height:30px;display:flex;align-items:center">Atlas</span></div>
        <div class="field" style="grid-template-columns:110px 1fr"><div class="lab">What it's for</div><span class="select" style="height:30px;display:flex;align-items:center">Ships my Pair work end to end</span></div>
        <div class="sep" style="margin:4px 0"></div>
        ${model("Brain", REVIEWER, "Plans, answers sessions, writes reports")}
        ${model("Worker", WORKER, "Implementation and test sessions")}
        ${model("Reviewer", REVIEWER, "Review sessions")}
      </div>
      <div class="df"><span class="btn ghost">Cancel</span><span class="btn primary">Save</span></div></div>`;
    const del = `<div class="dialog" style="width:440px">
      <div class="dh" style="padding-bottom:8px"><h2>Delete Atlas?</h2></div>
      <div class="db"><div class="muted">All 11 of its sessions move into Threads (3 are still running and keep going). Its 9 jobs and 4 notes are deleted.</div></div>
      <div class="df"><span class="btn ghost">Cancel</span><span class="btn danger">Delete Atlas</span></div></div>`;
    return `<div class="board natural"><h1>Bot menu, settings and delete</h1>
      <div class="row" style="gap:28px;align-items:flex-start;margin-top:18px">
        <div class="card" style="width:760px;height:300px;overflow:hidden;position:relative">${botTop({ menu })}</div>
        <div class="col" style="gap:24px">${dialog}${del}</div>
      </div></div>`;
  },
};

// ---------- 9. Chat ----------

S.chat = {
  title: "9. Chat: the home thread. Wake-ups are quiet rows; notes it saves show with Remove",
  render() {
    const botMsg = (time, body) =>
      `<div class="row" style="align-items:flex-start;gap:10px">${botAv(20)}<div class="grow"><div class="row" style="gap:6px"><span class="w6">Atlas</span><span class="t12 muted">${time}</span></div><div>${body}</div></div></div>`;
    return shell(
      sideBots({ sel: "atlas" }),
      `${botTop({ tab: "Chat" })}<div class="feed"><div class="feed-in">
        <div class="sys">${ic("ask", "s12")}Upgrade server asked a question · J-13 · 10:49</div>
        ${botMsg("10:49", 'Answered Upgrade server from your instructions: move the tests off <span class="code">Layer.mock</span>. It\'s resuming.')}
        <div class="umsg"><div class="who"><span class="w6">You</span><span class="t12 muted">10:52</span>${av("rutvik")}</div><div class="bubble">what's blocking right now?</div></div>
        ${botMsg("10:52", `Two things wait on you, and one session went quiet.<ul style="margin:6px 0;padding-left:18px"><li><b>J-15</b>: per member or per token for the rate limit. I'd pick per member.</li><li><b>J-16</b>: deleting the V1 copy path. I'd keep it one more release.</li></ul>J-13's web session has had no output for 34m; I asked it for a status and will tell you if it's stuck. J-14's fix is in review, and J-12 just started.`)}
        <div class="umsg"><div class="who"><span class="w6">You</span><span class="t12 muted">10:53</span>${av("rutvik")}</div><div class="bubble">ok. from now on always add a changeset to PRs that touch packages/</div></div>
        ${botMsg("10:53", `Saved, and I'll tell the sessions that open PRs.<div class="row t12" style="gap:6px;margin-top:6px;padding:6px 8px;border-radius:7px;background:var(--muted)">${ic("sparkle", "s12 c-input")}<span class="grow">“PRs that touch packages/ include a changeset.”</span><span class="linkbtn">Remove note</span></div>`)}
      </div></div>
      ${composer({ text: "Message Atlas" })}`,
    );
  },
};

// ---------- 10. Inbox ----------

S.inbox = {
  title:
    "10. Inbox: Asks and stalled session requests sit with your approvals, answerable in place",
  render() {
    const lrow = (o) =>
      `<div class="lrow${o.focus ? " focus" : ""}"><span class="lead">${o.lead}</span><div class="grow" style="min-width:0"><div class="l1"><span class="ell">${o.t}</span></div><div class="l2">${o.l2}</div></div><span class="meta">${o.m}</span></div>`;
    const list = `
      <div class="ghead" style="margin-top:6px"><span>Needs you</span><span class="cnt">3</span></div>
      ${lrow({ focus: true, lead: botAv(16), t: "Atlas asks: rate-limit per member or per API token?", l2: `${jobGlyph("working", 12)}J-15 · Rate-limit the threads API`, m: "4m" })}
      ${lrow({ lead: botAv(16), t: "Atlas asks: delete the V1 state.sqlite copy path?", l2: `${jobGlyph("working", 12)}J-16 · Drop the V1 state.sqlite copy`, m: "12m" })}
      ${lrow({ lead: act("approval", "s16"), t: 'Approve <span class="code">git push --force-with-lease</span>', l2: `${ic("folder", "s12")}pair<span class="mid">·</span>Release checklist 0.1.8`, m: "20m" })}
      <div class="ghead"><span>For you</span><span class="cnt">1</span></div>
      ${lrow({ lead: botAv(16), t: "Atlas finished J-11 · Flaky snapshot test", l2: `${pr(604)}merged by you`, m: "2h" })}`;
    const preview = `
      <div class="top" style="gap:8px">${botAv(20)}<span class="w6">Atlas</span><span class="muted">/</span><span class="ell">J-15 · Rate-limit the threads API</span><span class="grow"></span><span class="btn sm">Open Atlas ${ic("right", "s12")}</span></div>
      <div class="feed"><div class="feed-in" style="max-width:620px">
        ${askCard({ ...ASK_15, noJob: true })}
        <div class="t12 faint" style="margin-top:10px">Answering here answers Atlas. It continues the job on its own.</div>
      </div></div>`;
    return shell(
      sideBots({ sel: "inbox" }),
      `<div class="top"><span class="title">Inbox</span><span class="seg"><span class="on">All</span><span>Needs you</span><span>For you</span></span><span class="grow"></span></div>
      <div class="row" style="flex:1;align-items:stretch;min-height:0">
        <div style="flex:0 0 470px;border-right:1px solid var(--border);padding:6px 10px;overflow:hidden">${list}</div>
        <div class="col grow" style="min-height:0">${preview}</div>
      </div>`,
    );
  },
};

// ---------- 11. First run ----------

S.create = {
  title:
    "11. First run: an inline card, a starter that says what it sets, then clickable first jobs",
  render() {
    const starter = (t, d, on) =>
      `<div class="opt${on ? " on" : ""}" style="padding:9px 12px;display:flex;gap:10px;align-items:flex-start"><span class="radio${on ? " on" : ""}" style="margin-top:2px"></span><div><div class="w5">${t}</div><div class="t12 muted">${d}</div></div></div>`;
    const card = `<div class="card" style="width:520px;padding:18px 20px">
      <div class="row" style="gap:10px">${botAv(28)}<div><div class="w6 t14">Make your bot</div><div class="t12 muted">Give it jobs. It starts sessions, answers them your way, and asks you only when it has to.</div></div></div>
      <div class="field" style="grid-template-columns:110px 1fr;margin-top:16px"><div class="lab">Name</div><span class="select" style="height:30px;display:flex;align-items:center">Atlas</span></div>
      <div class="field" style="grid-template-columns:110px 1fr;margin-top:6px"><div class="lab">What it's for</div><span class="select" style="height:30px;display:flex;align-items:center;color:var(--faint)">e.g. Ships my Pair work end to end</span></div>
      <div class="t12 muted w5" style="margin:14px 0 6px">Start its playbook from</div>
      <div class="col" style="gap:6px">
        ${starter("Default", "Decides code details itself. Checks with you before merging, pushing to a default branch, deleting code outside the job, migrations or deploys, and spending money.", true)}
        ${starter("Blank", "No instructions and no limits. You write them in its Playbook.", false)}
      </div>
      <div class="t12 muted" style="margin-top:12px">Thinks on Claude · Opus 5.5. Sessions run on ${WORKER} and review on Opus. Change them in Settings.</div>
      <div class="row" style="margin-top:14px"><span class="grow"></span><span class="btn primary">Create Atlas</span></div>
    </div>`;
    const ready = `<div class="col" style="align-items:center;gap:8px;color:var(--muted-foreground);margin-top:40px">
      ${botAv(32)}<div class="w6 t14" style="color:var(--foreground)">Atlas is ready</div><div>Give it a job below, or start with one of these:</div>
      <div class="col" style="gap:6px;margin-top:6px;width:460px">${["Fix the flaky test in ThreadTerminalDrawer", "Find and fix the slowest query on the threads list", "Upgrade Effect to the latest 3.x"].map((t) => `<span class="btn" style="justify-content:flex-start">${ic("plus", "s12")}${t}</span>`).join("")}</div></div>`;
    return `<div class="board natural"><h1>First run</h1><div class="row" style="gap:28px;align-items:flex-start;margin-top:18px">
      <div class="card" style="width:820px;height:640px;overflow:hidden">${shell(sideBots({ noBot: true, sel: "bots", inbox: 1 }), `<div class="feed" style="display:flex;justify-content:center;padding-top:60px">${card}</div>`)}</div>
      <div class="card" style="width:560px;height:640px;overflow:hidden;display:flex;flex-direction:column">${botTop({ summary: "No jobs yet" })}<div class="grow">${ready}</div>${jobComposer()}</div>
    </div></div>`;
  },
};

// ---------- 12. States ----------

S.states = {
  title: "12. Every state, and each way back",
  w: 1440,
  h: 1240,
  render() {
    const box = (t, body, w = 640) =>
      `<div><div class="w6" style="margin-bottom:8px">${t}</div><div class="card" style="width:${w}px;padding:10px">${body}</div></div>`;
    const waiting = escalated({
      t: "Upgrade server has waited on Atlas for 11m",
      job: 13,
      jobTitle: "Upgrade Effect to 3.12",
      age: "11m",
      why: "Keep the deprecated Layer.mock helpers, or move the tests? Also in your Inbox.",
    });
    const stall = sessRow({
      state: "working",
      t: "Upgrade web",
      line: "No new output for 34m · last: fixing 7 type errors",
      warn: true,
    });
    const limit = sessRow({
      state: "paused",
      t: "Review #612",
      line: "Claude usage limit · paused until 14:00",
      action: '<span class="btn sm">Retry now</span>',
    });
    const took = sessRow({
      state: "took",
      t: "Fix drag flicker",
      line: "You took over · Atlas isn't steering it",
      action: '<span class="btn sm">Hand back</span>',
    });
    const brain = `<div class="row" style="gap:10px;padding:6px 4px">${ic("alert", "s16 c-error")}<div class="grow"><div class="w5">Atlas can't think right now</div><div class="t12 muted">Claude is signed out on this Mac. Sessions keep running; their questions go to your Inbox.</div></div><span class="btn sm">Open Providers</span></div>`;
    const paused = `<div class="row" style="gap:10px;padding:6px 4px">${pause("s16")}<div class="grow"><div class="w5">Atlas is paused</div><div class="t12 muted">It takes no turns. Sessions keep running; their questions go to your Inbox. Resume tells it what happened meanwhile.</div></div><span class="btn sm primary">Resume</span></div><div class="row t12 muted" style="gap:6px;margin:6px 4px 2px;padding:8px 10px;border:1px dashed var(--border);border-radius:8px">Give Atlas a job…<span class="grow"></span>Atlas is paused<span class="mid">·</span><span class="linkbtn t12">Resume</span></div>`;
    const stopped = `${jobRow(JOBS.j9)}<div class="row" style="gap:8px;padding:2px 10px 6px 52px"><span class="btn sm">Reopen</span><span class="t12 muted">Atlas picks it up where it stopped.</span></div>`;
    const started = jobRow(JOBS.j12);
    const worst = [
      { ...JOBS.j13 },
      {
        ...JOBS.j14,
        fresh: false,
        h: "Fix is up as #612; the review session hit a usage limit",
        progress: "Review paused until 14:00",
        warn: true,
      },
      {
        ...JOBS.j14,
        n: 17,
        t: "Drag handle on mobile rows",
        fresh: false,
        h: "You're steering the fix session yourself",
        progress: "You took over",
        warn: true,
        prs: [],
      },
      {
        ...JOBS.j14,
        n: 18,
        t: "Trim the Pi model list",
        fresh: false,
        h: "Atlas is retrying on Opus after a failure",
        progress: "Implement failed",
        warn: true,
        prs: [],
      },
    ]
      .map((j) => jobRow(j))
      .join("");
    const remembered = `<div style="padding:2px 4px">
      <div class="row" style="gap:8px">${ic("check", "s14 c-success")}<span class="w6 ell grow">Rate-limit per member or per API token?</span><span class="t12 muted">J-15 · now</span></div>
      <div style="margin:3px 0 0 22px">You picked <span class="w5">Per member</span>. Atlas is continuing.</div>
      <div class="row" style="gap:8px;margin:8px 0 0 22px;padding:7px 9px;border-radius:7px;background:var(--muted)">${ic("sparkle", "s12 c-input")}<span class="grow">Saved: “Rate limits are per member unless I say otherwise.”</span><span class="btn sm ghost muted">Edit</span><span class="btn sm ghost muted">Remove note</span></div>
      <div class="row" style="gap:8px;margin:8px 0 0 22px"><span class="linkbtn t12">Change answer</span></div></div>`;
    return `<div class="board natural"><h1>Bots: every state</h1>
      <div class="row" style="gap:28px;align-items:flex-start;flex-wrap:wrap;margin-top:18px">
        ${box("Job rows show their worst session, in the warning colour", worst)}
        ${box("After Remember this: the exact note Atlas saved", remembered)}
        ${box("Just started: honest until the bot's first update", started)}
        ${box("A request Atlas hasn't answered in 10 minutes", waiting)}
        ${box("A working session with no output for 30 minutes", stall)}
        ${box("A session hit a usage limit", limit)}
        ${box("You typed into a session: you took over", took)}
        ${box("Stopped, with Reopen", stopped)}
        ${box("Paused, from ⋯ → Pause", paused)}
        ${box("The brain's provider is unavailable", brain)}
      </div></div>`;
  },
};

// ---------- 13. Mobile ----------

S.mobile = {
  title: "13. Mobile: Briefing, an Ask with send, the report the finish notification opens, Chat",
  w: 1800,
  h: 980,
  render() {
    const phone = (title, body, foot = "") =>
      `<div class="phone" style="width:390px;height:844px;position:relative"><div class="status"><span>9:41</span></div><div style="padding:6px 16px 10px;display:flex;align-items:center;gap:8px">${title}</div><div style="padding:0 12px;overflow:hidden;height:700px">${body}</div>${foot}</div>`;
    const seg = `<div class="row" style="justify-content:center;margin:0 0 10px"><span class="seg"><span class="on">Briefing</span><span>Chat</span></span></div>`;
    const brief = phone(
      `${ic("back", "s16")}${botAv(24)}<span class="w6 t14 grow">Atlas</span>${ic("more", "s16")}`,
      `${seg}<div class="ghead" style="margin-top:0"><span>Needs you</span><span class="cnt">2</span></div>
       <div class="lrow">${ic("ask", "s16 c-input")}<div class="grow"><div class="w5">Per member or per API token?</div><div class="t12 muted">J-15 · Rate-limit the threads API</div></div></div>
       <div class="lrow">${ic("ask", "s16 c-input")}<div class="grow"><div class="w5">Delete the V1 copy path?</div><div class="t12 muted">J-16 · Drop the V1 state.sqlite copy</div></div></div>
       <div class="row t12 muted" style="gap:6px;padding:8px 10px">${ic("check", "s12")}Decided 4 things since you last looked<span class="grow"></span>${ic("right", "s12")}</div>
       <div class="ghead"><span>In progress</span><span class="cnt">3</span></div>
       ${[JOBS.j14, JOBS.j13, JOBS.j12].map((j) => `<div class="lrow">${jobGlyph(j.status)}<div class="grow" style="min-width:0"><div class="w5 ell">${j.t}</div><div class="t12 muted ell">${j.h}</div></div><span class="t12 muted">${j.m}</span></div>`).join("")}
       <div class="ghead">${ic("right", "s12")}<span>Done this week</span><span class="cnt">3</span></div>`,
      `<div style="position:absolute;left:12px;right:12px;bottom:24px"><div class="composer"><div class="ph">Give Atlas a job…</div><div class="foot"><span class="grow"></span><span class="send">${ic("up")}</span></div></div></div>`,
    );
    const ask = phone(
      `${ic("back", "s16")}<span class="w6 t14 grow">Atlas asks</span>`,
      `<div class="t12 muted" style="margin:4px 4px 8px">J-15 · Rate-limit the threads API · 4m</div>
       <div class="w6 t14" style="margin:0 4px">Rate-limit per member or per API token?</div>
       <div class="muted" style="margin:8px 4px 14px">Your playbook doesn't say. Per member also caps outside agents that use your tokens.</div>
       <div class="col" style="gap:8px">${["Per member", "Per token", "Both, tighter per token"].map((t) => `<span class="btn" style="height:40px;justify-content:center">${t}</span>`).join("")}</div>
       <div class="t12 faint" style="margin:8px 4px">Atlas would pick Per member</div>
       <div class="row" style="gap:8px;margin-top:6px"><span class="select grow" style="height:40px;color:var(--faint)">Or answer in your own words…</span><span class="send" style="width:36px;height:36px">${ic("up")}</span></div>
       <div class="row" style="gap:8px;margin:12px 4px"><span class="check"></span>Remember this</div>
       <div class="row" style="margin:4px"><span class="linkbtn">Let Atlas decide</span></div>`,
    );
    const rep = phone(
      `${ic("back", "s16")}<span class="w6 t14 grow ell">J-11 · Flaky snapshot test</span>`,
      `<div class="row" style="gap:8px;margin:0 4px">${jobGlyph("done")}<span class="w5">Done</span><span class="t12 muted">Merged #604 · 2h ago</span></div>
       <div class="t12 muted w5" style="margin:14px 4px 4px">What changed</div>
       <div style="margin:0 4px">The drawer test raced the terminal's first paint. It now waits on the <span class="code">ready</span> event.</div>
       <div class="t12 muted w5" style="margin:14px 4px 4px">Evidence</div>
       <div class="col" style="gap:4px;margin:0 4px"><div class="t12"><span class="mono">vp test run ThreadTerminalDrawer</span> <span class="c-success">50 of 50</span></div><div class="row" style="gap:6px">${pr(604)}<span class="t12 muted">2 files · merged</span></div></div>
       <div class="t12 muted w5" style="margin:14px 4px 4px">You decided · 1</div>
       <div class="t12" style="margin:0 4px">Retry or fix the race? → <span class="w5">Fix the race</span></div>
       <div class="t12 muted w5" style="margin:14px 4px 4px">Next</div>
       <div class="card" style="padding:9px 11px">Two other drawer tests use the same pattern.<div style="margin-top:8px"><span class="btn sm">Start job: fix the other two</span></div></div>`,
    );
    const chat = phone(
      `${ic("back", "s16")}${botAv(24)}<span class="w6 t14 grow">Atlas</span>${ic("more", "s16")}`,
      `<div class="row" style="justify-content:center;margin:0 0 10px"><span class="seg"><span>Briefing</span><span class="on">Chat</span></span></div>
       <div class="sys" style="margin:4px 0 10px">${ic("ask", "s12")}Upgrade server asked a question · 10:49</div>
       <div class="row" style="gap:8px;align-items:flex-start">${botAv(20)}<div>Answered Upgrade server from your instructions: move the tests off <span class="code">Layer.mock</span>.</div></div>
       <div class="row" style="justify-content:flex-end;margin:12px 0"><div class="bubble" style="background:var(--muted);padding:8px 12px;border-radius:14px">what's blocking right now?</div></div>
       <div class="row" style="gap:8px;align-items:flex-start">${botAv(20)}<div>Two things wait on you: <b>J-15</b> (per member or per token; I'd pick per member) and <b>J-16</b> (keep the V1 copy one more release?). Everything else is moving.</div></div>`,
      `<div style="position:absolute;left:12px;right:12px;bottom:24px"><div class="composer"><div class="ph">Message Atlas</div><div class="foot"><span class="grow"></span><span class="send">${ic("up")}</span></div></div></div>`,
    );
    return `<div class="board natural"><h1>Bots on mobile</h1><div class="row" style="gap:32px;align-items:flex-start;justify-content:center;margin-top:20px">${brief}${ask}${rep}${chat}</div></div>`;
  },
};

// ---------- Router ----------

function render() {
  const [, id = "", theme] = (location.hash || "#/").split("/");
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  const root = document.getElementById("root");
  const screen = S[id];
  if (!screen) {
    root.innerHTML = `<div class="board"><h1>Bots prototype</h1><div class="muted t14" style="margin-bottom:18px">Persistent bots that run your work. The spec is ../bots.md.</div>
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
