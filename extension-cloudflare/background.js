// ============================================================
// Gemini Web-Bridge: Background Service Worker
// Owns the Cloudflare WebSocket (MV3-safe), coordinates bridge tabs,
// and manages conversation scope switching (app / notebook).
// Phase 4: Multiplexed Message Protocol + Scope Router
//   - Single WebSocket handles all scopes via message routing
//   - SCOPE_SWITCH message type for scope switching without reconnect
//   - ScopeSessionManager maintains current scope state
// ============================================================

import { 
  validateScope, 
  scopeFromPath, 
  scopeToUrl,
  MessageTypes,
  ScopeSessionManager,
  buildMessage,
  buildScopeSwitchMessage,
  buildScopeReadyMessage,
  PROTOCOL_VERSION,
  supportsMultiplexedProtocol,
} from './protocol-messages.js';

const DEFAULT_WORKER_URL = "https://gemini-web-bridge.pansakorn-pho.workers.dev";
// Injected by scripts/build-extension.py at build time — never commit real values.
const DEFAULT_BRIDGE_SECRET = "__BRIDGE_AUTH_TOKEN__";
const SCOPE_SWITCH_TIMEOUT_MS = 45000;
const INSTANCE_ID_STORAGE_KEY = "bridge_instance_id";

/**
 * AsyncMutex: promise-based mutual exclusion lock.
 * Multiple callers acquire the lock sequentially — only one
 * holds it at a time; others queue on the returned promise.
 */
class AsyncMutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  acquire() {
    return new Promise((resolve) => {
      this._queue.push(resolve);
      this._drain();
    });
  }

  async runLocked(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  _drain() {
    if (this._locked || this._queue.length === 0) return;
    this._locked = true;
    const next = this._queue.shift();
    next(() => {
      this._locked = false;
      this._drain();
    });
  }
}

/**
 * ConnectionState: finite state machine for the WebSocket lifecycle.
 * Replaces ad-hoc readyState checks that allowed race conditions.
 */
const ConnectionState = Object.freeze({
  DISCONNECTED: "DISCONNECTED",     // No socket, not trying to connect.
  CONNECTING: "CONNECTING",         // Lock held, socket created, waiting for onopen.
  CONNECTED: "CONNECTED",           // Socket open and healthy.
  RECONNECTING: "RECONNECTING",     // Socket closed unexpectedly; backoff timer armed.
  AUTH_FAILED: "AUTH_FAILED",       // 401/4401 received; must not reconnect until settings change.
});

/**
 * Generates a cryptographically random UUID v4 instance ID.
 * This persists across SW restarts and identifies this specific
 * Chrome extension installation.
 */
function generateInstanceId() {
  return crypto.randomUUID();
}

/**
 * Retrieves or creates a persistent instance ID from chrome.storage.session.
 * The instance ID survives service worker restarts but is cleared when
 * the browser session ends (normal Chrome behavior for session storage).
 */
async function getOrCreateInstanceId(storageSession) {
  if (!storageSession) {
    // Fallback for non-Chrome environments: generate ephemeral ID
    return generateInstanceId();
  }
  try {
    const stored = await new Promise((resolve) => {
      storageSession.get([INSTANCE_ID_STORAGE_KEY], (res) => resolve(res || {}));
    });
    if (stored?.[INSTANCE_ID_STORAGE_KEY]) {
      return stored[INSTANCE_ID_STORAGE_KEY];
    }
    // Generate new instance ID and persist it
    const newId = generateInstanceId();
    await new Promise((resolve) => {
      storageSession.set({ [INSTANCE_ID_STORAGE_KEY]: newId }, resolve);
    });
    return newId;
  } catch (e) {
    console.warn("[BackgroundCoordinator] Error managing instance ID:", e);
    return generateInstanceId(); // Fallback
  }
}

/**
 * Allowed characters for a scope id; same charset as scopeFromPath's capture
 * group ([A-Za-z0-9_-]+) so only well-formed ids can reach URL construction.
 * group ([A-Za-z0-9_-]+) so only well-formed ids can reach URL construction.
 */
