#!/usr/bin/env node
/**
 * Generates a fast, self-contained screenshot viewer HTML for Playwright test screenshots.
 * Scans tests/screenshots/{desktop,mobile}/ and builds a navigable gallery.
 *
 * Usage: node scripts/build-screenshot-viewer.mjs
 * Output: tests/screenshots/viewer.html
 */

import { readdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const ssDir = join(root, "tests", "screenshots");

function scanDir(subdir) {
  const dir = join(ssDir, subdir);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  } catch {
    return new Map();
  }
  // Group by name (strip leading index), keep highest index (latest run)
  const map = new Map();
  for (const f of files) {
    const name = f.replace(/^\d+-/, "");
    map.set(name, `${subdir}/${f}`);
  }
  return map;
}

const desktop = scanDir("desktop");
const mobile = scanDir("mobile");

// Merge all unique names, sorted
const allNames = [...new Set([...desktop.keys(), ...mobile.keys()])].sort();

// Group by test section number (prefix before first dash)
const groups = new Map();
for (const name of allNames) {
  const section = name.match(/^(\d+)/)?.[1] ?? "00";
  if (!groups.has(section)) groups.set(section, []);
  groups.get(section).push({
    name,
    label: name.replace(/\.png$/, ""),
    desktop: desktop.get(name) || null,
    mobile: mobile.get(name) || null,
  });
}

const TEST_GROUP_LABELS = {
  "01": "Single text token counting",
  "02": "Edit and compare token diff",
  "03": "Pure diff viewing",
  "04": "Model switching (desktop dropdown)",
  "05": "Token visualization",
  "06": "Real-time iteration",
  "07": "AI rewrite comparison",
  "08": "Token boundary understanding",
  "09": "Mobile tabs",
  "10": "Mobile native model selector",
  "11": "Share workflow",
  "12": "Cross-language tokenization",
  "13": "Full desktop workflow",
};

// Build flat items array for JS
const items = [];
for (const [, entries] of [...groups.entries()].sort((a, b) =>
  a[0].localeCompare(b[0])
)) {
  for (const e of entries) items.push(e);
}

