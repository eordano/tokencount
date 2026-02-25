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

// ===== State =====
let textA = "";
let textB = "";
let modelA = localStorage.getItem("tde-modelA") || localStorage.getItem("tde-model") || "claude";
let modelB = localStorage.getItem("tde-modelB") || localStorage.getItem("tde-model") || "claude";
let showAll = localStorage.getItem("tde-showAll") === "true";
let compareMode = false;        // Compare two different texts
let modelCompareMode = false;   // Compare same text with two models
let mobileTab = "a";
let highlightA = true;
let highlightB = true;
// Pre-computed token counts from share link (shown before model loads)
let preTokens = null; // { a: number, b: number, modelA: string, modelB: string }

// Validate stored models
if (!MODEL_PROFILES.find((p) => p.name === modelA)) modelA = "claude";
if (!MODEL_PROFILES.find((p) => p.name === modelB)) modelB = "claude";

function savePrefs() {
  localStorage.setItem("tde-modelA", modelA);
  localStorage.setItem("tde-modelB", modelB);
  localStorage.setItem("tde-showAll", showAll);
}

// ===== DOM refs =====
const mainContent = document.querySelector(".main-content");
const panelA = document.getElementById("panel-a");
const panelB = document.getElementById("panel-b");
const textareaA = document.getElementById("textarea-a");
const textareaB = document.getElementById("textarea-b");

// Panel titles
const panelTitleA = document.getElementById("panel-title-a");

// Model selectors (in diff summary)
const modelSelectorA = document.getElementById("model-selector-a");
const modelDotA = document.getElementById("model-dot-a");
const modelNameA = document.getElementById("model-name-a");
const modelDropdownA = document.getElementById("model-dropdown-a");
const modelSelectorB = document.getElementById("model-selector-b");
const modelDotB = document.getElementById("model-dot-b");
const modelNameB = document.getElementById("model-name-b");
const modelDropdownB = document.getElementById("model-dropdown-b");
const allModelsA = document.getElementById("all-models-a");

// Token counts (in panel footers)
const tokenCountA = document.getElementById("tokencount-a");
const tokenCountB = document.getElementById("tokencount-b");

// Char counts
const charCountA = document.getElementById("char-count-a");
const charCountB = document.getElementById("char-count-b");

// Compare toggle
const compareToggle = document.getElementById("compare-toggle");
const compareBtn = document.getElementById("compare-btn");
const compareModelsBtn = document.getElementById("compare-models-btn");
const closePanelB = document.getElementById("close-panel-b");

// Mobile tabs
const mobileTabsContainer = document.getElementById("mobile-tabs");
const mobileTabBtns = document.querySelectorAll(".mobile-tab");

// Diff summary
const diffSummary = document.getElementById("diff-summary");
const diffHeroNumber = document.getElementById("diff-hero-number");
const diffHeroLabel = document.getElementById("diff-hero-label");
const diffSummaryDetail = document.getElementById("diff-summary-detail");
const diffSummaryAll = document.getElementById("diff-summary-all");
const shareBtn = document.getElementById("share-btn");

// Token highlight
const tokenViewBtnA = document.getElementById("token-view-btn-a");
const tokenViewBtnB = document.getElementById("token-view-btn-b");
const tokenHighlightA = document.getElementById("token-highlight-a");
const tokenHighlightB = document.getElementById("token-highlight-b");

// Native model select (mobile)
const modelSelectNativeA = document.getElementById("model-select-native-a");
const modelSelectNativeB = document.getElementById("model-select-native-b");

// Diff card
const diffCard = document.getElementById("diff-card");
const diffCardLabel = document.getElementById("diff-card-label");
const diffStatsAdded = document.getElementById("diff-stats-added");
const diffStatsRemoved = document.getElementById("diff-stats-removed");
const diffStatsUnchanged = document.getElementById("diff-stats-unchanged");
const diffBody = document.getElementById("diff-body");

// ===== Helpers =====
function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatNumber(n) {
  return n.toLocaleString();
}

