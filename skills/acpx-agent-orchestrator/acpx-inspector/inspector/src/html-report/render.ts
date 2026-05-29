import type { ReportModel } from "../types.js";

export function renderReportHtml(model: ReportModel): string {
  const data = JSON.stringify(model).replace(/</g, "\\u003c");
  const visual = buildVisualModel(model);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(model.title)} · acpx inspector</title>
  <style>${CSS}</style>
</head>
<body>
  <script id="report-data" type="application/json">${data}</script>
  <div class="shell">
    <aside class="rail">
      <div class="brand">
        <span class="brand__mark">AI</span>
        <div><strong>acpx inspector</strong><span>${escapeHtml(model.kind)}</span></div>
      </div>
      <nav>
        ${model.sections.map((section) => `<a href="#${escapeAttr(section.id)}">${escapeHtml(section.title)}</a>`).join("")}
      </nav>
    </aside>
    <main class="main">
      <header class="top">
        <div>
          <p class="eyebrow">${escapeHtml(model.kind)} report</p>
          <h1>${escapeHtml(model.title)}</h1>
          <p class="subtitle">${escapeHtml(model.subtitle)}</p>
        </div>
        <div class="status status--${escapeAttr(toneForStatus(model.status))}">${escapeHtml(model.status)}</div>
      </header>
      <section class="summary" aria-label="Summary">
        ${model.summary.map((item) => `<div class="metric metric--${escapeAttr(item.tone ?? "neutral")}"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>`).join("")}
      </section>
      <section class="signal-strip" aria-label="Visual overview">
        ${visual.sections.map((section) => `<a class="signal-strip__cell signal-strip__cell--${escapeAttr(section.tone)}" href="#${escapeAttr(section.id)}" style="--w:${section.width}%" title="${escapeAttr(section.title)} · ${section.count} item${section.count === 1 ? "" : "s"}"><span></span></a>`).join("")}
      </section>
      <div class="workspace">
        <section class="content">
          ${model.sections.map(renderSection).join("")}
        </section>
        <aside class="visual-panel">
          <p class="eyebrow">Signal map</p>
          <h2>Session Shape</h2>
          <div class="status-gauge status-gauge--${escapeAttr(toneForStatus(model.status))}" aria-label="Status ${escapeAttr(model.status)}">
            <span>${escapeHtml(model.status)}</span>
          </div>
          <div class="viz-block">
            <div class="viz-block__head"><span>Section weight</span><strong>${visual.totalItems}</strong></div>
            <div class="bar-stack">
              ${visual.sections.map((section) => `<a href="#${escapeAttr(section.id)}" class="bar-stack__segment bar-stack__segment--${escapeAttr(section.tone)}" style="--w:${section.width}%" title="${escapeAttr(section.title)}"></a>`).join("")}
            </div>
          </div>
          <div class="viz-block">
            <div class="viz-block__head"><span>Signal tone</span><strong>${visual.toneTotal}</strong></div>
            <div class="tone-grid">
              ${visual.tones.map((tone) => `<div class="tone-grid__row"><span>${escapeHtml(tone.label)}</span><div><i class="tone-grid__fill tone-grid__fill--${escapeAttr(tone.id)}" style="--w:${tone.width}%"></i></div><strong>${tone.count}</strong></div>`).join("")}
            </div>
          </div>
          <div class="viz-block">
            <div class="viz-block__head"><span>Timeline rhythm</span><strong>${visual.rhythm.length}</strong></div>
            <div class="rhythm" aria-label="Timeline rhythm">
              ${visual.rhythm.map((item) => `<a href="#${escapeAttr(item.sectionId)}" class="rhythm__bar rhythm__bar--${escapeAttr(item.tone)}" style="--h:${item.height}%" title="${escapeAttr(item.title)}"></a>`).join("")}
            </div>
          </div>
        </aside>
      </div>
    </main>
  </div>
  <script>${JS}</script>