const SCOPE_ID_RE = /^[A-Za-z0-9_-]+$/;

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
    this.lastLeaderHeartbeat = null; // Timestamp of last heartbeat from current leader (ms)
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
      if (msg?.type === "HEARTBEAT" && this.activeLeaderTabId === tabId) {
        this.lastLeaderHeartbeat = Date.now();
        this.sendPortMessage(port, { type: "HEARTBEAT_ACK", timestamp: Date.now() });
      }
      // Check leader health on every incoming message
      this.checkLeaderHealth();
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

  checkLeaderHealth() {
    if (this.activeLeaderTabId === null) return;
    if (typeof this.lastLeaderHeartbeat !== "number") return;
    const now = Date.now();
    const heartbeatAge = now - this.lastLeaderHeartbeat;
    if (heartbeatAge > 15000) {
      // Leader heartbeat stale > 15s (3 misses at 5s interval) — auto-failover
      console.warn(`[BackgroundCoordinator] ⚠️ Leader heartbeat stale (${Math.round(heartbeatAge/1000)}s) — auto-failover`);
      const nextEntry = this.connectedPorts.entries().next().value;
      if (nextEntry) {
        const [nextTabId, nextPort] = nextEntry;
        const oldLeaderId = this.activeLeaderTabId;
        this.activeLeaderTabId = nextTabId;
        this.persistLeader(nextTabId);
        // Demote old leader
        if (this.connectedPorts.has(oldLeaderId)) {
          const oldPort = this.connectedPorts.get(oldLeaderId);
          this.sendPortMessage(oldPort, { type: "COORDINATOR_STATE", role: "standby", tabId: oldLeaderId, leaderTabId: nextTabId });
        }
        // Promote new leader
        if (this.connectedPorts.has(nextTabId)) {
          this.sendPortMessage(nextPort, { type: "COORDINATOR_STATE", role: "leader", tabId: nextTabId });
        }
        console.log(`[BackgroundCoordinator] 👑 Auto-failover: Tab ${nextTabId} promoted to Leader (leader unresponsive)`);
      }
    }
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
    // Phase 1: Connection singleton guard
    this._mutex = new AsyncMutex();
    this._state = ConnectionState.DISCONNECTED;
    this._connectionAttemptTimer = null; // 15s timeout guard
    this._staleCheckTimer = null;        // 60s idle detection
    // requestId -> { scope, timer } for in-flight scope switches awaiting a tab publish
    this.pendingScopes = new Map();
    // tabId -> Port for content scripts connected via "gemini-bridge-socket"
    this.bridgePorts = new Map();
    // Per-instance-id tracking
    this.instanceId = null;
    // Phase 4: Scope session manager for multiplexed protocol
    this.scopeSessionManager = new ScopeSessionManager();
    // Default handler: unscoped messages get forwarded to the active bridge tab.
    // This is wired after connect() so `forwardToActiveTab` exists; set it here as
    // a stable reference so the manager can call it before the socket is open too.
    this.scopeSessionManager.setDefaultHandler((msg, scopeId) => {
      this.forwardToActiveTab(msg);
    });
  }

  async initInstanceId() {
    // Use session storage for instance ID persistence (survives SW restarts)
    const sessionStorage = (typeof chrome !== "undefined" && chrome.storage?.session) ? chrome.storage.session : null;
    this.instanceId = await getOrCreateInstanceId(sessionStorage);
    console.log(`[BridgeSocket] Initialized instance ID: ${this.instanceId}`);
  }

  wsUrl() {
    const url = new URL(this.settings.workerUrl);
    url.protocol = url.protocol === "http:" || url.protocol === "ws:" ? "ws:" : "wss:";
    url.pathname = "/bridge";
    url.search = "";
    url.searchParams.set("token", this.settings.bridgeToken);
    url.searchParams.set("client", "background_sw");
    if (this.instanceId) {
      url.searchParams.set("instanceId", this.instanceId);
    }
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
    // Fast path: already connected — nothing to do.
    if (this._state === ConnectionState.CONNECTED) {
      return;
    }
    // Fast path: auth is broken — don't even try.
    if (this._state === ConnectionState.AUTH_FAILED) {
      return;
    }
    // Run the entire connection attempt under the mutex so that racing
    // entry points (storage callback, onChanged, alarms) serialize.
    this._mutex.runLocked(async () => {
      // Re-check state under lock — another queued caller may have
      // already transitioned us.
      if (this._state === ConnectionState.CONNECTED) return;
      if (this._state === ConnectionState.AUTH_FAILED) return;
      // Don't start a new attempt while one is in flight or scheduled.
      if (this._state === ConnectionState.CONNECTING || this._state === ConnectionState.RECONNECTING) {
        return;
      }
      await this._doConnectInternal();
    }).catch((e) => {
      console.error("[BridgeSocket] connect() mutex error:", e);
    });
  }

  /**
   * Internal connection attempt. Must be called while the mutex is held.
   */
  async _doConnectInternal() {
    this._state = ConnectionState.CONNECTING;
    this.reconnectTimer = null; // cancel any pending backoff timer

    if (!this.WebSocketImpl) {
      console.error("[BridgeSocket] WebSocket API unavailable; cannot connect.");
      this._state = ConnectionState.DISCONNECTED;
      return;
    }

    // Ensure instanceId is set before building the WebSocket URL.
    // It can be null after _onConflict() clears it or if initInstanceId()
    // hasn't resolved yet. A missing ?instanceId= param causes a 401 on the
    // DO side, which would permanently lock out reconnection via AUTH_FAILED.
    if (!this.instanceId) {
      try {
        await this.initInstanceId();
      } catch (e) {
        console.error("[BridgeSocket] Failed to reinitialize instanceId:", e);
        // Generate a transient ID so we at least attempt the connection.
        this.instanceId = (typeof crypto !== "undefined" && crypto.randomUUID)
          ? crypto.randomUUID()
          : `fallback-${Date.now()}`;
      }
    }

    let wsUrl;
    try {
      wsUrl = this.wsUrl();
    } catch (e) {
      console.error("[BridgeSocket] wsUrl() construction failed:", e);
      this._state = ConnectionState.DISCONNECTED;
      this.scheduleReconnect();
      return;
    }

    try {
      this.socket = new this.WebSocketImpl(wsUrl);
    } catch (e) {
      console.error("[BridgeSocket] WebSocket creation failed:", e);
      this._state = ConnectionState.DISCONNECTED;
      this.scheduleReconnect();
      return;
    }

    // ── 15-second connection attempt timeout ──
    this._connectionAttemptTimer = setTimeout(() => {
      if (this._state === ConnectionState.CONNECTING && this.socket) {
        console.warn("[BridgeSocket] Connection attempt timed out after 15s — forcing close.");
        try { this.socket.close(1006, "connection timeout"); } catch (e) {}
        this.socket = null;
        this._onConnectionTimeout();
      }
    }, 15000);

    this.socket.onopen = () => {
      if (this._connectionAttemptTimer) {
        clearTimeout(this._connectionAttemptTimer);
        this._connectionAttemptTimer = null;
      }
      console.log("[BridgeSocket] ✅ Connected to Cloudflare DO Hub");
      this.reconnectAttempts = 0;
      this._state = ConnectionState.CONNECTED;
      // Wire the multiplexed scope session manager to the live socket.
      this.scopeSessionManager.setSendFn((msg) => this.sendToWorker(msg));
      // Start stale-socket detection ticker.
      this._resetStaleCheckTimer();
      // After a SW restart the DO lost our session publish; ask the active
      // bridge tab to re-send its session/model state.
      this.requestSync();
    };

    this.socket.onerror = () => {
      // onclose will fire shortly after onerror; handle there.
    };

    this.socket.onclose = (event) => {
      if (this._connectionAttemptTimer) {
        clearTimeout(this._connectionAttemptTimer);
        this._connectionAttemptTimer = null;
      }
      this._resetStaleCheckTimer();

      if (!this.socket) return; // already nulled out by timeout path
      console.warn(`[BridgeSocket] Disconnected (code: ${event?.code}, reason: ${event?.reason || "none"})`);
      this.socket = null;

      if (this._state === ConnectionState.CONNECTING) {
        // Connection attempt failed.
        this._state = ConnectionState.DISCONNECTED;
        if (event?.code === 4401 || event?.code === 401 || (event?.reason && /unauthorized|invalid\s+bridge\s+secret/i.test(event.reason))) {
          this._state = ConnectionState.AUTH_FAILED;
          this.authFailed = true;
          console.warn("[BridgeSocket] Auth failure. Reconnection stopped until settings change.");
          return;
        }
        // HTTP 409 Conflict: another device/tab is already using the bridge.
        if (event?.code === 409 || (event?.reason && /conflict|active and healthy/i.test(event.reason))) {
          console.warn("[BridgeSocket] Connection rejected (409 Conflict): bridge is already active on another device/tab.");
          console.warn("[BridgeSocket] If this is the only active Chrome profile, restart Chrome or close other Chrome profiles.");
          this._onConflict();
          return;
        }
        this.scheduleReconnect();
        return;
      }

      // Transitioning from CONNECTED — socket closed unexpectedly.
      if (this._state === ConnectionState.CONNECTED) {
        this._state = ConnectionState.DISCONNECTED;
        // Don't auto-reconnect on explicit close from handleSettingsChange.
        if (event?.code === 1000 && event?.reason === "Settings changed") {
          return;
        }
        this.scheduleReconnect();
      }
    };

    this.socket.onmessage = (event) => {
      try {
        this.handleWorkerMessage(JSON.parse(event.data));
      } catch (e) {
        console.error("[BridgeSocket] Failed to parse Worker message:", e);
      }
    };
  }

  /**
   * Called when a connection attempt times out after 15s.
   */
  _onConnectionTimeout() {
    this._state = ConnectionState.DISCONNECTED;
    if (this._state !== ConnectionState.AUTH_FAILED) {
      this.scheduleReconnect();
    }
  }

  /**
   * Called on 409 Conflict. Clears the stale instanceId, waits for the DO's
   * 45-second stale-connection window to elapse (we wait 50s to be safe), then
   * generates a fresh instanceId and retries. Without this retry the SW would
   * stay DISCONNECTED forever because `_onConflict` was the only path out of the
   * 409 branch that did NOT call scheduleReconnect().
   */
  _onConflict() {
    this.reconnectAttempts = 0;
    this.instanceId = null; // forget identity; next connect() generates new
    const sessionStorage = (typeof chrome !== "undefined" && chrome.storage?.session) ? chrome.storage.session : null;
    if (sessionStorage) {
      try { sessionStorage.remove([INSTANCE_ID_STORAGE_KEY]); } catch (e) {}
    }
    // Schedule a reconnect attempt after the DO's 45s stale window (+5s grace).
    // The state stays DISCONNECTED so checkStaleSocket() / alarms can also
    // trigger the attempt independently.
    const CONFLICT_RETRY_DELAY_MS = 50_000;
    console.log(`[BridgeSocket] 409 Conflict: will retry with fresh identity in ${CONFLICT_RETRY_DELAY_MS / 1000}s.`);
    if (!this.reconnectTimer) {
      this._state = ConnectionState.RECONNECTING;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        // Re-initialize instanceId before the next attempt so wsUrl() always
        // includes the required ?instanceId= param (missing it causes 401).
        this.initInstanceId().then(() => this.connect()).catch(() => this.connect());
      }, CONFLICT_RETRY_DELAY_MS);
    }
  }

  /**
   * Starts/resets the 60-second stale-socket detection timer.
   * Each incoming message or successful send resets the clock.
   */
  _resetStaleCheckTimer() {
    if (this._staleCheckTimer) {
      clearTimeout(this._staleCheckTimer);
    }
    this._staleCheckTimer = setTimeout(() => {
      this._staleCheckTimer = null;
      this._detectStaleSocket();
    }, 60_000);
  }

  /**
   * Called when the 60s idle threshold expires.
   * If the socket is still open but has had no activity, treat as stale
   * and reconnect.
   */
  _detectStaleSocket() {
    if (this._state !== ConnectionState.CONNECTED || !this.socket) return;
    console.warn("[BridgeSocket] ⚠️ Stale socket detected: 60s without activity. Reconnecting.");
    try { this.socket.close(1001, "stale socket"); } catch (e) {}
    this.socket = null;
    this._state = ConnectionState.DISCONNECTED;
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.authFailed || this._state === ConnectionState.AUTH_FAILED) return;
    if (this._state === ConnectionState.CONNECTING) return; // don't stack
    this._state = ConnectionState.RECONNECTING;
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
    // Forget old instanceId so the DO hub sees this as a fresh identity
    // after a credential rotation (prevents lingering 409).
    this.instanceId = null;
    if (this.socket) {
      try { this.socket.close(1000, "Settings changed"); } catch (e) {}
      this.socket = null;
    }
    // Clear any stale-check timer; connect() will restart it.
    if (this._staleCheckTimer) {
      clearTimeout(this._staleCheckTimer);
      this._staleCheckTimer = null;
    }
    this.connect();
  }

  activeBridgePort() {
    const tabId = this.coordinator?.activeLeaderTabId;
    if (tabId != null && this.bridgePorts.has(tabId)) {
      return this.bridgePorts.get(tabId);
    }
    return null;
  }

  forwardToActiveTab(msg) {
    const port = this.activeBridgePort();
    if (!port) return false;
    try {
      port.postMessage(msg);
      // Reset stale-check timer on every successful send.
      this._resetStaleCheckTimer();
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

    // Control messages must be handled directly by the socket manager
    // before any envelope/scope routing. Specifically, DO keepalive PING
    // must always reply with PONG to maintain connection liveness.
    if (msg.type === "PING") {
      this.sendToWorker({ type: "PONG" });
      this._resetStaleCheckTimer();
      return;
    }

    // Direct handling of control, execution, and scope messages
    switch (msg.type) {
      case "PREPARE_SCOPE":
        this.handlePrepareScope(msg);
        break;

      case MessageTypes.SCOPE_SWITCH:
        this.handleScopeSwitch(msg);
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

      case MessageTypes.PROTOCOL_INFO:
        console.log("[BridgeSocket] Protocol info from worker:", msg);
        break;

      case MessageTypes.SUBSCRIBE:
      case MessageTypes.UNSUBSCRIBE:
        this.scopeSessionManager.routeMessage(msg);
        break;

      default:
        // Any remaining custom message routed through scopeSessionManager
        this.scopeSessionManager.routeMessage(msg);
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
        console.log(`[BridgeSocket] Navigated leader tab ${leaderId} to ${url}; awaiting scope confirmation`);
        const pollDelays = [300, 800, 1600, 3000];
        for (const delay of pollDelays) {
          setTimeout(() => {
            if (this.pendingScopes.has(requestId)) {
              this.sendToActiveTab({ type: "REQUEST_SCOPE_DETECTION" });
            }
          }, delay);
        }
        return;
      } catch (e) {
        console.warn("[BridgeSocket] Tab navigation failed:", e);
      }
    }
    if (this.tabsApi) {
      try {
        await this.tabsApi.create({ url, active: false });
        console.log(`[BridgeSocket] Created background tab for ${url}; awaiting scope confirmation`);
        const pollDelays = [500, 1200, 2500, 4000];
        for (const delay of pollDelays) {
          setTimeout(() => {
            if (this.pendingScopes.has(requestId)) {
              this.sendToActiveTab({ type: "REQUEST_SCOPE_DETECTION" });
            }
          }, delay);
        }
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

  /** Resolve pending scope switches using the ACTUAL detected scope (not the target). */
  resolvePendingScopes(actualScope) {
    if (!this.pendingScopes.size) return;
    const effective = actualScope || "app";
    const validated = validateScope(actualScope) || actualScope;

    // Confirm the scope via the session manager (it handles wire SCOPE_READY + listener resolution).
    this.scopeSessionManager.confirmScope(validated);

    for (const [requestId, entry] of Array.from(this.pendingScopes.entries())) {
      if (entry.scope === effective || entry.scope === validated) {
        clearTimeout(entry.timer);
        this.pendingScopes.delete(requestId);
        // The manager already emitted SCOPE_READY in confirmScope; ensure the worker
        // also gets the explicit per-request SCOPE_READY for legacy compatibility.
        this.sendToWorker({ type: "SCOPE_READY", requestId, scope: validated });
      }
    }
  }

  /** Respond to a content-script scope re-detection request. */
  onScopeDetected(tabId, actualScope) {
    if (!actualScope) return;
    console.log(`[BridgeSocket] Tab ${tabId} detected scope: ${actualScope}`);
    this.resolvePendingScopes(actualScope);
    // Also update the DO hub's currentScope by forwarding a SESSION_READY
    // with the verified scope so the Worker can trust it.
    this.sendToWorker({ type: "SESSION_READY", scope: actualScope, tabId });
  }

  /**
   * Phase 4: Handle SCOPE_SWITCH message from worker (multiplexed protocol).
   * Delegates scope switching state machine to ScopeSessionManager.
   * The manager validates, notifies handlers, emits the wire SCOPE_SWITCH,
   * and (when wired) awaits a navigation callback to perform the tab switch.
   */
  async handleScopeSwitch(msg) {
    // Delegate entirely to the scope session manager; it handles validation,
    // handler notifications, wire emission, and optional navigation callback.
    // The navigation callback is wired inline: it updates the leader tab URL and
    // requests scope detection from the content script — the same flow as the
    // legacy path but owned by the manager now.
    const navigateFn = async (url, validatedScope) => {
      const leaderId = this.coordinator?.activeLeaderTabId;
      if (leaderId != null && this.coordinator.connectedPorts.has(leaderId) && this.tabsApi) {
        try {
          await this.tabsApi.update(leaderId, { url });
          console.log(`[BridgeSocket] Navigated leader tab ${leaderId} to ${url}; awaiting scope confirmation`);
          const pollDelays = [300, 800, 1600, 3000];
          for (const delay of pollDelays) {
            setTimeout(() => {
              this.sendToActiveTab({ type: "REQUEST_SCOPE_DETECTION" });
            }, delay);
          }
          return;
        } catch (e) {
          console.warn("[BridgeSocket] Tab navigation failed:", e);
        }
      }
      if (this.tabsApi) {
        try {
          await this.tabsApi.create({ url, active: false });
          console.log(`[BridgeSocket] Created background tab for ${url}; awaiting scope confirmation`);
          const pollDelays = [500, 1200, 2500, 4000];
          for (const delay of pollDelays) {
            setTimeout(() => {
              this.sendToActiveTab({ type: "REQUEST_SCOPE_DETECTION" });
            }, delay);
          }
          return;
        } catch (e) {
          console.warn("[BridgeSocket] Tab creation failed:", e);
        }
      }
      // No tab available to navigate — the manager will later get a scope
      // confirmation failure; surface it here as a stream error.
      const requestId = msg.requestId;
      this.sendToWorker({
        type: MessageTypes.STREAM_ERROR,
        requestId,
        error: `Scope switch to '${validatedScope}' failed: no tab available to navigate`,
        code: "scope_switch_failed",
      });
    };

    await this.scopeSessionManager.handleScopeSwitch(msg, navigateFn);
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
    } else if (msg.type === "SCOPE_DETECTED") {
      // Content script re-detected scope after navigation; resolve pending scopes
      // with the ACTUAL scope (not the target). Also forward to Worker for currentScope update.
      this.onScopeDetected(tabId, msg.scope);
    } else if (["STREAM_CHUNK", "STREAM_DONE", "STREAM_ERROR", "MODEL_READY"].includes(msg.type)) {
      this.sendToWorker(msg);
    } else if (msg.type === "REQUEST_SCOPE_DETECTION") {
      // Forward scope re-detection requests to the active content script.
      this.sendToActiveTab(msg);
    }
    // Phase 4: Handle SCOPE_READY from content script (multiplexed protocol).
    // The session manager confirms the scope and emits SCOPE_READY over the wire.
    else if (msg.type === MessageTypes.SCOPE_READY) {
      this.scopeSessionManager.confirmScope(msg.scope, msg.requestId);
      this.sendToWorker(msg);
    }
  }

  sendToActiveTab(msg) {
    const port = this.activeBridgePort();
    if (!port) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch (e) {
      console.warn("[BridgeSocket] Send to active tab failed:", e.message);
      return false;
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

  /**
   * Public entry point for the keepalive alarm (and any other external
   * trigger). Checks if the socket is stale and reconnects if needed.
   */
  checkStaleSocket() {
    if (this._state === ConnectionState.CONNECTED && this.socket && this.socket.readyState === 1) {
      // Socket is healthy — reset the idle clock.
      this._resetStaleCheckTimer();
      return;
    }
    // Socket missing or not open — kick off a reconnect (serialized by connect()).
    this.connect();
  }
}

// ─── Singleton wiring for the real browser runtime ───────────
// All chrome.* event listeners are registered synchronously at the top level
// (MV3 requirement) so they survive service worker restarts.
if (typeof chrome !== "undefined" && chrome.runtime?.onConnect) {
  const coordinator = new CentralTabCoordinator();
  coordinator.init();
  const manager = new BridgeSocketManager({ coordinator });

  // Initialize instance ID before first connection
  manager.initInstanceId().then(() => {
    // Connect after instance ID is ready
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
  }).catch((e) => {
    console.error("[BridgeSocket] Failed to initialize instance ID:", e);
    // Fallback: connect anyway without instance ID
    manager.connect();
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "gemini-tab-coordinator") {
      coordinator.handlePortConnect(port);
    } else if (port.name === "gemini-bridge-socket") {
      manager.handleBridgePort(port);
    }
  });

  // Fallback keepalive: WS traffic normally keeps the SW alive, but the alarm
  // guarantees a reconnect check even after a suspension edge case.
  if (chrome.alarms?.onAlarm) {
    chrome.alarms.create("bridge-keepalive", { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "bridge-keepalive") {
        manager.checkStaleSocket();
      }
    });
  }
}
