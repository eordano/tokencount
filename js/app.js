import { computeDiff } from "./diff.js";
import {
  MODEL_PROFILES,
  countTokens,
  countAllTokenizers,
  encodeTokens,
  loadModel,
  isReady,
  getStatus,
} from "./tokenizer.js";
import { encodePayload, decodePayload, decodePayloadBase64 } from "./zbase32.js";

let textA = "";
let textB = "";
let model = localStorage.getItem("tde-model") || "claude";
let showAll = localStorage.getItem("tde-showAll") === "true";
let compareMode = false;
let mobileTab = "a";
let highlightA = true;
let highlightB = true;
let preTokens = null;

if (!MODEL_PROFILES.find((p) => p.name === model)) model = "claude";

function savePrefs() {
  localStorage.setItem("tde-model", model);
  localStorage.setItem("tde-showAll", showAll);
}

const $ = (id) => document.getElementById(id);
const mainContent = document.querySelector(".main-content");
const panelA = $("panel-a"), panelB = $("panel-b");
const textareaA = $("textarea-a"), textareaB = $("textarea-b");
const panelTitleA = $("panel-title-a");
const modelSelectorA = $("model-selector-a"), modelDotA = $("model-dot-a");
const modelNameA = $("model-name-a"), allModelsA = $("all-models-a");
const modelDropdown = $("model-dropdown");
const tokenCountA = $("tokencount-a"), tokenCountB = $("tokencount-b");
const charCountA = $("char-count-a"), charCountB = $("char-count-b");
const compareToggle = $("compare-toggle"), compareBtn = $("compare-btn");
const closePanelB = $("close-panel-b");
const mobileTabsContainer = $("mobile-tabs");
const mobileTabBtns = document.querySelectorAll(".mobile-tab");
const diffSummary = $("diff-summary"), diffHeroNumber = $("diff-hero-number");
const diffHeroLabel = $("diff-hero-label"), diffSummaryDetail = $("diff-summary-detail");
const diffSummaryAll = $("diff-summary-all"), shareBtn = $("share-btn");
const tokenViewBtnA = $("token-view-btn-a"), tokenViewBtnB = $("token-view-btn-b");
const tokenHighlightA = $("token-highlight-a"), tokenHighlightB = $("token-highlight-b");
const modelSelectNativeCompare = $("model-select-native-compare");
const diffCard = $("diff-card"), diffCardLabel = $("diff-card-label");
const diffStatsAdded = $("diff-stats-added"), diffStatsRemoved = $("diff-stats-removed");
const diffStatsUnchanged = $("diff-stats-unchanged"), diffBody = $("diff-body");

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatNumber(n) {
  return n.toLocaleString();
}

function bestTokenCount(text, panel) {
  if (preTokens && preTokens.model === model && !isReady(model)) {
    return { count: preTokens[panel], exact: true };
  }
  return { count: countTokens(text, model), exact: isReady(model) };
}

function getProfile(name) {
  return MODEL_PROFILES.find((p) => p.name === name) || null;
}

