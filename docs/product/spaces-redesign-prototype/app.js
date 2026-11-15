// Shared pieces for every screen: icons, the cast, avatars, status glyphs, sidebars, thread chrome.

const I = {
  inbox:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  tasks:
    '<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  space:
    '<path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/>',
  branch:
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  merge:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  compose:
    '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  ask: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  alert:
    '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  machine:
    '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  term: '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>',
  diff: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M9 10h6"/><path d="M12 13V7"/><path d="M9 17h6"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  pull: '<path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M19 21H5"/>',
  push: '<path d="m18 9-6-6-6 6"/><path d="M12 3v14"/><path d="M5 21h14"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  layers:
    '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  userplus:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  undo: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  pair: '<path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z"/>',
  filter: '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
  room: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  archive:
    '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  share:
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>',
  read: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  snooze:
    '<circle cx="12" cy="13" r="8"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/><path d="M10 11h4l-4 4h4"/>',
  sparkle:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
};

function ic(name, cls = "") {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24">${I[name] || ""}</svg>`;
}

// The cast. The viewer is set per screen.
const M = {
  rutvik: { n: "Rutvik", i: "R", c: "#2563eb", on: true },
  kousik: { n: "Kousik", i: "K", c: "#ea580c", on: true },
  hanad: { n: "Hanad", i: "H", c: "#059669", on: true },
  ankur: { n: "Ankur", i: "A", c: "#7c3aed", on: false },
  meera: { n: "Meera", i: "M", c: "#0d9488", on: true },
  priya: { n: "Priya", i: "P", c: "#db2777", on: false },
  tanvi: { n: "Tanvi", i: "T", c: "#ca8a04", on: true },
  sam: { n: "Sam", i: "S", c: "#475569", on: false },
};

function av(id, o = {}) {
  const m = M[id];
  const size = o.size ? ` s${o.size}` : "";
  const hollow = o.hollow ? " hollow" : "";
  const online = o.presence && m.on ? '<span class="on"></span>' : "";
  return `<span class="av${size}${hollow}" style="--c:${m.c}" title="${m.n}">${m.i}${online}</span>`;
}
function stack(ids, o = {}) {
  return `<span class="stack">${ids.map((id) => av(id, o)).join("")}</span>`;
}

// Task status: stored. Icons match the v2 prototype README.
function st(status, size = 14) {
  const s = `width="${size}" height="${size}" viewBox="0 0 16 16" style="flex:none"`;
  const ring = (c) =>
    `<circle cx="8" cy="8" r="6.25" fill="none" stroke="${c}" stroke-width="1.5"/>`;
  switch (status) {
    case "todo":
      return `<svg ${s}>${ring("var(--muted-foreground)")}</svg>`;
    case "progress":
      return `<svg ${s}>${ring("var(--info-foreground)")}<path d="M8 8 L8 4.25 A3.75 3.75 0 0 1 8 11.75 Z" fill="var(--info-foreground)"/></svg>`;
    case "review":
      return `<svg ${s}>${ring("var(--success-foreground)")}<path d="M8 8 L8 4.25 A3.75 3.75 0 1 1 4.25 8 Z" fill="var(--success-foreground)"/></svg>`;
    case "done":
      return `<svg ${s}><circle cx="8" cy="8" r="7" fill="var(--success-foreground)"/><path d="M5 8.2 7 10.2 11 6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case "canceled":
      return `<svg ${s}>${ring("var(--muted-foreground)")}<path d="M6 6l4 4M10 6l-4 4" stroke="var(--muted-foreground)" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }
  return "";
}

// Live activity: derived from threads.
function act(kind, cls = "s12") {
  switch (kind) {
    case "working":
      return `<svg class="ic ${cls} c-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke-dasharray="3.2 3.2"/></svg>`;
    case "approval":
      return ic("shield", `${cls} c-warning`);
    case "answer":
      return ic("ask", `${cls} c-input`);
    case "failed":
      return ic("alert", `${cls} c-error`);
    case "offer":
      return ic("merge", `${cls} c-input`);
  }
  return "";
}

// ---------- Sidebar data ----------

