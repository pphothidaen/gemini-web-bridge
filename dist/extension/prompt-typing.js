// ============================================================
// Gemini Web-Bridge: Prompt typing fallback
// Ask through Gemini's own input box when the replay path fails.
//
// Why this exists
// ---------------
// The primary path POSTs an assembled `StreamGenerate` payload. Google
// has changed that request's schema, so the payload is refused for
// everything — including "What is the capital of France?". The symptom
// is a 60s timeout with 0 user-queries and 0 model-responses rendered:
// the question never reaches Gemini at all.
//
// Typing the prompt into Gemini's own input box makes the PAGE build the
// request, so the stale schema is bypassed entirely. It also has a
// second benefit that replay can never have: a page-initiated request
// is a NATIVE call, so `injected.js` records it as real evidence
// (`internalBridgeCalls` deliberately excludes only the bridge's own
// calls). Every fallback therefore teaches the evidence registry what a
// current request looks like — which is how a correct `f_req` can be
// derived later and the primary path repaired.
//
// This is the second half of the strategy written into
// `native-recovery.js` ("retry the button first, fall back to typing
// into the input box") — the typing half was specified but never
// implemented, and the retry half cannot help a request that never
// leaves the browser.
//
// Verified 2026-09-29 against a live authenticated tab: prompt sent,
// `user-query` rendered, answer streamed back.
// ============================================================

