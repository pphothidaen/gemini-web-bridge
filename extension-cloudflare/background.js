// ============================================================
// Gemini Web-Bridge: Background Service Worker
// Owns the Cloudflare WebSocket (MV3-safe), coordinates bridge tabs,
// and manages conversation scope switching (app / notebook).
// ============================================================

const DEFAULT_WORKER_URL = "https://gemini-web-bridge.pansakorn-pho.workers.dev";
const DEFAULT_BRIDGE_SECRET = "__BRIDGE_AUTH_TOKEN__";
const SCOPE_SWITCH_TIMEOUT_MS = 45000;

/**
 * Maps a gemini.google.com pathname to a canonical scope id.
 *   /app            -> "app"
 *   /app/<convId>   -> "app:<convId>"
 *   /notebook/<id>  -> "notebook:<id>"
 */
export function scopeFromPath(pathname) {
  let m = /^\/notebook\/([A-Za-z0-9_-]+)/.exec(pathname || "");
  if (m) return `notebook:${m[1]}`;
  m = /^\/app\/([A-Za-z0-9_-]+)/.exec(pathname || "");
  if (m) return `app:${m[1]}`;
  return "app";
}

/**
 * Maps a canonical scope id back to the gemini.google.com URL to open.
 */
export function scopeToUrl(scope) {
  if (!scope || scope === "app") return "https://gemini.google.com/app";
  const [kind, id] = String(scope).split(":");
  if ((kind === "app" || kind === "notebook") && id) return `https://gemini.google.com/${kind}/${id}`;
  return "https://gemini.google.com/app";
}

function computeBackoff(attempt, base = 1000, max = 30000, rnd = Math.random) {
  const exp = Math.min(base * Math.pow(2, Math.max(0, attempt)), max);
  return Math.min(exp + Math.floor(rnd() * 1000), max);
}

export class CentralTabCoordinator {
  constructor(storageSession = null) {
    this.sessionStorage = storageSession || (typeof chrome !== "undefined" && chrome.storage?.session ? chrome.storage.session : null);
    this.connectedPorts = new Map(); // tabId -> Port
    this.activeLeaderTabId = null;
    this.initialized = false;
  }

  async init() {
    if (this.sessionStorage) {
      try {
        const stored = await new Promise((resolve) => {
          this.sessionStorage.get(["activeLeaderTabId"], (res) => resolve(res || {}));
        });
        if (stored?.activeLeaderTabId) {
          this.activeLeaderTabId = stored.activeLeaderTabId;
        }
      } catch (e) {
        console.warn("[BackgroundCoordinator] Error reading session storage:", e);
      }
    }
    this.initialized = true;
  }

  handlePortConnect(port) {
    if (port.name !== "gemini-tab-coordinator") return;

    const tabId = port.sender?.tab?.id ?? (port._mockTabId || Math.floor(Math.random() * 1000000));
    this.connectedPorts.set(tabId, port);

    // Election logic
    if (this.activeLeaderTabId === null || !this.connectedPorts.has(this.activeLeaderTabId)) {
      this.activeLeaderTabId = tabId;
      this.persistLeader(tabId);
      this.sendPortMessage(port, { type: "COORDINATOR_STATE", role: "leader", tabId });
      console.log(`[BackgroundCoordinator] 👑 Tab ${tabId} elected as Leader`);
    } else if (this.activeLeaderTabId === tabId) {
      // Reconnecting leader tab
      this.sendPortMessage(port, { type: "COORDINATOR_STATE", role: "leader", tabId });
    } else {
      // Existing active leader exists: assign standby
      this.sendPortMessage(port, { type: "COORDINATOR_STATE", role: "standby", tabId, leaderTabId: this.activeLeaderTabId });
      console.log(`[BackgroundCoordinator] 💤 Tab ${tabId} assigned as Standby (Leader is ${this.activeLeaderTabId})`);
    }

    port.onMessage.addListener((msg) => {
      if (msg?.type === "CLAIM_LEADERSHIP") {
        this.promoteToLeader(tabId);
      }
    });

    port.onDisconnect.addListener(() => {
      this.connectedPorts.delete(tabId);
      console.log(`[BackgroundCoordinator] Tab ${tabId} disconnected`);

      if (this.activeLeaderTabId === tabId) {
        this.activeLeaderTabId = null;
        // Elect next available connected tab
        const nextEntry = this.connectedPorts.entries().next().value;
        if (nextEntry) {
          const [nextTabId, nextPort] = nextEntry;
          this.activeLeaderTabId = nextTabId;
          this.persistLeader(nextTabId);
          this.sendPortMessage(nextPort, { type: "COORDINATOR_STATE", role: "leader", tabId: nextTabId });
          console.log(`[BackgroundCoordinator] 👑 Failover: Tab ${nextTabId} promoted to Leader`);
        } else {
          this.clearLeader();
        }
      }
    });
  }