const SPACES = [
  { id: "qc", n: "Question creation", needs: 2 },
  { id: "onb", n: "Onboarding revamp", needs: 1 },
  { id: "bill", n: "Billing v3", unread: true },
  { id: "push", n: "Mobile push", needs: 1 },
  { id: "docs", n: "Docs site" },
  { id: "eval", n: "Eval harness", hidden: true },
  { id: "sched", n: "Interview scheduler", hidden: true },
];

// Rutvik's own threads. g: glyph before the title, a: live activity, with: avatars of people branched off it.
const R_THREADS = {
  pinned: [
    { t: "Fix sidebar drag flicker", m: "2d" },
    { t: "Release checklist 0.1.8", m: "5h" },
  ],
  active: [
    { t: "Seed role catalog", g: "space", a: "approval", with: ["hanad"] },
    { t: "Expo token refresh", g: "space", a: "answer" },
    { t: "Question schema v2", g: "space", m: "20m", pr: true },
    { t: "Prompt builder", g: "space", by: "kousik", m: "4m" },
    { t: "Search index for docs", g: "space", m: "1h" },
    { t: "Bundle upload retries", m: "5d" },
  ],
  working: [
    { t: "Invoice PDF export", g: "space", a: "working" },
    { t: "Upgrade Effect to 3.12", a: "working" },
  ],
};

function sideRowThread(t, sel) {
  const lead =
    t.g === "space" ? ic("space", "s12 faint") : t.g === "branch" ? ic("branch", "s12 faint") : "";
  const right = [
    t.with
      ? `<span class="row faint" style="gap:2px">${ic("branch", "s12")}${stack(t.with, { size: 14 })}</span>`
      : "",
    t.by ? av(t.by, { size: 14 }) : "",
    t.pr ? `<span class="t11 muted row" style="gap:3px">${ic("pr", "s12")}482</span>` : "",
    t.a ? act(t.a) : "",
    t.m && !t.a && !t.pr ? `<span class="cnt">${t.m}</span>` : "",
  ].join("");
  return `<div class="srow${sel ? " sel" : ""}" style="gap:7px">${lead ? `<span style="width:14px;display:inline-flex;justify-content:center">${lead}</span>` : '<span style="width:14px"></span>'}<span class="grow ell">${t.t}</span>${right}</div>`;
}

/**
 * The proposed sidebar.
 * o.sel: "inbox" | "tasks" | "shared" | space id | thread title
 * o.viewer: "rutvik" | "hanad" | "kousik"
 */
function sideNew(o = {}) {
  const sel = o.sel;
  const v = o.viewer || "rutvik";
  const D = SIDE_DATA[v];
  const top = `
  <div class="side-top">
    <span class="brand">Pair</span>
    <span class="envchip">Pair Cloud ${ic("down", "s12")}</span>
    <span class="grow"></span>
    <button class="iconbtn" title="New thread">${ic("compose")}</button>
  </div>`;
  const fixed = `
    <div class="search">${ic("search")}<span class="grow">Search</span><span class="kbd">⌘K</span></div>
    <div class="srow${sel === "inbox" ? " sel" : ""}">${ic("inbox")}<span class="grow">Inbox</span>${D.inbox ? `<span class="pill">${D.inbox}</span>` : ""}</div>
    <div class="srow${sel === "tasks" ? " sel" : ""}">${ic("tasks")}<span class="grow">My tasks</span></div>
    <div class="srow${sel === "shared" ? " sel" : ""}">${ic("share")}<span class="grow">Shared with you</span></div>`;
  const spaces = D.spaces
    .filter((s) => !s.hidden || o.moreOpen)
    .map(
      (s) =>
        `<div class="srow${sel === s.id ? " sel" : ""}">${ic("space")}<span class="grow ell">${s.n}</span>${s.needs ? `<span class="cnt">${s.needs}</span>` : s.unread ? '<span class="dot" style="background:var(--faint)"></span>' : ""}</div>`,
    )
    .join("");
  const hiddenCount = D.spaces.filter((s) => s.hidden).length;
  const more =
    hiddenCount > 0 && !o.moreOpen
      ? `<div class="srow muted">${ic("right", "s12")}<span class="grow t12">${hiddenCount} more</span>${o.moreNeeds ? `<span class="cnt">${o.moreNeeds}</span>` : ""}</div>`
      : "";
  const threads = (list) =>
    list
      .filter((t) => t.t !== o.skip)
      .map((t) => sideRowThread(t, sel === t.t))
      .join("");
  const T = D.threads;
  const draft = o.draft
    ? `<div class="srow sel" style="gap:7px"><span style="width:14px;display:inline-flex;justify-content:center">${ic("branch", "s12 faint")}</span><span class="grow ell muted"><i>New thread</i></span><span class="t11 faint">Draft</span></div>`
    : "";
  return `<aside class="side">${top}<div class="side-body">${fixed}
    <div class="sect"><span class="grow">Spaces</span>${ic("plus")}</div>${spaces}${more}
    <div class="sect"><span class="grow">Threads</span>${ic("filter")}</div>
    ${threads(T.pinned)}${T.pinned.length ? '<div class="sep" style="margin:4px 8px"></div>' : ""}
    ${draft}${threads(T.active)}
    ${T.working.length ? `<div class="sect">${ic("down")}<span class="grow">Working</span><span class="tnum">${T.working.length}</span></div>${threads(T.working)}` : ""}
    <div class="sect">${ic("right")}<span class="grow">Snoozed</span><span class="tnum">2</span></div>
    <div class="sect" style="margin-top:0">${ic("right")}<span class="grow">Settled</span></div>
  </div></aside>`;
}

