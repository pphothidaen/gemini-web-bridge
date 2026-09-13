// ============================================================
// Gemini Web-Bridge: Main World Injected Script
// Declarative Early Interceptor & Native Gemini RPC Observer
// ============================================================

(function () {
  "use strict";

  console.log("[Gemini Cloudflare Bridge Injected] Main World Interceptor Initialized (Declarative MAIN).");

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

  // ─── 1. Token & Session Extraction (MAIN World Memory Only) ─
  function inspectWizGlobalData() {
    try {
      const wizData = window.WIZ_global_data;
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
    return isReady;
  }

  // Initial session broadcast with polling fallback until WIZ_global_data hydrates
  if (!broadcastSessionState()) {
    let attempts = 0;
    const tokenPoll = setInterval(() => {
      attempts++;
      if (broadcastSessionState() || attempts > 30) {
        clearInterval(tokenPoll);
      }
    }, 500);
  }

  // ─── 2. Recognized Endpoints & Payload Decoder ─────────────
  const GEMINI_ORIGIN = "https://gemini.google.com";
  const RECOGNIZED_PATHS = [
    "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
    "/_/BardChatUi/data/batchexecute"
  ];

  function matchRecognizedEndpoint(urlStr) {
    try {
      const parsed = new URL(urlStr, window.location.href);
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
    if (typeof val === "string") {
      return { type: "string", length: val.length };
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

  const originalFetch = window.fetch;

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

  // Intercept XMLHttpRequest
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

  // ─── 4. Message Bus from Content Script ─────────────────────
  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.source !== "GEMINI_CONTENT") {
      return;
    }

    const { type, requestId, payload } = event.data;

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

    // Execute Stream (Replay via verified adapter ONLY)
    if (type === "EXECUTE_STREAM") {
      const abortController = new AbortController();
      activeExecutions.set(requestId, abortController);

      try {
        inspectWizGlobalData();
        if (!activeCsrfToken) {
          throw new Error("Missing CSRF token in Gemini MAIN session.");
        }

        const buildLabel = activeBuildLabel || "boq_assistant-bard-web-server_20260901.00_p0";
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

})();
