// Chat-first Bots. Open index.html#/<id>, or #/<id>/dark. index.html#/ lists every board.
// The bot page is the bot's own T3 thread: T3's timeline and T3's composer, unchanged.

const S = {};

const BOT = {
  n: "Atlas",
  c: "#6366f1",
  shape: "round",
  role: "Runs the work in pair",
  voice: "crisp",
};
const NOVA = {
  n: "Nova",
  c: "#0d9488",
  shape: "hex",
  role: "Frontend work in pair",
  voice: "candid",
};
const ECHO = { n: "Echo", c: "#db2777", shape: "tall", role: "", voice: "crisp" };
const JUNO = { n: "Juno", c: "#ea580c", shape: "square", role: "Server and infra", voice: "crisp" };

// A bot's face: a static, non-human SVG. The server assigns a shape and a colour when the bot is
// made (the least-used colour, then the least-used shape); each shape has fixed eyes. You can pick
// another in Edit bot. No mouths, no expressions, no animation, and the face never shows state.
const FACES = {
  round: {
    body: '<circle cx="16" cy="16" r="15"/>',
    eyes: '<circle cx="11.5" cy="15" r="2.6"/><circle cx="20.5" cy="15" r="2.6"/>',
  },
  square: {
    body: '<rect x="1" y="1" width="30" height="30" rx="9"/>',
    eyes: '<rect x="9.4" y="10.6" width="4.2" height="8.6" rx="2.1"/><rect x="18.4" y="10.6" width="4.2" height="8.6" rx="2.1"/>',
  },
  tall: {
    body: '<rect x="4" y="1" width="24" height="30" rx="12"/>',
    eyes: '<circle cx="16" cy="14" r="4.6"/><circle cx="17.2" cy="14.6" r="1.9" fill="var(--fc)"/>',
  },
  hex: {
    body: '<path d="M16 2.2 27.9 9.1v13.8L16 29.8 4.1 22.9V9.1Z" stroke-width="2.4" stroke-linejoin="round"/>',
    eyes: '<circle cx="11.8" cy="15.5" r="2.5"/><circle cx="20.2" cy="15.5" r="2.5"/>',
  },
};
function face(b, size = 20) {
  const f = FACES[b.shape];
  return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" style="--fc:${b.c};flex:none;display:inline-block;vertical-align:middle" aria-hidden="true"><g fill="${b.c}" stroke="${b.c}">${f.body}</g><g fill="#fff">${f.eyes}</g></svg>`;
}

function botAv(size = 20, b = BOT) {
  return face(b, size);
}

const VOICES = {
  crisp: { n: "Crisp", d: "Results first, fewest words." },
  candid: { n: "Candid", d: "Results, plus its own call in one sentence." },
};

// The empty chat greets you in the bot's voice: static copy, one line, no model call.
const GREETING = {
  crisp: (n) => `${n} here. What should I take on?`,
  candid: (n) => `${n} here. Send me work; I'll push back.`,
};

// Session state glyphs. "you" is only for a question the bot raised to you (bot_ask);
// a session waiting on the bot shows as working, so the sidebar doesn't cry wolf.
function sess(kind, cls = "s12") {
  switch (kind) {
    case "working":
      return act("working", cls);
    case "you":
      return ic("ask", `${cls} c-input`);
    case "done":
      return ic("check", `${cls} c-success`);
    case "failed":
      return ic("alert", `${cls} c-error`);
  }
  return "";
}

// T3's native thread link chip (MarkdownThreadLink): the bot writes t3-thread:// links.
const tlink = (title, kind) =>
  `<span class="row" style="display:inline-flex;gap:5px;height:20px;padding:0 7px;border:1px solid var(--border);border-radius:6px;font-size:12.5px;vertical-align:-3px;background:var(--card)">${sess(kind)}<span>${title}</span></span>`;

const pr = (n) =>
  `<span class="chip ghost t11" style="height:18px;gap:3px;padding:0 6px;vertical-align:-2px">${ic("pr", "s12")}#${n}</span>`;

// ---------- Sidebar: the bot row, with its sessions nested under it ----------

const SESSIONS = {
  rate: { t: "Rate limit threads API", k: "working", m: "" },
  flicker: { t: "Sidebar drag flicker", k: "done", m: "3m" },
};