const itemsJSON = JSON.stringify(items);
const groupsJSON = JSON.stringify(
  [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([sec, entries]) => ({
      section: sec,
      title: TEST_GROUP_LABELS[sec] || `Section ${sec}`,
      count: entries.length,
    }))
);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test Screenshots</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#1a1a2e;--bg2:#16213e;--fg:#e0e0e0;--fg2:#999;--accent:#e94560;--green:#4ade80;--border:#2a2a4a;--sw:280px}
html{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--fg);height:100%;display:flex;flex-direction:column;overflow:hidden}
header{display:flex;align-items:center;gap:12px;padding:8px 16px;background:var(--bg2);border-bottom:1px solid var(--border);flex-shrink:0;min-height:48px;z-index:10}
header h1{font-size:14px;font-weight:600;white-space:nowrap}
.mode-toggle{display:flex;background:var(--bg);border-radius:6px;overflow:hidden;border:1px solid var(--border)}
.mode-toggle button{padding:5px 14px;border:none;background:transparent;color:var(--fg2);font-size:13px;cursor:pointer;font-weight:500;transition:background .1s,color .1s}
.mode-toggle button.active{background:var(--accent);color:#fff}
.mode-toggle button:hover:not(.active){background:var(--border);color:var(--fg)}
.nav-info{font-size:13px;color:var(--fg2);margin-left:auto;white-space:nowrap;display:flex;align-items:center;gap:8px}
.nav-info kbd{display:inline-block;padding:1px 6px;background:var(--bg);border:1px solid var(--border);border-radius:3px;font-size:11px;font-family:inherit}
.container{display:flex;flex:1;overflow:hidden}
.sidebar{width:var(--sw);min-width:var(--sw);overflow-y:auto;background:var(--bg2);border-right:1px solid var(--border);scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.group-header{padding:8px 12px 4px;font-size:11px;font-weight:600;color:var(--accent);text-transform:uppercase;letter-spacing:.5px;position:sticky;top:0;background:var(--bg2);z-index:1}
.sidebar-item{display:flex;align-items:center;gap:8px;padding:5px 12px 5px 20px;cursor:pointer;font-size:12px;border-left:3px solid transparent;transition:background .08s;line-height:1.3}
.sidebar-item:hover{background:rgba(255,255,255,.04)}
.sidebar-item.active{background:rgba(233,69,96,.12);border-left-color:var(--accent);color:#fff}
.sidebar-item.disabled{opacity:.35;cursor:default;pointer-events:none}
.sidebar-item .dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.sidebar-item .dot.both{background:var(--green)}
.sidebar-item .dot.desktop-only{background:#60a5fa}
.sidebar-item .dot.mobile-only{background:#f472b6}
.main{flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;padding:16px;position:relative}
.main img{max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;box-shadow:0 4px 24px rgba(0,0,0,.5)}
.disabled-msg{text-align:center;color:var(--fg2)}
.disabled-msg .icon{font-size:48px;margin-bottom:12px;display:block}
.disabled-msg p{font-size:15px}
.disabled-msg .sub{font-size:12px;margin-top:4px;color:var(--fg2);opacity:.7}
.preload{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden}
</style>
</head>
<body>

<header>
  <h1>Test Screenshots</h1>
  <div class="mode-toggle">
    <button id="btn-desktop" class="active" onclick="setMode('desktop')">Desktop</button>
    <button id="btn-mobile" onclick="setMode('mobile')">Mobile</button>
  </div>
  <div class="nav-info">
    <kbd>&larr;</kbd> <kbd>&rarr;</kbd> nav
    &emsp;
    <kbd>D</kbd> / <kbd>M</kbd> mode
    &emsp;
    <span id="counter"></span>
  </div>
</header>

<div class="container">
  <nav class="sidebar" id="sidebar"></nav>
  <div class="main" id="main"></div>
</div>

<!-- Preload container for adjacent images -->
<div class="preload" id="preload" aria-hidden="true"></div>

<script>
const ITEMS = ${itemsJSON};
const GROUPS = ${groupsJSON};

let mode = "desktop";
let idx = 0;

function setMode(m) {
  mode = m;
  document.getElementById("btn-desktop").classList.toggle("active", m === "desktop");
  document.getElementById("btn-mobile").classList.toggle("active", m === "mobile");
  buildSidebar();
  render();
}

function select(i) {
  if (i < 0 || i >= ITEMS.length) return;
  idx = i;
  render();
  // Scroll sidebar item into view
  const el = document.querySelector('.sidebar-item[data-i="' + i + '"]');
  if (el) el.scrollIntoView({ block: "nearest" });
}

function buildSidebar() {
  const sb = document.getElementById("sidebar");
  let html = "";
  let offset = 0;
  for (const g of GROUPS) {
    html += '<div class="group-header">' + g.section + " \\u2013 " + g.title + "</div>";
    for (let j = 0; j < g.count; j++) {
      const gi = offset + j;
      const item = ITEMS[gi];
      const has = !!item[mode];
      const cls = (gi === idx ? " active" : "") + (has ? "" : " disabled");
      const dotCls = item.desktop && item.mobile ? "both" : item.desktop ? "desktop-only" : "mobile-only";
      html += '<div class="sidebar-item' + cls + '" data-i="' + gi + '"' +
        (has ? ' onclick="select(' + gi + ')"' : '') + '>' +
        '<span class="dot ' + dotCls + '"></span>' +
        '<span>' + item.label + '</span></div>';
    }
    offset += g.count;
  }
  sb.innerHTML = html;
}

function render() {
  const item = ITEMS[idx];
  const src = item[mode];
  const main = document.getElementById("main");
  const counter = document.getElementById("counter");
  counter.textContent = (idx + 1) + " / " + ITEMS.length;

  if (src) {
    main.innerHTML = '<img src="' + src + '" alt="' + item.label + '" draggable="false">';
  } else {
    const other = mode === "desktop" ? "mobile" : "desktop";
    main.innerHTML =
      '<div class="disabled-msg">' +
      '<span class="icon">&#x1f6ab;</span>' +
      '<p>No ' + mode + ' screenshot</p>' +
      '<div class="sub">This test only runs on ' + other + '</div>' +
      '</div>';
  }

  // Preload adjacent images
  const pre = document.getElementById("preload");
  let preHtml = "";
  for (const di of [-2, -1, 1, 2]) {
    const ni = idx + di;
    if (ni >= 0 && ni < ITEMS.length) {
      const nsrc = ITEMS[ni][mode];
      if (nsrc) preHtml += '<img src="' + nsrc + '">';
    }
  }
  pre.innerHTML = preHtml;

  // Update sidebar active state
  document.querySelectorAll(".sidebar-item.active").forEach((el) => el.classList.remove("active"));
  const el = document.querySelector('.sidebar-item[data-i="' + idx + '"]');
  if (el) { el.classList.add("active"); el.scrollIntoView({ block: "nearest" }); }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); select(idx + 1); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); select(idx - 1); }
  else if (e.key === "d" || e.key === "D") setMode("desktop");
  else if (e.key === "m" || e.key === "M") setMode("mobile");
});

// Init
buildSidebar();
render();
</script>
</body>
</html>
`;

const outPath = join(ssDir, "viewer.html");
writeFileSync(outPath, html);
console.log(`Generated: ${outPath}`);
console.log(
  `  ${items.length} screenshots (${desktop.size} desktop, ${mobile.size} mobile)`
);