// Return best available token count: pre-computed from share link, or live
function bestTokenCount(text, panel) {
  const panelModel = panel === "a" ? modelA : modelB;
  const preTokenModel = panel === "a" ? preTokens?.modelA : preTokens?.modelB;
  if (preTokens && preTokenModel === panelModel && !isReady(panelModel)) {
    return { count: preTokens[panel], exact: true };
  }
  return { count: countTokens(text, panelModel), exact: isReady(panelModel) };
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

// ===== Debounce =====
const highlightTimers = { a: null, b: null };
const HIGHLIGHT_DEBOUNCE_MS = 300;

function debouncedRenderHighlight(container, text, timerKey, panelModel) {
  const textarea = timerKey === "a" ? textareaA : textareaB;
  // While waiting for highlight to render, show plain text
  textarea.classList.remove("token-overlay-active");

  clearTimeout(highlightTimers[timerKey]);
  highlightTimers[timerKey] = setTimeout(() => {
    renderTokenHighlight(container, text, panelModel);
    // Highlight is now up-to-date — switch to transparent overlay
    textarea.classList.add("token-overlay-active");
  }, HIGHLIGHT_DEBOUNCE_MS);
}

// ===== Model loading =====
function ensureModelLoaded(name) {
  if (isReady(name) || getStatus(name) === "error") return;
  loadModel(name, () => {
    // Clear pre-computed tokens once the real model is available
    if (preTokens && (preTokens.modelA === name || preTokens.modelB === name)) preTokens = null;
    render();
  });
}

// ===== Layout =====
function updateLayout() {
  const isComparing = compareMode || modelCompareMode;

  if (isComparing) {
    mainContent.classList.add("compare-mode");
    panelB.style.display = "";
    compareToggle.style.display = "none";
    diffSummary.style.display = "";
    shareBtn.style.display = "";

    // No titles in either compare mode
    panelTitleA.textContent = "";
    document.getElementById("panel-title-b").textContent = "";

    if (modelCompareMode) {
      // Model compare mode: same text, different models
      textareaB.readOnly = true;
      textareaB.classList.add("readonly");
      // Sync text B with text A
      if (textB !== textA) {
        textB = textA;
        textareaB.value = textA;
      }
      // Hide diff card in model compare mode
      diffCard.style.display = "none";
      // Show both model selectors
      document.querySelector("#panel-a .panel-model-selector").style.display = "";
      document.querySelector("#panel-b .panel-model-selector").style.display = "";
    } else {
      // Text compare mode: different texts, same model
      textareaB.readOnly = false;
      textareaB.classList.remove("readonly");
      // Sync models - in text compare mode, both panels use the same model
      if (modelB !== modelA) {
        modelB = modelA;
        savePrefs();
      }
      // Show only panel A model selector, hide panel B
      document.querySelector("#panel-a .panel-model-selector").style.display = "";
      document.querySelector("#panel-b .panel-model-selector").style.display = "none";
    }

    updateMobileTabs();
  } else {
    mainContent.classList.remove("compare-mode");
    panelB.style.display = "none";
    diffCard.style.display = "none";
    mobileTabsContainer.style.display = "none";
    panelTitleA.textContent = "";
    textareaB.readOnly = false;
    textareaB.classList.remove("readonly");

    const hasText = textA.trim();
    // Show diff summary strip (model chooser + count + share) when text exists
    diffSummary.style.display = hasText ? "" : "none";
    shareBtn.style.display = hasText ? "" : "none";
    compareToggle.style.display = hasText ? "" : "none";
  }
}

function updateMobileTabs() {
  const isComparing = compareMode || modelCompareMode;
  if (!isComparing) {
    mobileTabsContainer.style.display = "none";
    return;
  }
  // Clear inline display:none so CSS grid rule can take effect on mobile
  mobileTabsContainer.style.display = "";
  mobileTabBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === mobileTab);
  });
  panelA.classList.toggle("mobile-hidden", mobileTab !== "a");
  panelB.classList.toggle("mobile-hidden", mobileTab !== "b");
}