function sideBots(o = {}) {
  const top = `
  <div class="side-top">
    <span class="brand">Pair</span>
    <span class="envchip">This Mac ${ic("down", "s12")}</span>
    <span class="grow"></span>
    <button class="iconbtn" title="New thread">${ic("compose")}</button>
  </div>`;
  const inbox = o.inbox ?? 0;
  const fixed = `
    <div class="search">${ic("search")}<span class="grow">Search</span><span class="kbd">⌘K</span></div>
    <div class="srow">${ic("inbox")}<span class="grow">Inbox</span>${inbox ? `<span class="pill">${inbox}</span>` : ""}</div>`;
  const right =
    o.botRight ?? (o.needs ? `<span class="pill">${o.needs}</span>` : o.idle ? "" : act("working"));
  const sessions = (o.sessions ?? [SESSIONS.rate, SESSIONS.flicker])
    .map(
      (x) =>
        `<div class="srow${x.sel ? " sel" : ""}" style="gap:7px;padding-left:30px"><span style="width:14px;display:inline-flex;justify-content:center">${sess(x.k)}</span><span class="grow ell">${x.t}</span>${x.m ? `<span class="cnt">${x.m}</span>` : ""}</div>`,
    )
    .join("");
  const more = o.more
    ? `<div class="srow muted t12" style="padding-left:30px;gap:6px">${ic("right", "s12")}${o.more}</div>`
    : "";
  const others = (o.others ?? [NOVA])
    .map(
      (b) =>
        `<div class="srow${o.sel === b.n ? " sel" : ""}" style="gap:8px">${botAv(16, b)}<span class="grow ell">${b.n}</span></div>`,
    )
    .join("");
  const bot = `<div class="srow${o.sel === "atlas" ? " sel" : ""}" style="gap:8px">${botAv(16)}<span class="grow ell">${BOT.n}</span>${right}</div>${sessions}${more}${others}`;
  const threads = [
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
  </div></aside>`;
}

// ---------- The bot's thread header ----------

// The status line is a button when something needs you: it jumps to the oldest open question.
function botTop(o = {}) {
  const b = o.bot ?? BOT;
  const status = o.status ?? "1 session working · nothing needs you";
  const statusEl = o.needs
    ? `<span class="row t12 w5 c-input" style="gap:4px;white-space:nowrap;padding:2px 8px;border-radius:6px;background:var(--muted)">${ic("ask", "s12")}${status}${ic("right", "s12")}</span>`
    : `<span class="t12 muted" style="white-space:nowrap">${status}</span>`;
  return `<div class="top" style="gap:10px;position:relative">
    ${botAv(24, b)}
    <span class="title" title="${b.role}">${b.n}</span>
    ${statusEl}
    <span class="grow"></span>
    <span class="btn sm ghost"${o.memory ? ' style="background:var(--accent)"' : ""}>${ic("sparkle", "s12")}Memory</span>
    <button class="iconbtn"${o.menu ? ' style="background:var(--accent)"' : ""}>${ic("more")}</button>
    ${o.menu || ""}
  </div>`;
}

// ---------- T3 timeline pieces ----------

const you = (time, text, o = {}) =>
  `<div class="umsg"><div class="who">${o.queued ? `<span class="row t12 muted" style="gap:5px"><span style="width:6px;height:6px;border-radius:99px;background:#3b82f6"></span>Queued</span>` : ""}<span class="w6">You</span><span class="t12 muted">${time}</span>${av("rutvik")}</div><div class="bubble">${text}</div></div>`;

// A wake-up is not a row of its own. It labels T3's turn fold, the row that today says
// "Worked for 6s ›", so each update is one quiet row plus the bot's reply, if it wrote one.
// A turn where the bot answered a session from memory says so in the label, so nothing done in
// your name hides inside a collapsed fold.
const fold = (icon, text, time, o = {}) =>
  `<div class="row t12 muted" style="gap:6px">${icon}<span>${text}</span>${o.memo ? `<span class="w5">· ${o.memo}</span>` : ""}<span class="faint">· ${time}</span>${ic(o.open ? "down" : "right", "s12 faint")}</div>`;

// Back-to-back turns where the bot wrote nothing and asked, finished, learned or forgot nothing
// merge into one fold. Memory answers still count in the label.
const handled = (n, span, memo = 0) =>
  `<div class="row t12 muted" style="gap:6px">${ic("check", "s12")}<span>${BOT.n} handled ${n} updates</span>${memo ? `<span class="w5">· answered ${memo} from memory</span>` : ""}<span class="faint">· ${span}</span>${ic("right", "s12 faint")}</div>`;

// An expanded fold: T3's work log for that turn, the wake text and the tool calls.
const foldBody = (rows) =>
  `<div class="col t12" style="gap:4px;margin:-8px 0 0 6px;padding-left:12px;border-left:2px solid var(--border)">${rows.map((r) => `<div class="muted">${r}</div>`).join("")}</div>`;

// The bot's reply: plain assistant text, as T3 renders any assistant message.
const atlas = (body) => `<div style="line-height:1.55">${body}</div>`;

// T3's composer, unchanged, with the thread's placeholder. The model chip is the bot's brain.
const t3Composer = (o = {}) =>
  composer({
    text: o.text ?? `Message ${BOT.n}`,
    typed: o.typed,
    right: `<span class="t12 muted row" style="gap:5px;margin-right:8px"><span style="color:#d97757">✳</span>Opus 5.5 High</span>`,
    above: o.above,
  });

const chatTimeline = () => `
  ${you("10:31", "fix the sidebar drag flicker, and rate-limit the threads API. per member is probably right but check with me")}
  ${atlas(`On it, both in <b>pair</b>: ${tlink("Sidebar drag flicker", "done")} and ${tlink("Rate limit threads API", "working")}. I'll check the limit with you before it lands.`)}
  ${fold(ic("ask", "s12"), "Sidebar drag flicker asked a question", "10:38", { memo: "answered from memory", open: true })}
  ${foldBody([
    `<span class="w5" style="color:var(--fg)">Sidebar drag flicker asks:</span> debounce the drag handler, or remove the double render?`,
    `${ic("check", "s12")} Answered: remove the double render. From your memory, <i>“Fix the cause, not the symptom.”</i> Reply here to overrule it.`,
  ])}
  ${fold(ic("ask", "s12"), "Rate limit threads API is waiting", "10:44")}
  ${atlas(`<b>Rate limit threads API needs you:</b> per member or per API token? Per member also caps outside agents that use your tokens. I'd pick per member, 60 a minute.`)}
  ${you("10:46", "per member, 60/min. remember that for future rate limits")}
  ${atlas(`Told it. Saved to memory: <i>“Rate limits are per member unless I say otherwise.”</i>`)}
  ${fold(ic("check", "s12"), "Sidebar drag flicker finished", "10:52")}
  ${atlas(`<b>Sidebar drag flicker is done.</b> The list re-rendered twice on drop; it now renders once.
    <div style="margin-top:6px"><span class="muted">Evidence:</span> <span class="code">vp test run Sidebar</span> 42 of 42 pass, plus a drag test that failed before the fix. ${pr(612)} is a draft; merging is yours.</div>`)}
  ${you("10:54", "what's left?")}
  ${atlas(`Just ${tlink("Rate limit threads API", "working")}: it's adding the limiter at 60 a minute per member. I'll post the report when it's done.`)}
  ${fold(ic("compose", "s12"), "You typed in Rate limit threads API", "10:58")}
  ${atlas(`You've taken ${tlink("Rate limit threads API", "working")}; I've stopped steering it. Say “hand it back” to return it.`)}
`;

// ---------- Boards ----------

S.chat = {
  title: "1. The bot is one chat: you keep typing, it works in the background and reports here",
  render() {
    return shell(
      sideBots({ sel: "atlas" }),
      `${botTop()}<div class="feed"><div class="feed-in" style="gap:14px">${chatTimeline()}</div></div>
      ${t3Composer()}`,
    );
  },
};

const DAY_SESSIONS = [
  { t: "Upgrade Effect to 3.12", k: "you" },
  { t: "Composer paste bug", k: "working" },
  { t: "Sidebar drag flicker", k: "done", m: "2h" },
  { t: "Release workflow timing", k: "done", m: "2h" },
  { t: "Changeset for shared", k: "done", m: "3h" },
];

S.day = {
  title: "2. A busy day as ChatView renders it: 5 jobs, 22 updates, you away 4 hours",
  h: 1180,
  render() {
    return shell(
      sideBots({ sel: "atlas", needs: 1, sessions: DAY_SESSIONS }),
      `${botTop({ needs: true, status: "Upgrade Effect to 3.12 needs you" })}<div class="feed"><div class="feed-in" style="gap:14px">
        ${you("9:02", "today: fix the sidebar drag flicker, upgrade effect to 3.12, fix the composer paste bug, and add a changeset for packages/shared. also look at why the release workflow is slow")}
        ${atlas(`On it. Five jobs in <b>pair</b>: ${tlink("Sidebar drag flicker", "done")}, ${tlink("Upgrade Effect to 3.12", "you")}, ${tlink("Composer paste bug", "working")}, ${tlink("Changeset for shared", "done")} and ${tlink("Release workflow timing", "done")}.`)}
        ${handled(6, "9:04–9:51", 2)}
        ${fold(ic("check", "s12"), "Changeset for shared finished", "9:58")}
        ${atlas(`<b>Changeset for shared is done.</b> One patch changeset; ${pr(615)} is ready. Merging is yours.`)}
        ${handled(4, "10:02–10:40", 1)}
        ${fold(ic("check", "s12"), "Release workflow timing finished", "10:44")}
        ${atlas(`<b>Release workflow timing:</b> 11 of its 19 minutes are the DMG notarization wait; caching the pnpm store saves 2 more. ${pr(617)} adds the cache. Notarization can't go faster from our side.`)}
        ${handled(3, "10:51–11:30")}
        ${fold(ic("check", "s12"), "Sidebar drag flicker finished", "11:36")}
        ${atlas(`<b>Sidebar drag flicker is done.</b> It renders once on drop now. 42 of 42 tests pass. ${pr(612)} is a draft.`)}
        ${fold(ic("ask", "s12"), "Upgrade Effect to 3.12 is waiting", "11:48")}
        ${atlas(`<b>Upgrade Effect to 3.12 needs you:</b> 3.12 removes <span class="code">Layer.mock</span>, used in 14 tests. Rewrite them now, or pin those tests to 3.11 and do it as its own job? I'd rewrite now; it's an hour of work.`)}
        ${handled(5, "11:52–12:58", 1)}
        ${you("13:05", "what's new?")}
        ${atlas(`Since you last wrote at 9:02: <b>3 done</b>. Changeset for shared and Release workflow timing are ready to merge, ${pr(615)} ${pr(617)}; Sidebar drag flicker's ${pr(612)} is a draft. <b>1 needs you</b>: ${tlink("Upgrade Effect to 3.12", "you")}, rewrite the 14 <span class="code">Layer.mock</span> tests now or later. <b>1 working</b>: ${tlink("Composer paste bug", "working")}, writing the regression test. I answered 4 session questions from your memory; each is in the folds above.`)}
      </div></div>
      ${t3Composer()}`,
    );
  },
};

S.busy = {
  title: "3. Writing while it works: T3 queues your message, ahead of Pair's updates",
  render() {
    return shell(
      sideBots({ sel: "atlas", sessions: [] }),
      `${botTop({ status: "Working…" })}<div class="feed"><div class="feed-in" style="gap:14px">
        ${you("10:31", "fix the sidebar drag flicker, and rate-limit the threads API. per member is probably right but check with me")}
        <div class="row t12 muted" style="gap:6px">${act("working")}Working…</div>
        ${you("10:31", "also add a changeset for packages/shared", { queued: true })}
      </div></div>
      ${t3Composer()}`,
    );
  },
};

// The empty chat is the bot's introduction: its face, its greeting in its voice, its role.
const emptyChat = (
  b,
) => `<div class="feed"><div class="feed-in" style="justify-content:center;align-items:center;min-height:520px;gap:10px;text-align:center">
        ${botAv(56, b)}
        <div class="w6" style="font-size:22px;max-width:560px">${GREETING[b.voice](b.n)}</div>
        ${b.role ? `<div class="t12 muted">${b.role}</div>` : ""}
        <div class="muted" style="max-width:520px;margin-top:6px">Give it work in any of your projects or on this machine. It starts sessions, answers their questions the way you would, and asks you only what it can't decide.</div>
      </div></div>`;

S.first = {
  title:
    "4. A new bot opens on its empty chat: its face, a one-line greeting in its voice, its role",
  render() {
    return shell(
      sideBots({ sel: "atlas", idle: true, sessions: [] }),
      `${botTop({ status: "Ready" })}${emptyChat(BOT)}
      ${t3Composer()}`,
    );
  },
};

function memoryPanel() {
  return `<aside class="panel" style="width:380px"><div class="row" style="gap:8px;padding:12px 14px;border-bottom:1px solid var(--border)">${ic("sparkle", "s16")}<span class="w6 grow">Memory</span>${ic("x", "s16 muted")}</div>
  <div class="pbody" style="padding:14px;display:flex;flex-direction:column;gap:16px">
    <div><div class="w5">Instructions</div><div class="t12 muted" style="margin:2px 0 6px">How you like work done. ${BOT.n} reads this every turn.</div>
      <div class="card" style="padding:9px 11px;min-height:70px">Decide code details yourself. Ask me about product copy and anything a user would notice. One PR per concern.</div></div>
    <div><div class="w5">Learned</div><div class="t12 muted" style="margin:2px 0 6px">What ${BOT.n} saved from your chats. Tell it “forget that” in chat, or here.</div>
      ${[
        [
          "Rate limits are per member unless I say otherwise.",
          "From your reply about Rate limit threads API · 10:46",
        ],
        ["Fix the cause, not the symptom.", "From chat · used 3 times"],
      ]
        .map(
          ([t, src]) =>
            `<div class="card" style="padding:8px 10px;margin-bottom:6px"><div>${t}</div><div class="row t12 muted" style="gap:10px;margin-top:2px"><span class="grow">${src}</span><span class="linkbtn">Edit</span><span class="linkbtn">Forget</span></div></div>`,
        )
        .join("")}</div>
    <div><div class="w5">Check with me before</div><div class="t12 muted" style="margin:2px 0 6px">${BOT.n} asks you instead of deciding these, and tells every session to stop and ask.</div>
      ${[
        ["Merging a pull request", true],
        ["Pushing to a default branch", true],
        ["Deleting code outside the job", true],
        ["Running migrations or deploys", true],
        ["Adding a dependency", false],
        ["Anything that spends money", true],
      ]
        .map(
          ([t, on]) =>
            `<div class="row" style="gap:8px;margin:5px 0"><span class="check${on ? " on" : ""}">${on ? ic("check", "s12") : ""}</span>${t}</div>`,
        )
        .join("")}
      <div class="row t12 muted" style="gap:6px;margin-top:8px">${ic("alert", "s12")}Sessions run with full access in their own worktree, so these are instructions, not locks.</div></div>
  </div></aside>`;
}

S.memory = {
  title:
    "5. Memory: instructions, what it learned, and the limits. Talking to it edits the same list",
  render() {
    return shell(
      sideBots({ sel: "atlas" }),
      `${botTop({ memory: true })}<div class="feed"><div class="feed-in" style="gap:14px">${chatTimeline()}</div></div>
      ${t3Composer()}`,
      memoryPanel(),
    );
  },
};

S.menu = {
  title: "6. The ⋯ menu: pause, models, edit, delete",
  render() {
    const menu = `<div class="menu" style="position:absolute;right:12px;top:44px;width:230px;z-index:5">
      <div class="mi">${ic("clock", "s12")}<span>Pause ${BOT.n}</span></div>
      <div class="mi">${ic("cpu", "s12")}<span>Models…</span></div>
      <div class="mi">${ic("compose", "s12")}<span>Edit bot…</span></div>
      <div class="msep"></div>
      <div class="mi c-error">${ic("x", "s12")}<span>Delete bot…</span></div></div>`;
    return shell(
      sideBots({ sel: "atlas" }),
      `${botTop({ menu })}<div class="feed"><div class="feed-in" style="gap:14px">${chatTimeline()}</div></div>
      ${t3Composer()}`,
    );
  },
};

S.sessions = {
  title:
    "7. Sessions nest under the bot; one click opens the real thread. Typing in it takes it over",
  render() {
    const sessionThread = `<div class="top" style="gap:8px"><span class="t12 muted">pair</span><span class="faint">/</span><span class="title">Rate limit threads API</span><span class="grow"></span></div>
      <div class="feed"><div class="feed-in" style="gap:14px">
        <div class="umsg"><div class="who"><span class="w6">${BOT.n}</span><span class="t12 muted">10:31</span>${botAv(20)}</div><div class="bubble">Add a per-member rate limit to the threads API. Check with the user before choosing the limit…</div></div>
        <div>Added a token bucket keyed on the member id, 60 a minute. Writing the tests now.</div>
        <div class="row t12 muted" style="gap:6px">${act("working")}Working…</div>
      </div></div>
      ${composer({ text: `Message this session (${BOT.n} steps back)` })}`;
    return shell(
      sideBots({
        sessions: [{ ...SESSIONS.rate, sel: true }, SESSIONS.flicker],
        more: "3 earlier",
      }),
      sessionThread,
    );
  },
};

S.states = {
  title: "8. The bot row tells you its state; Inbox carries its questions",
  w: 1440,
  h: 760,
  render() {
    const col = (label, side) =>
      `<div class="col" style="gap:8px"><div class="t12 muted w5">${label}</div><div style="width:260px;height:520px;border:1px solid var(--border);border-radius:10px;overflow:hidden">${side}</div></div>`;
    const mini = (o) =>
      sideBots(o).replace('class="side"', 'class="side" style="width:260px;height:100%"');
    const inbox = `<div class="col" style="gap:8px"><div class="t12 muted w5">Inbox</div><div class="card" style="width:420px;padding:0">
      <div class="lrow">${botAv(20)}<div class="grow" style="min-width:0"><div class="w5 ell">Per member or per API token?</div><div class="t12 muted ell">${BOT.n} · Rate limit threads API</div></div><span class="t12 muted">4m</span></div>
      <div class="lrow">${botAv(20)}<div class="grow" style="min-width:0"><div class="w5 ell">Sidebar drag flicker is done</div><div class="t12 muted ell">${BOT.n} · PR #612 · merging is yours</div></div><span class="t12 muted">3m</span></div>
      </div><div class="t12 muted" style="max-width:420px">Both open ${BOT.n}'s chat at that message. You answer in the chat.</div></div>`;
    return `<div class="board natural"><h1>Bot states</h1><div class="row" style="gap:24px;align-items:flex-start;margin-top:16px">
      ${col("Needs you (a question from Atlas)", mini({ needs: 1, sessions: [{ t: "Rate limit threads API", k: "you" }, SESSIONS.flicker] }))}
      ${col("Working (incl. waiting on Atlas)", mini({}))}
      ${col("Paused", mini({ botRight: `<span class="t11 muted">Paused</span>`, sessions: [SESSIONS.rate] }))}
      ${inbox}
    </div></div>`;
  },
};

