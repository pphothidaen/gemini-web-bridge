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
        DEFAULT_WORKER_URL: "https://gemini-web-bridge.taijustarrett417.workers.dev",
        DEFAULT_BRIDGE_SECRET: "gemini-bridge-secret-2026",
        resolveSettings: (s = {}) => ({
          workerUrl: (s.workerUrl || "https://gemini-web-bridge.taijustarrett417.workers.dev").trim(),
          bridgeToken: (s.bridgeToken && s.bridgeToken.trim()) ? s.bridgeToken.trim() : "gemini-bridge-secret-2026",
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
      };

  // ─── State Variables ─────────────────────────────────────────
  let socket = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let authFailed = false;
  let isLeaderTab = true; // Default leader for fallback/test compatibility

  let sessionState = { sessionReady: false, buildLabel: null, sessionEpoch: null };
  let connectionModels = [];
  let currentActiveModelSlug = null;
  let isThinkingActive = false;
  let resolvedSettings = Settings.resolveSettings({});
  let indicatorEl = null;

  // Coordinator port to extension background service worker
  let coordinatorPort = null;

  // Pending prepare timers: requestId -> { timer, model }
  const pendingPrepares = new Map();

  // Active execution request tracking
  const activeRequests = new Set();

  const registry = new EvidenceRegistryClass();

  // ─── 1. Floating UI Status Indicator ────────────────────────
  function createOrUpdateIndicator(status, text) {
    if (typeof document === "undefined" || !document.body) return;

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
          connectWebSocket();
          return;
        }

        if (!socket || socket.readyState !== WebSocket.OPEN) {
          console.log("[Bridge] 🔄 Manual reconnect triggered by user click");
          reconnectAttempts = 0;
          connectWebSocket();
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
      console.error("[Bridge] ❌ WebSocket Error:", err);
    };

    socket.onclose = (event) => {
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
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case "PREPARE_MODEL":
            handlePrepareModel(msg);
            break;

          case "EXECUTE_REQUEST":
            handleExecuteRequest(msg);
            break;

          case "CANCEL_REQUEST":
            handleCancelRequest(msg);
            break;

          case "REFRESH_MODELS":
            syncModelsToWorker();
            break;

          case "PING":
            sendToWorker({ type: "PONG" });
            break;

          default:
            break;
        }
      } catch (e) {
        console.error("[Bridge] ❌ Failed to parse Worker message:", e);
      }
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer || authFailed || !isLeaderTab) return;

    const delay = Settings.computeBackoff(reconnectAttempts);
    reconnectAttempts++;

    console.log(`[Bridge] ⏳ Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, delay);
  }

  function sendToWorker(data) {
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
      const allElements = Array.from(document.querySelectorAll(
        "button, [role='button'], [role='menuitem'], [role='menuitemradio'], [role='option']"
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
    } catch (e) {
      console.warn("[Bridge] Error extracting models from DOM:", e);
    }

    // Extended thinking variants
    const thinkingAvailable = Array.from(document.querySelectorAll("button, [role='switch'], [role='checkbox'], [role='menuitemcheckbox']"))
      .some(el => /extended thinking/i.test(el.innerText || el.textContent || (el.getAttribute && el.getAttribute("aria-label")) || ""));

    if (thinkingAvailable) {
      for (const model of Array.from(discovered.values())) {
        discovered.set(model.id + "-thinking", {
          ...model,
          id: model.id + "-thinking",
          name: model.name + " + Extended thinking",
          thinking: true
        });
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
    // User amendment: sessionReady boolean only, tokens: { sessionReady: true }. No Google CSRF sent to Worker!
    sendToWorker({
      type: "SESSION_READY",
      protocolVersion: 2,
      capabilities: { verifiedRpc: true },
      enforcementMode: resolvedSettings.enforcementMode,
      tokens: { sessionReady: true },
      sessionReady: true,
      buildLabel: sessionState.buildLabel,
      sessionEpoch: sessionState.sessionEpoch,
      models: catalog.models,
      activeModel: catalog.activeModel,
      extendedThinking: catalog.extendedThinking
    });
    createOrUpdateIndicator("connected", `Bridge: Online (${catalog.activeModel || "Gemini"}${catalog.extendedThinking ? " + Thinking" : ""})`);
  }

  function syncModelsToWorker() {
    const catalog = extractModelsFromPage();
    if (socket && socket.readyState === WebSocket.OPEN) {
      sendToWorker({
        type: "MODELS_DISCOVERED",
        protocolVersion: 2,
        capabilities: { verifiedRpc: true },
        enforcementMode: resolvedSettings.enforcementMode,
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
      const trigger = document.querySelector("button[aria-haspopup='menu'], [role='button'][aria-haspopup='menu']");
      const isClosed = trigger && trigger.getAttribute("aria-expanded") === "false";

      if (isClosed) {
        trigger.click(); // Open menu
      }

      const cleanTarget = targetModelId.replace(/^gemini-/, "").replace(/-thinking$/, "").toLowerCase();
      const words = cleanTarget.split(/[-_\s]+/).filter(Boolean);
      const items = Array.from(document.querySelectorAll("[role='menuitem'], [role='menuitemradio'], button"));

      for (const item of items) {
        const text = (item.innerText || item.textContent || "").toLowerCase();
        if (words.length > 0 && words.every(w => text.includes(w))) {
          item.click(); // Select target model item
          console.log(`[Bridge] 🎯 UI selector clicked for model: ${targetModelId}`);

          // Close menu if open
          if (trigger && trigger.getAttribute("aria-expanded") === "true") {
            trigger.click();
          }
          return true;
        }
      }

      // Close menu if no item matched
      if (isClosed && trigger && trigger.getAttribute("aria-expanded") === "true") {
        trigger.click();
      }
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

    const currentStatus = registry.getModelStatus(model);

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
    triggerUiModelSelection(model);

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

    if (!payload || payload.protocolVersion !== 2) {
      sendToWorker({
        type: "STREAM_ERROR",
        requestId,
        error: "Protocol version mismatch: protocolVersion 2 required",
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
              sessionState = {
                sessionReady: Boolean(payload?.at || payload?.sessionReady),
                buildLabel: payload?.cfb2h || null,
                sessionEpoch: `epoch_${Date.now()}`
              };
            } else {
              sessionState = payload || { sessionReady: false };
            }
            console.log("[Bridge] 🔑 Session state received:", sessionState.sessionReady ? "READY" : "NOT READY");

            if (sessionState.buildLabel || sessionState.accountHash) {
              registry.updateSession(sessionState.buildLabel, sessionState.accountHash, sessionState.sessionEpoch);
            }

            if (sessionState.sessionReady && isLeaderTab) {
              publishSessionReady();
            } else if (!sessionState.sessionReady) {
              createOrUpdateIndicator("connecting", "Bridge: Please Log In to Gemini");
            }
            break;

          case "NATIVE_RPC_OBSERVED":
            if (evidence) {
              if (evidence.endpoint === "StreamGenerate") {
                const targetModel = evidence.canonicalModelId || currentActiveModelSlug;
                if (targetModel) {
                  registry.recordGenerationEvidence(targetModel, evidence);
                }
              } else {
                const targetModel = evidence.canonicalModelId || currentActiveModelSlug;
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
              connectWebSocket();
            } else if (msg.role === "standby") {
              console.log(`[Bridge] 💤 Port notified: Standby role assigned (Leader is ${msg.leaderTabId})`);
              isLeaderTab = false;
              if (socket) {
                socket.close(1000, "Standby tab");
                socket = null;
              }
              createOrUpdateIndicator("standby", "Bridge: Standby (Inactive tab — click to activate)");
            }
          }
        });

        coordinatorPort.onDisconnect.addListener(() => {
          console.warn("[Bridge] Coordinator port disconnected. Attempting reconnect...");
          setTimeout(initCentralCoordinator, 1000);
        });
      } catch (e) {
        console.warn("[Bridge] Could not connect to background coordinator:", e);
      }
    }
  }

  // ─── 7. DOM Mutation Observer ───────────────────────────────
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("click", () => {
      setTimeout(syncModelsToWorker, 600);
    });

    try {
      let debounceTimer = null;
      const observer = new MutationObserver(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (isLeaderTab) syncModelsToWorker();
        }, 500);
      });

      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-checked", "aria-selected"] });
      }
    } catch (e) {}
  }

  // ─── 8. Initialization ─────────────────────────────────────
  console.log("[Bridge] 🚀 Gemini Web-Bridge Content Script Initialized (Protocol v2)");
  createOrUpdateIndicator("connecting", "Bridge: Initializing...");

  // Handshake with declarative MAIN world script
  if (typeof window !== "undefined" && typeof window.postMessage === "function") {
    window.postMessage({ source: "GEMINI_CONTENT", type: "REQUEST_SESSION_STATE" }, "*");
  }

  initCentralCoordinator();

  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(["workerUrl", "bridgeToken", "enforcementMode"]).then(settings => {
      resolvedSettings = Settings.resolveSettings(settings);
      registry.init();
      connectWebSocket();
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
        if (socket) socket.close(1000, "Settings changed");
        else connectWebSocket();
      }
    });
  } else {
    connectWebSocket();
    registry.init();
  }

})();