// ===== Model display rendering =====
function renderModelDisplay() {
  const profileA = getProfile(modelA);
  const profileB = getProfile(modelB);

  // Sync native selects
  modelSelectNativeA.value = modelA;
  modelSelectNativeB.value = modelB;

  // Update model selector A (Original)
  if (profileA) {
    modelDotA.style.background = profileA.color;
    modelNameA.textContent = profileA.displayName;
  }

  // Update model selector B (Modified)
  if (profileB) {
    modelDotB.style.background = profileB.color;
    modelNameB.textContent = profileB.displayName;
  }

  if (compareMode) {
    // All-models row
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

  // Update token counts in panel footers
  const bA = bestTokenCount(textA, "a");
  const prefixA = bA.exact ? "" : "~";
  tokenCountA.textContent = prefixA + formatNumber(bA.count) + " tok";

  const bB = bestTokenCount(textB, "b");
  const prefixB = bB.exact ? "" : "~";
  tokenCountB.textContent = prefixB + formatNumber(bB.count) + " tok";

  // Update char counts
  charCountA.textContent = formatNumber(textA.length) + " chr";
  charCountB.textContent = formatNumber(textB.length) + " chr";
}

// ===== Dropdown =====
let dropdownOpen = false;
let activeDropdownEl = null;
let activeDropdownPanel = null; // "a" or "b"

function buildDropdownHtml(panel) {
  const currentModel = panel === "a" ? modelA : modelB;
  const text = panel === "a" ? textA : textB;
  const allCounts = countAllTokenizers(text);

  let html = "";
  for (const est of allCounts) {
    const isActive = currentModel === est.name;
    const statusIcon = est.status === "loading"
      ? '<span class="model-loading-spinner"></span>'
      : est.status === "error"
        ? '<span class="model-status-icon" title="Using estimate">~</span>'
        : "";
    const prefix = est.ready ? "" : "~";

    html += `<button class="model-option${isActive ? " active" : ""}" data-mode="${est.name}">
      <span class="dot" style="background:${est.color}"></span>
      <span>${est.label || est.displayName}</span>
      ${statusIcon}
      <span class="tokens">${prefix}${formatNumber(est.tokens)}</span>
    </button>`;
  }

  html += `<div class="dropdown-divider"></div>`;
  html += `<button class="dropdown-toggle" data-action="toggle-all">
    ${showAll ? "Show one model" : "Show all models"}
  </button>`;
  return html;
}

function openDropdown(dropdownEl, panel) {
  dropdownEl.innerHTML = buildDropdownHtml(panel);
  dropdownEl.style.display = "block";
  activeDropdownEl = dropdownEl;
  activeDropdownPanel = panel;
  dropdownOpen = true;

  dropdownEl.querySelectorAll("button[data-mode]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const newModel = btn.dataset.mode;
      if (panel === "a") {
        modelA = newModel;
        // In text compare mode, both panels use the same model
        if (compareMode && !modelCompareMode) {
          modelB = newModel;
        }
      } else {
        modelB = newModel;
      }
      ensureModelLoaded(newModel);
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

// ===== Diff summary =====
function renderDiffSummary() {
  const profileA = getProfile(modelA);
  const profileB = getProfile(modelB);
  if (!profileA) return;

  const bA = bestTokenCount(textA, "a");
  const tokA = bA.count;

  const isComparing = compareMode || modelCompareMode;

  if (!isComparing) {
    // Single-panel mode: show token count only
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
  const fmtA = (bA.exact ? "" : "~") + formatNumber(tokA);
  const fmtB = (bB.exact ? "" : "~") + formatNumber(tokB);

  if (modelCompareMode) {
    // MODEL COMPARE MODE: "Claude 17 → Gemini 15 (-2)" format
    let diffText = "";
    if (diff === 0) {
      diffText = "=";
    } else {
      const sign = diff > 0 ? "+" : "";
      diffText = `(${sign}${diffPrefix}${formatNumber(diff)})`;
    }

    diffHeroNumber.innerHTML = `
      <span class="hero-model-a" style="color: ${profileA.color}">${profileA.displayName} ${fmtA}</span>
      <span class="hero-arrow">→</span>
      <span class="hero-model-b" style="color: ${profileB.color}">${profileB.displayName} ${fmtB}</span>
      <span class="hero-diff ${cls}">${diffText}</span>
    `;
    diffHeroNumber.className = "diff-hero-number";
    diffHeroLabel.textContent = "";

    // Percentage detail
    let pctText = "";
    if (diff !== 0 && tokA > 0) {
      const pct = ((diff / tokA) * 100).toFixed(1);
      const pctSign = diff > 0 ? "+" : "";
      pctText = `${pctSign}${pct}% tokens`;
    }
    diffSummaryDetail.innerHTML = pctText ? `<span class="detail-pct">${pctText}</span>` : "";
    diffSummaryAll.style.display = "none";
    return;
  }

  // TEXT COMPARE MODE: Original/Modified format with all-models section
  if (diff === 0) {
    diffHeroNumber.textContent = "=";
  } else {
    const sign = diff > 0 ? "+" : "-";
    diffHeroNumber.textContent = sign + diffPrefix + formatNumber(Math.abs(diff));
  }
  diffHeroNumber.className = `diff-hero-number ${cls}`;
  diffHeroLabel.textContent = "tokens";

  // Percentage
  let pctText = "";
  if (diff !== 0 && tokA > 0) {
    const pct = ((diff / tokA) * 100).toFixed(1);
    const pctSign = diff > 0 ? "+" : "";
    pctText = ` (${pctSign}${pct}%)`;
  }

  diffSummaryDetail.innerHTML = `
    <span class="detail-a">Original: ${fmtA}</span>
    <span class="detail-b">Modified: ${fmtB}${pctText}</span>
  `;

  // All-models deltas - shows what the delta would be if using each model for BOTH texts
  if (showAll) {
    const allCounts = MODEL_PROFILES.map((p) => ({
      name: p.name,
      displayName: p.displayName,
      color: p.color,
      tokA: countTokens(textA, p.name),
      tokB: countTokens(textB, p.name),
    }));

    let html = '<div class="all-models-label">Same model for both texts:</div><div class="all-models-items">';
    for (const est of allCounts) {
      const { cls, val } = formatDelta(est.tokB - est.tokA);
      html += `<span class="delta-item">
        <span class="dot" style="background:${est.color}"></span>
        <span>${est.displayName}</span>
        <span class="delta-val ${cls}">${val}</span>
      </span>`;
    }
    html += '</div>';
    diffSummaryAll.innerHTML = html;
    diffSummaryAll.style.display = "flex";
  } else {
    diffSummaryAll.style.display = "none";
  }
}

// ===== Diff card =====
function renderDiffCard() {
  // Diff card is no longer used - always hide it
  diffCard.style.display = "none";
}

// ===== Token highlight =====
function renderTokenHighlight(container, text, panelModel) {
  if (!text || !text.trim()) {
    container.innerHTML = '<span class="tok-empty">Enter text to see token boundaries</span>';
    return;
  }

  const tokens = encodeTokens(text, panelModel);
  if (!tokens) {
    const profile = getProfile(panelModel);
    const name = profile ? profile.displayName : panelModel;
    container.innerHTML = `<span class="tok-empty">Loading ${name} tokenizer\u2026</span>`;
    return;
  }

  let html = "";
  for (let i = 0; i < tokens.length; i++) {
    const cls = `tok-${i % 6}`;
    // Split at line breaks so they aren't swallowed inside colored spans
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
    { highlight: highlightA, text: textA, key: "a", model: modelA, container: tokenHighlightA, textarea: textareaA, btn: tokenViewBtnA },
    { highlight: highlightB, text: textB, key: "b", model: modelB, container: tokenHighlightB, textarea: textareaB, btn: tokenViewBtnB },
  ];
  for (const p of panels) {
    if (p.highlight && p.text.trim()) {
      p.container.style.display = "block";
      debouncedRenderHighlight(p.container, p.text, p.key, p.model);
    } else {
      p.textarea.classList.remove("token-overlay-active");
      p.container.style.display = "none";
    }
    p.btn.classList.toggle("active", p.highlight);
    p.btn.disabled = !p.text.trim();
  }
}

// ===== Main render =====
function render() {
  updateLayout();
  renderModelDisplay();
  renderDiffSummary();
  renderDiffCard();
  updateTokenHighlights();
}

// ===== Compare mode =====
function enterCompareMode() {
  compareMode = true;
  modelCompareMode = false;
  mobileTab = "b";
  if (!textB) {
    textB = textA;
    textareaB.value = textB;
  }
  render();
  textareaB.focus();
}

function enterModelCompareMode() {
  modelCompareMode = true;
  compareMode = false;
  mobileTab = "b";
  // In model compare mode, both panels show the same text
  textB = textA;
  textareaB.value = textA;
  // Default to different models for meaningful comparison
  if (modelA === modelB) {
    modelB = modelA === "openai" ? "claude" : "openai";
    savePrefs();
  }
  render();
}

function exitCompareMode() {
  compareMode = false;
  modelCompareMode = false;
  mobileTab = "a";
  render();
}

// ===== Paste-prefill =====
let pasteIntoA = false;

textareaA.addEventListener("paste", () => {
  const isComparing = compareMode || modelCompareMode;
  if (!textB && !isComparing) pasteIntoA = true;
});

// ===== Event handlers =====
textareaA.addEventListener("input", () => {
  textA = textareaA.value;
  // In model compare mode, always sync textB with textA
  if (modelCompareMode) {
    textB = textA;
    textareaB.value = textA;
  } else if (pasteIntoA) {
    pasteIntoA = false;
    if (compareMode) {
      textB = textA;
      textareaB.value = textB;
    }
  }
  render();
});

textareaB.addEventListener("input", () => {
  // Ignore input in model compare mode (textarea is readonly)
  if (modelCompareMode) return;
  textB = textareaB.value;
  render();
});

// Model selector clicks
modelSelectorA.addEventListener("click", (e) => {
  e.stopPropagation();
  if (dropdownOpen && activeDropdownPanel === "a") {
    closeDropdown();
  } else {
    closeDropdown();
    openDropdown(modelDropdownA, "a");
  }
});

modelSelectorB.addEventListener("click", (e) => {
  e.stopPropagation();
  if (dropdownOpen && activeDropdownPanel === "b") {
    closeDropdown();
  } else {
    closeDropdown();
    openDropdown(modelDropdownB, "b");
  }
});

// Close dropdown on outside click
document.addEventListener("click", () => {
  if (dropdownOpen) closeDropdown();
});

// Compare toggle
compareBtn.addEventListener("click", () => {
  enterCompareMode();
});

compareModelsBtn.addEventListener("click", () => {
  enterModelCompareMode();
});

// Close panel B
closePanelB.addEventListener("click", () => {
  exitCompareMode();
});

// Mobile tabs
mobileTabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    mobileTab = btn.dataset.tab;
    render();
  });
});

