// ============================================================
// Gemini Web-Bridge: Auto Thinking Effort Controller
// Enables Extended Thinking and sets effort level in Gemini web UI
// ============================================================

(function (root) {
  "use strict";

  const THINKING_TOGGLE_SELECTOR = [
    "button[aria-label*='Thinking']",
    "button[aria-label*='thinking']",
    "button[aria-label*='Extended']",
    "button[aria-label*='extended']",
    "button[aria-label*='ความคิดเพิ่มเติม']",
    "button[aria-label*='การคิด']",
    "[data-test-id*='thinking']",
    "[role='switch'][aria-label*='Thinking']",
    "[role='checkbox'][aria-label*='Thinking']",
    "button:has-text('Thinking')"
  ].join(", ");

  /**
   * Finds the Extended Thinking toggle/switch in the DOM.
   */
  function findThinkingToggle() {
    for (const selector of THINKING_TOGGLE_SELECTOR.split(", ")) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch (e) {}
    }
    // Fallback: search all buttons/switches for "thinking" text
    const allInteractive = Array.from(document.querySelectorAll(
      "button, [role='switch'], [role='checkbox'], [role='menuitemcheckbox'], input[type='checkbox']"
    ));
    for (const el of allInteractive) {
      const text = (el.innerText || el.textContent || "").toLowerCase();
      const aria = (el.getAttribute && el.getAttribute("aria-label")) || "";
      if (text.includes("thinking") || aria.includes("thinking") || aria.includes("Thinking")) {
        return el;
      }
    }
    return null;
  }

  /**
   * Checks if Extended Thinking is currently enabled.
   */
  function isThinkingEnabled() {
    const toggle = findThinkingToggle();
    if (!toggle) return false;
    return toggle.getAttribute("aria-checked") === "true" ||
           toggle.getAttribute("aria-selected") === "true" ||
           (toggle instanceof HTMLInputElement && toggle.checked) ||
           toggle.classList.contains("checked") ||
           toggle.classList.contains("active") ||
           toggle.getAttribute("data-state") === "on";
  }

  /**
   * Toggles Extended Thinking on or off.
   *
   * @param {boolean} enable - true to enable, false to disable
   * @returns {boolean} success
   */
  function toggleThinking(enable = true) {
    try {
      const toggle = findThinkingToggle();
      if (!toggle) {
        console.warn("[Bridge] Thinking toggle not found in DOM");
        return false;
      }

      const currentState = isThinkingEnabled();
      if (currentState === enable) {
        console.log(`[Bridge] Thinking is already ${enable ? "enabled" : "disabled"}`);
        return true;
      }

      toggle.click();
      console.log(`[Bridge] ${enable ? "Enabled" : "Disabled"} Extended Thinking`);
      return true;
    } catch (e) {
      console.warn("[Bridge] Error toggling thinking:", e);
      return false;
    }
  }

  /**
   * Sets the thinking effort level.
   * UI may expose this as a slider, segmented control, or menu options.
   *
   * @param {string} level - "off" | "low" | "medium" | "high" | "max"
   * @returns {boolean} success
   */
  function setThinkingEffort(level = "high") {
    try {
      if (level === "off") {
        return toggleThinking(false);
      }

      // First ensure thinking is enabled
      if (!isThinkingEnabled()) {
        toggleThinking(true);
      }

      // Look for effort selector (slider, segmented control, or menu)
      // Pattern 1: Buttons/segments with effort labels
      const effortButtons = Array.from(document.querySelectorAll(
        "[role='radio'], [role='menuitemradio'], button, [role='option']"
      )).filter(el => {
        const text = (el.innerText || el.textContent || "").trim().toLowerCase();
        return text === level || text.includes(level);
      });

      if (effortButtons.length > 0) {
        effortButtons[0].click();
        console.log(`[Bridge] Set thinking effort to: ${level}`);
        return true;
      }

      // Pattern 2: Select/dropdown
      const selects = Array.from(document.querySelectorAll("select"));
      for (const sel of selects) {
        const options = Array.from(sel.options);
        const match = options.find(o =>
          o.value.toLowerCase().includes(level) ||
          o.text.toLowerCase().includes(level)
        );
        if (match) {
          sel.value = match.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          console.log(`[Bridge] Set thinking effort via select: ${level}`);
          return true;
        }
      }

      // Pattern 3: Input range (slider)
      const sliders = Array.from(document.querySelectorAll("input[type='range']"));
      for (const slider of sliders) {
        const parent = slider.closest("[class*='thinking'], [class*='effort'], [aria-label*='thinking' i]");
        if (parent) {
          const min = parseFloat(slider.min) || 0;
          const max = parseFloat(slider.max) || 10;
          const values = { low: min + (max - min) * 0.25, medium: min + (max - min) * 0.5, high: min + (max - min) * 0.75, max: max };
          const val = values[level] || values.high;
          slider.value = val;
          slider.dispatchEvent(new Event("input", { bubbles: true }));
          slider.dispatchEvent(new Event("change", { bubbles: true }));
          console.log(`[Bridge] Set thinking effort via slider: ${level} (${val})`);
          return true;
        }
      }

      console.debug(`[Bridge] Effort selector not available in current UI layout for level: ${level}`);
      return false;
    } catch (e) {
      console.debug("[Bridge] Error setting thinking effort:", e);
      return false;
    }
  }

  const AutoThinking = {
    setThinkingEffort,
    toggleThinking,
    isThinkingEnabled,
    findThinkingToggle
  };

  root.AutoThinking = AutoThinking;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = AutoThinking;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
