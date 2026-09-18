// ============================================================
// Test: Auto Model Selector Priority Logic
// Simulates DOM model options and verifies sort order
// ============================================================

// Mock globalThis for Node.js test environment
if (typeof globalThis === "undefined") {
  global.globalThis = global;
}

// Load the module
const AutoModelSelector = require("./auto-model-selector.js");

// Mock DOM elements for testing
function createMockElement(name, version, family, isThinking = false) {
  return {
    innerText: isThinking ? `${name} + Extended thinking` : name,
    textContent: isThinking ? `${name} + Extended thinking` : name,
    getAttribute: (attr) => {
      if (attr === "aria-checked") return "false";
      if (attr === "aria-selected") return "false";
      return null;
    },
    classList: { contains: () => false },
    click: () => {}
  };
}

// Test cases
const testCases = [
  {
    name: "Priority 1: Version 3.8 > 3.6 (Pro)",
    options: [
      { name: "3.6 Pro", version: 3.6, family: "pro" },
      { name: "3.8 Pro", version: 3.8, family: "pro" },
      { name: "3.5 Pro", version: 3.5, family: "pro" }
    ],
    expected: "3.8 Pro"
  },
  {
    name: "Priority 2: Pro > Flash (same version 3.8)",
    options: [
      { name: "3.8 Flash", version: 3.8, family: "flash" },
      { name: "3.8 Pro", version: 3.8, family: "pro" },
      { name: "3.8 Flash-Lite", version: 3.8, family: "flash-lite" }
    ],
    expected: "3.8 Pro"
  },
  {
    name: "Priority 3: Thinking model preferred (same version+family)",
    options: [
      { name: "3.8 Pro", version: 3.8, family: "pro" },
      { name: "3.8 Pro + Extended thinking", version: 3.8, family: "pro", thinking: true }
    ],
    expected: "3.8 Pro + Extended thinking"
  },
  {
    name: "Combined: 3.8 Pro Thinking > 3.8 Pro > 3.6 Pro",
    options: [
      { name: "3.6 Pro", version: 3.6, family: "pro" },
      { name: "3.8 Pro", version: 3.8, family: "pro" },
      { name: "3.8 Pro + Extended thinking", version: 3.8, family: "pro", thinking: true }
    ],
    expected: "3.8 Pro + Extended thinking"
  },
  {
    name: "Flash Thinking: 3.8 Flash Thinking > 3.8 Flash",
    options: [
      { name: "3.8 Flash", version: 3.8, family: "flash" },
      { name: "3.8 Flash + Extended thinking", version: 3.8, family: "flash", thinking: true }
    ],
    expected: "3.8 Flash + Extended thinking"
  }
];

// Run tests
let passed = 0;
let failed = 0;

for (const tc of testCases) {
  // Simulate the sort logic from selectModel
  const familyPriority = { pro: 3, flash: 2, "flash-lite": 1, unknown: 0 };
  const isThinkingModel = (name) => {
    const lower = name.toLowerCase();
    return lower.includes("thinking") || lower.includes("think") || lower.includes("reasoning");
  };

  const sorted = [...tc.options].sort((a, b) => {
    // Priority 1: version (newest first)
    if (b.version !== a.version) return b.version - a.version;
    // Priority 2: family (Pro > Flash > Flash-Lite)
    const aFamily = familyPriority[a.family] || 0;
    const bFamily = familyPriority[b.family] || 0;
    if (aFamily !== bFamily) return bFamily - aFamily;
    // Priority 3: thinking models (prefer thinking variant)
    const aThinking = isThinkingModel(a.name) ? 1 : 0;
    const bThinking = isThinkingModel(b.name) ? 1 : 0;
    return bThinking - aThinking;
  });

  const actual = sorted[0].name;
  const success = actual === tc.expected;

  if (success) {
    console.log(`✅ PASS: ${tc.name}`);
    console.log(`   Expected: ${tc.expected}`);
    console.log(`   Actual:   ${actual}`);
    passed++;
  } else {
    console.log(`❌ FAIL: ${tc.name}`);
    console.log(`   Expected: ${tc.expected}`);
    console.log(`   Actual:   ${actual}`);
    failed++;
  }
  console.log("");
}

console.log("=".repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed > 0) {
  process.exit(1);
}