// Token view toggles
tokenViewBtnA.addEventListener("click", () => {
  highlightA = !highlightA;
  if (highlightA) ensureModelLoaded(modelA);
  render();
});

tokenViewBtnB.addEventListener("click", () => {
  highlightB = !highlightB;
  if (highlightB) ensureModelLoaded(modelB);
  render();
});

// Scroll sync: keep highlight div in sync with textarea scroll position
textareaA.addEventListener("scroll", () => {
  tokenHighlightA.scrollTop = textareaA.scrollTop;
  tokenHighlightA.scrollLeft = textareaA.scrollLeft;
});
textareaB.addEventListener("scroll", () => {
  tokenHighlightB.scrollTop = textareaB.scrollTop;
  tokenHighlightB.scrollLeft = textareaB.scrollLeft;
});

// Native model select (mobile)
function populateNativeSelects() {
  for (const select of [modelSelectNativeA, modelSelectNativeB]) {
    select.innerHTML = "";
    for (const p of MODEL_PROFILES) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.displayName;
      select.appendChild(opt);
    }
  }
  modelSelectNativeA.value = modelA;
  modelSelectNativeB.value = modelB;
}
populateNativeSelects();

modelSelectNativeA.addEventListener("change", (e) => {
  modelA = e.target.value;
  // In text compare mode, both panels use the same model
  if (compareMode && !modelCompareMode) {
    modelB = modelA;
  }
  ensureModelLoaded(modelA);
  savePrefs();
  render();
});

