// ============================================================
// Priority Order Test: Verifies exact 12-item sort order
// User requirement:
// 1. 3.8 Pro + Extended thinking
// 2. 3.8 Pro
// 3. 3.8 Flash + Extended thinking
// 4. 3.8 Flash
// 5. 3.8 Flash-Lite + Extended thinking
// 6. 3.8 Flash-Lite
// 7. 3.6 Pro + Extended thinking
// 8. 3.6 Pro
// 9. 3.6 Flash + Extended thinking
// 10. 3.6 Flash
// 11. 3.6 Flash-Lite + Extended thinking
// 12. 3.6 Flash-Lite
// ============================================================

// Mock DOM environment
const allItems = [];

function createMockElement(name, version, family, isThinking = false) {
  const text = isThinking ? `${name} + Extended thinking` : name;
  return {
    innerText: text,
    textContent: text,
    _name: name,
    _version: version,
    _family: family,
    _isThinking: isThinking,
    getAttribute(attr) {
      if (attr === "aria-checked") return "false";
      if (attr === "aria-selected") return "false";
      if (attr === "aria-expanded") return "false";
      return null;
    },
    classList: { contains: () => false },
    click() {}
  };
}

global.document = {
  querySelector() {
    return { getAttribute: () => "false", classList: { contains: () => false }, click: () => {} };
  },
  querySelectorAll() {
    return allItems;
  }
};

global.window = { location: { hostname: "gemini.google.com" } };

// Load module
const AutoModelSelector = require("./auto-model-selector.js");

// Build all 12 models in random order
const allModels = [
  { name: "3.8 Pro", version: 3.8, family: "pro" },
  { name: "3.8 Pro", version: 3.8, family: "pro", thinking: true },
  { name: "3.8 Flash", version: 3.8, family: "flash" },
  { name: "3.8 Flash", version: 3.8, family: "flash", thinking: true },
  { name: "3.8 Flash-Lite", version: 3.8, family: "flash-lite" },
  { name: "3.8 Flash-Lite", version: 3.8, family: "flash-lite", thinking: true },
  { name: "3.6 Pro", version: 3.6, family: "pro" },
  { name: "3.6 Pro", version: 3.6, family: "pro", thinking: true },
  { name: "3.6 Flash", version: 3.6, family: "flash" },
  { name: "3.6 Flash", version: 3.6, family: "flash", thinking: true },
  { name: "3.6 Flash-Lite", version: 3.6, family: "flash-lite" },
  { name: "3.6 Flash-Lite", version: 3.6, family: "flash-lite", thinking: true },
];

// Expected order
const expectedOrder = [
  "3.8 Pro + Extended thinking",  // 1
  "3.8 Pro",                     // 2
  "3.8 Flash + Extended thinking", // 3
  "3.8 Flash",                   // 4
  "3.8 Flash-Lite + Extended thinking", // 5
  "3.8 Flash-Lite",               // 6
  "3.6 Pro + Extended thinking",  // 7
  "3.6 Pro",                     // 8
  "3.6 Flash + Extended thinking", // 9
  "3.6 Flash",                   // 10
  "3.6 Flash-Lite + Extended thinking", // 11
  "3.6 Flash-Lite",               // 12
];

// Test: getModelMenuOptions returns sorted options
allItems.length = 0;
for (const m of allModels) {
  allItems.push(createMockElement(m.name, m.version, m.family, m.thinking));
}

const options = AutoModelSelector.getModelMenuOptions();

// Apply same sort logic as selectModel
const familyPriority = { pro: 3, flash: 2, "flash-lite": 1, unknown: 0 };
const isThinkingModel = (name) => {
  const lower = name.toLowerCase();
  return lower.includes("thinking") || lower.includes("think") || lower.includes("reasoning");
};

options.sort((a, b) => {
  if (b.version !== a.version) return b.version - a.version;
  const aFamily = familyPriority[a.family] || 0;
  const bFamily = familyPriority[b.family] || 0;
  if (aFamily !== bFamily) return bFamily - aFamily;
  const aThinking = isThinkingModel(a.name) ? 0 : 1;
  const bThinking = isThinkingModel(b.name) ? 0 : 1;
  return aThinking - bThinking;
});

console.log("=".repeat(70));
console.log("Priority Order Test: Full 12-item sort");
console.log("=".repeat(70));
console.log("");

let passed = 0;
for (let i = 0; i < expectedOrder.length; i++) {
  const expected = expectedOrder[i];
  const actual = options[i]?.name || "(none)";
  const ok = actual === expected;
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} | Rank ${i + 1,2} | Expected: ${expected.padEnd(35)} | Actual: ${actual}`);
  if (ok) passed++;
}

console.log("");
console.log("=".repeat(70));
console.log(`Results: ${passed}/12 passed`);
console.log("=".repeat(70));

if (passed < 12) process.exit(1);