const SIDE_DATA = {
  rutvik: { inbox: 4, tasks: 10, shared: 20, sharedNew: true, spaces: SPACES, threads: R_THREADS },
  hanad: {
    inbox: 1,
    tasks: 4,
    shared: 12,
    sharedNew: false,
    spaces: [
      { id: "qc", n: "Question creation", unread: true },
      { id: "bill", n: "Billing v3", needs: 1 },
      { id: "push", n: "Mobile push" },
    ],
    threads: {
      pinned: [],
      active: [
        { t: "Rationale per question", g: "branch", m: "now" },
        { t: "Preview renderer API", g: "space", m: "2h" },
        { t: "Stripe webhook replay", g: "space", a: "answer" },
        { t: "Migrate to Expo SDK 52", g: "space", m: "1d" },
        { t: "Role fixtures v2", g: "branch", m: "14m" },
      ],
      working: [],
    },
  },
  kousik: {
    inbox: 1,
    tasks: 3,
    shared: 9,
    sharedNew: false,
    spaces: [
      { id: "qc", n: "Question creation", needs: 1 },
      { id: "eval", n: "Eval harness" },
    ],
    threads: {
      pinned: [{ t: "Retry budget for evals", m: "3h" }],
      active: [
        { t: "Prompt builder", g: "space", a: "offer", with: ["hanad"] },
        { t: "Eval fixtures", g: "space", m: "3h" },
        { t: "Fixture loader perf", m: "1d" },
      ],
      working: [],
    },
  },
};

// ---------- The sidebar as it is on feat/pair, at the same scale ----------