</body>
</html>
`;
}

function renderSection(section: ReportModel["sections"][number]): string {
  const density = Math.min(100, Math.max(8, section.items.length * 12));
  return `<section class="section" id="${escapeAttr(section.id)}">
    ${section.eyebrow ? `<p class="eyebrow">${escapeHtml(section.eyebrow)}</p>` : ""}
    <div class="section__title-row"><h2>${escapeHtml(section.title)}</h2><span class="density" style="--density:${density}%"></span></div>
    <div class="timeline">
      ${section.items.length === 0 ? `<p class="muted">No items recorded.</p>` : ""}
      ${section.items.map((item) => `<article class="event event--${escapeAttr(item.tone ?? "neutral")}">
        <span class="event__stripe" aria-hidden="true"></span>
        <div class="event__head"><strong>${escapeHtml(item.title)}</strong>${item.meta ? `<span>${escapeHtml(item.meta)}</span>` : ""}</div>
        ${item.body ? `<p>${escapeHtml(item.body)}</p>` : ""}
        ${item.code ? `<details><summary>Raw details</summary><pre>${escapeHtml(item.code)}</pre></details>` : ""}
      </article>`).join("")}
    </div>
  </section>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/[^A-Za-z0-9_-]/g, "-");
}

function toneForStatus(status: string): string {
  if (["running", "idle", "completed", "end_turn", "success"].includes(status)) return "success";
  if (["dead", "failed", "error", "timed_out"].includes(status)) return "danger";
  if (["closed", "cancelled", "unknown"].includes(status)) return "warning";
  return "neutral";
}

type VisualModel = {
  totalItems: number;
  toneTotal: number;
  sections: Array<{ id: string; title: string; count: number; width: number; tone: string }>;
  tones: Array<{ id: string; label: string; count: number; width: number }>;
  rhythm: Array<{ sectionId: string; title: string; tone: string; height: number }>;
};

function buildVisualModel(model: ReportModel): VisualModel {
  const sectionCounts = model.sections.map((section) => ({
    id: section.id,
    title: section.title,
    count: Math.max(0, section.items.length),
    tone: dominantTone(section.items.map((item) => item.tone ?? "neutral")),
  }));
  const totalItems = Math.max(1, sectionCounts.reduce((sum, section) => sum + section.count, 0));
  const tones = ["success", "warning", "danger", "neutral"].map((tone) => {
    const count = model.sections.flatMap((section) => section.items).filter((item) => (item.tone ?? "neutral") === tone).length;
    return {
      id: tone,
      label: tone,
      count,
      width: Math.max(count === 0 ? 0 : 6, Math.round((count / totalItems) * 100)),
    };
  });
  const rhythm = model.sections.flatMap((section) =>
    section.items.map((item, index) => ({
      sectionId: section.id,
      title: item.title,
      tone: item.tone ?? "neutral",
      height: 26 + ((index * 17 + section.id.length * 11) % 68),
    })),
  );
  return {
    totalItems,
    toneTotal: tones.reduce((sum, tone) => sum + tone.count, 0),
    sections: sectionCounts.map((section) => ({
      ...section,
      width: Math.max(section.count === 0 ? 0 : 8, Math.round((section.count / totalItems) * 100)),
    })),
    tones,
    rhythm,
  };
}

function dominantTone(tones: string[]): string {
  if (tones.includes("danger")) return "danger";
  if (tones.includes("warning")) return "warning";
  if (tones.includes("success")) return "success";
  return "neutral";
}

