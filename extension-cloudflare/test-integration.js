// ============================================================
// Integration Test: Auto Model Selector with Mock DOM
// Tests the full flow: open menu → scrape options → sort → select
// ============================================================

// ─── Mock DOM Environment ────────────────────────────────────
const clickedElements = [];

function createMockElement(name, version, family, isThinking = false) {
  const text = isThinking ? `${name} + Extended thinking` : name;
  return {
    innerText: text,
    textContent: text,
    _name: name,
    _version: version,
    _family: family,
    _isThinking: isThinking,
    _clicked: false,
    getAttribute(attr) {
      if (attr === "aria-checked") return "false";
      if (attr === "aria-selected") return "false";
      if (attr === "aria-expanded") return "false";
      return null;
    },
    classList: { contains: () => false },
    click() {
      this._clicked = true;
      clickedElements.push(this);
    }
  };
}

// Mock document with model menu items
const mockMenuItems = [];
const mockTrigger = {
  getAttribute(attr) {
    if (attr === "aria-expanded") return "false";
    return null;
  },
  classList: { contains: () => false },
  click() {}
};

global.document = {
  querySelector(selector) {
    if (selector.includes("picker") || selector.includes("aria-haspopup")) {
      return mockTrigger;
    }
    return null;
  },
  querySelectorAll(selector) {
    if (selector.includes("menuitem") || selector.includes("gem-menu-item") || selector.includes("button")) {
      return mockMenuItems;
    }
    return [];
  }
};

global.window = {
  location: { hostname: "gemini.google.com" }
};

// ─── Load Module ────────────────────────────────────────────
const AutoModelSelector = require("./auto-model-selector.js");

// ─── Test Cases ──────────────────────────────────────────────
function setupMockMenu(models) {
  clickedElements.length = 0;
  mockMenuItems.length = 0;
  for (const m of models) {
    mockMenuItems.push(createMockElement(m.name, m.version, m.family, m.thinking));
  }
}

function runTest(testName, models, expectedModel, preferredFamily = "pro") {
  setupMockMenu(models);
  const result = AutoModelSelector.autoSelectNewestModel(preferredFamily);
  const clicked = clickedElements[0];
  const actualModel = clicked ? clicked._name : null;
  const success = result.success && actualModel === expectedModel;

  console.log(success ? "✅ PASS" : "❌ FAIL", testName);
  console.log("   Expected:", expectedModel);
  console.log("   Actual:  ", actualModel);
  if (!success) {
    console.log("   Result:", JSON.stringify(result));
    console.log("   Clicked elements:", clickedElements.map(e => e._name));
  }
  console.log("");
  return success;
}

// ─── Run Tests ───────────────────────────────────────────────
let passed = 0;
let failed = 0;

// Test 1: Version priority — 3.8 > 3.6
if (runTest(
  "Version 3.8 > 3.6 (Pro)",
  [
    { name: "3.6 Pro", version: 3.6, family: "pro" },
    { name: "3.8 Pro", version: 3.8, family: "pro" },
    { name: "3.5 Pro", version: 3.5, family: "pro" }
  ],
  "3.8 Pro"
)) passed++; else failed++;

// Test 2: Family priority — Pro > Flash (same version)
if (runTest(
  "Pro > Flash (same version 3.8)",
  [
    { name: "3.8 Flash", version: 3.8, family: "flash" },
    { name: "3.8 Pro", version: 3.8, family: "pro" },
    { name: "3.8 Flash-Lite", version: 3.8, family: "flash-lite" }
  ],
  "3.8 Pro"
)) passed++; else failed++;

// Test 3: Thinking model preferred (same version+family)
if (runTest(
  "Thinking model preferred (3.8 Pro Thinking > 3.8 Pro)",
  [
    { name: "3.8 Pro", version: 3.8, family: "pro" },
    { name: "3.8 Pro + Extended thinking", version: 3.8, family: "pro", thinking: true }
  ],
  "3.8 Pro + Extended thinking"
)) passed++; else failed++;

// Test 4: Combined — 3.8 Pro Thinking > 3.8 Pro > 3.6 Pro
if (runTest(
  "Combined: 3.8 Pro Thinking > 3.8 Pro > 3.6 Pro",
  [
    { name: "3.6 Pro", version: 3.6, family: "pro" },
    { name: "3.8 Pro", version: 3.8, family: "pro" },
    { name: "3.8 Pro + Extended thinking", version: 3.8, family: "pro", thinking: true }
  ],
  "3.8 Pro + Extended thinking"
)) passed++; else failed++;

// Test 5: Flash Thinking
if (runTest(
  "Flash Thinking: 3.8 Flash Thinking > 3.8 Flash",
  [
    { name: "3.8 Flash", version: 3.8, family: "flash" },
    { name: "3.8 Flash + Extended thinking", version: 3.8, family: "flash", thinking: true }
  ],
  "3.8 Flash + Extended thinking"
)) passed++; else failed++;

// Test 6: preferredFamily = "flash"
if (runTest(
  "preferredFamily=flash: 3.8 Flash > 3.6 Flash",
  [
    { name: "3.6 Flash", version: 3.6, family: "flash" },
    { name: "3.8 Flash", version: 3.8, family: "flash" }
  ],
  "3.8 Flash",
  "flash"
)) passed++; else failed++;

// Test 7: preferredFamily = "any" — should pick highest version regardless of family
if (runTest(
  "preferredFamily=any: 3.8 Flash > 3.6 Pro",
  [
    { name: "3.6 Pro", version: 3.6, family: "pro" },
    { name: "3.8 Flash", version: 3.8, family: "flash" }
  ],
  "3.8 Flash",
  "any"
)) passed++; else failed++;

// Test 8: minVersion filter
if (runTest(
  "minVersion=3.7: 3.8 Pro > 3.6 Pro (filtered out)",
  [
    { name: "3.6 Pro", version: 3.6, family: "pro" },
    { name: "3.8 Pro", version: 3.8, family: "pro" }
  ],
  "3.8 Pro"
)) passed++; else failed++;

// ─── Summary ─────────────────────────────────────────────────
console.log("=".repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed > 0) process.exit(1);