function sideBefore() {
  const r = (html, cls = "") => `<div class="srow ${cls}">${html}</div>`;
  const task = (s, t, extra = "") => r(`${st(s)}<span class="grow ell">${t}</span>${extra}`, "sub");
  const assigned = [
    ["progress", "Seed role catalog"],
    ["review", "Question schema v2"],
    ["todo", "Trial banner copy"],
    ["progress", "Invoice PDF export"],
    ["todo", "Proration edge cases"],
    ["progress", "Expo token refresh"],
    ["todo", "Silent push on iOS 18"],
    ["progress", "Search index for docs"],
    ["todo", "Versioned API reference"],
    ["review", "Welcome checklist"],
  ];
  const team = [
    ["kousik", "Prompt builder"],
    ["hanad", "Role fixtures v2"],
    ["ankur", "Perf budget for /questions"],
    ["hanad", "Stripe webhook replay"],
    ["meera", "Trial banner experiments"],
    ["kousik", "Eval fixtures"],
    ["priya", "APNs cert rotation"],
    ["tanvi", "Docs search ranking"],
    ["ankur", "Preview renderer"],
    ["meera", "Onboarding email drip"],
    ["hanad", "Preview renderer API"],
    ["kousik", "Fixture loader perf"],
    ["priya", "Silent push investigation"],
    ["ankur", "Image sizes spike"],
    ["meera", "Checklist analytics"],
    ["tanvi", "Sidebar nav for docs"],
    ["kousik", "Retry budget for evals"],
    ["hanad", "Migrate to Expo SDK 52"],
    ["priya", "Push opt-in copy"],
    ["kousik", "Flaky snapshot test"],
  ];
  const own = [
    "Seed role catalog",
    "Expo token refresh",
    "Question schema v2",
    "Search index for docs",
    "Bundle upload retries",
    "Trial banner copy",
    "Proration edge cases",
    "Welcome checklist",
  ];
  return `<aside class="side" style="height:auto;overflow:visible"><div class="side-top"><span class="brand">Pair</span><span class="envchip">Pair Cloud</span></div><div class="side-body" style="overflow:visible">
    ${r(`${ic("plus")}<span class="grow">New thread</span>`)}
    ${r(`<span class="grow">Assigned to me</span><span class="pill">10</span>`)}
    ${assigned.map(([s, t]) => task(s, t)).join("")}
    <div class="sect"><span class="grow">Spaces</span>${ic("plus")}</div>
    ${r(`${ic("space")}<span class="grow">Question creation</span>`, "sel")}
    ${task("progress", "Seed role catalog", '<span class="t12 c-input">Needs you</span>')}
    ${r('<span class="grow ell">Seed role catalog</span>', "sub2")}
    ${r('<span class="col grow" style="gap:0"><span class="ell">Role fixtures v2</span><span class="t11 muted">Hanad\'s thread</span></span>', "sub2 two")}
    ${r('<span class="t12 muted">6 more tasks</span>', "sub")}
    ${r(`${ic("space")}<span class="grow w6">Onboarding revamp</span><span class="dot"></span>`)}
    ${["Billing v3", "Mobile push", "Docs site", "Eval harness", "Interview scheduler"].map((n) => r(`${ic("space")}<span class="grow">${n}</span>`)).join("")}
    <div class="sect">${ic("right")}<span class="grow">Archived</span></div>
    <div class="sect"><span class="grow">Threads</span></div>
    ${r('<span class="grow">Fix sidebar drag flicker</span><span class="cnt">2d</span>')}
    ${r('<span class="grow">Release checklist 0.1.8</span><span class="cnt">5h</span>')}
    <div class="sep" style="margin:4px 8px"></div>
    ${own.map((t) => r(`<span class="grow ell">${t}</span>`)).join("")}
    <div class="sect">${ic("down")}<span class="grow">Working</span><span>2</span></div>
    ${r('<span class="grow">Invoice PDF export</span>' + act("working"))}
    ${r('<span class="grow">Upgrade Effect to 3.12</span>' + act("working"))}
    <div class="sect">${ic("down")}<span class="grow">Team</span><span>20</span></div>
    ${team.map(([who, t]) => r(`${av(who, { size: 14 })}<span class="grow ell">${t}</span>`)).join("")}
    <div class="sect">${ic("right")}<span class="grow">Snoozed</span><span>2</span></div>
    <div class="sect" style="margin-top:0">${ic("right")}<span class="grow">Settled</span></div>
  </div></aside>`;
}

// ---------- Thread chrome ----------

function shell(side, main, panel = "", extra = "") {
  return `<div class="app" style="position:relative">${side}<main class="main">${main}</main>${panel}${extra}</div>`;
}

function crumbs(parts) {
  return `<div class="crumb">${parts
    .map((p, i) =>
      i === parts.length - 1
        ? `<span class="cur ell">${p}</span>`
        : `<span class="ell">${p}</span><span class="slash">/</span>`,
    )
    .join("")}</div>`;
}

function statusChip(status, label) {
  return `<span class="chip ghost">${st(status, 12)}${label}</span>`;
}