function getWordCount(text) {
  if (!text.trim()) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function formatDelta(d) {
  const sign = d > 0 ? "+" : "";
  const cls = d > 0 ? "positive" : d < 0 ? "negative" : "";
  const val = d === 0 ? "=" : `${sign}${formatNumber(d)}`;
  return { cls, val };
}

const highlightTimers = { a: null, b: null };
const HIGHLIGHT_DEBOUNCE_MS = 300;

function debouncedRenderHighlight(container, text, timerKey) {
  const textarea = timerKey === "a" ? textareaA : textareaB;
  textarea.classList.remove("token-overlay-active");

  clearTimeout(highlightTimers[timerKey]);
  highlightTimers[timerKey] = setTimeout(() => {
    renderTokenHighlight(container, text);
    textarea.classList.add("token-overlay-active");
  }, HIGHLIGHT_DEBOUNCE_MS);
}

function ensureModelLoaded(name) {
  if (isReady(name) || getStatus(name) === "error") return;
  loadModel(name, () => {
    if (preTokens && preTokens.model === name) preTokens = null;
    render();
  });
}

function updateLayout() {
  if (compareMode) {
    mainContent.classList.add("compare-mode");
    panelB.style.display = "";
    compareToggle.style.display = "none";
    diffSummary.style.display = "";
    shareBtn.style.display = "";
    panelTitleA.textContent = "Original";
    updateMobileTabs();
  } else {
    mainContent.classList.remove("compare-mode");
    panelB.style.display = "none";
    diffCard.style.display = "none";
    mobileTabsContainer.style.display = "none";
    panelTitleA.textContent = "Input text";

    const hasText = textA.trim();
    diffSummary.style.display = hasText ? "" : "none";
    shareBtn.style.display = hasText ? "" : "none";
    compareToggle.style.display = hasText ? "" : "none";
  }
}

function updateMobileTabs() {
  if (!compareMode) {
    mobileTabsContainer.style.display = "none";
    return;
  }
  mobileTabsContainer.style.display = "";
  mobileTabBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === mobileTab);
  });
  panelA.classList.toggle("mobile-hidden", mobileTab !== "a");
  panelB.classList.toggle("mobile-hidden", mobileTab !== "b");
}

function renderModelDisplay() {
  const profile = getProfile(model);
  if (!profile) return;

  modelSelectNativeCompare.value = model;
  modelDotA.style.background = profile.color;
  modelNameA.textContent = profile.displayName;

  if (compareMode) {
    if (showAll) {
      const allCounts = countAllTokenizers(textA + " " + textB);
      let html = "";
      for (const est of allCounts) {
        const prefix = est.ready ? "" : "~";
        html += `<span class="all-models-item">
          <span class="dot" style="background:${est.color}"></span>
          <span>${est.displayName}</span>
          <span class="count">${prefix}${formatNumber(est.tokens)}</span>
        </span>`;
      }
      allModelsA.innerHTML = html;
      allModelsA.style.display = "flex";
    } else {
      allModelsA.style.display = "none";
    }
  } else {
    allModelsA.style.display = "none";
  }

  const bA = bestTokenCount(textA, "a");
  const prefixA = bA.exact ? "" : "~";
  tokenCountA.textContent = prefixA + formatNumber(bA.count) + " tok";

  const bB = bestTokenCount(textB, "b");
  const prefixB = bB.exact ? "" : "~";
  tokenCountB.textContent = prefixB + formatNumber(bB.count) + " tok";

  charCountA.textContent = formatNumber(textA.length) + " chr";
  charCountB.textContent = formatNumber(textB.length) + " chr";
}

let dropdownOpen = false;
let activeDropdownEl = null;

function buildDropdownHtml() {
  const combinedText = compareMode ? textA + " " + textB : textA;
  const allCounts = countAllTokenizers(combinedText);

  let html = "";
  for (const est of allCounts) {
    const isActive = model === est.name;
    const statusIcon = est.status === "loading"
      ? '<span class="model-loading-spinner"></span>'
      : est.status === "error"
        ? '<span class="model-status-icon" title="Using estimate">~</span>'
        : "";
    const prefix = est.ready ? "" : "~";

    let deltaHtml = "";
    if (compareMode && textA && textB) {
      const d = countTokens(textB, est.name) - countTokens(textA, est.name);
      const { cls, val } = formatDelta(d);
      deltaHtml = `<span class="delta ${cls}">${val}</span>`;
    }

    html += `<button class="model-option${isActive ? " active" : ""}" data-mode="${est.name}">
      <span class="dot" style="background:${est.color}"></span>
      <span>${est.label || est.displayName}</span>
      ${statusIcon}
      <span class="tokens">${prefix}${formatNumber(est.tokens)}</span>
      ${deltaHtml}
    </button>`;
  }

  html += `<div class="dropdown-divider"></div>`;
  html += `<button class="dropdown-toggle" data-action="toggle-all">
    ${showAll ? "Show one model" : "Show all models"}
  </button>`;
  return html;
}

