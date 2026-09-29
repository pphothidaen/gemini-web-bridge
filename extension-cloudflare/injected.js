// ============================================================
// Gemini Web-Bridge: Main World Injected Script
// Declarative Early Interceptor & Native Gemini RPC Observer
// ============================================================

(function (root) {
  "use strict";

  if (typeof console !== "undefined" && console.log) {
    console.log("[Gemini Cloudflare Bridge Injected] Main World Interceptor Initialized (Declarative MAIN).");
  }

  // In-memory private storage in MAIN world (CSRF token NEVER leaves MAIN world)
  let activeCsrfToken = null;
  let activeBuildLabel = null;
  let activeAccountHash = null;
  const currentSessionEpoch = `epoch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Track active bridge executions for cancellation and hook bypass
  const activeExecutions = new Map(); // requestId -> AbortController
  const internalBridgeCalls = new WeakSet();

  // Current canonical model ID tracked from DOM/UI selector state
  let currentCanonicalModelId = null;

  // ─── String classification for sanitized evidence (KAN-196) ──
  //
  // A length alone cannot say what a field holds: two different values can
  // share a length, so "this field changed size" does not tell you whether a
  // notebook reference appeared in it, vanished, or was replaced by something
  // else of similar size. That ambiguity is what left the replay-path question
  // open after KAN-195.
  //
  // So each sanitized string also carries a class. The classes are shapes the
  // PROTOCOL defines, not shapes the user supplies, and only a fixed prefix
  // allowlist is consulted — no prefix, substring, hash or first-N of an
  // arbitrary string is ever recorded. A user's prompt cannot match any of
  // these prefixes, so it lands in OPAQUE with nothing about it retained, which
  // is what keeps GUARDRAILS G1.2.1 satisfied.
  //
  // The question this answers is not "what does field 3 contain" but "does any
  // field carry a notebook reference at all" — one bit per field, carried by
  // the protocol rather than by the person typing.
  const STRING_CLASS = {
    NOTEBOOK_REF: "notebook_ref",  // notebook://…/sources/…
    URL:         "url",            // http:// or https://
    UUID:        "uuid",           // bare 8-4-4-4-12 hex
    BUILD_LABEL: "build_label",    // boq_…
    JSON_BLOB:   "json_blob",      // parses as JSON
    OPAQUE:      "opaque"          // everything else, including the prompt
  };

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * Name the SHAPE of a string without keeping any of it.
   *
   * Order is fixed and load-bearing. NOTEBOOK_REF is tested before URL because
   * a notebook reference is protocol-specific and must not be absorbed by a
   * looser scheme test. JSON_BLOB is last among the specific classes: it is
   * the most expensive test and the least specific, and "this field is a
   * serialized blob" is itself the useful answer for the list that carries
   * notebook references.
   *
   * A prompt that happens to open with "[" must not be filed as a blob, so
   * JSON.parse has to actually succeed.
   */
  function classifyString(str) {
    if (typeof str !== "string" || str.length === 0) return STRING_CLASS.OPAQUE;
    if (str.startsWith("notebook://")) return STRING_CLASS.NOTEBOOK_REF;
    if (str.startsWith("https://") || str.startsWith("http://")) return STRING_CLASS.URL;
    if (UUID_RE.test(str)) return STRING_CLASS.UUID;
    if (str.startsWith("boq_")) return STRING_CLASS.BUILD_LABEL;
    const first = str[0];
    if (first === "[" || first === "{") {
      try {
        JSON.parse(str);
        return STRING_CLASS.JSON_BLOB;
      } catch (e) {
        return STRING_CLASS.OPAQUE;
      }
    }
    return STRING_CLASS.OPAQUE;
  }

  // ─── 0. Prompt typing in the MAIN world (KAN-182) ───
  //
  // Kept here rather than in prompt-typing.js because of where the Quill
  // instance lives. Content scripts run in the ISOLATED world, which shares
  // the DOM but not JavaScript expandos: a `__quill` property that Angular
  // sets on `rich-textarea` in the page's own context is invisible to the
  // isolated world. That is why the isolated-side lookups always came back
  // null, and why every DOM-level fallback was reconciled away.
  //
  // Selectors are the same ones verified live in the isolated world, since
  // the DOM is genuinely shared. Localization-proof: no aria-label, no text.
  const PROMPT_EDITOR_SELECTORS = {
    richTextarea: "input-area-v2 rich-textarea",
    editor: 'input-area-v2 .ql-editor[contenteditable="true"]'
  };

  /**
   * The Quill instance backing Gemini's prompt box, from the world that owns it.
   *
   * Checks the host first, then the inner editor: different Gemini builds hang
   * the instance off different elements, and guessing wrong is silent.
   */
  function findQuillInMainWorld(doc = (typeof document !== "undefined" ? document : null)) {
    if (!doc || typeof doc.querySelector !== "function") return null;
    const host = doc.querySelector(PROMPT_EDITOR_SELECTORS.richTextarea);
    if (!host) return null;
    if (host.__quill) return host.__quill;
    const editor = host.querySelector(PROMPT_EDITOR_SELECTORS.editor);
    if (editor && editor.__quill) return editor.__quill;
    return null;
  }

  /**
   * Put `text` in the prompt box and report what the editor actually holds.
   *
   * Order matters and each step is verified, because the failure modes all
   * look like success from the outside:
   *
   *   1. `quill.setText(t, 'user')` — the only form that makes Angular aware
   *      of the content, so the send button appears. `'api'` writes the text
   *      but no button ever shows up; `'silent'` likewise.
   *   2. `execCommand('insertText')` on the focused editor — for a build with
   *      no reachable Quill instance.
   *   3. `textContent` — last resort only. It is known to double the text when
   *      it works, and the read-back below is what catches that.
   *
   * The returned text is read from the DOM, never assumed from the write.
   */
  /**
   * Push the value into Angular's own model, when Angular exposes its debug
   * API. This is what makes a Quill write persist.
   *
   * Why it is needed: `quill.setText(t, "user")` does emit Quill's
   * `text-change`, but it runs outside `NgZone` when called from a MAIN-world
   * script, so the wrapper's `onChange` never reaches the `FormControl`. The
   * form value stays `""`, and the next change-detection pass calls
   * `ControlValueAccessor.writeValue("")` — which resets the editor. Retrying
   * the write alone just flickers against that loop; syncing the model is what
   * stops it.
   *
   * Best-effort: `window.ng` is absent in some production builds, in which case
   * this returns false and the caller keeps the other strategies.
   */
  function syncAngularModel(host, value) {
    try {
      const ng = (typeof window !== "undefined" && window.ng) || null;
      if (!ng) return false;
      let comp = null;
      if (typeof ng.getComponent === "function") comp = ng.getComponent(host);
      if (!comp && typeof ng.getDirectives === "function") {
        const dirs = ng.getDirectives(host);
        comp = (Array.isArray(dirs) && dirs[0]) || null;
      }
      if (!comp) return false;

      // The binding name differs per wrapper, so try the common ones rather
      // than guessing one and failing silently.
      for (const key of ["formControl", "control", "model", "value"]) {
        const target = comp[key];
        if (target && typeof target.setValue === "function") {
          target.setValue(value);
          if (typeof ng.applyChanges === "function") ng.applyChanges(comp);
          return true;
        }
      }
      if (typeof ng.applyChanges === "function") {
        ng.applyChanges(comp);
        return true;
      }
    } catch (e) {
      // Debug API shape differs by build; treat any failure as "unavailable".
    }
    return false;
  }

  /**
   * Put `text` in the prompt box and report what the editor ACTUALLY holds
   * after Angular has had a chance to reconcile.
   *
   * Why this is async and why it re-reads
   * --------------------------------------
   * The synchronous version read the editor back immediately and reported
   * success, and that was wrong. Live on 2026-09-29: `setText` wrote the text,
   * the immediate read-back returned it, and milliseconds later Angular
   * reconciled the editor back to `ql-blank`. The read-back was reporting a
   * transient value — a false positive of exactly the kind this ticket has
   * been about at every layer.
   *
   * Settledness is read from the `ql-blank` class rather than from the text,
   * because that class IS the state Angular restores, so it is the honest
   * signal that a write survived rather than one that merely looked fine for a
   * frame.
   *
   * The retry is bounded, and only re-applies while the editor is still blank.
   */
  async function typePromptInMainWorld(text, opts = {}) {
    const {
      settleMs = 250,
      maxAttempts = 3,
      setT = setTimeout,
      doc = (typeof document !== "undefined" ? document : null)
    } = opts;

    const value = typeof text === "string" ? text : "";
    if (!value.trim()) {
      return { ok: false, reason: "empty_prompt", text: "", attempts: 0 };
    }
    if (!doc || typeof doc.querySelector !== "function") {
      return { ok: false, reason: "document_not_available", text: "", attempts: 0 };
    }

    const sleep = (ms) => new Promise((resolve) => setT(resolve, ms));
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const editorSel = PROMPT_EDITOR_SELECTORS.editor;
    const hostSel = PROMPT_EDITOR_SELECTORS.richTextarea;
    const wanted = norm(value);

    const readEditor = () => {
      const el = doc.querySelector(editorSel);
      return el ? (el.innerText || el.textContent || "") : "";
    };

    // `ql-blank` is what Angular puts back when it reverts, so it is the
    // signal that actually answers "did this survive?" — the text can be
    // present for a frame and gone by the next, and a text-only read-back
    // cannot tell those apart.
    const isBlank = () => {
      const el = doc.querySelector(editorSel);
      if (!el) return true;
      const cls = el.className;
      if (typeof cls === "string" && cls.indexOf("ql-blank") !== -1) return true;
      return norm(el.innerText || el.textContent || "") === "";
    };

    let attempts = 0;
    let lastSeen = "";
    let ngSynced = false;

    for (; attempts < Math.max(1, maxAttempts); attempts++) {
      const editor = doc.querySelector(editorSel);
      if (!editor) {
        return { ok: false, reason: "editor_not_found", text: "", attempts };
      }
      const host = doc.querySelector(hostSel);

      const quill = findQuillInMainWorld(doc);
      if (quill && typeof quill.setText === "function") {
        quill.setText(value, "user");
        if (typeof quill.setSelection === "function") {
          try {
            quill.setSelection(quill.getLength(), quill.getLength(), "silent");
          } catch (e) {
            // Selection is cosmetic; the text is already in the model.
          }
        }
        // Zone.js hooks native events, so give it one to enqueue an Angular tick.
        try {
          const evt = typeof InputEvent !== "undefined"
            ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })
            : { type: "input", bubbles: true, inputType: "insertText", data: value };
          editor.dispatchEvent(evt);
        } catch (e) {
          // The settled read below is still the verdict.
        }
        // The part that makes it persist: get the value into the form model.
        if (host) ngSynced = syncAngularModel(host, value) || ngSynced;
      } else {
        // No Quill reachable. Focus first — execCommand does nothing on a
        // blurred editable, indistinguishable from a broken selector.
        try {
          editor.focus();
        } catch (e) {
          // Fall through; the write below still reports what happened.
        }
        let inserted = false;
        try {
          inserted = doc.execCommand("insertText", false, value);
        } catch (e) {
          inserted = false;
        }
        if (!inserted) {
          editor.textContent = value;
          try {
            const evt = typeof InputEvent !== "undefined"
              ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })
              : { type: "input", bubbles: true, inputType: "insertText", data: value };
            editor.dispatchEvent(evt);
          } catch (e) {
            // The settled read-back below is the real verdict.
          }
        }
      }

      // Let change detection run, then read what survived. Reading now would
      // only see the transient value and would report a false success.
      await sleep(settleMs);
      lastSeen = readEditor();

      if (!isBlank() && norm(lastSeen).indexOf(wanted) !== -1) {
        return {
          ok: true,
          reason: "",
          text: lastSeen,
          attempts: attempts + 1,
          settled: true,
          ngSynced
        };
      }
    }

    // Every attempt was reverted. Say so plainly, and report whether the
    // Angular model was reachable, because that decides the next step: no `ng`
    // plus a persistent revert means the write is being rejected outright and
    // only a trusted input event can get through.
    return {
      ok: false,
      reason: isBlank() ? "text_reverted_after_settle" : "text_mismatch",
      text: lastSeen,
      attempts,
      settled: true,
      ngSynced
    };
  }

  // ─── 1. Token & Session Extraction (MAIN World Memory Only) ─
  function inspectWizGlobalData() {
    try {
      const wizData = (typeof window !== "undefined" && window.WIZ_global_data) || null;
      if (!wizData) return false;

      // Extract CSRF 'at' token - kept strictly inside MAIN world memory
      if (wizData.SNlM0e) {
        activeCsrfToken = wizData.SNlM0e;
      }
      if (wizData.cfb2h) {
        activeBuildLabel = wizData.cfb2h;
      }
      // Simple hash of user account identifier if available (e.g. o_u index or email placeholder)
      if (wizData.o_u !== undefined) {
        activeAccountHash = String(wizData.o_u);
      }
      return Boolean(activeCsrfToken);
    } catch (e) {
      return false;
    }
  }

  function broadcastSessionState() {
    const isReady = inspectWizGlobalData();
    if (typeof window !== "undefined" && typeof window.postMessage === "function") {
      window.postMessage({
        source: "GEMINI_INJECTED",
        type: "SESSION_STATE",
        payload: {
          sessionReady: isReady,
          buildLabel: activeBuildLabel,
          sessionEpoch: currentSessionEpoch,
          accountHash: activeAccountHash
        }
      }, "*");
    }
    return isReady;
  }

  // Initial session broadcast with polling fallback until WIZ_global_data hydrates
  if (typeof window !== "undefined") {
    if (!broadcastSessionState()) {
      let attempts = 0;
      const tokenPoll = setInterval(() => {
        attempts++;
        if (broadcastSessionState() || attempts > 30) {
          clearInterval(tokenPoll);
        }
      }, 500);
    }
  }

  // ─── 2. Recognized Endpoints & Payload Decoder ─────────────
  const GEMINI_ORIGIN = "https://gemini.google.com";
  const RECOGNIZED_PATHS = [
    "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
    "/_/BardChatUi/data/batchexecute"
  ];

  function matchRecognizedEndpoint(urlStr) {
    try {
      const baseHref = (typeof window !== "undefined" && window.location?.href) || GEMINI_ORIGIN;
      const parsed = new URL(urlStr, baseHref);
      if (parsed.origin !== GEMINI_ORIGIN) return null;
      for (const path of RECOGNIZED_PATHS) {
        if (parsed.pathname.includes(path)) {
          return {
            endpoint: path.includes("StreamGenerate") ? "StreamGenerate" : "BatchExecute",
            canonicalPath: path,
            buildLabel: parsed.searchParams.get("bl") || activeBuildLabel
          };
        }
      }
    } catch (e) {}
    return null;
  }

  /**
   * Bounded decoding of known JSON envelope fields.
   * Parses outer f.req parameter and nested JSON string inside it,
   * completely replacing prompt strings with structural placeholders.
   */
  function decodeAndSanitizePayload(rawBody) {
    if (!rawBody) return null;
    try {
      let bodyStr = "";
      if (typeof rawBody === "string") {
        bodyStr = rawBody;
      } else if (rawBody instanceof URLSearchParams) {
        bodyStr = rawBody.toString();
      }

      if (!bodyStr.includes("f.req=")) return null;

      const params = new URLSearchParams(bodyStr);
      const fReq = params.get("f.req");
      if (!fReq) return null;

      const outerArray = JSON.parse(fReq);
      if (!Array.isArray(outerArray)) return null;

      // Decode inner serialized JSON string if present (e.g. outerArray[1])
      const innerArray = (typeof outerArray[1] === "string" && outerArray[1].startsWith("["))
        ? JSON.parse(outerArray[1])
        : outerArray[1];

      return {
        outerLength: outerArray.length,
        hasEnvelope: Array.isArray(innerArray),
        structure: extractBoundedStructure(innerArray)
      };
    } catch (e) {
      return null;
    }
  }

  function extractBoundedStructure(val, depth = 0) {
    if (depth > 6) return "max_depth";
    if (val === null) return null;
    if (val === undefined) return undefined;
    if (typeof val === "boolean") return val;
    if (typeof val === "number") return typeof val;

    // Never preserve user prompt text or model response text!
    // `cls` names the shape only — see classifyString above and GUARDRAILS
    // G1.2.1. It is what makes a length delta attributable: without it, a
    // field that changed size could have gained a notebook reference, lost
    // one, or held something unrelated all along.
    if (typeof val === "string") {
      return { type: "string", length: val.length, cls: classifyString(val) };
    }

    if (Array.isArray(val)) {
      return val.slice(0, 20).map(item => extractBoundedStructure(item, depth + 1));
    }

    if (typeof val === "object") {
      const out = {};
      for (const [k, v] of Object.entries(val).slice(0, 20)) {
        out[k] = extractBoundedStructure(v, depth + 1);
      }
      return out;
    }

    return typeof val;
  }

  // ─── 3. Early Fetch & XHR Interceptors ───────────────────────
  // Captures SUCCESSFUL responses only. Zero learning from bridge replay.

  // ─── Sanitized payload probe (KAN-196) ───────────────────────
  //
  // Off by default, and toggled at runtime from the page console:
  //   window.postMessage({source:"GEMINI_CONTENT",
  //                        type:"PAYLOAD_PROBE_SET", enabled:true}, "*")
  //
  // KAN-195's probe was a hand-inserted console.log that had to be committed,
  // built and reloaded before every capture. This one is gated so a later
  // capture costs one message instead, and so a debugging aid can never be
  // left switched on in a build that ships.
  //
  // What it writes is `requestStructure` — already reduced to {type,length,cls}
  // by extractBoundedStructure, so it holds no prompt text (GUARDRAILS
  // G1.2.1) and no CSRF token. It goes to the console and nowhere else: the
  // console is the only sink that cannot persist anything, which is what made
  // the KAN-195 capture acceptable in the first place.
  let payloadProbeEnabled = false;

  function probeRecord(matched, transport, requestStructure, modelId) {
    if (!requestStructure) return null;
    return {
      endpoint: matched.endpoint,
      transport,
      buildLabel: matched.buildLabel || activeBuildLabel,
      sessionEpoch: currentSessionEpoch,
      canonicalModelId: modelId || null,
      structure: requestStructure
    };
  }

  function logProbeRecord(record) {
    if (!record || !payloadProbeEnabled) return;
    if (typeof console === "undefined") return;
    try {
      console.log("PAYLOAD_PROBE " + JSON.stringify(record));
    } catch (e) {}
  }

  /** Accepts only a boolean; anything else leaves the flag as it was. */
  function handleProbeSet(msg) {
    if (!msg || typeof msg.enabled !== "boolean") return false;
    payloadProbeEnabled = msg.enabled;
    return payloadProbeEnabled;
  }

  const originalFetch = (typeof window !== "undefined" && typeof window.fetch === "function") ? window.fetch : null;

  if (typeof window !== "undefined" && originalFetch) {
    window.fetch = async function (input, init) {
      let urlStr = "";
      let requestInit = init || {};

      if (typeof input === "string") {
        urlStr = input;
      } else if (input instanceof URL) {
        urlStr = input.toString();
      } else if (input && typeof input === "object" && input.url) {
        urlStr = input.url;
        requestInit = { ...input, ...init };
      }

      // Check if internal bridge replay call (WeakSet check, NO custom headers sent upstream)
      const isBridgeCall = internalBridgeCalls.has(requestInit) || (init && internalBridgeCalls.has(init));
      if (isBridgeCall) {
        return originalFetch.apply(this, arguments);
      }

      const matched = matchRecognizedEndpoint(urlStr);
      if (!matched) {
        return originalFetch.apply(this, arguments);
      }

      // Capture model ID at request initiation time
      const modelIdAtRequestTime = currentCanonicalModelId;
      const requestStructure = decodeAndSanitizePayload(requestInit.body);

      // Logged before the response is awaited, so a slow or hanging endpoint
      // cannot delay or reorder the record relative to the request itself.
      logProbeRecord(probeRecord(matched, "fetch", requestStructure, modelIdAtRequestTime));


      const response = await originalFetch.apply(this, arguments);

      // Only qualify successful responses (HTTP 200) with valid Gemini envelope
      if (response.ok && response.status === 200 && requestStructure) {
        try {
          const clone = response.clone();
          const reader = clone.body?.getReader();
          if (reader) {
            reader.read().then(({ value }) => {
              if (value) {
                const preview = new TextDecoder().decode(value.slice(0, 100));
                // Verify Gemini RPC envelope prefix
                if (preview.includes(")]}'") || preview.includes("wrb.fr")) {
                  window.postMessage({
                    source: "GEMINI_INJECTED",
                    type: "NATIVE_RPC_OBSERVED",
                    evidence: {
                      endpoint: matched.endpoint,
                      canonicalPath: matched.canonicalPath,
                      buildLabel: matched.buildLabel || activeBuildLabel,
                      sessionEpoch: currentSessionEpoch,
                      canonicalModelId: modelIdAtRequestTime,
                      timestamp: Date.now(),
                      requestSignature: requestStructure,
                      responseVerified: true
                    }
                  }, "*");
                }
              }
            }).catch(() => {});
          }
        } catch (e) {}
      }

      return response;
    };
  }

  // Intercept XMLHttpRequest
  const hasXhr = typeof XMLHttpRequest !== "undefined" && XMLHttpRequest.prototype;
  if (hasXhr) {
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this._bridgeUrl = String(url);
      return originalXhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      const matched = matchRecognizedEndpoint(this._bridgeUrl || "");
      if (!matched) {
        return originalXhrSend.apply(this, arguments);
      }

      const modelIdAtRequestTime = currentCanonicalModelId;
      const requestStructure = decodeAndSanitizePayload(body);

      // The prompt travels over XHR, so the fetch-side probe alone never sees
      // it — a fetch-only capture produces structures with no prompt field and
      // is what made the first KAN-195 pass come back empty.
      logProbeRecord(probeRecord(matched, "xhr", requestStructure, modelIdAtRequestTime));


      this.addEventListener("loadend", () => {
        if (this.status === 200 && requestStructure) {
          const text = typeof this.responseText === "string" ? this.responseText.slice(0, 100) : "";
          if (text.includes(")]}'") || text.includes("wrb.fr")) {
            window.postMessage({
              source: "GEMINI_INJECTED",
              type: "NATIVE_RPC_OBSERVED",
              evidence: {
                endpoint: matched.endpoint,
                canonicalPath: matched.canonicalPath,
                buildLabel: matched.buildLabel || activeBuildLabel,
                sessionEpoch: currentSessionEpoch,
                canonicalModelId: modelIdAtRequestTime,
                timestamp: Date.now(),
                requestSignature: requestStructure,
                responseVerified: true
              }
            }, "*");
          }
        }
      }, { once: true });

      return originalXhrSend.apply(this, arguments);
    };
  }

  // ─── 4. Message Bus from Content Script ─────────────────────
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.source !== "GEMINI_CONTENT") {
      return;
    }

    const { type, requestId, payload } = event.data;

    // Runtime toggle for the sanitized payload probe (KAN-196). Off unless a
    // boolean explicitly turns it on.
    if (type === "PAYLOAD_PROBE_SET") {
      handleProbeSet(event.data);
      return;
    }

    // Explicit Handshake Re-request
    if (type === "REQUEST_SESSION_STATE") {
      broadcastSessionState();
      return;
    }

    // Synchronize Canonical Model ID from UI selection
    if (type === "CANONICAL_MODEL_UPDATED") {
      currentCanonicalModelId = payload?.modelId || null;
      return;
    }

    // KAN-182: type a prompt into Gemini's own input box.
    //
    // This has to run HERE, in the MAIN world, and that is the whole point.
    // The content script lives in the ISOLATED world, which shares the DOM but
    // not JavaScript expandos: `rich-textarea.__quill`, which Angular sets in
    // the page's own context, is simply not visible from there. So
    // `getQuill()` in prompt-typing.js returns null no matter how it looks,
    // and the isolated-world fallbacks (`textContent`, a synthetic
    // InputEvent, `execCommand`) all get reconciled away by Angular —
    // measured live on 2026-09-29: the editor stayed `ql-blank`, no prompt was
    // ever sent, and the call reported the previous turn's answer.
    //
    // Driving Quill's own API from the world that owns the instance produces a
    // real model update, which is what makes the send button appear. The
    // reply carries the read-back text so the isolated side verifies rather
    // than assumes.
    if (type === "TYPE_PROMPT_INTO_EDITOR") {
      const requestId = payload?.requestId || requestId || null;
      const text = typeof payload?.text === "string" ? payload.text : "";
      // Awaited: the write now settles before reporting, so the reply carries
      // the value that survived change detection rather than the transient one.
      let outcome;
      try {
        outcome = await typePromptInMainWorld(text);
      } catch (err) {
        outcome = { ok: false, reason: err?.message || "main_world_type_failed", text: "", attempts: 0 };
      }
      window.postMessage({
        source: "GEMINI_INJECTED",
        type: "PROMPT_TYPED",
        requestId,
        ok: Boolean(outcome.ok),
        reason: outcome.reason || "",
        text: outcome.text || "",
        attempts: outcome.attempts || 0
      }, "*");
      return;
    }

    // Execute Stream (Replay via verified adapter ONLY)
    if (type === "EXECUTE_STREAM") {
      const abortController = new AbortController();
      activeExecutions.set(requestId, abortController);

      try {
        inspectWizGlobalData();
        if (!activeCsrfToken) {
          throw new Error("Missing CSRF token in Gemini MAIN session.");
        }

        if (!activeBuildLabel) {
          throw new Error("Missing build label (cfb2h) from Gemini session. Reload the page.");
        }
        const buildLabel = activeBuildLabel;
        const reqId = Math.floor(Math.random() * 900000) + 100000;
        const url = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${encodeURIComponent(buildLabel)}&_reqid=${reqId}&rt=c`;

        const bodyParams = new URLSearchParams();
        bodyParams.append("f.req", payload.f_req);
        bodyParams.append("at", activeCsrfToken);

        const fetchInit = {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "X-Same-Domain": "1"
          },
          body: bodyParams.toString(),
          credentials: "include",
          signal: abortController.signal
        };

        // Mark internal bridge call in WeakSet so fetch hook completely ignores it
        internalBridgeCalls.add(fetchInit);

        const response = await originalFetch(url, fetchInit);

        if (!response.ok) {
          throw new Error(`Google Web Endpoint returned HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            window.postMessage({
              source: "GEMINI_INJECTED",
              type: "STREAM_DONE",
              requestId
            }, "*");
            break;
          }

          const rawChunk = decoder.decode(value, { stream: true });
          window.postMessage({
            source: "GEMINI_INJECTED",
            type: "STREAM_CHUNK",
            requestId,
            chunk: rawChunk
          }, "*");
        }
      } catch (err) {
        const isAborted = err.name === "AbortError" || abortController.signal.aborted;
        window.postMessage({
          source: "GEMINI_INJECTED",
          type: "STREAM_ERROR",
          requestId,
          error: isAborted ? "Request was cancelled" : err.message,
          code: isAborted ? "cancelled" : "execution_failed"
        }, "*");
      } finally {
        activeExecutions.delete(requestId);
      }
    }

    // Cancel Stream
    if (type === "CANCEL_STREAM") {
      const controller = activeExecutions.get(requestId);
      if (controller) {
        controller.abort();
        activeExecutions.delete(requestId);
      }
    }
  });
  }

  const api = {
    PROMPT_EDITOR_SELECTORS,
    findQuillInMainWorld,
    syncAngularModel,
    typePromptInMainWorld,
    inspectWizGlobalData,
    broadcastSessionState,
    matchRecognizedEndpoint,
    decodeAndSanitizePayload,
    STRING_CLASS,
    classifyString,
    extractBoundedStructure,
    handleProbeSet
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.GeminiInjected = api;
  root.__GeminiBridgeMain = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
