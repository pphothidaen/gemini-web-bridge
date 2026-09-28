// ============================================================
// Gemini Web-Bridge: Native Recovery
// Re-ask Gemini through its own UI controls when the replay path fails.
//
// Why this exists
// ---------------
// The bridge answers by POSTing to /_/BardChatUi/.../StreamGenerate with a
// payload it assembled itself. Google changed that request's schema, so Gemini
// now replies "I encountered an error doing what you asked." to everything —
// including "What is the capital of France?".
//
// Clicking Gemini's own retry button re-asks through Gemini's own code, so the
// payload is always current. It also flows through injected.js as a NATIVE call
// (it is not in internalBridgeCalls), so the interceptor captures real
// evidence — the one thing the bridge cannot learn on its own.
//
// Strategy order, as specified: retry the button first, fall back to typing
// into the input box only after the button is exhausted.
// ============================================================

(function (root) {
  "use strict";

  // Locate the newest model response. Scoping to the LAST one matters: a
  // conversation holds many responses and re-asking an old one answers the
  // wrong question.
  function lastModelResponse(doc = document) {
    const all = doc.querySelectorAll("model-response");
    return all.length ? all[all.length - 1] : null;
  }

  /**
   * Find the retry ("regenerate") control of the newest model response.
   *
   * Prefers data-test-id over aria-label: the label is localized ("ทำซ้ำ" in
   * Thai, "Regenerate" in English) while the test id is stable. The aria match
   * is kept only as a fallback.
   */
  function findRetryButton(doc = document) {
    const response = lastModelResponse(doc);
    if (!response) return null;

    const byTestId = response.querySelector('[data-test-id="regenerate-button"]');
    if (byTestId) return byTestId;

    const icon = response.querySelector('mat-icon[data-mat-icon-name="refresh"]');
    if (icon) return icon.closest("button, [role='button'], gem-icon-button") || icon;

    // Last resort: any refresh icon on the page, but only if it belongs to a
    // model response — never click an unrelated refresh control.
    const loose = doc.querySelector('mat-icon[data-mat-icon-name="refresh"]');
    if (loose && loose.closest("model-response")) {
      return loose.closest("button, [role='button'], gem-icon-button") || loose;
    }
    return null;
  }

  /**
   * Click Gemini's retry button for the newest response.
   * @returns {boolean} true when a control was found and clicked.
   */
  function clickRetryButton(doc = document) {
    const button = findRetryButton(doc);
    if (!button) return false;
    button.click();
    return true;
  }

  /**
   * Current text of the newest model response, or "" when absent.
   * Used both to detect a finished regeneration and to tell a fresh answer
   * apart from the failed one that is still on screen.
   */
  function readLastResponseText(doc = document) {
    const response = lastModelResponse(doc);
    return response ? (response.innerText || "").trim() : "";
  }

  /**
   * True when a body is Gemini's "Gemini บอกว่า" style label rather than an
   * answer. Gemini renders that label first and streams the real text in
   * afterwards, so treating the label as content returns a 13-character
   * "answer" that is really just a placeholder.
   */
  function isPlaceholderOnly(text) {
    const value = (typeof text === "string" ? text : "").trim();
    if (!value) return true;
    return /^(gemini\s*บอกว่า|gemini\s+(says|states))\s*[:：]?$/i.test(value);
  }

  /**
   * Wait until the newest model response settles on a real answer.
   *
   * Waiting for the text merely to *change* is not enough: Gemini clears the
   * old answer and briefly renders its "Gemini บอกว่า" label, so a change
   * detector resolves on the placeholder and the caller receives 13 characters
   * of label instead of the answer. This waits for the text to stop changing
   * (two consecutive identical samples) and to be non-placeholder.
   *
   * @param {string} previousText
   * @param {number} timeoutMs
   * @param {Document} doc  injected so tests need no global `document`
   * @param {Function} now  injectable clock, for tests
   * @param {Function} setT  injectable timer, for tests
   * @returns {Promise<{changed: boolean, text: string}>}
   */
  function waitForResponseChange(previousText, timeoutMs = 30000, doc = document, now = Date.now, setT = setTimeout) {
    return new Promise((resolve) => {
      const startedAt = now();
      let lastSeen = null;
      let stableCount = 0;
      const poll = () => {
        const text = readLastResponseText(doc);
        const substantive = text && text !== previousText && !isPlaceholderOnly(text);

        if (substantive) {
          // Require two identical samples: the first can still be mid-stream.
          if (text === lastSeen) {
            stableCount += 1;
          } else {
            stableCount = 0;
            lastSeen = text;
          }
          if (stableCount >= 1) {
            resolve({ changed: true, text });
            return;
          }
        } else {
          lastSeen = null;
          stableCount = 0;
        }

        if (now() - startedAt >= timeoutMs) {
          resolve({ changed: false, text });
          return;
        }
        setT(poll, 400);
      };
      poll();
    });
  }

  /**
   * True when a response body looks like a failure worth re-asking.
   *
   * This guard exists because of a real production race: the worker decides to
   * retry ~2s after the replay finishes, but Gemini may still be navigating to
   * the new conversation. The click then lands on the PREVIOUS conversation's
   * retry button and returns a complete, healthy answer to the wrong question.
   * Requiring a failure body means we only ever click when there is genuinely
   * something to re-ask.
   */
  function looksLikeFailure(text) {
    if (typeof text !== "string") return false;
    const value = text.trim();
    if (!value) return false;
    return [
      /I encountered an error/i,
      /I seem to be encountering an error/i,
      /something went wrong/i,
      /internal error/i,
      /hard time fulfilling/i,
      /help you with something else/i,
      /can I try something else/i
    ].some((re) => re.test(value));
  }

  /**
   * True while Gemini is still generating.
   *
   * Verified against the live Gemini DOM on 2026-09-28 (boq-gemini-web-uiserver
   * 20260927.05). The real indicator is Angular's Material spinner:
   *
   *   <div class="loading-content-spinner-container ng-star-inserted">
   *     <mat-progress-spinner class="mat-mdc-progress-spinner mdc-circular-progress">
   *
   * The `ng-star-inserted` marker means Angular inserts the node only while
   * loading, so its presence/absence is a clean start/stop signal. The
   * `thinking-dots-animation` node appears during the thinking phase only, so
   * it is deliberately NOT counted as "generating" — it can disappear before
   * the answer is finished.
   *
   * The Lottie SVG (clipPath id `__lottie_element_<n>`) was probed at length
   * and matched NOTHING over a real 1500-word generation, so it is kept only
   * as a last-resort fallback for other Gemini surfaces.
   *
   * This is a far better "is it done yet?" signal than watching text: a stream
   * pauses and resumes, so a text-stability heuristic can resolve on a
   * half-finished answer, whereas the spinner is present for the whole
   * generation and disappears exactly once.
   */
  /**
   * The generation signal, with provenance.
   *
   * Returned so callers can see WHICH selector actually matched. A dead
   * selector must be loud: the previous implementation matched a Lottie
   * clipPath that never existed on the live build, so isGenerating() returned
   * false on every call and every wait silently degraded to text-stability
   * without a single error. Reporting the source turns that into something
   * visible in the bridge logs.
   *
   * @returns {{active: boolean, source: string}}
   */
  function generatingSignal(doc = document) {
    if (!doc) return { active: false, source: "no_document" };
    if (doc.querySelector("div.loading-content-spinner-container")) {
      return { active: true, source: "material_spinner_container" };
    }
    if (doc.querySelector("mat-progress-spinner.mat-mdc-progress-spinner")) {
      return { active: true, source: "material_progress_spinner" };
    }
    if (doc.querySelector('clipPath[id^="__lottie_element"]')) {
      return { active: true, source: "lottie_clippath" };
    }
    if (doc.querySelector('svg[clip-path*="__lottie_element"]')) {
      return { active: true, source: "lottie_svg" };
    }
    if (doc.querySelector('button[aria-label*="หยุดการสร้าง"], button[aria-label*="Stop generating"]')) {
      return { active: true, source: "stop_button" };
    }
    return { active: false, source: "none" };
  }

  function isGenerating(doc = document) {
    return generatingSignal(doc).active;
  }

  /**
   * Wait for a predicate to become true, or give up.
   * @returns {Promise<boolean>} whether it became true in time
   */
  function waitFor(predicate, timeoutMs, doc, now, setT) {
    return new Promise((resolve) => {
      const startedAt = now();
      const poll = () => {
        if (predicate(doc)) { resolve(true); return; }
        if (now() - startedAt >= timeoutMs) { resolve(false); return; }
        setT(poll, 200);
      };
      poll();
    });
  }

  /**
   * Full native re-ask: click retry, wait for the new answer.
   *
   * @param {object} deps
   * @param {number} deps.timeoutMs     how long to wait for the new answer
   * @param {number} deps.settleMs      how long to let Gemini finish rendering
   *                                    and navigate before clicking
   * @param {Function} [deps.sleep]     backoff helper, for tests
   * @returns {Promise<{ok: boolean, text: string, reason: string}>}
   */
  async function retryViaUi({ timeoutMs = 30000, settleMs = 1500, doc = document, sleep = null } = {}) {
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = Date.now;
    const setT = setTimeout;

    // Let Gemini finish the navigation/render for the request that just
    // failed. Clicking earlier targets the previous conversation.
    if (settleMs > 0) await wait(settleMs);

    const before = readLastResponseText(doc);
    if (!looksLikeFailure(before)) {
      // Nothing to re-ask: either the new conversation has not rendered yet,
      // or the newest answer is already good. Do not touch it.
      return { ok: false, text: "", reason: before.trim() ? "not_a_failure" : "no_response_rendered" };
    }

    const clicked = clickRetryButton(doc);
    if (!clicked) {
      return { ok: false, text: "", reason: "no_retry_button" };
    }

    // Phase 1: generation should start. If the spinner never appears the click
    // did not take, and waiting out the full timeout would just burn it.
    const started = await waitFor(() => generatingSignal(doc).active, Math.min(5000, timeoutMs), doc, now, setT);
    const signal = generatingSignal(doc).source;
    let waitedOnSpinner = false;
    if (started) {
      waitedOnSpinner = true;
      // Phase 2: wait for the spinner to clear — that is the real completion
      // signal, and it cannot fire on a half-written answer the way text
      // stability can.
      await waitFor((d) => !generatingSignal(d).active, timeoutMs, doc, now, setT);
    } else {
      console.warn("[NativeRecovery] No generation indicator appeared after clicking retry; " +
        "falling back to text-stability. The loading selector may have gone stale.");
    }

    // Phase 3: let the finished DOM settle so we read the complete answer.
    const result = await waitForResponseChange(before, 4000, doc);
    if (!result.changed) {
      const finalText = readLastResponseText(doc);
      if (finalText && finalText !== before && !isPlaceholderOnly(finalText)) {
        return { ok: true, text: finalText, reason: "", signal, waitedOnSpinner };
      }
      return { ok: false, text: "", reason: "no_new_response", signal, waitedOnSpinner };
    }
    return { ok: true, text: result.text, reason: "", signal, waitedOnSpinner };
  }

  const NativeRecovery = {
    findRetryButton,
    clickRetryButton,
    readLastResponseText,
    lastModelResponse,
    looksLikeFailure,
    isPlaceholderOnly,
    isGenerating,
    generatingSignal,
    waitForResponseChange,
    retryViaUi
  };

  root.NativeRecovery = NativeRecovery;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = NativeRecovery;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