function openDropdown(dropdownEl) {
  dropdownEl.innerHTML = buildDropdownHtml();
  dropdownEl.style.display = "block";
  activeDropdownEl = dropdownEl;
  dropdownOpen = true;

  dropdownEl.querySelectorAll("button[data-mode]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      model = btn.dataset.mode;
      ensureModelLoaded(model);
      savePrefs();
      closeDropdown();
      render();
    });
  });

  const toggleBtn = dropdownEl.querySelector("[data-action='toggle-all']");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showAll = !showAll;
      savePrefs();
      closeDropdown();
      render();
      if (showAll) {
        for (const p of MODEL_PROFILES) ensureModelLoaded(p.name);
      }
    });
  }
}

function closeDropdown() {
  if (activeDropdownEl) {
    activeDropdownEl.style.display = "none";
    activeDropdownEl = null;
  }
  dropdownOpen = false;
}

function renderDiffSummary() {
  const profile = getProfile(model);
  if (!profile) return;

  const bA = bestTokenCount(textA, "a");
  const tokA = bA.count;

  if (!compareMode) {
    if (!textA.trim()) return;
    const fmtA = (bA.exact ? "" : "~") + formatNumber(tokA);
    diffHeroNumber.textContent = fmtA;
    diffHeroNumber.className = "diff-hero-number neutral";
    diffHeroLabel.textContent = "tokens";
    diffSummaryDetail.innerHTML = "";
    diffSummaryAll.style.display = "none";
    return;
  }

  const bB = bestTokenCount(textB, "b");
  const tokB = bB.count;
  const bothExact = bA.exact && bB.exact;
  const diff = tokB - tokA;
  const cls = diff > 0 ? "positive" : diff < 0 ? "negative" : "neutral";
  const diffPrefix = bothExact ? "" : "~";

  if (diff === 0) {
    diffHeroNumber.textContent = "=";
  } else {
    const sign = diff > 0 ? "+" : "-";
    diffHeroNumber.textContent = sign + diffPrefix + formatNumber(Math.abs(diff));
  }
  diffHeroNumber.className = `diff-hero-number ${cls}`;
  diffHeroLabel.textContent = "tokens";

  let pctText = "";
  if (diff !== 0 && tokA > 0) {
    const pct = ((diff / tokA) * 100).toFixed(1);
    const pctSign = diff > 0 ? "+" : "";
    pctText = ` (${pctSign}${pct}%)`;
  }

  const fmtA = (bA.exact ? "" : "~") + formatNumber(tokA);
  const fmtB = (bB.exact ? "" : "~") + formatNumber(tokB);

  diffSummaryDetail.innerHTML = `
    <span class="detail-a">Original: ${fmtA}</span>
    <span class="detail-b">Modified: ${fmtB}${pctText}</span>
  `;

  if (showAll) {
    const allCounts = MODEL_PROFILES.map((p) => ({
      name: p.name,
      displayName: p.displayName,
      color: p.color,
      tokA: countTokens(textA, p.name),
      tokB: countTokens(textB, p.name),
    }));

    let html = "";
    for (const est of allCounts) {
      const { cls, val } = formatDelta(est.tokB - est.tokA);
      html += `<span class="delta-item">
        <span class="dot" style="background:${est.color}"></span>
        <span>${est.displayName}</span>
        <span class="delta-val ${cls}">${val}</span>
      </span>`;
    }
    diffSummaryAll.innerHTML = html;
    diffSummaryAll.style.display = "flex";
  } else {
    diffSummaryAll.style.display = "none";
  }
}

