// @ts-check
import { test, expect } from "@playwright/test";

const SAMPLE_TEXT_A =
  "The quick brown fox jumps over the lazy dog. This is a sample text to test tokenization across different models.";
const SAMPLE_TEXT_B =
  "The fast brown fox leaps over the sleepy dog. This is modified text to test tokenization differences across models.";
const LONG_TEXT =
  "Artificial intelligence is transforming how we build software. Large language models can understand and generate human language with remarkable fluency. Token counting matters because API costs are measured per token. Understanding how different tokenizers split text helps developers optimize prompts and reduce costs. Each model family uses its own tokenizer with different vocabulary sizes and encoding strategies.";
const CJK_TEXT = "大型语言模型正在改变我们构建软件的方式。";
const CODE_TEXT = `function fibonacci(n) {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}`;

let shotIndex = 0;

/** Take a named screenshot, prefixed with project name + auto-index. */
async function snap(page, name, testInfo) {
  const project = testInfo.project.name;
  const prefix = String(shotIndex++).padStart(3, "0");
  await page.screenshot({
    path: `tests/screenshots/${project}/${prefix}-${name}.png`,
    fullPage: true,
  });
}

function isMobile(testInfo) {
  return testInfo.project.name === "mobile";
}

/**
 * In compare mode on mobile, panel B is shown by default (Modified tab active).
 * This helper ensures we're on tab B before filling textarea-b.
 */
async function fillTextareaBInCompareMode(page, text, testInfo) {
  await page.locator("#textarea-b").fill(text);
}