S.mobile = {
  title:
    "9. Mobile: faces, and the role line when nothing needs you. + creates at once, like today",
  w: 1400,
  h: 980,
  render() {
    const phone = (title, body, foot = "") =>
      `<div class="phone" style="width:390px;height:844px;position:relative"><div class="status"><span>9:41</span></div><div style="padding:6px 16px 10px;display:flex;align-items:center;gap:8px">${title}</div><div style="padding:0 14px;overflow:hidden;height:680px;display:flex;flex-direction:column;gap:12px">${body}</div>${foot}</div>`;
    const list = phone(
      `<span class="w6" style="font-size:22px">Bots</span><span class="grow"></span>${ic("plus", "s16")}`,
      `<div class="lrow">${botAv(28)}<div class="grow"><div class="w5">${BOT.n}</div><div class="t12 c-input w5">Rate limit threads API needs you</div></div><span class="pill">1</span></div>
       ${[{ t: "Rate limit threads API", k: "you" }, SESSIONS.flicker].map((x) => `<div class="row" style="gap:8px;padding:4px 10px 4px 46px">${sess(x.k)}<span class="grow ell">${x.t}</span><span class="t12 muted">${x.m ?? ""}</span></div>`).join("")}
       <div class="lrow">${botAv(28, NOVA)}<div class="grow"><div class="w5">${NOVA.n}</div><div class="t12 muted">${NOVA.role}</div></div></div>`,
    );
    const chat = phone(
      `${ic("back", "s16")}${botAv(24)}<div class="grow" style="min-width:0"><div class="w6 t14">${BOT.n}</div><div class="t12 c-input w5 ell">Rate limit threads API needs you ›</div></div>${ic("more", "s16")}`,
      `${fold(ic("ask", "s12"), "Rate limit threads API is waiting", "10:44")}
       ${atlas(`<b>Rate limit threads API needs you:</b> per member or per API token? I'd pick per member, 60 a minute.`)}
       ${fold(ic("check", "s12"), "Sidebar drag flicker finished", "10:52")}
       ${atlas(`<b>Sidebar drag flicker is done.</b> The list renders once on drop. 42 of 42 tests pass. ${pr(612)} is a draft; merging is yours.`)}`,
      `<div style="position:absolute;left:12px;right:12px;bottom:24px"><div class="composer"><div class="ph">Message ${BOT.n}</div><div class="foot"><span class="grow"></span><span class="send">${ic("up")}</span></div></div></div>`,
    );
    return `<div class="board natural"><h1>Bots on mobile</h1><div class="row" style="gap:40px;align-items:flex-start;justify-content:center;margin-top:20px">${list}${chat}</div></div>`;
  },
};

// ---------- Character ----------

const COLORS = ["#6366f1", "#0d9488", "#db2777", "#ea580c", "#2563eb"];
const swatch = (c, on) =>
  `<span style="width:20px;height:20px;border-radius:99px;background:${c};display:inline-block;box-shadow:${on ? "0 0 0 2px var(--popover),0 0 0 4px " + c : "none"}"></span>`;
const pickCell = (inner, on) =>
  `<span style="width:36px;height:36px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;border:1px solid ${on ? "var(--foreground)" : "var(--border)"};background:${on ? "var(--accent)" : "var(--card)"}">${inner}</span>`;
const input = (v, o = {}) =>
  `<div class="select" style="height:32px;${o.focus ? "box-shadow:0 0 0 2px var(--ring, #6366f1);" : ""}">${o.placeholder ? `<span class="muted">${o.placeholder}</span>` : o.selected ? `<span style="background:rgba(99,102,241,.35);border-radius:2px;padding:0 1px">${v}</span>` : v}</div>`;

// The same report in each voice. Candid is Crisp plus one sentence with its own call.
const SAMPLE = {
  crisp: `<b>Sidebar drag flicker is done.</b> It renders once on drop now. 42 of 42 tests pass. #612 is yours to merge.`,
  candid: `<b>Sidebar drag flicker is done.</b> It renders once on drop now. 42 of 42 tests pass. #612 is yours to merge, and I'd merge it today.`,
};

// One dialog creates a bot and edits it. Everything is prefilled, so Enter creates.
function botDialog(o) {
  const b = o.bot;
  const shapes = Object.keys(FACES)
    .map((k) => pickCell(face({ ...b, shape: k }, 24), k === b.shape))
    .join("");
  const colors = COLORS.map((c) => swatch(c, c === b.c)).join("");
  const seg = `<span class="seg">${Object.entries(VOICES)
    .map(
      ([k, v]) =>
        `<span class="${k === b.voice ? "on" : ""}" style="padding:3px 12px">${v.n}</span>`,
    )
    .join("")}</span>`;
  return `<div class="backdrop"><div class="dialog" style="width:480px">
    <div class="dh"><h2>${o.create ? "New bot" : `Edit ${b.n}`}</h2></div>
    <div class="db col" style="gap:12px">
      <div class="field" style="grid-template-columns:64px 1fr"><span class="lab">Face</span><span class="row" style="gap:6px">${shapes}<span style="width:10px"></span>${colors}</span></div>
      <div class="field" style="grid-template-columns:64px 1fr"><span class="lab">Name</span>${input(b.n, { focus: o.create, selected: o.create })}</div>
      <div class="field" style="grid-template-columns:64px 1fr;align-items:start"><span class="lab" style="padding-top:7px">Role</span><div>${b.role ? input(b.role) : input("", { placeholder: "What it's for, e.g. Frontend work in pair" })}<div class="t12 muted" style="margin-top:5px">Shown under its name. ${b.n} reads this as its job.</div></div></div>
      <div class="field" style="grid-template-columns:64px 1fr;align-items:start"><span class="lab" style="padding-top:5px">Voice</span><div class="col" style="gap:6px"><div class="row" style="gap:10px">${seg}<span class="t12 muted">${VOICES[b.voice].d}</span></div>
        <div class="card t12" style="padding:8px 10px;line-height:1.5">${SAMPLE[b.voice]}</div>
        <div class="t12 muted">Changes how it sounds, not what it reports. Questions and session tasks are always plain.</div></div></div>
    </div>
    <div class="df"><span class="btn sm ghost">Cancel</span><span class="btn sm primary">${o.create ? "Create" : "Save"}</span></div>
  </div></div>`;
}

S.faces = {
  title: "10. Faces: four shapes, each with its own eyes, in five colours. Static, non-human",
  w: 1440,
  h: 640,
  render() {
    const grid = Object.keys(FACES)
      .map(
        (sh) =>
          `<div class="row" style="gap:18px">${COLORS.map((c) => face({ shape: sh, c }, 40)).join("")}</div>`,
      )
      .join("");
    const sizes = [16, 20, 24, 56]
      .map(
        (n) =>
          `<div class="col" style="gap:6px;align-items:center">${[BOT, NOVA, ECHO, JUNO].map((b) => face(b, n)).join("")}<span class="t11 muted">${n}px</span></div>`,
      )
      .join("");
    const crew = [BOT, NOVA, ECHO, JUNO]
      .map(
        (b) =>
          `<div class="lrow" style="gap:10px">${face(b, 24)}<div class="grow" style="min-width:0"><div class="w5">${b.n}</div><div class="t12 muted ell">${b.role || "&nbsp;"}</div></div><span class="t11 muted">${VOICES[b.voice].n}</span></div>`,
      )
      .join("");
    return `<div class="board natural"><h1>Bot faces</h1><div class="muted t14" style="max-width:760px">Pair gives every new bot the least-used colour, then the least-used shape, so a handful of bots never look alike. Shape and colour carry identity at 16px; the eyes read from 20px up. Change it in ⋯ → Edit bot.</div>
      <div class="row" style="gap:48px;align-items:flex-start;margin-top:22px">
        <div class="col" style="gap:14px"><div class="t12 muted w5">4 shapes × 5 colours</div>${grid}</div>
        <div class="col" style="gap:10px"><div class="t12 muted w5">Sidebar, Inbox, header, empty chat</div><div class="row" style="gap:22px;align-items:flex-end">${sizes}</div></div>
        <div class="col" style="gap:8px;width:300px"><div class="t12 muted w5">Four bots: name, role, voice</div><div class="card" style="padding:0">${crew}</div></div>
      </div></div>`;
  },
};

S.create = {
  title: "11. + opens New bot: a free name (selected), an unused face, Crisp. Enter creates",
  render() {
    const dlg = botDialog({ bot: ECHO, create: true });
    return shell(
      sideBots({ sel: "atlas" }),
      `${botTop()}<div class="feed"><div class="feed-in" style="gap:14px">${chatTimeline()}</div></div>${t3Composer()}`,
      "",
      dlg,
    );
  },
};

S.profile = {
  title: "12. ⋯ → Edit bot…: the same dialog. Face, name, role, voice",
  render() {
    const dlg = botDialog({ bot: { ...BOT, voice: "candid" } });
    return shell(
      sideBots({ sel: "atlas" }),
      `${botTop()}<div class="feed"><div class="feed-in" style="gap:14px">${chatTimeline()}</div></div>${t3Composer()}`,
      "",
      dlg,
    );
  },
};

S.voices = {
  title: "13. Two voices. Candid adds its own call; questions and fold labels stay plain",
  w: 1440,
  h: 760,
  render() {
    const col = (b) => `<div class="card col" style="padding:14px;gap:12px;width:400px">
      <div class="row" style="gap:8px">${face(b, 24)}<div><div class="w6">${b.n}</div><div class="t12 muted">${VOICES[b.voice].n} · ${b.role}</div></div></div>
      <div class="t12 muted w5">Empty chat</div><div class="w6" style="font-size:15px">${GREETING[b.voice](b.n)}</div>
      <div class="t12 muted w5">Starting work</div><div style="line-height:1.55">${
        {
          crisp: `On it, in <b>pair</b>: ${tlink("Sidebar drag flicker", "working")}.`,
          candid: `On it, in <b>pair</b>: ${tlink("Sidebar drag flicker", "working")}. If it's the double render I suspect, the fix is small.`,
        }[b.voice]
      }</div>
      <div class="t12 muted w5">Finished</div><div style="line-height:1.55">${SAMPLE[b.voice]}</div>
      <div class="t12 muted w5">Needs you (plain in both)</div><div style="line-height:1.55"><b>Rate limit threads API needs you:</b> per member or per API token? Per member also caps outside agents. I'd pick per member, 60 a minute.</div>
      <div class="t12 muted w5">Fold label (always Pair's)</div>${fold(ic("check", "s12"), "Sidebar drag flicker finished", "10:52")}
    </div>`;
    return `<div class="board natural"><h1>Voices</h1><div class="muted t14" style="max-width:820px">Crisp by default. Candid writes the same thing and adds its own call in one sentence. Anything more personal goes in Memory → Instructions, in your own words. No emoji, no flattery, in either voice.</div>
      <div class="row" style="gap:16px;align-items:flex-start;margin-top:20px">${[BOT, NOVA].map(col).join("")}</div></div>`;
  },
};

// Problem 1: the bot never works in its own turn. Machine work gets a session too, so the chat
// is free a few seconds after you write.
S.machine = {
  title:
    "14. Work outside a project gets a session too, so the chat is free seconds after you write",
  render() {
    return shell(
      sideBots({
        sel: "atlas",
        sessions: [SESSIONS.rate, { t: "Add pgAdmin login to .zshrc", k: "done", m: "now" }],
      }),
      `${botTop({ status: "1 session working · nothing needs you" })}<div class="feed"><div class="feed-in" style="gap:14px">
        ${you("12:51", "add my pgAdmin login to my zshrc and tell me which line to put the password on")}
        ${atlas(`On it, on this machine: ${tlink("Add pgAdmin login to .zshrc", "working")}. I'll tell you the line when it's in.`)}
        ${you("12:51", "also, is the threads rate limit merged yet?")}
        ${atlas(`Not yet. ${tlink("Rate limit threads API", "working")} is writing its tests; ${pr(618)} is a draft.`)}
        ${fold(ic("check", "s12"), "Add pgAdmin login to .zshrc finished", "12:53")}
        ${atlas(`<b>Add pgAdmin login to .zshrc is done.</b> Put your password on <b>line 37</b>, inside the single quotes. Your old file is backed up as <span class="code">.zshrc.bak-2026-11-19</span>.`)}
      </div></div>
      ${t3Composer()}`,
    );
  },
};

// ---------- Router ----------

function render() {
  const [, id = "", theme] = (location.hash || "#/").split("/");
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  const root = document.getElementById("root");
  const screen = S[id];
  if (!screen) {
    root.innerHTML = `<div class="board"><h1>Bots, chat-first</h1><div class="muted t14" style="margin-bottom:18px">The spec is ../bots.md.</div>
      ${Object.entries(S)
        .map(
          ([k, x]) =>
            `<div style="margin:6px 0"><a class="linkbtn" href="#/${k}">${x.title}</a> <span class="muted t12">· <a href="#/${k}/dark">dark</a></span></div>`,
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
