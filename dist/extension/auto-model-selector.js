// ============================================================
// Gemini Web-Bridge: Auto Model Selector
// Discovers and auto-selects the newest Gemini model from the web UI
// ============================================================

(function (root) {
  "use strict";

  const MODEL_NAME_REGEX = /(?:(\d+(?:\.\d+)*)\s*)?(Pro|Flash(?:-Lite)?|Extended|Thinking)/i;

  /**
   * Extracts a numeric version score from a model name string.
   * e.g., "3.8 Pro" -> 3.8, "3.1 Flash-Lite" -> 3.1
   */
  function extractVersionScore(name) {
    const match = name.match(/(\d+(?:\.\d+)*)/);
    if (!match) return 0;
    return parseFloat(match[1]);
  }

  /**
   * Detects the family (Pro/Flash/Flash-Lite) from a model name.
   */
  function extractFamily(name) {
    const lower = name.toLowerCase();
    if (lower.includes("flash lite") || lower.includes("flash-lite")) return "flash-lite";
    if (lower.includes("flash")) return "flash";
    if (lower.includes("pro")) return "pro";
    return "unknown";
  }

  /**
   * Checks if a model name indicates thinking/reasoning capability.
   */
  function isThinkingModel(name) {
    const lower = name.toLowerCase();
    return lower.includes("thinking") || lower.includes("think") || lower.includes("reasoning");
  }

  /**
   * Scrapes all model option elements from the currently open Gemini model menu.
   */
  function getModelMenuOptions() {
    const items = Array.from(document.querySelectorAll(
      "[role='menuitem'], [role='menuitemradio'], gem-menu-item, button[data-test-id*='model']"
    ));

    const options = [];
    for (const item of items) {
      const text = (item.innerText || item.textContent || "").trim();
      if (!text || text.length > 200) continue;

      const match = text.match(MODEL_NAME_REGEX);
      if (match) {
        options.push({
          element: item,
          name: text.replace(/\n/g, " ").replace(/\s+/g, " ").trim(),
          version: extractVersionScore(text),
          family: extractFamily(text),
          isSelected: item.getAttribute("aria-checked") === "true" ||
                      item.getAttribute("aria-selected") === "true" ||
                      text.includes("✓") ||
                      (item.classList && typeof item.classList.contains === "function" &&
                       item.classList.contains("selected"))
        });
      }
    }
    return options;
  }

  /**
   * Opens the Gemini model picker dropdown.
   * Returns the trigger button element if successfully opened.
   */
  function openModelPicker() {
    const trigger = document.querySelector(
      "button[data-test-id='bard-mode-menu-button'], " +
      "button.input-area-switch, " +
      "button[aria-label*='mode picker'], button[aria-label*='model picker'], " +
      "button[aria-label*='เปิดตัวเลือกโหมด'], " +
      "button[aria-label*='picker'], button[aria-haspopup='menu'], " +
      "[role='button'][aria-haspopup='menu']"
    );

    if (!trigger) {
      console.debug("[Bridge] Model picker button not found in DOM");
      return null;
    }

    const isClosed = trigger.getAttribute("aria-expanded") !== "true";
    if (isClosed) {
      trigger.click();
    }
    return trigger;
  }

  /**
   * Closes the model picker dropdown.
   */
  function closeModelPicker(trigger) {
    if (trigger && trigger.getAttribute("aria-expanded") === "true") {
      trigger.click();
    }
  }

  /**
   * Selects a specific model from the open menu by matching its name.
   * If exact match fails, falls back to highest version + family priority.
   *
   * @param {string} preferredFamily - "pro" or "flash"
   * @param {number} minVersion - minimum version to consider
   * @returns {{success: boolean, selectedModel: string|null}}
   */
  function selectModel(preferredFamily = "pro", minVersion = 0) {
    try {
      const trigger = openModelPicker();
      if (!trigger) return { success: false, selectedModel: null };

      // Wait briefly for menu to render
      const options = getModelMenuOptions();
      if (options.length === 0) {
        console.debug("[Bridge] No model options found in dropdown");
        closeModelPicker(trigger);
        return { success: false, selectedModel: null };
      }

      // Sort priority: 1) version descending (3.8 > 3.6), 2) family (pro > flash > flash-lite),
      // 3) thinking variant BEFORE non-thinking (Extended thinking first)
      const familyPriority = { pro: 3, flash: 2, "flash-lite": 1, unknown: 0 };
      options.sort((a, b) => {
        // Priority 1: version (newest first)
        if (b.version !== a.version) return b.version - a.version;
        // Priority 2: family (Pro > Flash > Flash-Lite)
        const aFamily = familyPriority[a.family] || 0;
        const bFamily = familyPriority[b.family] || 0;
        if (aFamily !== bFamily) return bFamily - aFamily;
        // Priority 3: thinking models BEFORE non-thinking (Extended thinking first)
        const aThinking = isThinkingModel(a.name) ? 0 : 1;  // 0 = thinking (higher priority)
        const bThinking = isThinkingModel(b.name) ? 0 : 1;  // 1 = non-thinking (lower priority)
        return aThinking - bThinking;
      });

      // Filter by minimum version and preferred family (if specified)
      let candidates = options.filter(o => o.version >= minVersion);
      if (preferredFamily && preferredFamily !== "any") {
        const familyMatch = candidates.filter(o =>
          o.family === preferredFamily ||
          (preferredFamily === "pro" && o.family === "pro") ||
          (preferredFamily === "flash" && (o.family === "flash" || o.family === "flash-lite"))
        );
        if (familyMatch.length > 0) candidates = familyMatch;
      }

      if (candidates.length === 0) {
        console.warn("[Bridge] No model candidates match criteria");
        closeModelPicker(trigger);
        return { success: false, selectedModel: null };
      }

      const target = candidates[0];
      console.log(`[Bridge] Auto-selecting model: ${target.name} (v${target.version}, ${target.family})`);
      target.element.click();

      // Close the menu after selection
      setTimeout(() => closeModelPicker(trigger), 100);

      return { success: true, selectedModel: target.name };
    } catch (e) {
      console.warn("[Bridge] Error during model selection:", e);
      return { success: false, selectedModel: null };
    }
  }

  /**
   * Auto-selects the newest Gemini model available in the menu.
   * Priority: highest version > Pro > Flash > Flash-Lite
   *
   * @param {string} preferredFamily - "pro" | "flash" | "any" (default: "pro")
   * @returns {{success: boolean, selectedModel: string|null}}
   */
  function autoSelectNewestModel(preferredFamily = "pro") {
    return selectModel(preferredFamily, 0);
  }

  const AutoModelSelector = {
    autoSelectNewestModel,
    selectModel,
    getModelMenuOptions,
    openModelPicker,
    closeModelPicker
  };

  root.AutoModelSelector = AutoModelSelector;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = AutoModelSelector;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