/** The lineage chip: a source and its branches, in the header's meta line. */
function lineageChip(text, o = {}) {
  return `<span class="lchip${o.open ? " open" : ""}${o.offer ? " offer" : ""}">${ic(o.offer ? "merge" : "branch", "s12")}${o.avs ? stack(o.avs, { size: 14 }) : ""}<span>${text}</span>${ic("down", "s12")}</span>`;
}

/** The lineage popover. rows: {owner, t, sub, right, here, child} */
function lineagePopover(o) {
  const rows = o.rows
    .map(
      (r) =>
        `<div class="mi${r.here ? " on" : ""}" style="align-items:center;${r.child ? "padding-left:26px" : ""}">${r.child ? '<span class="faint" style="margin-left:-14px;width:10px">└</span>' : ""}${av(r.owner, { size: 20 })}<div class="grow" style="min-width:0"><div class="row" style="gap:6px"><span class="w5 ell">${r.t}</span>${r.here ? '<span class="t11 muted">this thread</span>' : ""}</div><div class="t12 muted ell">${r.sub}</div></div><div class="t12 muted" style="text-align:right;white-space:nowrap">${r.right || ""}</div></div>`,
    )
    .join("");
  return `<div class="menu" style="${o.style}"><div class="t12 muted w5" style="padding:6px 9px 4px">${o.title}</div>${rows}${o.actions ? `<div class="msep"></div><div class="row" style="gap:6px;padding:6px 8px">${o.actions}</div>` : ""}${o.noBranchOff ? "" : `<div class="msep"></div><div class="mi" style="align-items:center">${ic("branch", "s12")}<span>Branch off…</span><span class="grow"></span><span class="t12 faint">${o.foot || ""}</span></div>`}</div>`;
}

function composer(o) {
  return `<div class="composer-wrap">${o.above || ""}<div class="composer"><div class="ph${o.typed ? " typed" : ""}">${o.text}</div><div class="foot">${o.left || ""}<span class="grow"></span>${o.right || ""}<span class="send${o.sendCls ? " " + o.sendCls : ""}">${o.sendIcon || ic("up")}</span></div></div>${o.below || ""}</div>`;
}

function panelTabs(active, extra = "") {
  const tabs = [
    ["Overview", "layers"],
    ["Browser", "globe"],
    ["Terminal", "term"],
    ["Changes", "diff"],
  ];
  return `<div class="tabs">${tabs
    .map(([n, i]) => `<span class="tab${n === active ? " on" : ""}">${ic(i, "s12")}${n}</span>`)
    .join(
      "",
    )}<span class="grow"></span>${extra}<button class="iconbtn">${ic("panel")}</button></div>`;
}

function browserPanel(url) {
  return `<aside class="panel">${panelTabs("Browser")}
  <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border)">
    <span class="muted">${ic("back")}</span><span class="select grow mono" style="height:26px;font-size:11.5px">${url}</span><span class="btn sm ghost">${ic("ext")}</span>
  </div>
  <div class="pbody" style="padding:18px">
    <div class="row" style="gap:18px;margin-bottom:18px"><span class="w6">Question studio</span><span class="muted">Roles</span><span>Question sets</span></div>
    <div class="w6" style="margin-bottom:6px">New question set</div>
    <div class="card" style="padding:10px;margin-bottom:10px;color:var(--muted-foreground)">Senior backend engineer, payments team. Owns the ledger and card retries.</div>
    <span class="btn primary" style="background:#18181b">Draft questions</span>
    <div class="muted t12" style="margin:14px 0 8px">5 questions drafted · schema v2</div>
    ${[
      ["Design an idempotent retry for failed card payments.", "System design · 30 min"],
      [
        "A ledger is off by one cent at month end. Walk through how you find it.",
        "Debugging · 20 min",
      ],
      ["When would you pick an outbox table over a message queue?", "Trade-offs · 15 min"],
    ]
      .map(
        ([q, m]) =>
          `<div class="card" style="padding:9px 11px;margin-bottom:8px"><div>${q}</div><div class="t12 muted">${m}</div></div>`,
      )
      .join("")}
  </div></aside>`;
}