  promoteToLeader(tabId) {
    if (this.activeLeaderTabId === tabId) return;

    const oldLeaderId = this.activeLeaderTabId;
    this.activeLeaderTabId = tabId;
    this.persistLeader(tabId);

    // Demote previous leader if connected
    if (oldLeaderId !== null && this.connectedPorts.has(oldLeaderId)) {
      const oldPort = this.connectedPorts.get(oldLeaderId);
      this.sendPortMessage(oldPort, { type: "COORDINATOR_STATE", role: "standby", tabId: oldLeaderId, leaderTabId: tabId });
    }

    // Promote new leader
    if (this.connectedPorts.has(tabId)) {
      const newPort = this.connectedPorts.get(tabId);
      this.sendPortMessage(newPort, { type: "COORDINATOR_STATE", role: "leader", tabId });
    }

    console.log(`[BackgroundCoordinator] 👑 User takeover: Tab ${tabId} promoted to Leader`);
  }

  sendPortMessage(port, msg) {
    try {
      port.postMessage(msg);
    } catch (e) {
      console.warn("[BackgroundCoordinator] Error posting port message:", e);
    }
  }

  persistLeader(tabId) {
    if (this.sessionStorage) {
      try {
        this.sessionStorage.set({ activeLeaderTabId: tabId });
      } catch (e) {}
    }
  }

  clearLeader() {
    if (this.sessionStorage) {
      try {
        this.sessionStorage.remove(["activeLeaderTabId"]);
      } catch (e) {}
    }
  }
}

/**
 * Owns the WebSocket to the Cloudflare DO hub so the connection no longer
 * depends on the Gemini tab staying alive (Chrome discards/freezes idle tabs).
 * Since Chrome 116, WebSocket activity keeps the MV3 service worker alive;
 * a chrome.alarms keepalive covers the remaining suspension window.
 */
export class BridgeSocketManager {
  constructor(options = {}) {
    this.coordinator = options.coordinator || null;
    this.settings = options.settings || { workerUrl: DEFAULT_WORKER_URL, bridgeToken: DEFAULT_BRIDGE_SECRET, enforcementMode: "strict" };
    this.tabsApi = options.tabsApi || (typeof chrome !== "undefined" && chrome.tabs ? chrome.tabs : null);
    this.WebSocketImpl = options.WebSocketImpl || (typeof WebSocket !== "undefined" ? WebSocket : null);
    this.storageApi = options.storageApi || (typeof chrome !== "undefined" && chrome.storage?.sync ? chrome.storage.sync : null);

    this.socket = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.authFailed = false;
    // requestId -> { scope, timer } for in-flight scope switches awaiting a tab publish
    this.pendingScopes = new Map();
    // tabId -> Port for content scripts connected via "gemini-bridge-socket"
    this.bridgePorts = new Map();
  }

  wsUrl() {
    const url = new URL(this.settings.workerUrl);
    url.protocol = url.protocol === "http:" || url.protocol === "ws:" ? "ws:" : "wss:";
    url.pathname = "/bridge";
    url.search = "";
    url.searchParams.set("token", this.settings.bridgeToken);
    url.searchParams.set("client", "background_sw");
    return url.toString();
  }

  sendToWorker(data) {
    if (this.socket && this.socket.readyState === 1) {
      try {
        this.socket.send(JSON.stringify(data));
        return true;
      } catch (e) {
        console.warn("[BridgeSocket] Send failed:", e.message);
      }
    }
    console.warn("[BridgeSocket] Cannot send: WebSocket not open.", data?.type);
    return false;
  }