(function (root) {
  "use strict";

  // Localization-proof. The send button's accessible name is
  // "ส่งข้อความ" in Thai and "Send message" in English, so it is keyed on
  // the Material icon name instead.
  const SELECTORS = {
    richTextarea: "input-area-v2 rich-textarea",
    editor: 'input-area-v2 .ql-editor[contenteditable="true"]',
    sendButton: 'input-area-v2 button:has(mat-icon[data-mat-icon-name="arrow_upward"])',
    // Kept as a structural fallback for surfaces without the icon.
    sendButtonFallback: "input-area-v2 button.send-button, input-area-v2 [data-test-id='send-button']"
  };

  const STEP_TIMEOUT_MS = 20000;
  const POLL_MS = 150;


  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * True when the tab is foregrounded.
   *
   * Same requirement as the notebook attach: Gemini's editor does not
   * commit the prompt on a backgrounded tab, so the request would
   * silently never be sent. Failing fast beats a silent no-op.
   */
  function isTabVisible(doc = document) {
    if (typeof doc.hidden === "boolean") return !doc.hidden;
    return true;
  }

  /**
   * The Quill instance backing Gemini's prompt box, if one is reachable.
   *
   * KAN-182: this is now best-effort rather than the primary path. It looks
   * for the `__quill` property Angular leaves on `rich-textarea`, and that
   * property was NOT found on the live tab during the 2026-09-29 run — the
   * editor stayed blank and no prompt was ever submitted. A serialised DOM
   * cannot show JS properties, so this stays unproven either way; the point
   * is that nothing may depend on it.
   *
   * @returns {object|null}
   */
  function getQuill(doc = document) {
    const host = doc.querySelector(SELECTORS.richTextarea);
    if (host && host.__quill) return host.__quill;
    // Some builds hang the instance off the inner editor instead.
    const editor = host && host.querySelector(SELECTORS.editor);
    if (editor && editor.__quill) return editor.__quill;
    return null;
  }

  /** The contenteditable element a human types into. */
  function findEditor(doc = document) {
    return doc.querySelector(SELECTORS.editor);
  }

  /** The send control, once Gemini has rendered it. */
  function findSendButton(doc = document) {
    return doc.querySelector(SELECTORS.sendButton) || doc.querySelector(SELECTORS.sendButtonFallback);
  }

  /** True when the editor currently holds text. */
  function editorHasText(doc = document) {
    const editor = findEditor(doc);
    if (!editor) return false;
    return ((editor.innerText || editor.textContent || "").trim() || "").length > 0;
  }

  /**
   * How many `model-response` elements the conversation holds.
   *
   * Sampled BEFORE a prompt is submitted, so the collector can insist on an
   * answer that is newer than the request. Taken afterwards it is useless:
   * Gemini can render the answer before the collector is even asked for it.
   */
  function countModelResponses(doc = document) {
    try {
      const all = doc.querySelectorAll("model-response");
      return all ? all.length : 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Ask the MAIN world to type `text`, and wait for its read-back.
   *
   * KAN-182. This is the only path that works, and the reason is architectural
   * rather than a selector problem: content scripts run in the ISOLATED world,
   * which shares the DOM with the page but **not JavaScript expandos**. The
   * `__quill` property Angular sets on `rich-textarea` lives in the page's own
   * context, so `getQuill()` here returns null no matter how it is written.
   * Every isolated-world write (`textContent`, a synthetic `InputEvent`,
   * `execCommand`) is then reconciled away by Angular — measured live on
   * 2026-09-29: the editor stayed `ql-blank` and no prompt was ever sent.
   *
   * `injected.js` runs in the MAIN world and can see the instance, so the
   * request is relayed there over the existing `postMessage` bridge. The reply
   * carries the editor's actual text, so this still verifies instead of
   * assuming.
   *
   * @returns {Promise<{ok: boolean, reason: string, text: string}>}
   */
  function typeViaMainWorld(text, opts = {}) {
    const { timeoutMs = 5000, setT = setTimeout } = opts;
    const win = typeof window !== "undefined" ? window : null;
    if (!win || typeof win.postMessage !== "function") {
      return Promise.resolve({ ok: false, reason: "no_window", text: "" });
    }

    const requestId = `pt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        win.removeEventListener("message", onMessage);
        resolve(result);
      };

      function onMessage(event) {
        if (event.source !== win || !event.data) return;
        const data = event.data;
        if (data.source !== "GEMINI_INJECTED" || data.type !== "PROMPT_TYPED") return;
        if (data.requestId !== requestId) return;
        finish({
          ok: Boolean(data.ok),
          reason: data.reason || "",
          text: typeof data.text === "string" ? data.text : ""
        });
      }

      win.addEventListener("message", onMessage);
      // A silent MAIN world must not hang the call: the send-button wait that
      // follows is the next real signal, and a timeout here degrades into the
      // existing fallback path rather than blocking.
      setT(() => finish({ ok: false, reason: "main_world_timeout", text: "" }), timeoutMs);

      try {
        win.postMessage({
          source: "GEMINI_CONTENT",
          type: "TYPE_PROMPT_INTO_EDITOR",
          requestId,
          payload: { requestId, text }
        }, "*");
      } catch (e) {
        finish({ ok: false, reason: "main_world_post_failed", text: "" });
      }
    });
  }

  /**
   * Put `text` into the prompt box so Gemini believes a human typed it.
   *
   * Delegates to the MAIN world first — see `typeViaMainWorld` for why that is
   * the only reliable route. The DOM writes below remain as a last resort for
   * a MAIN world that is absent or unresponsive, and the read-back at the end
   * is what decides whether any of it worked.
   *
   * @returns {boolean} whether the editor now holds `text`
   */
  async function setPromptTextAsync(text, opts = {}) {
    const value = typeof text === "string" ? text : "";
    if (!value.trim()) return false;

    const viaMain = await typeViaMainWorld(value, opts);
    if (viaMain.ok) return true;

    const doc = opts.doc || document;
    const editor = findEditor(doc);
    if (!editor) return false;

    // Last resort. `textContent` is known to double the text when it works and
    // to be reverted when it does not, so the read-back is mandatory and its
    // verdict is the one that counts.
    //
    // The write and the event are guarded separately on purpose: `InputEvent`
    // does not exist in every environment, and letting that throw discard an
    // already-applied write would report a failure that did not happen.
    try {
      editor.textContent = value;
    } catch (e) {
      return false;
    }
    try {
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "insertText", data: value
      }));
    } catch (e) {
      // The read-back below still decides whether the text landed.
    }
    const now = editor.innerText || editor.textContent || "";
    return (now.replace(/\s+/g, " ").trim() || "").indexOf(value.replace(/\s+/g, " ").trim()) !== -1;
  }

  /**
   * Put `text` into the prompt box so Gemini believes a human typed it.
   *
   * KAN-182, reworked after the 2026-09-29 live run. The previous version
   * depended entirely on a `__quill` JS property and had no working fallback:
   * when that property was absent, it fell back to `textContent` plus a
   * synthetic InputEvent, and the editor went back to `ql-blank`. The prompt
   * was never sent, and the call went on to report the PREVIOUS turn's
   * answer.
   *
   * What the live tab actually proved, in order of reliability:
   *
   *   1. Real input events (CDP `Input.insertText`) → text lands, `ql-blank`
   *      clears, the send button appears, and the prompt submits. Verified
   *      end to end: a 9th `user-query` appeared.
   *   2. `quill.setText(t, 'user')` from the MAIN world → correct text AND the
   *      send button, because Angular is told about the change.
   *   3. Anything written from the ISOLATED world → reconciled away.
   *
   * `typeAndSend` uses `setPromptTextAsync`, which routes through the MAIN
   * world. This synchronous version is retained for direct callers and tests;
   * it still tries Quill, then `execCommand`, then a direct write, and always
   * verifies with a read-back.
   *
   * @returns {boolean} whether the editor now holds `text`
   */
  function setPromptText(text, doc = document) {
    const value = typeof text === "string" ? text : "";
    if (!value.trim()) return false;

    const quill = getQuill(doc);
    const editor = findEditor(doc);
    if (!editor && !quill) return false;

    if (quill && typeof quill.setText === "function") {
      quill.setText(value, "user");
      if (typeof quill.setSelection === "function") {
        quill.setSelection(quill.getLength(), quill.getLength(), "silent");
      }
    } else {
      // Focus first: execCommand only applies to the focused editable, and a
      // blurred one silently does nothing.
      if (typeof editor.focus === "function") editor.focus();

      // Select the existing contents so a leftover prompt is replaced rather
      // than appended to. A no-op on an empty editor, which is the normal case.
      const host = editor.ownerDocument || doc;
      try {
        const selection = typeof host.getSelection === "function" ? host.getSelection() : null;
        if (selection && typeof host.createRange === "function") {
          const range = host.createRange();
          range.selectNodeContents(editor);
          if (typeof selection.removeAllRanges === "function") selection.removeAllRanges();
          if (typeof selection.addRange === "function") selection.addRange(range);
        }
      } catch (e) {
        // Selection is a convenience here, not a requirement — insertText
        // still works without it, it just appends.
      }

      let inserted = false;
      try {
        inserted = typeof host.execCommand === "function" && host.execCommand("insertText", false, value);
      } catch (e) {
        inserted = false;
      }

      // execCommand returns false when it declines. Fall back to a direct
      // write ONLY as a last resort — the read-back below is what catches the
      // known doubling problem, which is why it is mandatory, not optional.
      if (!inserted) {
        editor.textContent = value;
      }

      try {
        editor.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: value
        }));
      } catch (e) {
        // InputEvent may be unavailable in a test stub; the read-back below
        // still reports whether the text landed.
      }
    }

    if (editor && typeof editor.focus === "function") editor.focus();

    // Verified against the DOM rather than assumed: the textContent path
    // produced doubled text while still looking like it worked, so the text
    // is read back before anything is sent.
    const now = (editor && (editor.innerText || editor.textContent)) || "";
    return (now.replace(/\s+/g, " ").trim() || "").indexOf(value.replace(/\s+/g, " ").trim()) !== -1;
  }

  /** Clear the prompt box without typing into it. */
  function clearPrompt(doc = document) {
    const quill = getQuill(doc);
    if (quill && typeof quill.setText === "function") {
      quill.setText("", "user");
      return true;
    }
    const editor = findEditor(doc);
    if (!editor) return false;
    editor.textContent = "";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    return true;
  }

  /**
   * Poll until `predicate` returns truthy, or give up.
   * `Document` and the clock are injected so tests need no globals.
   */
  function waitFor(predicate, timeoutMs, doc, now, setT) {
    return new Promise((resolve) => {
      const startedAt = now();
      const poll = () => {
        let value = null;
        try {
          value = predicate(doc);
        } catch (e) {
          value = null;
        }
        if (value) {
          resolve(value);
          return;
        }
        if (now() - startedAt >= timeoutMs) {
          resolve(null);
          return;
        }
        setT(poll, POLL_MS);
      };
      poll();
    });
  }

  /** Number of `user-query` nodes currently rendered. */
  function countUserQueries(doc = document) {
    return doc.querySelectorAll("user-query").length;
  }

  /**
   * Type a prompt into Gemini's own input box and submit it.
   *
   * The fallback for the replay path. Everything is verified against the
   * live DOM rather than assumed, because the three obvious ways to fill
   * a rich-text editor all fail differently and each failure looks like
   * success at first glance:
   *
   *   1. `textContent` + synthetic InputEvent → text lands twice.
   *   2. `quill.setText(t, 'api')`          → text is right, no send button.
   *   3. `quill.setText(t, 'user')`         → correct, and the button appears.
   *
   * @param {object} opts
   * @param {string} opts.prompt
   * @param {number} [opts.timeoutMs]
   * @param {Document} [opts.doc]
   * @param {Function} [opts.now]
   * @param {Function} [opts.setT]
   * @param {Function} [opts.sleep]
   * @param {Function} [opts.log]
   * @returns {Promise<{ok: boolean, reason?: string, step?: string,
   *                    submitted?: boolean}>}
   */
  async function typeAndSend(opts = {}) {
    const {
      prompt,
      timeoutMs = STEP_TIMEOUT_MS,
      doc = document,
      now = Date.now,
      setT = setTimeout,
      sleep: sleepFn = sleep,
      log = () => {}
    } = opts;

    const text = typeof prompt === "string" ? prompt.trim() : "";
    if (!text) {
      return { ok: false, reason: "empty_prompt", step: "validate" };
    }

    if (!isTabVisible(doc)) {
      log("[typing] step=visibility FAILED tab is not foregrounded");
      return { ok: false, reason: "tab_not_visible", step: "visibility" };
    }

    if (!findEditor(doc)) {
      log(`[typing] step=editor FAILED selector="${SELECTORS.editor}"`);
      return { ok: false, reason: "editor_not_found", step: "editor" };
    }

    // Step 1 — fill the box. Read back rather than trusting the write.
    //
    // Routed through the MAIN world: an isolated-world write is reconciled
    // away by Angular, which is why the editor stayed empty on every live run
    // of 4.7.3. See typeViaMainWorld.
    const applied = await setPromptTextAsync(text, { doc, setT });
    if (!applied) {
      log(`[typing] step=fill FAILED (text did not land cleanly)`);
      return { ok: false, reason: "prompt_text_not_applied", step: "fill" };
    }
    log(`[typing] step=fill ok chars=${text.length}`);

    // Step 2 — wait for the send control. It only exists once Gemini
    // believes the editor has content, so its absence means the text did
    // not register even if the DOM looks right.
    const send = await waitFor(
      (d) => {
        const b = findSendButton(d);
        if (!b) return null;
        return b.hasAttribute("disabled") || b.getAttribute("aria-disabled") === "true" ? null : b;
      },
      Math.min(timeoutMs, 8000), doc, now, setT
    );
    if (!send) {
      log(`[typing] step=send_button FAILED selector="${SELECTORS.sendButton}"`);
      return { ok: false, reason: "send_button_not_found", step: "send_button" };
    }
    log(`[typing] step=send_button ok selector="${SELECTORS.sendButton}"`);

    // Step 3 — click and confirm the page actually accepted it. A click
    // on a detached or re-rendered control does nothing at all, and this is
    // the difference between "submitted" and "believed it was submitted".
    // KAN-182: the response count is captured HERE, before the send, and not by
    // the collector afterwards. Gemini can render the answer before the worker
    // gets round to asking for it, so a collector that snapshots on arrival is
    // already looking at the answer it is waiting for and concludes nothing new
    // ever appeared — measured live on 2026-09-29, where a perfectly good third
    // turn was reported as `no_answer_rendered` with `responses on screen=3`.
    // The baseline has to predate the request.
    const before = countUserQueries(doc);
    const responsesBefore = countModelResponses(doc);
    send.click();

    const accepted = await waitFor(
      (d) => (countUserQueries(d) > before ? true : null),
      Math.min(timeoutMs, 10000), doc, now, setT
    );
    if (!accepted) {
      log("[typing] step=confirm FAILED no new user-query appeared after clicking send");
      return { ok: false, reason: "prompt_not_submitted", step: "confirm" };
    }
    log(`[typing] step=confirm ok user-query rendered (responses before=${responsesBefore})`);

    return { ok: true, submitted: true, responsesBefore };
  }

  const api = {
    SELECTORS,
    isTabVisible,
    getQuill,
    findEditor,
    findSendButton,
    editorHasText,
    setPromptText,
    setPromptTextAsync,
    typeViaMainWorld,
    clearPrompt,
    countUserQueries,
    countModelResponses,
    typeAndSend,
    waitFor
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.PromptTyping = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

