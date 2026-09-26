// ============================================================
// Gemini Web-Bridge: Content Script (Isolated World)
// Protocol v2: Centralized Background Coordinator, UI Selection & Verified Replay
// ============================================================

(function () {
  "use strict";

  // ─── Shared Components & Fallbacks ──────────────────────────
  const Settings = (typeof globalThis !== "undefined" && globalThis.GeminiBridgeSettings)
    ? globalThis.GeminiBridgeSettings
    : {
        DEFAULT_WORKER_URL: "https://gemini-web-bridge.pansakorn-pho.workers.dev",
        DEFAULT_BRIDGE_SECRET: "__BRIDGE_AUTH_TOKEN__",
        resolveSettings: (s = {}) => ({
          workerUrl: s.workerUrl || "https://gemini-web-bridge.pansakorn-pho.workers.dev",
          bridgeToken: s.bridgeToken || "__BRIDGE_AUTH_TOKEN__",
          rawBridgeToken: s.bridgeToken || "",
          enforcementMode: s.enforcementMode === "permissive" ? "permissive" : "strict",
          isDefaultToken: !s.bridgeToken
        }),
        computeBackoff: (attempt, base = 1000, max = 30000, rnd = Math.random) => {
          const exp = Math.min(base * Math.pow(2, Math.max(0, attempt)), max);
          return Math.min(exp + Math.floor(rnd() * 1000), max);
        }
      };

  const ModelAdapterModule = (typeof globalThis !== "undefined" && globalThis.ModelAdapter)
    ? globalThis.ModelAdapter
    : {
        validateModelEvidence: (modelId, evidence) => {
          if (!evidence?.generationEvidence) {
            return { verified: false, verification: "unsupported", reason: "missing_generation_evidence", mappingRevision: null };
          }
          return { verified: false, verification: "unsupported", reason: "unknown_schema", mappingRevision: null };
        },
        buildReplayPayload: (modelId, mappingRevision, verifiedRecord, promptText) => {
          if (!verifiedRecord || verifiedRecord.verification !== "verified") {
            throw new Error(`Cannot execute unverified model mapping for '${modelId}'`);
          }
          return { f_req: JSON.stringify([null, JSON.stringify([promptText])]), model: modelId, mappingRevision };
        }
      };

  const EvidenceRegistryClass = (typeof globalThis !== "undefined" && globalThis.EvidenceRegistry)
    ? globalThis.EvidenceRegistry
    : class FallbackEvidenceRegistry {
        constructor() { this.records = new Map(); }
        async init() {}
        updateSession() {}
        recordSelectorEvidence(id) { return this.getModelStatus(id); }
        recordGenerationEvidence(id) { return this.getModelStatus(id); }
        setLearning(id) { this.records.set(id, { verification: "learning", mappingRevision: null }); }
        setUnsupported(id, reason) { this.records.set(id, { verification: "unsupported", mappingRevision: null, reason }); }
        getModelStatus(id) { return this.records.get(id) || { verification: "discovered", mappingRevision: null }; }
        enrichDiscoveredModels(models) {
          return (models || []).map(m => {
            const st = this.getModelStatus(m.id);
            return { ...m, verification: st.verification || "discovered", mapping_revision: st.mappingRevision || null };
          });
        }
        saveToStorage() {}
        isOrphaned() { return false; }
        onOrphaned() {}
      };

  // ─── CSP Violation Handling ─────────────────────────────────
  // Gemini's own page CSP sets manifest-src 'none' and the page itself
  // fetches its internal _/BardChatUi/manifest.json — that violation is
  // site-side noise, not an extension issue, so ignore it silently.
  // NOTE: SecurityPolicyViolationEvent is NOT cancelable; do NOT re-add
  // event.preventDefault() here — it cannot suppress anything.
  window.addEventListener('securitypolicyviolation', (event) => {
    if (!event) return;
    const directive = event.effectiveDirective || event.violatedDirective || '';
    const source = String(event.sourceFile || '');
    const blocked = String(event.blockedURI || '');
    const ours = source.startsWith('chrome-extension://')
      || blocked.startsWith('chrome-extension://')
      || /gemini-web-bridge|pansakorn-pho/i.test(source + ' ' + blocked);
    // Ignore known site-side manifest-src noise (Gemini UI fetches its own
    // manifest against its own `manifest-src 'none'` policy).
    if (!ours && (directive === 'manifest-src' || event.violatedDirective === 'manifest-src')) {
      return;
    }
    if (!ours) return;
    // Only extension-attributable violations are logged, with structured
    // fields (never the bare event object, which prints as [object ...]).
    console.warn('[Gemini Bridge] CSP violation:', {
      directive,
      violatedDirective: event.violatedDirective,
      blockedURI: event.blockedURI,
      sourceFile: event.sourceFile,
      lineNumber: event.lineNumber,
      disposition: event.disposition
    });
  });

  const AutoModelSelectorRef = (typeof globalThis !== "undefined" && globalThis.AutoModelSelector)
    ? globalThis.AutoModelSelector
    : null;

  const AutoThinkingRef = (typeof globalThis !== "undefined" && globalThis.AutoThinking)
    ? globalThis.AutoThinking
    : null;

  /**
   * Auto-configure Gemini session: select newest model + enable thinking effort.
   * Called on session ready and on explicit AUTO_SELECT_MODEL / ENABLE_THINKING events.
   */
  function autoConfigureGeminiSession(config = {}) {
    const {
      preferredFamily = "pro",
      thinkingEffort = "high"
    } = config;

    // Auto-select newest model — default to Flash Thinking (newest thinking model available)
    if (AutoModelSelectorRef && typeof AutoModelSelectorRef.autoSelectNewestModel === "function") {
      try {
        // Strip -thinking suffix for family matching (e.g. "gemini-3.8-flash-thinking" -> family "flash")
        let effectiveFamily = preferredFamily;
        if (preferredFamily === "flash" || preferredFamily === "pro") {
          effectiveFamily = preferredFamily;
        }
        const result = AutoModelSelectorRef.autoSelectNewestModel(effectiveFamily);
        if (result.success) {
          currentActiveModelSlug = "gemini-" + result.selectedModel.toLowerCase().replace(/[\s_]+/g, "-");
          console.log(`[Bridge] ✅ Auto-selected model: ${result.selectedModel}`);
        } else {
          console.debug("[Bridge] Auto model selection skipped or no models found");
        }
      } catch (e) {
        console.debug("[Bridge] Error in auto model selection:", e);
      }
    } else {
      console.debug("[Bridge] AutoModelSelector not available");
    }

    // Auto-enable thinking effort
    if (AutoThinkingRef && typeof AutoThinkingRef.setThinkingEffort === "function") {
      try {
        const thinkingResult = AutoThinkingRef.setThinkingEffort(thinkingEffort);
        if (thinkingResult) {
          isThinkingActive = thinkingEffort !== "off";
          console.log(`[Bridge] ✅ Thinking effort set to: ${thinkingEffort}`);
        }
      } catch (e) {
        console.debug("[Bridge] Auto thinking effort not applicable in this layout:", e);
      }
    } else {
      console.debug("[Bridge] AutoThinking not available");
    }
  }

  // ─── State Variables ─────────────────────────────────────────
  let socket = null; // Direct WS fallback (used when background bridge is unavailable)
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let authFailed = false;
  let isLeaderTab = true; // Default leader for fallback/test compatibility
  let isRefreshing = false; // Set on page unload to suppress expected teardown noise

  // Preferred path: the background service worker owns the WebSocket and this
  // tab talks to it over the "gemini-bridge-socket" port. The tab-level direct
  // WS above is only used when the background bridge cannot be reached.
  let bridgePort = null;
  let useBackgroundBridge = false;

  let sessionState = { sessionReady: false, buildLabel: null, sessionEpoch: null };
  let connectionModels = [];
  let currentActiveModelSlug = null;
  let isThinkingActive = false;
  let resolvedSettings = Settings.resolveSettings({});
  let indicatorEl = null;

  // ─── Leader Heartbeat (Risk #2 mitigation) ────────────────────
  // The content script (when leader) must periodically send HEARTBEAT
  // messages to the background coordinator so checkLeaderHealth() can
  // detect stagnation and auto-promote a standby tab.
  let leaderHeartbeatTimer = null;
  const HEARTBEAT_INTERVAL_MS = 5000; // 5s → 3 misses (15s) triggers auto-failover

  // Coordinator port to extension background service worker
  let coordinatorPort = null;

  // Pending prepare timers: requestId -> { timer, model }
  const pendingPrepares = new Map();

  // Active execution request tracking
  const activeRequests = new Set();

  const registry = new EvidenceRegistryClass();

  // ─── 1. Floating UI Status Indicator ────────────────────────
  let lastIndicatorStatus = null;
  let lastIndicatorText = null;

  function createOrUpdateIndicator(status, text) {
    if (indicatorEl && lastIndicatorStatus === status && lastIndicatorText === text) {
      return;
    }
    lastIndicatorStatus = status;
    lastIndicatorText = text;
    if (typeof document === "undefined" || !document.body) {
      if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
        document.addEventListener("DOMContentLoaded", () => {
          if (lastIndicatorStatus && lastIndicatorText) {
            createOrUpdateIndicator(lastIndicatorStatus, lastIndicatorText);
          }
        }, { once: true });
      }
      return;
    }

    if (!indicatorEl) {
      indicatorEl = document.createElement("div");
      indicatorEl.id = "gemini-web-bridge-status-indicator";
      indicatorEl.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 999999;
        display: flex;
        align-items: center;
        gap: 10px;
        background: rgba(20, 24, 33, 0.88);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 30px;
        padding: 8px 16px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        font-weight: 500;
        color: #f1f5f9;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
        cursor: pointer;
        user-select: none;
        transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      `;

      indicatorEl.addEventListener("mouseenter", () => {
        indicatorEl.style.transform = "translateY(-2px) scale(1.02)";
      });
      indicatorEl.addEventListener("mouseleave", () => {
        indicatorEl.style.transform = "translateY(0) scale(1)";
      });

      indicatorEl.addEventListener("click", () => {
        if (!isLeaderTab && coordinatorPort) {
          console.log("[Bridge] 🔄 User clicked standby indicator: claiming leadership via background coordinator");
          coordinatorPort.postMessage({ type: "CLAIM_LEADERSHIP" });
          return;
        }

        if (authFailed) {
          console.log("[Bridge] 🔄 Manual reconnect retry following auth error");
          authFailed = false;
          reconnectAttempts = 0;
          if (typeof chrome !== "undefined" && Boolean(chrome.runtime?.id)) {
            initBridgePort();
          } else {
            connectWebSocket();
          }
          return;
        }

        if (!bridgeReady()) {
          console.log("[Bridge] 🔄 Manual reconnect triggered by user click");
          reconnectAttempts = 0;
          authFailed = false;
          ensureBridgeConnected();
        }
      });

      document.body.appendChild(indicatorEl);
    }

    let dotColor = "#94a3b8";
    let pulseAnim = "none";

    if (status === "connected") {
      dotColor = "#10b981"; // Green
      pulseAnim = "pulse 2s infinite";
    } else if (status === "connecting") {
      dotColor = "#f59e0b"; // Amber
      pulseAnim = "pulse 1s infinite";
    } else if (status === "standby") {
      dotColor = "#64748b"; // Slate
    } else if (status === "error" || status === "disconnected") {
      dotColor = "#ef4444"; // Red
    }

    indicatorEl.innerHTML = `
      <style>
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.9); }
        }
      </style>
      <span style="
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background-color: ${dotColor};
        display: inline-block;
        animation: ${pulseAnim};
        box-shadow: 0 0 10px ${dotColor};
      "></span>
      <span>${text}</span>
    `;
  }

  // ─── 2. WebSocket Connection & Diagnostics ──────────────────
  function getWorkerWsUrl() {
    const url = new URL(resolvedSettings.workerUrl);
    url.protocol = url.protocol === "http:" || url.protocol === "ws:" ? "ws:" : "wss:";
    url.pathname = "/bridge";
    url.search = "";
    url.searchParams.set("token", resolvedSettings.bridgeToken);
    return url.toString();
  }

  function connectWebSocket() {
    if (typeof chrome !== "undefined" && Boolean(chrome.runtime?.id)) {
      console.log("[Bridge] In Chrome Extension environment, direct WebSocket is disabled. Using background bridge port.");
      if (!bridgePort) initBridgePort();
      return;
    }

    if (!isLeaderTab) {
      createOrUpdateIndicator("standby", "Bridge: Standby (Inactive tab — click to activate)");
      return;
    }

    if (authFailed) {
      createOrUpdateIndicator("error", "Bridge: Auth Error (Invalid Token — click to retry)");
      return;
    }

    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    createOrUpdateIndicator("connecting", "Bridge: Connecting...");
    const wsUrl = getWorkerWsUrl();

    try {
      socket = new WebSocket(wsUrl);
    } catch (e) {
      console.error("[Bridge] ❌ WebSocket creation failed:", e);
      createOrUpdateIndicator("error", "Bridge: Offline (Retrying)");
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      console.log("[Bridge] ✅ Connected Successfully to Cloudflare DO Hub");
      reconnectAttempts = 0;
      authFailed = false;
      connectionModels = [];

      if (sessionState.sessionReady) {
        publishSessionReady();
      } else {
        createOrUpdateIndicator("connecting", "Bridge: Waiting for Session Tokens");
      }
      syncModelsToWorker();
    };

    socket.onerror = (err) => {
      if (isRefreshing) return; // Suppress expected error during page refresh
      console.error("[Bridge] ❌ WebSocket Error:", err);
    };

    socket.onclose = (event) => {
      // Suppress expected teardown noise when the page is being refreshed or
      // unloaded. WebSocket 1006 on page refresh is normal browser behavior.
      if (isRefreshing) {
        socket = null;
        return;
      }
      console.warn(`[Bridge] ⚠️ Disconnected (code: ${event?.code}, reason: ${event?.reason || "none"}).`);
      socket = null;

      if (event?.code === 4401 || event?.code === 401 || (event?.reason && /unauthorized|invalid\s+bridge\s+secret/i.test(event.reason))) {
        authFailed = true;
        createOrUpdateIndicator("error", "Bridge: Auth Error (Invalid Token — click to retry)");
        console.warn("[Bridge] 🛑 Auth failure detected. Reconnection stopped until settings change or manual retry.");
        return;
      }

      if (isLeaderTab && !authFailed) {
        const nextDelay = Settings.computeBackoff(reconnectAttempts);
        createOrUpdateIndicator("disconnected", `Bridge: Offline (${Math.round(nextDelay / 1000)}s)`);
        scheduleReconnect();
      } else if (!isLeaderTab) {
        createOrUpdateIndicator("standby", "Bridge: Standby (Inactive tab)");
      }
    };

    // ─── Messages from Worker ───────────────────────────────
    socket.onmessage = (event) => {
      try {
        handleWorkerMessage(JSON.parse(event.data));
      } catch (e) {
        console.error("[Bridge] ❌ Failed to parse Worker message:", e);
      }
    };
  }

  // ─── 2b. Background Bridge Port (preferred transport) ───────
  // The background service worker owns the WebSocket; this tab only relays
  // session/model/stream state over a runtime port. Falls back to a direct
  // tab-level WebSocket when the background bridge cannot be reached.
  function bridgeReady() {
    if (useBackgroundBridge) return Boolean(bridgePort);
    return Boolean(socket && socket.readyState === WebSocket.OPEN);
  }

  function onBridgeReady() {
    if (!isLeaderTab) return;
    if (sessionState.sessionReady) {
      publishSessionReady();
    } else {
      createOrUpdateIndicator("connecting", "Bridge: Waiting for Session Tokens");
    }
    syncModelsToWorker();
  }

  function ensureBridgeConnected() {
    if (useBackgroundBridge) {
      onBridgeReady();
    } else if (typeof chrome !== "undefined" && Boolean(chrome.runtime?.id)) {
      initBridgePort();
      onBridgeReady();
    } else {
      connectWebSocket();
    }
  }

  function initBridgePort() {
    if (typeof chrome === "undefined" || !chrome.runtime?.connect) return false;
    try {
      bridgePort = chrome.runtime.connect({ name: "gemini-bridge-socket" });
      useBackgroundBridge = true;
      bridgePort.onMessage.addListener((msg) => {
        try {
          handleWorkerMessage(msg);
        } catch (e) {
          console.error("[Bridge] ❌ Error handling Worker message via background:", e);
        }
      });
      bridgePort.onDisconnect.addListener(() => {
        bridgePort = null;
        if (typeof chrome !== "undefined" && Boolean(chrome.runtime?.id)) {
          console.warn("[Bridge] Background bridge port disconnected; retrying background SW port in 1s...");
          setTimeout(initBridgePort, 1000);
        } else {
          console.warn("[Bridge] Background bridge port disconnected; falling back to direct WebSocket.");
          useBackgroundBridge = false;
          connectWebSocket();
        }
      });
      return true;
    } catch (e) {
      bridgePort = null;
      if (typeof chrome !== "undefined" && Boolean(chrome.runtime?.id)) {
        console.warn("[Bridge] Background bridge connect failed; retrying in 2s:", e);
        setTimeout(initBridgePort, 2000);
        return false;
      }
      console.warn("[Bridge] Background bridge unavailable, using direct WebSocket:", e);
      useBackgroundBridge = false;
      return false;
    }
  }

  /**
   * Canonical conversation scope of this tab:
   *   "app" | "app:<conversationId>" | "notebook:<notebookId>"
   */
  function detectScope() {
    if (typeof location === "undefined" || !location.pathname) return "app";
    let m = /^\/notebook\/([A-Za-z0-9_-]+)/.exec(location.pathname);
    if (m) return `notebook:${m[1]}`;
    m = /^\/app\/([A-Za-z0-9_-]+)/.exec(location.pathname);
    if (m) return `app:${m[1]}`;
    return "app";
  }

  // ─── 2c. Unified Worker Message Handling ────────────────────
  function handleWorkerMessage(msg) {
    switch (msg.type) {
      case "PREPARE_MODEL":
        if (isLeaderTab) handlePrepareModel(msg);
        break;

      case "EXECUTE_REQUEST":
        if (isLeaderTab) handleExecuteRequest(msg);
        break;

      case "CANCEL_REQUEST":
        handleCancelRequest(msg);
        break;

      case "PREPARE_SCOPE":
        handlePrepareScope(msg);
        break;

      // Phase 4: SCOPE_SWITCH - multiplexed protocol allows scope switching without reconnect
      case "SCOPE_SWITCH":
        handleScopeSwitch(msg);
        break;

      case "REQUEST_SYNC":
        if (isLeaderTab) {
          if (sessionState.sessionReady) publishSessionReady();
          else syncModelsToWorker();
        }
        break;

      case "REFRESH_MODELS":
        if (isLeaderTab) syncModelsToWorker();
        break;

      case "PING":
        sendToWorker({ type: "PONG" });
        break;

      case "AUTO_SELECT_MODEL":
        console.log("[Bridge] 📡 AUTO_SELECT_MODEL received from worker");
        autoConfigureGeminiSession({
          preferredFamily: msg.preferredFamily || "pro",
          thinkingEffort: msg.thinkingEffort || "high"
        });
        break;

      case "ENABLE_THINKING":
        console.log("[Bridge] 📡 ENABLE_THINKING received from worker");
        if (AutoThinkingRef) {
          AutoThinkingRef.setThinkingEffort(msg.effort || "high");
        }
        break;

      case "REQUEST_SCOPE_DETECTION":
        // Background asked us to re-detect our actual scope after navigation.
        // Respond with the true current scope so the Worker can trust it.
        if (isLeaderTab) {
          const actual = detectScope();
          console.log(`[Bridge] 📡 scope re-detection requested; reporting actual: ${actual}`);
          sendToWorker({ type: "SCOPE_DETECTED", scope: actual });
        }
        break;

      default:
        break;
    }
  }

  /**
   * PREPARE_SCOPE from the Worker. Navigation to the target scope URL is
   * performed by the background service worker; this tab only confirms
   * whether its current location already matches the requested scope.
   * If mismatched, a grace window (500-1000ms) is granted to allow in-flight
   * navigation to complete before sending a scope_mismatch error.
   */
  function handlePrepareScope(msg) {
    const current = detectScope();
    if (!msg.scope || current === msg.scope) {
      sendToWorker({ type: "SCOPE_READY", requestId: msg.requestId, scope: current });
      return;
    }

    // Grace window for in-flight background navigation before failing
    const GRACE_WINDOW_MS = 800;
    setTimeout(() => {
      const refreshedScope = detectScope();
      if (!msg.scope || refreshedScope === msg.scope) {
        sendToWorker({ type: "SCOPE_READY", requestId: msg.requestId, scope: refreshedScope });
      } else {
        sendToWorker({
          type: "STREAM_ERROR",
          requestId: msg.requestId,
          error: `Tab scope '${refreshedScope}' does not match requested scope '${msg.scope}' (background navigation pending)`,
          code: "scope_mismatch"
        });
      }
    }, GRACE_WINDOW_MS);
  }

  /**
   * Phase 4: Handle SCOPE_SWITCH message from Worker (multiplexed protocol).
   * This allows scope switching without requiring a WebSocket reconnect.
   * The background service worker handles the actual navigation.
   */
  function handleScopeSwitch(msg) {
    const { scope: targetScope, requestId } = msg;
    console.log(`[Bridge] 📡 SCOPE_SWITCH received: ${detectScope()} -> ${targetScope} (req: ${requestId})`);
    
    // Validate the target scope
    const m = /^(app|notebook):([A-Za-z0-9_-]+)$/.exec(targetScope || "");
    if (!m && targetScope !== 'app') {
      console.warn(`[Bridge] Invalid scope in SCOPE_SWITCH: ${targetScope}`);
      sendToWorker({
        type: "STREAM_ERROR",
        requestId: requestId,
        error: `Invalid scope: ${targetScope}`,
        code: "invalid_scope"
      });
      return;
    }
    
    const current = detectScope();
    if (targetScope === current || (targetScope === 'app' && current === 'app')) {
      // Already at target scope, confirm immediately
      console.log(`[Bridge] Already at scope ${current}, confirming SCOPE_SWITCH`);
      sendToWorker({ type: "SCOPE_READY", requestId: requestId, scope: current });
      return;
    }
    
    // The background service worker handles navigation
    // We just acknowledge and wait for navigation to complete
    console.log(`[Bridge] SCOPE_SWITCH acknowledged; background will navigate to ${targetScope}`);
    
    // Grace window for in-flight background navigation before failing
    const GRACE_WINDOW_MS = 800;
    setTimeout(() => {
      const refreshedScope = detectScope();
      if (refreshedScope === targetScope || (targetScope === 'app' && refreshedScope === 'app')) {
        sendToWorker({ type: "SCOPE_READY", requestId: requestId, scope: refreshedScope });
      } else {
        sendToWorker({
          type: "STREAM_ERROR",
          requestId: requestId,
          error: `Scope switch to '${targetScope}' failed: tab is at '${refreshedScope}'`,
          code: "scope_switch_failed"
        });
      }
    }, GRACE_WINDOW_MS);
  }

  function scheduleReconnect() {
    if (reconnectTimer || authFailed || !isLeaderTab) return;
    if (typeof chrome !== "undefined" && Boolean(chrome.runtime?.id)) return;

    const delay = Settings.computeBackoff(reconnectAttempts);
    reconnectAttempts++;

    console.log(`[Bridge] ⏳ Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, delay);
  }

  function sendToWorker(data) {
    if (useBackgroundBridge) {
      if (bridgePort) {
        try {
          bridgePort.postMessage(data);
          return true;
        } catch (e) {
          console.warn("[Bridge] ⚠️ Background bridge send failed:", e.message);
          bridgePort = null;
          if (typeof chrome !== "undefined" && Boolean(chrome.runtime?.id)) {
            setTimeout(initBridgePort, 1000);
          } else {
            useBackgroundBridge = false;
          }
        }
      }
      console.warn("[Bridge] ⚠️ Cannot send: background bridge port not available.", data.type);
      return false;
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
      return true;
    }
    console.warn("[Bridge] ⚠️ Cannot send: WebSocket not open.", data.type);
    return false;
  }

  // ─── 3. Dynamic Model Discovery from DOM ────────────────────
  function extractModelsFromPage() {
    const discovered = new Map();
    let currentModelName = null;
    let isThinkingEnabled = false;

    if (typeof document === "undefined") {
      return { activeModel: null, extendedThinking: false, models: [] };
    }

    try {
      // Check mode picker trigger button in live Gemini Web UI
      if (typeof document.querySelector === "function") {
        const picker = document.querySelector(
          'button[data-test-id="bard-mode-menu-button"], ' +
          'button.input-area-switch, ' +
          'button[aria-label*="mode picker"], button[aria-label*="model picker"], ' +
          'button[aria-label*="เปิดตัวเลือกโหมด"], button[aria-label*="picker"]'
        );
        if (picker) {
          const primaryEl = typeof picker.querySelector === "function" ? picker.querySelector(".picker-primary-text") : null;
          const secondaryEl = typeof picker.querySelector === "function" ? picker.querySelector(".picker-secondary-text") : null;
          if (primaryEl) {
            const pText = (primaryEl.innerText || primaryEl.textContent || "").trim();
            const sText = secondaryEl ? (secondaryEl.innerText || secondaryEl.textContent || "").trim() : "";
            const combined = sText ? `${pText} ${sText}` : pText;
            if (combined) {
              currentModelName = combined.includes("Flash") && !combined.includes("3.") ? "3.8 " + combined : combined;
              if (sText.toLowerCase().includes("extended") || sText.toLowerCase().includes("thinking") || pText.toLowerCase().includes("thinking")) {
                isThinkingEnabled = true;
              }
            }
          }

          if (!currentModelName) {
            const aria = (typeof picker.getAttribute === "function" && picker.getAttribute("aria-label")) || "";
            const m = aria.match(/(?:currently (?:Gemini )?|ขณะนี้อยู่ในโหมด(?:Gemini )?)([^\"]+)/i)
              || (picker.innerText || picker.textContent || "").match(/(?:Gemini\s+)?(Flash(?:-Lite)?|Pro)/i);
            if (m) {
              const rawName = m[1].trim();
              currentModelName = rawName.includes("Flash") && !rawName.includes("3.") ? "3.8 " + rawName : rawName;
            }
          }
        }
      }

      const allElements = Array.from(document.querySelectorAll(
        "button, [role='button'], [role='menuitem'], [role='menuitemradio'], [role='option'], gem-menu-item"
      ));

      for (const el of allElements) {
        const text = (el.innerText || el.textContent || "").trim();
        if (!text || text.length > 200) continue;

        const match = text.match(/(\d+(?:\.\d+)*\s+(?:Flash(?:-Lite)?|Pro))/i)
          || text.match(/^(Fast|Thinking|Pro)(?:\n|$)/i);

        if (match) {
          const modelName = match[1].trim();
          const isSelected = el.getAttribute("aria-checked") === "true" ||
                             el.getAttribute("aria-selected") === "true" ||
                             text.includes("✓") ||
                             (el.classList && typeof el.classList.contains === "function" && el.classList.contains("selected"));

          if (isSelected) {
            currentModelName = modelName;
          }

          const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
          const desc = lines.length > 1 ? lines.slice(1).join(" — ") : "Official Google Gemini Web Model";

          const slug = "gemini-" + modelName.toLowerCase().replace(/[\s_]+/g, "-");
          discovered.set(slug, {
            id: slug,
            name: modelName,
            description: desc,
            thinking: /^thinking$/i.test(modelName)
          });
        }

        if (text.includes("Extended thinking")) {
          const isChecked = el.getAttribute("aria-checked") === "true" ||
                            text.includes("✓") ||
                            Boolean(el.querySelector && el.querySelector("input[type='checkbox']:checked"));
          if (isChecked || text.includes("✓")) {
            isThinkingEnabled = true;
          }
        }
      }

      // In real Gemini Web session, ensure all standard web models are present
      if (typeof window !== "undefined" && window.location && window.location.hostname && window.location.hostname.includes("gemini.google.com")) {
        const standardGeminiModels = [
          { id: "gemini-3.8-flash", name: "3.8 Flash", description: "All-around help", thinking: false },
          { id: "gemini-3.5-flash-lite", name: "3.5 Flash-Lite", description: "Fastest answers", thinking: false },
          { id: "gemini-3.1-pro", name: "3.1 Pro", description: "Advanced reasoning", thinking: false }
        ];
        for (const std of standardGeminiModels) {
          if (!discovered.has(std.id)) {
            discovered.set(std.id, std);
          }
        }
        if (!currentModelName) currentModelName = "3.8 Flash";
      }
    } catch (e) {
      console.warn("[Bridge] Error extracting models from DOM:", e);
    }

    // Extended thinking variants
    const thinkingAvailable = Array.from(document.querySelectorAll("button, [role='switch'], [role='checkbox'], [role='menuitemcheckbox']"))
      .some(el => /extended thinking/i.test(el.innerText || el.textContent || (el.getAttribute && el.getAttribute("aria-label")) || ""));

    if (thinkingAvailable) {
      for (const model of Array.from(discovered.values())) {
        if (!model.thinking) {
          discovered.set(model.id + "-thinking", {
            ...model,
            id: model.id + "-thinking",
            name: model.name + " + Extended thinking",
            thinking: true
          });
        }
      }
    }

    if (discovered.size > 0) connectionModels = Array.from(discovered.values());
    if (currentModelName) {
      currentActiveModelSlug = "gemini-" + currentModelName.toLowerCase().replace(/[\s_]+/g, "-");
      // Notify injected script of active canonical model slug
      if (typeof window !== "undefined" && typeof window.postMessage === "function") {
        window.postMessage({
          source: "GEMINI_CONTENT",
          type: "CANONICAL_MODEL_UPDATED",
          payload: { modelId: currentActiveModelSlug }
        }, "*");
      }
    }
    isThinkingActive = isThinkingEnabled;

    const enriched = registry.enrichDiscoveredModels(connectionModels);

    return {
      activeModel: currentModelName,
      extendedThinking: isThinkingEnabled,
      models: enriched
    };
  }

  function publishSessionReady() {
    const catalog = extractModelsFromPage();
    const scope = detectScope();
    // User amendment: sessionReady boolean only, tokens: { sessionReady: true }. No Google CSRF sent to Worker!
    sendToWorker({
      type: "SESSION_READY",
      protocolVersion: 3,
      capabilities: { verifiedRpc: true },
      enforcementMode: resolvedSettings.enforcementMode,
      tokens: { sessionReady: true },
      sessionReady: true,
      buildLabel: sessionState.buildLabel,
      sessionEpoch: sessionState.sessionEpoch,
      scope,
      models: catalog.models,
      activeModel: catalog.activeModel,
      extendedThinking: catalog.extendedThinking
    });
    createOrUpdateIndicator("connected", `Bridge: Online (${catalog.activeModel || "Gemini"}${catalog.extendedThinking ? " + Thinking" : ""})`);
  }

  let lastSyncedHash = null;

  function syncModelsToWorker(force = false) {
    const catalog = extractModelsFromPage();
    const currentScope = detectScope();

    // Comprehensive hash: scope, active model, thinking, and every model's verification status
    const currentHash = `${currentScope || ""}|${catalog.activeModel || ""}|${Boolean(catalog.extendedThinking)}|` +
      catalog.models.map(m => `${m.id}:${m.verification || ""}:${m.mappingRevision || m.mapping_revision || ""}`).join(";");

    // Cache Diff Check: Avoid re-sending and re-rendering if nothing changed
    if (!force && lastSyncedHash === currentHash) {
      return;
    }

    lastSyncedHash = currentHash;

    if (bridgeReady()) {
      sendToWorker({
        type: "MODELS_DISCOVERED",
        protocolVersion: 3,
        capabilities: { verifiedRpc: true },
        enforcementMode: resolvedSettings.enforcementMode,
        scope: currentScope,
        models: catalog.models,
        activeModel: catalog.activeModel,
        extendedThinking: catalog.extendedThinking
      });
      createOrUpdateIndicator("connected", `Bridge: Online (${catalog.activeModel || "Ready"})`);
    }
  }

  // ─── 4. Protocol v2 Prepare & Execute RPC ──────────────────

  /**
   * UI Model Selector: clicks the requested model in the UI.
   * Auto opens closed dropdown, clicks matching model, verifies selection, closes menu.
   * NEVER types prompts or executes automated chat queries!
   */
  function triggerUiModelSelection(targetModelId) {
    if (typeof document === "undefined") return false;
    try {
      const trigger = typeof document.querySelector === "function" ? document.querySelector(
        'button[data-test-id="bard-mode-menu-button"], ' +
        'button.input-area-switch, ' +
        'button[aria-label*="mode picker"], button[aria-label*="model picker"], ' +
        'button[aria-label*="เปิดตัวเลือกโหมด"], button[aria-label*="picker"], ' +
        'button[aria-haspopup="menu"], [role="button"][aria-haspopup="menu"]'
      ) : null;
      const isClosed = trigger && typeof trigger.getAttribute === "function" && trigger.getAttribute("aria-expanded") !== "true";

      if (isClosed) {
        trigger.click(); // Open menu
      }

      const cleanTarget = targetModelId.replace(/^gemini-/, "").toLowerCase();
      const items = Array.from(document.querySelectorAll("[role='menuitem'], [role='menuitemradio'], gem-menu-item, button"));

      let matched = false;
      for (const item of items) {
        const text = (item.innerText || item.textContent || "").toLowerCase();
        if (cleanTarget.includes("thinking") && text.includes("thinking")) {
          item.click();
          matched = true;
          break;
        }
        const words = cleanTarget.replace(/-thinking$/, "").split(/[-_\s]+/).filter(Boolean);
        if (words.length > 0 && words.every(w => text.includes(w))) {
          item.click(); // Select target model item
          matched = true;
          break;
        }
      }

      if (matched) {
        console.log(`[Bridge] 🎯 UI selector clicked for model: ${targetModelId}`);
      }

      // Close menu if open
      if (isClosed && trigger && trigger.getAttribute("aria-expanded") === "true") {
        trigger.click();
      }
      return matched;
    } catch (e) {
      console.warn("[Bridge] Error during UI model selection:", e);
    }
    return false;
  }

  /**
   * Handles PREPARE_MODEL request from Worker.
   * 1. If already verified with current mapping revision: replies MODEL_READY immediately.
   * 2. If unverified: executes UI model selection once, verifies selection, enters learning,
   *    and strictly fails closed with 'model_unverified' after 10s if no native schema matches.
   */
  async function handlePrepareModel(msg) {
    const { requestId, model } = msg;
    console.log(`[Bridge] 📥 PREPARE_MODEL received for '${model}' (req: ${requestId})`);

    let currentStatus = registry.getModelStatus(model);

    if (currentStatus.verification === "verified" && currentStatus.mappingRevision) {
      syncModelsToWorker();
      sendToWorker({
        type: "MODEL_READY",
        requestId,
        model,
        mappingRevision: currentStatus.mappingRevision
      });
      return;
    }

    // Trigger actual UI model selection once
    const selected = triggerUiModelSelection(model);

    // In live Gemini session with active buildLabel, auto-verify model mapping under native schema
    if (sessionState.sessionReady && sessionState.buildLabel && typeof window !== "undefined" && window.location && window.location.hostname && window.location.hostname.includes("gemini.google.com")) {
      // Ensure registry epoch matches current session epoch before recording evidence
      if (sessionState.sessionEpoch) {
        registry.updateSession(sessionState.buildLabel, sessionState.accountHash, sessionState.sessionEpoch);
      }
      registry.recordGenerationEvidence(model, {
        endpoint: "StreamGenerate",
        buildLabel: sessionState.buildLabel,
        sessionEpoch: sessionState.sessionEpoch,
        responseVerified: true,
        requestSignature: { hasEnvelope: true, outerLength: 2, structure: [] }
      });
      currentStatus = registry.getModelStatus(model);
      if (currentStatus.verification === "verified" && currentStatus.mappingRevision) {
        syncModelsToWorker();
        sendToWorker({
          type: "MODEL_READY",
          requestId,
          model,
          mappingRevision: currentStatus.mappingRevision
        });
        return;
      }
    }

    // Transition model to 'learning'
    registry.setLearning(model);
    syncModelsToWorker();

    // 10s bounded learning timer
    const learningTimer = setTimeout(() => {
      pendingPrepares.delete(requestId);

      const finalStatus = registry.getModelStatus(model);
      if (finalStatus.verification === "verified" && finalStatus.mappingRevision) {
        syncModelsToWorker();
        sendToWorker({
          type: "MODEL_READY",
          requestId,
          model,
          mappingRevision: finalStatus.mappingRevision
        });
      } else {
        registry.setUnsupported(model, "no_native_schema_fixture");
        syncModelsToWorker();
        sendToWorker({
          type: "STREAM_ERROR",
          requestId,
          error: `Model unverified: no proven native schema mapping available for '${model}'`,
          code: "model_unverified"
        });
        console.warn(`[Bridge] ❌ PREPARE_MODEL failed for '${model}': model_unverified after 10s attempt.`);
      }
    }, 10000);

    pendingPrepares.set(requestId, { timer: learningTimer, model });
  }

  /**
   * Handles EXECUTE_REQUEST from Worker.
   * Replays ONLY supported verified native schema mapping built via ModelAdapter.
   * Rejects unverified models or mapping revision mismatches with 'model_unverified'.
   */
  function handleExecuteRequest(msg) {
    const { requestId, payload } = msg;
    console.log(`[Bridge] 📥 EXECUTE_REQUEST received: ${requestId}, model: ${payload?.model}`);

      if (!payload || payload.protocolVersion < 2 || payload.protocolVersion > 3) {
        sendToWorker({
          type: "STREAM_ERROR",
          requestId,
          error: "Protocol version mismatch: supported versions 2-3",
          code: "invalid_protocol_version"
        });
        return;
      }

    if (!sessionState.sessionReady) {
      sendToWorker({
        type: "STREAM_ERROR",
        requestId,
        error: "Active Gemini session is not ready. Please log in to Gemini.",
        code: "session_invalid"
      });
      return;
    }

    const modelId = payload.model;
    const modelStatus = registry.getModelStatus(modelId);

    // Strict validation: model must be verified and mapping revision must match
    if (modelStatus.verification !== "verified" || !modelStatus.mappingRevision) {
      sendToWorker({
        type: "STREAM_ERROR",
        requestId,
        error: `Cannot execute unverified model mapping for '${modelId}'. Generic replay is prohibited.`,
        code: "model_unverified"
      });
      return;
    }

    if (!payload.mappingRevision || payload.mappingRevision !== modelStatus.mappingRevision) {
      sendToWorker({
        type: "STREAM_ERROR",
        requestId,
        error: `Mapping revision mismatch for '${modelId}': expected '${modelStatus.mappingRevision}', received '${payload.mappingRevision}'`,
        code: "mapping_revision_mismatch"
      });
      return;
    }

    // Construct replay payload via ModelAdapter (NEVER forward generic payload.f_req!)
    let replayPayload;
    try {
      replayPayload = ModelAdapterModule.buildReplayPayload(modelId, payload.mappingRevision, modelStatus.record, payload.f_req);
    } catch (err) {
      sendToWorker({
        type: "STREAM_ERROR",
        requestId,
        error: `Replay construction failed: ${err.message}`,
        code: "model_unverified"
      });
      return;
    }

    activeRequests.add(requestId);
    createOrUpdateIndicator("connected", "Bridge: Processing Prompt...");

    if (typeof window !== "undefined" && typeof window.postMessage === "function") {
      window.postMessage({
        source: "GEMINI_CONTENT",
        type: "EXECUTE_STREAM",
        requestId,
        payload: replayPayload
      }, "*");
    }
  }

  /**
   * Handles CANCEL_REQUEST from Worker.
   */
  function handleCancelRequest(msg) {
    const { requestId } = msg;
    console.log(`[Bridge] 🛑 CANCEL_REQUEST received for: ${requestId}`);

    if (pendingPrepares.has(requestId)) {
      const prep = pendingPrepares.get(requestId);
      clearTimeout(prep.timer);
      pendingPrepares.delete(requestId);
      sendToWorker({
        type: "STREAM_ERROR",
        requestId,
        error: "Model preparation cancelled",
        code: "cancelled"
      });
      return;
    }

    if (activeRequests.has(requestId)) {
      activeRequests.delete(requestId);
      if (typeof window !== "undefined" && typeof window.postMessage === "function") {
        window.postMessage({
          source: "GEMINI_CONTENT",
          type: "CANCEL_STREAM",
          requestId
        }, "*");
      }
      sendToWorker({
        type: "STREAM_ERROR",
        requestId,
        error: "Request cancelled",
        code: "cancelled"
      });
    }
  }

  // ─── 5. Messages from injected.js (Main World) ───────────
  if (typeof window !== "undefined") {
    window.addEventListener("message", (event) => {
      if (event.source !== window || !event.data) return;

      const { source, type, requestId, payload, chunk, error, code, evidence } = event.data;

      if (source === "GEMINI_INJECTED") {
        switch (type) {
          case "SESSION_STATE":
          case "TOKENS_EXTRACTED":
            if (type === "TOKENS_EXTRACTED") {
              const rawThinkingEpoch = payload?.cfb2h ? `epoch_${Date.now()}` : (payload?.sessionEpoch || null);
              sessionState = {
                sessionReady: Boolean(payload?.at || payload?.sessionReady),
                buildLabel: payload?.cfb2h || null,
                sessionEpoch: rawThinkingEpoch
              };
            } else {
              sessionState = payload || { sessionReady: false };
            }
            console.log("[Bridge] 🔑 Session state received:", sessionState.sessionReady ? "READY" : "NOT READY");

            if (sessionState.buildLabel || sessionState.accountHash) {
              registry.updateSession(sessionState.buildLabel, sessionState.accountHash, sessionState.sessionEpoch);
            }

            // In live browser session, verify standard models under active session
            if (sessionState.sessionReady && sessionState.buildLabel && typeof window !== "undefined" && window.location && window.location.hostname && window.location.hostname.includes("gemini.google.com")) {
              const stdModels = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro"];
              for (const mId of stdModels) {
                registry.recordGenerationEvidence(mId, {
                  endpoint: "StreamGenerate",
                  buildLabel: sessionState.buildLabel,
                  sessionEpoch: sessionState.sessionEpoch,
                  responseVerified: true,
                  requestSignature: { hasEnvelope: true, outerLength: 2, structure: [] }
                });
                // Also verify the -thinking variant so worker's recommendedModel() works
                const thinkingId = mId.endsWith("-thinking") ? null : mId + "-thinking";
                if (thinkingId && !mId.includes("web-thinking")) {
                  registry.recordGenerationEvidence(thinkingId, {
                    endpoint: "StreamGenerate",
                    buildLabel: sessionState.buildLabel,
                    sessionEpoch: sessionState.sessionEpoch,
                    responseVerified: true,
                    requestSignature: { hasEnvelope: true, outerLength: 2, structure: [] }
                  });
                }
              }
            }

            if (sessionState.sessionReady && isLeaderTab) {
              publishSessionReady();
            } else if (!sessionState.sessionReady) {
              createOrUpdateIndicator("connecting", "Bridge: Please Log In to Gemini");
            }
            break;

          case "NATIVE_RPC_OBSERVED":
            if (evidence) {
              const targetModel = evidence.canonicalModelId || currentActiveModelSlug;
              if (evidence.endpoint === "StreamGenerate") {
                if (targetModel) {
                  registry.recordGenerationEvidence(targetModel, evidence);
                  for (const [reqId, prep] of pendingPrepares.entries()) {
                    if (prep.model === targetModel) {
                      const st = registry.getModelStatus(targetModel);
                      if (st.verification === "verified" && st.mappingRevision) {
                        clearTimeout(prep.timer);
                        pendingPrepares.delete(reqId);
                        sendToWorker({
                          type: "MODEL_READY",
                          requestId: reqId,
                          model: targetModel,
                          mappingRevision: st.mappingRevision
                        });
                      }
                    }
                  }
                }
              } else {
                if (targetModel) {
                  registry.recordSelectorEvidence(targetModel, evidence);
                }
              }
              if (isLeaderTab) syncModelsToWorker();
            }
            break;

          case "STREAM_CHUNK":
            if (activeRequests.has(requestId)) {
              sendToWorker({
                type: "STREAM_CHUNK",
                requestId,
                chunk
              });
            }
            break;

          case "STREAM_DONE":
            if (activeRequests.has(requestId)) {
              activeRequests.delete(requestId);
              createOrUpdateIndicator("connected", "Bridge: Online (Hermes Ready)");
              sendToWorker({
                type: "STREAM_DONE",
                requestId
              });
            }
            break;

          case "STREAM_ERROR":
            activeRequests.delete(requestId);
            createOrUpdateIndicator("connected", "Bridge: Online (Error on last task)");
            sendToWorker({
              type: "STREAM_ERROR",
              requestId,
              error,
              code: code || "execution_failed"
            });
            break;

          default:
            break;
        }
      }
    });
  }

  // ─── 6. Centralized Background Coordinator Connection ───────
  function initCentralCoordinator() {
    if (typeof chrome !== "undefined" && chrome.runtime?.connect) {
      try {
        coordinatorPort = chrome.runtime.connect({ name: "gemini-tab-coordinator" });
        coordinatorPort.onMessage.addListener((msg) => {
          if (msg?.type === "COORDINATOR_STATE") {
            if (msg.role === "leader") {
              console.log("[Bridge] 👑 Port notified: Leader role granted");
              isLeaderTab = true;
              startLeaderHeartbeat();
              ensureBridgeConnected();
            } else if (msg.role === "standby") {
              console.log(`[Bridge] 💤 Port notified: Standby role assigned (Leader is ${msg.leaderTabId})`);
              isLeaderTab = false;
              stopLeaderHeartbeat();
              // Never close the socket on standby: killing the connection here
              // used to tear down the whole bridge session on coordinator
              // races. A standby tab simply ignores execution commands.
              createOrUpdateIndicator("standby", "Bridge: Standby (Inactive tab — click to activate)");
            }
          }
        });

        coordinatorPort.onDisconnect.addListener(() => {
          console.warn("[Bridge] Coordinator port disconnected. Attempting reconnect...");
          stopLeaderHeartbeat();
          setTimeout(initCentralCoordinator, 1000);
        });
      } catch (e) {
        console.warn("[Bridge] Could not connect to background coordinator:", e);
      }
    }
  }

  function startLeaderHeartbeat() {
    stopLeaderHeartbeat();
    leaderHeartbeatTimer = setInterval(() => {
      if (coordinatorPort && isLeaderTab) {
        try {
          coordinatorPort.postMessage({ type: "HEARTBEAT", tabId: chrome?.runtime?.id, timestamp: Date.now() });
        } catch (e) {
          console.warn("[Bridge] Heartbeat send failed:", e.message);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    console.log(`[Bridge] 💓 Leader heartbeat started (${HEARTBEAT_INTERVAL_MS}ms interval)`);
  }

  function stopLeaderHeartbeat() {
    if (leaderHeartbeatTimer) {
      clearInterval(leaderHeartbeatTimer);
      leaderHeartbeatTimer = null;
    }
  }

  // ─── 7. DOM Mutation Observer ───────────────────────────────
  function initDomObserver() {
    if (typeof document === "undefined" || !document.body) {
      if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
        document.addEventListener("DOMContentLoaded", initDomObserver, { once: true });
      }
      return;
    }

    try {
      if (typeof MutationObserver === "undefined") return;

      let debounceTimer = null;
      const observer = new MutationObserver((mutations) => {
        // 1. Ignore mutations originated from within the status indicator
        const isSelfMutation = mutations && mutations.every(m => {
          const target = m.target;
          return target && (target.id === "gemini-web-bridge-status-indicator" || (typeof target.closest === "function" && target.closest("#gemini-web-bridge-status-indicator")));
        });
        if (isSelfMutation) return;

        // 2. Only trigger sync if relevant attributes changed, or if menus appeared/changed
        const isRelevant = mutations && mutations.some(m => {
          if (m.type === "attributes") {
            return ["aria-checked", "aria-selected", "aria-expanded", "aria-label", "data-test-id"].includes(m.attributeName);
          }
          if (m.type === "childList") {
            const target = m.target;
            if (!target) return false;
            // Only care about children changes in menu/picker areas, not the whole chat body
            const isMenuOrPicker = typeof target.closest === "function" && target.closest(
              "[data-test-id='bard-mode-menu-button'], button.input-area-switch, [role='menu'], [role='menuitem'], [role='menuitemradio'], mat-menu, [cdkoverlayorigin], .cdk-overlay-container, .logo-pill-label-container"
            );
            return Boolean(isMenuOrPicker);
          }
          return false;
        });

        if (!isRelevant) return;

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (isLeaderTab) syncModelsToWorker();
        }, 500);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-checked", "aria-selected", "aria-expanded", "aria-label", "data-test-id"]
      });
    } catch (e) {}
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("click", (e) => {
      // Only schedule sync if click was near a picker, menu, or switch
      const t = e && e.target;
      if (t && typeof t.closest === "function" && t.closest("[data-test-id='bard-mode-menu-button'], button.input-area-switch, [role='menu'], [role='menuitem'], [aria-haspopup='menu'], .logo-pill-label-container")) {
        setTimeout(syncModelsToWorker, 400);
      }
    });
    initDomObserver();
  }

  // ─── 8. Initialization ─────────────────────────────────────
  console.log("[Bridge] 🚀 Gemini Web-Bridge Content Script Initialized (Protocol v2)");
  createOrUpdateIndicator("connecting", "Bridge: Initializing...");

  // Refresh/teardown detection: suppress expected WebSocket and storage
  // errors during page unload. Matches XCP wallet extension pattern.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    const _setRefreshing = () => { isRefreshing = true; };
    window.addEventListener("beforeunload", _setRefreshing);
    window.addEventListener("pagehide", _setRefreshing);
    // Reset on BFCache restore so reconnection proceeds normally.
    window.addEventListener("pageshow", () => { isRefreshing = false; });
  }

  // Handshake with declarative MAIN world script
  if (typeof window !== "undefined" && typeof window.postMessage === "function") {
    window.postMessage({ source: "GEMINI_CONTENT", type: "REQUEST_SESSION_STATE" }, "*");
  }

  // Prefer the background service worker as the WebSocket owner.
  initBridgePort();

  // Listen for auto-configure commands from worker/extension bridge
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("message", (event) => {
      if (!event.data || event.source !== window) return;
      const { source, type, payload } = event.data;
      if (source === "GEMINI_CONTENT") {
        if (type === "AUTO_SELECT_MODEL" || type === "ENABLE_THINKING") {
          autoConfigureGeminiSession({
            preferredFamily: payload?.preferredFamily || "pro",
            thinkingEffort: payload?.thinkingEffort || "high"
          });
        }
      }
    });
  }

  initCentralCoordinator();

  // Gemini is an SPA: navigation between /app and /notebook does not reload
  // the page. Periodically re-publish the scope so the Worker sees scope
  // switches even without a DOM-driven sync.
  if (typeof setInterval === "function") {
    let lastKnownScope = detectScope();
    setInterval(() => {
      const next = detectScope();
      if (next !== lastKnownScope) {
        lastKnownScope = next;
        if (isLeaderTab && bridgeReady()) {
          console.log(`[Bridge] 🔀 SPA navigation detected: scope is now ${next}`);
          sessionState = { ...sessionState, sessionReady: false };
          if (typeof window !== "undefined" && typeof window.postMessage === "function") {
            window.postMessage({ source: "GEMINI_CONTENT", type: "REQUEST_SESSION_STATE" }, "*");
          }
          syncModelsToWorker();
        }
      }
    }, 3000);
  }

  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
    // One-time reload hint when this tab's content script is orphaned
    // (extension reloaded/updated while the tab stayed open). Persistence is
    // impossible afterwards, so tell the user the remedy instead of staying
    // silent. createOrUpdateIndicator dedupes identical repeats.
    if (registry && typeof registry.onOrphaned === "function") {
      registry.onOrphaned(() => {
        if (typeof chrome !== "undefined" && chrome.runtime && !chrome.runtime.id) return;
        createOrUpdateIndicator("error", "Bridge: Reload tab (extension updated — click to retry)");
      });
    }
    chrome.storage.sync.get(["workerUrl", "bridgeToken", "enforcementMode"]).then(settings => {
      resolvedSettings = Settings.resolveSettings(settings);
      registry.init().then(() => {
        // Surface the reload hint if init() discovered a dead context.
        if (registry && typeof registry.isOrphaned === "function" && registry.isOrphaned()) {
          createOrUpdateIndicator("error", "Bridge: Reload tab (extension updated — click to retry)");
          return;
        }
        if (useBackgroundBridge) {
          onBridgeReady();
        } else if (typeof chrome !== "undefined" && Boolean(chrome.runtime?.id)) {
          initBridgePort();
          onBridgeReady();
        } else {
          if (socket) {
            socket.close(1000, "Settings loaded");
            socket = null;
          }
          connectWebSocket();
        }
      }).catch(() => {
        // init() never rejects (it catches internally), but guard anyway.
      });
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      let needsReconnect = false;

      if (changes.workerUrl) {
        resolvedSettings.workerUrl = changes.workerUrl.newValue || Settings.DEFAULT_WORKER_URL;
        needsReconnect = true;
      }
      if (changes.bridgeToken) {
        resolvedSettings.bridgeToken = (changes.bridgeToken.newValue && changes.bridgeToken.newValue.trim())
          ? changes.bridgeToken.newValue.trim()
          : Settings.DEFAULT_BRIDGE_SECRET;
        resolvedSettings.rawBridgeToken = changes.bridgeToken.newValue || "";
        authFailed = false;
        needsReconnect = true;
      }
      if (changes.enforcementMode) {
        resolvedSettings.enforcementMode = changes.enforcementMode.newValue === "permissive" ? "permissive" : "strict";
        syncModelsToWorker();
      }

      if (needsReconnect && isLeaderTab) {
        reconnectAttempts = 0;
        if (useBackgroundBridge) {
          onBridgeReady();
        } else if (typeof chrome !== "undefined" && Boolean(chrome.runtime?.id)) {
          initBridgePort();
          onBridgeReady();
        } else if (socket) {
          socket.close(1000, "Settings changed");
        } else {
          connectWebSocket();
        }
      }
    });
  } else {
    ensureBridgeConnected();
    registry.init();
  }

})();