function renderDiffCard() {
  if (!compareMode || textA === textB || (!textA && !textB)) {
    diffCard.style.display = "none";
    return;
  }

  diffCard.style.display = "";

  const diff = computeDiff(textA, textB);

  let addedText = "";
  let removedText = "";
  let unchangedText = "";
  for (const seg of diff) {
    if (seg.type === "added") addedText += seg.text;
    else if (seg.type === "removed") removedText += seg.text;
    else unchangedText += seg.text;
  }

  const profile = getProfile(model);
  if (profile) {
    diffCardLabel.textContent = `Tokens diff`;
    const prefix = isReady(model) ? "" : "~";
    const addedTok = countTokens(addedText, model);
    const removedTok = countTokens(removedText, model);
    const unchangedTok = countTokens(unchangedText, model);
    diffStatsAdded.textContent = `+${prefix}${formatNumber(addedTok)} tok`;
    diffStatsRemoved.textContent = `-${prefix}${formatNumber(removedTok)} tok`;
    diffStatsUnchanged.textContent = `${prefix}${formatNumber(unchangedTok)} unchanged`;
  } else {
    diffCardLabel.textContent = "Word Diff";
    diffStatsAdded.textContent = `+${getWordCount(addedText)} words`;
    diffStatsRemoved.textContent = `-${getWordCount(removedText)} words`;
    diffStatsUnchanged.textContent = `${getWordCount(unchangedText)} unchanged`;
  }

  diffBody.innerHTML = diff.map((seg) =>
    `<span class="diff-span-${seg.type}">${escapeHtml(seg.text)}</span>`
  ).join("");
}

function renderTokenHighlight(container, text) {
  if (!text || !text.trim()) {
    container.innerHTML = '<span class="tok-empty">Enter text to see token boundaries</span>';
    return;
  }

  const tokens = encodeTokens(text, model);
  if (!tokens) {
    const profile = getProfile(model);
    const name = profile ? profile.displayName : model;
    container.innerHTML = `<span class="tok-empty">Loading ${name} tokenizer\u2026</span>`;
    return;
  }

  let html = "";
  for (let i = 0; i < tokens.length; i++) {
    const cls = `tok-${i % 6}`;
    const parts = tokens[i].split(/(\r\n|\r|\n)/);
    for (const part of parts) {
      if (part === "\n" || part === "\r" || part === "\r\n") {
        html += "\n";
      } else if (part) {
        html += `<span class="${cls}" title="Token ${i + 1}">${escapeHtml(part)}</span>`;
      }
    }
  }
  container.innerHTML = html;
}

function updateTokenHighlights() {
  const panels = [
    { highlight: highlightA, text: textA, key: "a", container: tokenHighlightA, textarea: textareaA, btn: tokenViewBtnA },
    { highlight: highlightB, text: textB, key: "b", container: tokenHighlightB, textarea: textareaB, btn: tokenViewBtnB },
  ];
  for (const p of panels) {
    if (p.highlight && p.text.trim()) {
      p.container.style.display = "block";
      debouncedRenderHighlight(p.container, p.text, p.key);
    } else {
      p.textarea.classList.remove("token-overlay-active");
      p.container.style.display = "none";
    }
    p.btn.classList.toggle("active", p.highlight);
    p.btn.disabled = !p.text.trim();
  }
}

function render() {
  updateLayout();
  renderModelDisplay();
  renderDiffSummary();
  renderDiffCard();
  updateTokenHighlights();
}

function enterCompareMode() {
  compareMode = true;
  mobileTab = "b";
  if (!textB) {
    textB = textA;
    textareaB.value = textB;
  }
  render();
  textareaB.focus();
}

function exitCompareMode() {
  compareMode = false;
  mobileTab = "a";
  render();
}

let pasteIntoA = false;

textareaA.addEventListener("paste", () => {
  if (!textB && !compareMode) pasteIntoA = true;
});