modelSelectNativeB.addEventListener("change", (e) => {
  modelB = e.target.value;
  ensureModelLoaded(modelB);
  savePrefs();
  render();
});

// Share
shareBtn.addEventListener("click", () => {
  if (!textA && !textB) return;
  let highlight = "";
  if (highlightA) highlight += "a";
  if (highlightB) highlight += "b";
  const tokens = { a: countTokens(textA, modelA), b: countTokens(textB, modelB) };
  const encoded = encodePayload(textA, textB, { modelA, modelB, highlight: highlight || undefined, tokens });
  const url = `${window.location.origin}${window.location.pathname}?d=${encoded}`;

  if (url.length > 8000) {
    showToast("Text too long to share via URL");
    return;
  }

  window.history.replaceState(null, "", `?d=${encoded}`);
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

// ===== Load from URL =====
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
    // Restore models if shared (support both new mA/mB and old m format)
    if (decoded.mA && MODEL_PROFILES.find((p) => p.name === decoded.mA)) {
      modelA = decoded.mA;
    } else if (decoded.m && MODEL_PROFILES.find((p) => p.name === decoded.m)) {
      modelA = decoded.m;
    }
    if (decoded.mB && MODEL_PROFILES.find((p) => p.name === decoded.mB)) {
      modelB = decoded.mB;
    } else if (decoded.m && MODEL_PROFILES.find((p) => p.name === decoded.m)) {
      modelB = decoded.m;
    }
    savePrefs();
    // Restore pre-computed token counts
    if (decoded.t && typeof decoded.t.a === "number" && typeof decoded.t.b === "number") {
      preTokens = { a: decoded.t.a, b: decoded.t.b, modelA: modelA, modelB: modelB };
    }
    // Restore token view state
    if (decoded.h) {
      highlightA = decoded.h.includes("a");
      highlightB = decoded.h.includes("b");
    }
    // Enter compare mode if both texts exist and differ
    if (textA && textB) {
      compareMode = true;
    }
  }
}

// ===== Init =====
loadFromURL();
// Sync with browser-restored textarea values (browsers cache form values on reload)
if (!textA && textareaA.value) {
  textA = textareaA.value;
}
if (!textB && textareaB.value) {
  textB = textareaB.value;
}
ensureModelLoaded(modelA);
ensureModelLoaded(modelB);
if (showAll) {
  for (const p of MODEL_PROFILES) ensureModelLoaded(p.name);
}
render();