  connect() {
    if (this.authFailed) return;
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;
    if (!this.WebSocketImpl) return;

    try {
      this.socket = new this.WebSocketImpl(this.wsUrl());
    } catch (e) {
      console.error("[BridgeSocket] WebSocket creation failed:", e);
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      console.log("[BridgeSocket] ✅ Connected to Cloudflare DO Hub");
      this.reconnectAttempts = 0;
      // After a SW restart the DO lost our session publish; ask the active
      // bridge tab to re-send its session/model state.
      this.requestSync();
    };

    this.socket.onerror = () => {};

    this.socket.onclose = (event) => {
      console.warn(`[BridgeSocket] Disconnected (code: ${event?.code}, reason: ${event?.reason || "none"})`);
      this.socket = null;
      if (event?.code === 4401 || event?.code === 401 || (event?.reason && /unauthorized|invalid\s+bridge\s+secret/i.test(event.reason))) {
        this.authFailed = true;
        console.warn("[BridgeSocket] Auth failure. Reconnection stopped until settings change.");
        return;
      }
      this.scheduleReconnect();
    };

    this.socket.onmessage = (event) => {
      try {
        this.handleWorkerMessage(JSON.parse(event.data));
      } catch (e) {
        console.error("[BridgeSocket] Failed to parse Worker message:", e);
      }
    };
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.authFailed) return;
    const delay = computeBackoff(this.reconnectAttempts);
    this.reconnectAttempts++;
    console.log(`[BridgeSocket] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  handleSettingsChange(settings) {
    this.settings = { ...this.settings, ...settings };
    if (this.settings.bridgeToken && this.settings.bridgeToken.trim()) {
      this.settings.bridgeToken = this.settings.bridgeToken.trim();
    }
    this.authFailed = false;
    this.reconnectAttempts = 0;
    if (this.socket) {
      try { this.socket.close(1000, "Settings changed"); } catch (e) {}
      this.socket = null;
    }
    this.connect();
  }

  activeBridgePort() {
    const tabId = this.coordinator?.activeLeaderTabId;
    if (tabId != null && this.bridgePorts.has(tabId)) {
      return this.bridgePorts.get(tabId);
    }
    // Fallback: pick the first available content script bridgePort
    if (this.bridgePorts.size > 0) {
      return this.bridgePorts.values().next().value;
    }
    return null;
  }

  forwardToActiveTab(msg) {
    const port = this.activeBridgePort();
    if (!port) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch (e) {
      console.warn("[BridgeSocket] Forward to bridge tab failed:", e.message);
      return false;
    }
  }

  requestSync() {
    this.forwardToActiveTab({ type: "REQUEST_SYNC" });
  }

  handleWorkerMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "PING":
        this.sendToWorker({ type: "PONG" });
        break;
      case "PREPARE_MODEL":
      case "EXECUTE_REQUEST":
      case "CANCEL_REQUEST":
      case "REFRESH_MODELS":
      case "AUTO_SELECT_MODEL":
      case "ENABLE_THINKING": {
        const forwarded = this.forwardToActiveTab(msg);
        if (!forwarded && ["PREPARE_MODEL", "EXECUTE_REQUEST"].includes(msg.type)) {
          this.sendToWorker({
            type: "STREAM_ERROR",
            requestId: msg.requestId,
            error: "No active bridge tab is connected to the background coordinator.",
            code: "extension_disconnected"
          });
        }
        break;
      }
      case "PREPARE_SCOPE":
        this.handlePrepareScope(msg);
        break;
      default:
        break;
    }
  }

  async tabScope(tabId) {
    if (!this.tabsApi) return null;
    try {
      const tab = await this.tabsApi.get(tabId);
      return scopeFromPath(new URL(tab.url || "https://gemini.google.com/").pathname);
    } catch (e) {
      return null;
    }
  }

  /**
   * PREPARE_SCOPE from the DO hub. Resolution order:
   *  1. Active bridge tab already at the requested scope → forward for SCOPE_READY.
   *  2. Another connected tab at the requested scope → promote it to leader.
   *  3. Otherwise navigate the active tab (or open a background tab) and
   *     resolve pending scopes when the tab publishes SESSION_READY.
   */
  async handlePrepareScope(msg) {
    const { requestId } = msg;
    const target = msg.scope || "app";

    try {
      const leaderId = this.coordinator?.activeLeaderTabId;
      if (leaderId != null && (await this.tabScope(leaderId)) === target) {
        this.forwardToActiveTab(msg);
        return;
      }
      if (this.coordinator) {
        for (const tabId of this.coordinator.connectedPorts.keys()) {
          if (tabId === leaderId) continue;
          if ((await this.tabScope(tabId)) === target) {
            this.coordinator.promoteToLeader(tabId);
            this.forwardToActiveTab(msg);
            return;
          }
        }
      }
    } catch (e) {
      console.warn("[BridgeSocket] Scope tab probe failed:", e);
    }

    this.pendingScopes.set(requestId, {
      scope: target,
      timer: setTimeout(() => {
        this.pendingScopes.delete(requestId);
        this.sendToWorker({
          type: "STREAM_ERROR",
          requestId,
          error: `Scope switch to '${target}' timed out after ${Math.round(SCOPE_SWITCH_TIMEOUT_MS / 1000)}s`,
          code: "scope_switch_failed"
        });
      }, SCOPE_SWITCH_TIMEOUT_MS)
    });

    const url = scopeToUrl(target);
    const leaderId = this.coordinator?.activeLeaderTabId;
    if (leaderId != null && this.coordinator.connectedPorts.has(leaderId) && this.tabsApi) {
      try {
        await this.tabsApi.update(leaderId, { url });
        return;
      } catch (e) {
        console.warn("[BridgeSocket] Tab navigation failed:", e);
      }
    }
    if (this.tabsApi) {
      try {
        await this.tabsApi.create({ url, active: false });
        return;
      } catch (e) {
        console.warn("[BridgeSocket] Tab creation failed:", e);
      }
    }
    const entry = this.pendingScopes.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pendingScopes.delete(requestId);
      this.sendToWorker({
        type: "STREAM_ERROR",
        requestId,
        error: `Scope switch to '${target}' failed: no tab available to navigate`,
        code: "scope_switch_failed"
      });
    }
  }

  resolvePendingScopes(scope) {
    if (!this.pendingScopes.size) return;
    const effective = scope || "app";
    for (const [requestId, entry] of Array.from(this.pendingScopes.entries())) {
      if (entry.scope === effective) {
        clearTimeout(entry.timer);
        this.pendingScopes.delete(requestId);
        this.sendToWorker({ type: "SCOPE_READY", requestId, scope: entry.scope });
      }
    }
  }

  /** Messages arriving from content scripts over the "gemini-bridge-socket" port. */
  onTabMessage(tabId, msg) {
    if (!msg || typeof msg !== "object") return;
    // If no leader is currently registered or active, auto-assign this tab as leader
    if (this.coordinator && tabId && (this.coordinator.activeLeaderTabId == null || !this.coordinator.connectedPorts.has(this.coordinator.activeLeaderTabId))) {
      this.coordinator.activeLeaderTabId = tabId;
    }
    const isActive = !this.coordinator || this.coordinator.activeLeaderTabId == null || this.coordinator.activeLeaderTabId === tabId;
    if (!isActive) return;

    if (msg.type === "SESSION_READY" || msg.type === "MODELS_DISCOVERED") {
      this.resolvePendingScopes(msg.scope);
      this.sendToWorker(msg);
    } else if (["STREAM_CHUNK", "STREAM_DONE", "STREAM_ERROR", "MODEL_READY"].includes(msg.type)) {
      this.sendToWorker(msg);
    }
  }

  handleBridgePort(port) {
    const tabId = port.sender?.tab?.id ?? (port._mockTabId || Math.floor(Math.random() * 1000000));
    this.bridgePorts.set(tabId, port);
    if (this.tabsApi && port.sender?.tab?.id) {
      try { this.tabsApi.update(port.sender.tab.id, { autoDiscardable: false }).catch(() => {}); } catch (e) {}
    }
    port.onMessage.addListener((msg) => this.onTabMessage(tabId, msg));
    port.onDisconnect.addListener(() => {
      if (this.bridgePorts.get(tabId) === port) {
        this.bridgePorts.delete(tabId);
      }
    });
  }
}

// ─── Singleton wiring for the real browser runtime ───────────
// All chrome.* event listeners are registered synchronously at the top level
// (MV3 requirement) so they survive service worker restarts.
if (typeof chrome !== "undefined" && chrome.runtime?.onConnect) {
  const coordinator = new CentralTabCoordinator();
  coordinator.init();
  const manager = new BridgeSocketManager({ coordinator });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "gemini-tab-coordinator") {
      coordinator.handlePortConnect(port);
    } else if (port.name === "gemini-bridge-socket") {
      manager.handleBridgePort(port);
    }
  });

  if (chrome.storage?.sync) {
    chrome.storage.sync.get(["workerUrl", "bridgeToken", "enforcementMode"]).then((settings) => {
      manager.settings = {
        workerUrl: (settings.workerUrl || DEFAULT_WORKER_URL).trim(),
        bridgeToken: (settings.bridgeToken && settings.bridgeToken.trim()) ? settings.bridgeToken.trim() : DEFAULT_BRIDGE_SECRET,
        enforcementMode: settings.enforcementMode === "permissive" ? "permissive" : "strict"
      };
      manager.connect();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (changes.workerUrl || changes.bridgeToken || changes.enforcementMode) {
        manager.handleSettingsChange({
          workerUrl: changes.workerUrl?.newValue,
          bridgeToken: changes.bridgeToken?.newValue,
          enforcementMode: changes.enforcementMode?.newValue
        });
      }
    });
  } else {
    manager.connect();
  }

  // Fallback keepalive: WS traffic normally keeps the SW alive, but the alarm
  // guarantees a reconnect check even after a suspension edge case.
  if (chrome.alarms?.onAlarm) {
    chrome.alarms.create("bridge-keepalive", { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "bridge-keepalive") {
        if (!manager.socket || manager.socket.readyState !== 1) manager.connect();
      }
    });
  }
}