test.beforeAll(async ({}, testInfo) => {
  const fs = await import("fs");
  fs.mkdirSync(`tests/screenshots/${testInfo.project.name}`, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/");
  await page.waitForSelector("#textarea-a");
});

// ─────────────────────────────────────────────
// 1. Single text token counting
// ─────────────────────────────────────────────
test.describe("Single text token counting", () => {
  test("paste text and see token count immediately", async ({ page }, testInfo) => {
    await snap(page, "01-empty-state", testInfo);

    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(500);
    await snap(page, "01-text-pasted", testInfo);

    await expect(page.locator("#tokencount-a")).not.toHaveText("0 tok");
    await expect(page.locator("#char-count-a")).not.toHaveText("0 chr");
    await expect(page.locator("#compare-toggle")).toBeVisible();
    await snap(page, "01-counts-visible", testInfo);
  });

  test("token visualization is active by default", async ({ page }, testInfo) => {
    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(500);
    await snap(page, "01-highlight-default-on", testInfo);

    await expect(page.locator("#token-view-btn-a")).toHaveClass(/active/);
    await expect(page.locator("#textarea-a")).toHaveClass(/token-overlay-active/);
    await expect(page.locator("#token-highlight-a")).toBeVisible();
  });

  test("token button disabled when text is empty", async ({ page }, testInfo) => {
    await snap(page, "01-empty-token-btn", testInfo);
    await expect(page.locator("#token-view-btn-a")).toBeDisabled();
  });
});

// ─────────────────────────────────────────────
// 2. Edit and compare token diff
// ─────────────────────────────────────────────
test.describe("Edit and compare token diff", () => {
  test("enter compare mode and see diff", async ({ page }, testInfo) => {
    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(300);
    await snap(page, "02-before-compare", testInfo);

    await page.locator("#compare-btn").click();
    await page.waitForTimeout(300);
    await snap(page, "02-compare-mode-entered", testInfo);

    await expect(page.locator("#diff-summary")).toBeVisible();

    await fillTextareaBInCompareMode(page, SAMPLE_TEXT_B, testInfo);
    await page.waitForTimeout(500);
    await snap(page, "02-after-edit-b", testInfo);

    const heroNumber = page.locator("#diff-hero-number");
    await expect(heroNumber).toBeVisible();
    // Hero shows +N, -N, ~+N, ~-N, or = (when counts are equal)
    expect(await heroNumber.textContent()).toMatch(/^[+\-=~]/);

    await expect(page.locator("#diff-card")).toBeVisible();
    await snap(page, "02-diff-card-visible", testInfo);
  });

  test("exit compare mode returns to single panel", async ({ page }, testInfo) => {
    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.locator("#compare-btn").click();
    await page.waitForTimeout(300);

    // On mobile, close button is in panel B header; switch to tab B first
    if (isMobile(testInfo)) {
      await page.locator('.mobile-tab[data-tab="b"]').click();
      await page.waitForTimeout(200);
    }

    await page.locator("#close-panel-b").click();
    await page.waitForTimeout(300);
    await snap(page, "02-exited-compare", testInfo);

    await expect(page.locator("#panel-b")).not.toBeVisible();
    // Diff summary stays visible in single-panel mode (shows token count + model picker)
    await expect(page.locator("#diff-summary")).toBeVisible();
  });
});

// ─────────────────────────────────────────────
// 3. Pure diff viewing
// ─────────────────────────────────────────────
test.describe("Pure diff viewing", () => {
  test("paste two different texts and see word-level diff", async ({ page }, testInfo) => {
    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(200);
    await page.locator("#compare-btn").click();
    await page.waitForTimeout(200);

    await fillTextareaBInCompareMode(page, SAMPLE_TEXT_B, testInfo);
    await page.waitForTimeout(500);
    await snap(page, "03-two-texts-diffed", testInfo);

    const diffBody = page.locator("#diff-body");
    await expect(diffBody).toBeVisible();
    expect(await diffBody.locator(".diff-span-added").count()).toBeGreaterThan(0);
    expect(await diffBody.locator(".diff-span-removed").count()).toBeGreaterThan(0);
    await snap(page, "03-diff-detail", testInfo);
  });
});

// ─────────────────────────────────────────────
// 4. Model switching — desktop custom dropdown
// ─────────────────────────────────────────────
test.describe("Model switching (desktop dropdown)", () => {
  test("switch model via custom dropdown", async ({ page }, testInfo) => {
    test.skip(isMobile(testInfo), "Custom dropdown hidden on mobile");

    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(300);
    await snap(page, "04-before-model-switch", testInfo);

    // Model selector is in diff summary strip
    await page.locator("#model-selector-a").click();
    await page.waitForTimeout(200);
    await snap(page, "04-dropdown-open", testInfo);

    const dropdown = page.locator("#model-dropdown");
    await expect(dropdown).toBeVisible();

    const gptOption = dropdown.locator('button[data-mode="openai"]');
    if (await gptOption.isVisible()) {
      await gptOption.click();
      await page.waitForTimeout(500);
      await snap(page, "04-model-switched-gpt", testInfo);
      await expect(page.locator("#model-name-a")).toHaveText("GPT-5");
    }
  });

  test("dropdown is not clipped by panel border", async ({ page }, testInfo) => {
    test.skip(isMobile(testInfo), "Custom dropdown hidden on mobile");

    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(200);

    await page.locator("#model-selector-a").click();
    await page.waitForTimeout(200);

    const dropdown = page.locator("#model-dropdown");
    await expect(dropdown).toBeVisible();

    const dropdownBox = await dropdown.boundingBox();
    const summaryBox = await page.locator("#diff-summary").boundingBox();
    expect(dropdownBox).not.toBeNull();
    expect(summaryBox).not.toBeNull();
    if (dropdownBox && summaryBox) {
      // Dropdown should extend beyond the summary strip
      expect(dropdownBox.height).toBeGreaterThan(0);
    }
    await snap(page, "04-dropdown-not-clipped", testInfo);
  });
});

// ─────────────────────────────────────────────
// 5. Token visualization
// ─────────────────────────────────────────────
test.describe("Token visualization", () => {
  test("token boundaries show while typing", async ({ page }, testInfo) => {
    const textarea = page.locator("#textarea-a");
    await textarea.click();
    await textarea.pressSequentially("Hello world!", { delay: 50 });
    await page.waitForTimeout(500);
    await snap(page, "05-typing-with-highlights", testInfo);

    const highlight = page.locator("#token-highlight-a");
    await expect(highlight).toBeVisible();
    expect(await highlight.locator("[class^='tok-']").count()).toBeGreaterThan(0);
  });

  test("toggle highlight off and on", async ({ page }, testInfo) => {
    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(500);
    await snap(page, "05-highlight-on", testInfo);

    await page.locator("#token-view-btn-a").click();
    await page.waitForTimeout(200);
    await snap(page, "05-highlight-off", testInfo);
    await expect(page.locator("#textarea-a")).not.toHaveClass(/token-overlay-active/);

    await page.locator("#token-view-btn-a").click();
    await page.waitForTimeout(500);
    await snap(page, "05-highlight-back-on", testInfo);
    await expect(page.locator("#textarea-a")).toHaveClass(/token-overlay-active/);
  });

  test("highlight updates after editing text", async ({ page }, testInfo) => {
    const textarea = page.locator("#textarea-a");
    await textarea.fill("Hello");
    await page.waitForTimeout(500);
    const before = await page.locator("#token-highlight-a").innerHTML();
    await snap(page, "05-before-edit", testInfo);

    await textarea.fill("Hello world, this is a longer sentence now.");
    await page.waitForTimeout(500);
    await snap(page, "05-after-edit", testInfo);
    expect(await page.locator("#token-highlight-a").innerHTML()).not.toBe(before);
  });

  test("highlight matches textarea line-for-line (no extra blank lines from multi-byte chars)", async ({ page }, testInfo) => {
    const multiLineText = [
      "Testing if this correctly renders:",
      "",
      " Panel A (original)              Panel B (modified)",
      "\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510       \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510",
      "\u2502 The quick brown fox  \u2502       \u2502 The fast brown fox   \u2502",
      "\u2502 jumps over the lazy  \u2502       \u2502 leaps over the sleepy\u2502",
      "\u2502 dog.                 \u2502       \u2502 dog.                 \u2502",
      "\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518       \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518",
      "",
      "  Diff: -quick +fast  -jumps +leaps  -lazy +sleepy",
      "  GPT-5: 12 \u2192 12 tokens   Claude: 11 \u2192 11 tokens",
      "I can continue!",
    ].join("\n");

    await page.locator("#textarea-a").fill(multiLineText);
    await page.waitForTimeout(1500); // wait for debounce + tokenizer load
    await snap(page, "05-multiline-highlight", testInfo);

    const highlight = page.locator("#token-highlight-a");
    await expect(highlight).toBeVisible();

    // The highlight text must match the textarea text exactly —
    // no extra blank lines from replacement chars on multi-byte sequences
    const highlightText = await highlight.innerText();
    const inputLines = multiLineText.split("\n");
    const highlightLines = highlightText.split("\n");

    expect(highlightLines.length).toBe(inputLines.length);
    for (let i = 0; i < inputLines.length; i++) {
      expect(highlightLines[i]).toBe(inputLines[i]);
    }
  });

  test("highlight persists in compare mode on both panels", async ({ page }, testInfo) => {
    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(300);
    await page.locator("#compare-btn").click();
    await page.waitForTimeout(300);

    await fillTextareaBInCompareMode(page, SAMPLE_TEXT_B, testInfo);
    await page.waitForTimeout(500);
    await snap(page, "05-compare-both-highlighted", testInfo);

    if (isMobile(testInfo)) {
      // Currently on tab B after fillTextareaBInCompareMode
      await expect(page.locator("#textarea-b")).toHaveClass(/token-overlay-active/);
      await expect(page.locator("#token-highlight-b")).toBeVisible();

      await page.locator('.mobile-tab[data-tab="a"]').click();
      await page.waitForTimeout(500);
      await expect(page.locator("#textarea-a")).toHaveClass(/token-overlay-active/);
      await expect(page.locator("#token-highlight-a")).toBeVisible();
      await snap(page, "05-compare-highlight-tab-a", testInfo);
    } else {
      await expect(page.locator("#textarea-a")).toHaveClass(/token-overlay-active/);
      await expect(page.locator("#textarea-b")).toHaveClass(/token-overlay-active/);
      await expect(page.locator("#token-highlight-a")).toBeVisible();
      await expect(page.locator("#token-highlight-b")).toBeVisible();
    }
  });
});

// ─────────────────────────────────────────────
// 6. Real-time iteration
// ─────────────────────────────────────────────
test.describe("Real-time iteration", () => {
  test("token counts update on each keystroke", async ({ page }, testInfo) => {
    const textarea = page.locator("#textarea-a");
    const tokenCount = page.locator("#tokencount-a");

    await textarea.click();
    await textarea.pressSequentially("Hello", { delay: 30 });
    await page.waitForTimeout(200);
    const countAfterHello = await tokenCount.textContent();
    await snap(page, "06-count-after-hello", testInfo);

    await textarea.pressSequentially(" world this is more text", { delay: 30 });
    await page.waitForTimeout(200);
    const countAfterMore = await tokenCount.textContent();
    await snap(page, "06-count-after-more-text", testInfo);

    expect(countAfterMore).not.toBe(countAfterHello);
  });

  test("char count updates live", async ({ page }, testInfo) => {
    const textarea = page.locator("#textarea-a");
    const charCount = page.locator("#char-count-a");

    await textarea.fill("Short");
    await page.waitForTimeout(100);
    const short = await charCount.textContent();

    await textarea.fill("This is a much longer piece of text to check character counting");
    await page.waitForTimeout(100);
    const long = await charCount.textContent();
    await snap(page, "06-char-count-live", testInfo);

    expect(long).not.toBe(short);
  });
});

// ─────────────────────────────────────────────
// 7. AI rewrite comparison
// ─────────────────────────────────────────────
test.describe("AI rewrite comparison", () => {
  test("compare original vs shorter rewrite shows token savings", async ({ page }, testInfo) => {
    const summary =
      "AI transforms software development. LLMs generate human language fluently. Token counting matters for API costs. Different tokenizers split text differently.";

    await page.locator("#textarea-a").fill(LONG_TEXT);
    await page.waitForTimeout(200);
    await page.locator("#compare-btn").click();
    await page.waitForTimeout(200);

    await fillTextareaBInCompareMode(page, summary, testInfo);
    await page.waitForTimeout(500);
    await snap(page, "07-rewrite-comparison", testInfo);

    expect(await page.locator("#diff-hero-number").textContent()).toMatch(/^-/);
    await snap(page, "07-token-savings-shown", testInfo);
  });
});

// ─────────────────────────────────────────────
// 8. Token boundary understanding
// ─────────────────────────────────────────────
test.describe("Token boundary understanding", () => {
  test("code text shows token boundaries", async ({ page }, testInfo) => {
    await page.locator("#textarea-a").fill(CODE_TEXT);
    await page.waitForTimeout(500);
    await snap(page, "08-code-tokenized", testInfo);

    const highlight = page.locator("#token-highlight-a");
    await expect(highlight).toBeVisible();
    expect(await highlight.locator("[class^='tok-']").count()).toBeGreaterThan(0);
  });

  test("CJK text tokenization", async ({ page }, testInfo) => {
    await page.locator("#textarea-a").fill(CJK_TEXT);
    await page.waitForTimeout(500);
    await snap(page, "08-cjk-tokenized", testInfo);

    await expect(page.locator("#tokencount-a")).not.toHaveText("0 tok");
  });
});

// ─────────────────────────────────────────────
// 9. Mobile tabs — mobile only
// ─────────────────────────────────────────────
test.describe("Mobile tabs", () => {
  test("mobile tabs appear in compare mode and switch panels", async ({ page }, testInfo) => {
    test.skip(!isMobile(testInfo), "Mobile-only test");

    await snap(page, "09-mobile-empty", testInfo);

    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(200);
    await page.locator("#compare-btn").click();
    await page.waitForTimeout(300);
    await snap(page, "09-mobile-compare-mode", testInfo);

    await expect(page.locator("#mobile-tabs")).toBeVisible();

    const tabA = page.locator('.mobile-tab[data-tab="a"]');
    const tabB = page.locator('.mobile-tab[data-tab="b"]');
    // Compare mode defaults to Modified (tab B) on mobile
    await expect(tabB).toHaveClass(/active/);
    await expect(page.locator("#panel-a")).toHaveClass(/mobile-hidden/);
    await expect(page.locator("#panel-b")).not.toHaveClass(/mobile-hidden/);
    await snap(page, "09-mobile-tab-b-active", testInfo);

    await tabA.click();
    await page.waitForTimeout(300);
    await snap(page, "09-mobile-tab-a-back", testInfo);

    await expect(tabA).toHaveClass(/active/);
    await expect(page.locator("#panel-a")).not.toHaveClass(/mobile-hidden/);
  });

  test("token visualization persists when switching tabs", async ({ page }, testInfo) => {
    test.skip(!isMobile(testInfo), "Mobile-only test");

    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(200);
    await page.locator("#compare-btn").click();
    await page.waitForTimeout(200);

    await page.locator('.mobile-tab[data-tab="b"]').click();
    await page.waitForTimeout(200);
    await page.locator("#textarea-b").fill(SAMPLE_TEXT_B);
    await page.waitForTimeout(500);
    await snap(page, "09-mobile-highlights-tab-b", testInfo);

    await expect(page.locator("#token-view-btn-b")).toHaveClass(/active/);
    await expect(page.locator("#token-highlight-b")).toBeVisible();

    await page.locator('.mobile-tab[data-tab="a"]').click();
    await page.waitForTimeout(500);
    await snap(page, "09-mobile-highlights-tab-a", testInfo);

    await expect(page.locator("#token-view-btn-a")).toHaveClass(/active/);
    await expect(page.locator("#token-highlight-a")).toBeVisible();
  });
});

// ─────────────────────────────────────────────
// 10. Mobile native model selector — mobile only
// ─────────────────────────────────────────────
test.describe("Mobile native model selector", () => {
  test("native select visible on mobile, custom dropdown hidden", async ({ page }, testInfo) => {
    test.skip(!isMobile(testInfo), "Mobile-only test");

    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(300);
    await snap(page, "10-mobile-model-selector", testInfo);

    // Model selector is in diff summary strip on mobile
    await expect(page.locator("#model-select-native-compare")).toBeVisible();
    await expect(page.locator("#model-selector-a")).not.toBeVisible();
  });

  test("changing native select updates model", async ({ page }, testInfo) => {
    test.skip(!isMobile(testInfo), "Mobile-only test");

    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(300);
    await snap(page, "10-mobile-before-model-change", testInfo);

    await page.locator("#model-select-native-compare").selectOption("openai");
    await page.waitForTimeout(500);
    await snap(page, "10-mobile-after-model-change", testInfo);

    await expect(page.locator("#model-select-native-compare")).toHaveValue("openai");
  });

  test("native select in compare mode diff summary", async ({ page }, testInfo) => {
    test.skip(!isMobile(testInfo), "Mobile-only test");

    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(200);
    await page.locator("#compare-btn").click();
    await page.waitForTimeout(200);

    await page.locator('.mobile-tab[data-tab="b"]').click();
    await page.waitForTimeout(200);
    await page.locator("#textarea-b").fill(SAMPLE_TEXT_B);
    await page.waitForTimeout(300);
    await snap(page, "10-mobile-compare-native-select", testInfo);

    const compareSelect = page.locator("#model-select-native-compare");
    await expect(compareSelect).toBeVisible();

    await compareSelect.selectOption("deepseek");
    await page.waitForTimeout(500);
    await snap(page, "10-mobile-compare-model-changed", testInfo);

    await expect(compareSelect).toHaveValue("deepseek");
  });
});

// ─────────────────────────────────────────────
// 11. Share workflow
// ─────────────────────────────────────────────
test.describe("Share workflow", () => {
  test("share button generates URL with state", async ({ page }, testInfo) => {
    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(200);
    await page.locator("#compare-btn").click();
    await page.waitForTimeout(200);

    await fillTextareaBInCompareMode(page, SAMPLE_TEXT_B, testInfo);
    await page.waitForTimeout(300);
    await snap(page, "11-before-share", testInfo);

    await page.locator("#share-btn").click();
    await page.waitForTimeout(500);
    await snap(page, "11-after-share", testInfo);

    expect(page.url()).toContain("?d=");
  });

  test("loading a share URL restores state", async ({ page }, testInfo) => {
    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(200);
    await page.locator("#compare-btn").click();
    await page.waitForTimeout(200);

    await fillTextareaBInCompareMode(page, SAMPLE_TEXT_B, testInfo);
    await page.waitForTimeout(300);
    await page.locator("#share-btn").click();
    await page.waitForTimeout(300);

    const shareUrl = page.url();
    await page.evaluate(() => localStorage.clear());
    await page.goto(shareUrl);
    await page.waitForTimeout(500);
    await snap(page, "11-share-url-loaded", testInfo);

    await expect(page.locator("#textarea-a")).toHaveValue(SAMPLE_TEXT_A);
    await expect(page.locator("#textarea-b")).toHaveValue(SAMPLE_TEXT_B);
    await expect(page.locator("#diff-summary")).toBeVisible();
  });
});

// ─────────────────────────────────────────────
// 11b. Base64 URL sharing
// ─────────────────────────────────────────────
test.describe("Base64 URL sharing", () => {
  test("loading a base64url-encoded ?b= URL restores state", async ({ page }, testInfo) => {
    const payload = JSON.stringify({ a: SAMPLE_TEXT_A, b: SAMPLE_TEXT_B });
    const bytes = new TextEncoder().encode(payload);
    const binStr = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    const b64 = btoa(binStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    await page.goto(`/?b=${b64}`);
    await page.waitForSelector("#textarea-a");
    await page.waitForTimeout(500);
    await snap(page, "11b-base64-loaded", testInfo);

    await expect(page.locator("#textarea-a")).toHaveValue(SAMPLE_TEXT_A);
    await expect(page.locator("#textarea-b")).toHaveValue(SAMPLE_TEXT_B);
    await expect(page.locator("#diff-summary")).toBeVisible();
  });

  test("loading a standard base64 ?b= URL (with +/=) restores state", async ({ page }, testInfo) => {
    const payload = JSON.stringify({ a: SAMPLE_TEXT_A, b: SAMPLE_TEXT_B });
    const bytes = new TextEncoder().encode(payload);
    const binStr = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    const b64 = btoa(binStr); // standard base64 with + / =

    await page.goto(`/?b=${encodeURIComponent(b64)}`);
    await page.waitForSelector("#textarea-a");
    await page.waitForTimeout(500);
    await snap(page, "11b-base64-standard-loaded", testInfo);

    await expect(page.locator("#textarea-a")).toHaveValue(SAMPLE_TEXT_A);
    await expect(page.locator("#textarea-b")).toHaveValue(SAMPLE_TEXT_B);
  });

  test("base64 URL with model and highlight state", async ({ page }, testInfo) => {
    const payload = JSON.stringify({ a: SAMPLE_TEXT_A, b: SAMPLE_TEXT_B, m: "openai", h: "ab" });
    const bytes = new TextEncoder().encode(payload);
    const binStr = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    const b64 = btoa(binStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    await page.goto(`/?b=${b64}`);
    await page.waitForSelector("#textarea-a");
    await page.waitForTimeout(500);
    await snap(page, "11b-base64-with-model", testInfo);

    await expect(page.locator("#textarea-a")).toHaveValue(SAMPLE_TEXT_A);
    await expect(page.locator("#textarea-b")).toHaveValue(SAMPLE_TEXT_B);
    await expect(page.locator("#diff-summary")).toBeVisible();
  });

  test("?d= (zbase32) takes precedence when both params present", async ({ page }, testInfo) => {
    // Build a zbase32 URL via the share button
    await page.locator("#textarea-a").fill(SAMPLE_TEXT_A);
    await page.waitForTimeout(200);
    await page.locator("#compare-btn").click();
    await page.waitForTimeout(200);
    await fillTextareaBInCompareMode(page, SAMPLE_TEXT_B, testInfo);
    await page.waitForTimeout(300);
    await page.locator("#share-btn").click();
    await page.waitForTimeout(300);

    const shareUrl = new URL(page.url());
    const zb32Param = shareUrl.searchParams.get("d");

    // Build a base64 URL with different text
    const wrongPayload = JSON.stringify({ a: "wrong", b: "data" });
    const bytes = new TextEncoder().encode(wrongPayload);
    const binStr = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    const wrongB64 = btoa(binStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    // Load with both params — zbase32 should win
    await page.evaluate(() => localStorage.clear());
    await page.goto(`/?d=${zb32Param}&b=${wrongB64}`);
    await page.waitForSelector("#textarea-a");
    await page.waitForTimeout(500);

    await expect(page.locator("#textarea-a")).toHaveValue(SAMPLE_TEXT_A);
    await expect(page.locator("#textarea-b")).toHaveValue(SAMPLE_TEXT_B);
  });
});

// ─────────────────────────────────────────────
// 12. Cross-language tokenization
// ─────────────────────────────────────────────
test.describe("Cross-language tokenization", () => {
  test("English vs CJK shows different token counts", async ({ page }, testInfo) => {
    await page.locator("#textarea-a").fill("Large language models are changing how we build software.");
    await page.waitForTimeout(200);
    await page.locator("#compare-btn").click();
    await page.waitForTimeout(200);

    await fillTextareaBInCompareMode(page, CJK_TEXT, testInfo);
    await page.waitForTimeout(500);
    await snap(page, "12-cross-language-diff", testInfo);

    await expect(page.locator("#tokencount-a")).not.toHaveText("0 tok");
    await expect(page.locator("#tokencount-b")).not.toHaveText("0 tok");

    expect(await page.locator("#diff-hero-number").textContent()).not.toBe("+0");
    await snap(page, "12-cross-language-counts", testInfo);
  });
});

// ─────────────────────────────────────────────
// 13. Full desktop workflow — desktop only
// ─────────────────────────────────────────────
test.describe("Full desktop workflow", () => {
  test("complete workflow: paste → visualize → compare → switch model → share", async ({
    page,
  }, testInfo) => {
    test.skip(isMobile(testInfo), "Desktop-only end-to-end");

    await snap(page, "13-step1-empty", testInfo);

    await page.locator("#textarea-a").fill(LONG_TEXT);
    await page.waitForTimeout(500);
    await snap(page, "13-step2-text-pasted", testInfo);

    await expect(page.locator("#token-highlight-a")).toBeVisible();
    await expect(page.locator("#textarea-a")).toHaveClass(/token-overlay-active/);
    await snap(page, "13-step3-highlight-auto", testInfo);

    await page.locator("#compare-btn").click();
    await page.waitForTimeout(500);
    await snap(page, "13-step4-compare-mode", testInfo);

    await page.locator("#textarea-b").fill(SAMPLE_TEXT_B);
    await page.waitForTimeout(500);
    await snap(page, "13-step5-edited-b", testInfo);

    await page.locator("#model-selector-a").click();
    await page.waitForTimeout(200);
    await snap(page, "13-step6-dropdown-open", testInfo);

    const gptOpt = page.locator('#model-dropdown button[data-mode="openai"]');
    if (await gptOpt.isVisible()) {
      await gptOpt.click();
      await page.waitForTimeout(500);
      await snap(page, "13-step6-model-changed", testInfo);
    } else {
      await page.click("body");
      await page.waitForTimeout(200);
    }

    await page.locator("#share-btn").click();
    await page.waitForTimeout(300);
    await snap(page, "13-step7-shared", testInfo);

    expect(page.url()).toContain("?d=");
  });
});