const CSS = `
:root {
  color-scheme: light;
  --bg: #f6f7f4;
  --ink: #151817;
  --soft: #65706c;
  --line: #d8ddd7;
  --panel: #ffffff;
  --panel-alt: #eef2ef;
  --accent: #176f80;
  --success: #277246;
  --warning: #9b6b13;
  --danger: #a43c3c;
  --shadow: 0 18px 50px rgba(24, 34, 31, 0.12);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--ink); }
code, pre { font-family: "SFMono-Regular", Consolas, monospace; }
.shell { min-height: 100dvh; display: grid; grid-template-columns: 248px minmax(0, 1fr); }
.rail { position: sticky; top: 0; height: 100dvh; padding: 18px 14px; border-right: 1px solid var(--line); background: #fbfcfa; }
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
.brand__mark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; background: var(--ink); color: white; font-weight: 800; }
.brand strong, .brand span { display: block; }
.brand span { color: var(--soft); font-size: 0.82rem; margin-top: 2px; }
nav { display: grid; gap: 4px; }
nav a { color: var(--soft); text-decoration: none; padding: 9px 10px; border-radius: 8px; }
nav a:hover, nav a.active { color: var(--ink); background: var(--panel-alt); }
.main { min-width: 0; padding: 22px; }
.top { display: flex; justify-content: space-between; align-items: start; gap: 18px; margin-bottom: 16px; }
.eyebrow { margin: 0 0 5px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.09em; font-size: 0.76rem; font-weight: 800; }
h1 { margin: 0; font-size: 2rem; line-height: 1.05; letter-spacing: 0; }
h2 { margin: 0 0 10px; font-size: 1.06rem; letter-spacing: 0; }
.subtitle { max-width: 960px; margin: 8px 0 0; color: var(--soft); overflow-wrap: anywhere; }
.status { padding: 8px 12px; border-radius: 999px; border: 1px solid var(--line); font-weight: 800; }
.status--success { color: var(--success); background: #e8f4ec; }
.status--warning { color: var(--warning); background: #fff4d8; }
.status--danger { color: var(--danger); background: #fde9e9; }
.summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 16px; }
.metric { min-height: 74px; padding: 12px; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; }
.metric span { display: block; color: var(--soft); font-size: 0.78rem; margin-bottom: 8px; }
.metric strong { display: block; font-size: 1.1rem; overflow-wrap: anywhere; }
.signal-strip { height: 18px; display: flex; gap: 4px; margin-bottom: 16px; }
.signal-strip__cell { flex: 0 0 var(--w); min-width: 10px; height: 100%; border-radius: 4px; background: var(--panel-alt); border: 1px solid var(--line); overflow: hidden; }
.signal-strip__cell span { display: block; width: 100%; height: 100%; opacity: 0.82; }
.signal-strip__cell--success span { background: var(--success); }
.signal-strip__cell--warning span { background: var(--warning); }
.signal-strip__cell--danger span { background: var(--danger); }
.signal-strip__cell--neutral span { background: var(--accent); }
.workspace { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 14px; align-items: start; }
.content { display: grid; gap: 14px; }
.section { padding: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); scroll-margin-top: 16px; }
.section.flash { animation: flash 900ms ease; }
.section__title-row { display: grid; grid-template-columns: minmax(0, auto) minmax(96px, 1fr); gap: 12px; align-items: center; margin-bottom: 10px; }
.section__title-row h2 { margin: 0; }
.density { height: 8px; border-radius: 999px; background: linear-gradient(90deg, var(--accent) var(--density), var(--panel-alt) var(--density)); border: 1px solid var(--line); }
.timeline { display: grid; gap: 8px; }
.event { position: relative; display: grid; grid-template-columns: 8px minmax(0, 1fr); column-gap: 10px; padding: 10px 12px; background: #fbfcfa; border-radius: 8px; border: 1px solid rgba(216, 221, 215, 0.72); }
.event--success { border-left-color: var(--success); }
.event--warning { border-left-color: var(--warning); }
.event--danger { border-left-color: var(--danger); }
.event__stripe { grid-row: 1 / span 3; width: 8px; min-height: 100%; border-radius: 999px; background: var(--accent); opacity: 0.62; }
.event--success .event__stripe { background: var(--success); }
.event--warning .event__stripe { background: var(--warning); }
.event--danger .event__stripe { background: var(--danger); }
.event__head { display: flex; justify-content: space-between; gap: 12px; }
.event__head span, .muted { color: var(--soft); }
.event p, .event details { grid-column: 2; }
.event p { margin: 8px 0 0; color: #2d3633; overflow-wrap: anywhere; }
details { margin-top: 8px; }
summary { cursor: pointer; color: var(--accent); font-weight: 700; }
pre { overflow: auto; padding: 10px; background: #101514; color: #eaf2ee; border-radius: 8px; max-height: 360px; }
.visual-panel { position: sticky; top: 18px; padding: 16px; background: #fbfcfa; border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
.status-gauge { height: 126px; display: grid; place-items: center; margin: 8px 0 14px; border-radius: 8px; border: 1px solid var(--line); background: repeating-linear-gradient(135deg, #f8faf8, #f8faf8 8px, #edf2ef 8px, #edf2ef 16px); }
.status-gauge span { min-width: 68%; text-align: center; padding: 12px; border-radius: 8px; background: var(--panel); border: 2px solid var(--accent); font-size: 1.25rem; font-weight: 900; }
.status-gauge--success span { border-color: var(--success); color: var(--success); }
.status-gauge--warning span { border-color: var(--warning); color: var(--warning); }
.status-gauge--danger span { border-color: var(--danger); color: var(--danger); }
.viz-block { padding: 12px 0; border-top: 1px solid var(--line); }
.viz-block__head { display: flex; justify-content: space-between; gap: 8px; color: var(--soft); font-size: 0.78rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 9px; }
.bar-stack { height: 18px; display: flex; gap: 3px; }
.bar-stack__segment { flex: 0 0 var(--w); min-width: 5px; border-radius: 3px; background: var(--accent); }
.bar-stack__segment--success, .tone-grid__fill--success, .rhythm__bar--success { background: var(--success); }
.bar-stack__segment--warning, .tone-grid__fill--warning, .rhythm__bar--warning { background: var(--warning); }
.bar-stack__segment--danger, .tone-grid__fill--danger, .rhythm__bar--danger { background: var(--danger); }
.bar-stack__segment--neutral, .tone-grid__fill--neutral, .rhythm__bar--neutral { background: var(--accent); }
.tone-grid { display: grid; gap: 7px; }
.tone-grid__row { display: grid; grid-template-columns: 64px minmax(0, 1fr) 28px; gap: 8px; align-items: center; color: var(--soft); font-size: 0.78rem; }
.tone-grid__row div { height: 8px; border-radius: 999px; background: var(--panel-alt); overflow: hidden; border: 1px solid var(--line); }
.tone-grid__fill { display: block; width: var(--w); height: 100%; }
.rhythm { height: 112px; display: flex; align-items: end; gap: 3px; padding: 8px 0 2px; border-bottom: 1px solid var(--line); }
.rhythm__bar { flex: 1 1 6px; min-width: 4px; max-width: 18px; height: var(--h); border-radius: 4px 4px 0 0; background: var(--accent); opacity: 0.86; }
@keyframes flash { from { outline: 3px solid rgba(23,111,128,.35); } to { outline: 0 solid transparent; } }
@media (max-width: 920px) {
  .shell { grid-template-columns: 1fr; }
  .rail { position: sticky; z-index: 2; height: auto; top: 0; border-right: 0; border-bottom: 1px solid var(--line); }
  nav { grid-auto-flow: column; overflow-x: auto; }
  .main { padding: 14px; }
  .top { display: grid; }
  .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .workspace { grid-template-columns: 1fr; }
  .visual-panel { position: static; }
}
`;

const JS = `
const links = Array.from(document.querySelectorAll('nav a'));
const sections = Array.from(document.querySelectorAll('.section'));
function setActive() {
  const current = sections.findLast(section => section.getBoundingClientRect().top < 120) || sections[0];
  links.forEach(link => link.classList.toggle('active', current && link.getAttribute('href') === '#' + current.id));
}
for (const link of links) {
  link.addEventListener('click', () => {
    const id = link.getAttribute('href')?.slice(1);
    const section = id ? document.getElementById(id) : null;
    if (section) {
      section.classList.remove('flash');
      requestAnimationFrame(() => section.classList.add('flash'));
    }
  });
}
document.addEventListener('scroll', setActive, { passive: true });
setActive();
`;