textareaA.addEventListener("input", () => {
  textA = textareaA.value;
  if (pasteIntoA) {
    pasteIntoA = false;
    if (compareMode) {
      textB = textA;
      textareaB.value = textB;
    }
  }
  render();
});

textareaB.addEventListener("input", () => {
  textB = textareaB.value;
  render();
});

modelSelectorA.addEventListener("click", (e) => {
  e.stopPropagation();
  if (dropdownOpen) {
    closeDropdown();
  } else {
    openDropdown(modelDropdown);
  }
});

document.addEventListener("click", () => {
  if (dropdownOpen) closeDropdown();
});

compareBtn.addEventListener("click", () => {
  enterCompareMode();
});

closePanelB.addEventListener("click", () => {
  exitCompareMode();
});

mobileTabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    mobileTab = btn.dataset.tab;
    render();
  });
});

for (const [btn, getH, setH, ta, th] of [
  [tokenViewBtnA, () => highlightA, (v) => highlightA = v, textareaA, tokenHighlightA],
  [tokenViewBtnB, () => highlightB, (v) => highlightB = v, textareaB, tokenHighlightB],
]) {
  btn.addEventListener("click", () => { setH(!getH()); if (getH()) ensureModelLoaded(model); render(); });
  ta.addEventListener("scroll", () => { th.scrollTop = ta.scrollTop; th.scrollLeft = ta.scrollLeft; });
}

function populateNativeSelect() {
  modelSelectNativeCompare.innerHTML = "";
  for (const p of MODEL_PROFILES) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.displayName;
    modelSelectNativeCompare.appendChild(opt);
  }
  modelSelectNativeCompare.value = model;
}
populateNativeSelect();

modelSelectNativeCompare.addEventListener("change", (e) => {
  model = e.target.value;
  ensureModelLoaded(model);
  savePrefs();
  render();
});

shareBtn.addEventListener("click", () => {
  if (!textA && !textB) return;
  let highlight = "";
  if (highlightA) highlight += "a";
  if (highlightB) highlight += "b";
  const tokens = { a: countTokens(textA, model), b: countTokens(textB, model) };
  const encoded = encodePayload(textA, textB, { model, highlight: highlight || undefined, tokens });
  const url = `${window.location.origin}${window.location.pathname}?b=${encoded}`;

  if (url.length > 8000) {
    showToast("Text too long to share via URL");
    return;
  }

  window.history.replaceState(null, "", `?b=${encoded}`);
  navigator.clipboard.writeText(url).then(() => {
    showToast("Link copied to clipboard");
  }).catch(() => {
    const input = document.createElement("input");
    input.value = url;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    document.body.removeChild(input);
    showToast("Link copied to clipboard");
  });
});

function showToast(message) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2000);
}

function loadFromURL() {
  const params = new URLSearchParams(window.location.search);
  const zb32 = params.get("d");
  const b64 = params.get("b");
  const decoded = zb32 ? decodePayload(zb32) : b64 ? decodePayloadBase64(b64) : null;
  if (decoded) {
    textA = decoded.a;
    textB = decoded.b;
    textareaA.value = textA;
    textareaB.value = textB;
    if (decoded.m && MODEL_PROFILES.find((p) => p.name === decoded.m)) {
      model = decoded.m;
      savePrefs();
    }
    if (decoded.t && typeof decoded.t.a === "number" && typeof decoded.t.b === "number") {
      preTokens = { a: decoded.t.a, b: decoded.t.b, model: model };
    }
    if (decoded.h) {
      highlightA = decoded.h.includes("a");
      highlightB = decoded.h.includes("b");
    }
    if (textA && textB) {
      compareMode = true;
    }
  }
}

loadFromURL();
if (!textA && textareaA.value) {
  textA = textareaA.value;
}
if (!textB && textareaB.value) {
  textB = textareaB.value;
}
ensureModelLoaded(model);
if (showAll) {
  for (const p of MODEL_PROFILES) ensureModelLoaded(p.name);
}
render();
