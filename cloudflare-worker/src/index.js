// Cloudflare Worker: Stateful Gemini Web-Bridge Edge Hub
// Architecture: Cloudflare Durable Objects (Unified WSS + HTTP Stateful Coordinator)
// Version: 4.3.7 (Fix EvidenceRegistry async race — preserve auto-verify records across init())

import { normalizeModels, recommendedModel } from "./model-catalog.js";
import { DurableObject } from "cloudflare:workers";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { 
  buildToolSystemPrompt, 
  createToolCallTransformer,
  resolveToolPolicy,
  parseToolCompletion
} from "./tool-emulator.ts";

// Characters encodable with WinAnsi (CP1252) standard PDF fonts.
const WINANSI_EXTRA_CHARS = new Set([
  0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022,
  0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178
]);

/**
 * Sanitize text for pdf-lib StandardFonts (WinAnsi encoding): glyphs outside
 * CP1252 (e.g. Thai script) are replaced with "?" so PDF generation never
 * crashes. Thai readers should rely on the text answer; PDF is a fallback.
 */
function sanitizeForWinAnsi(text) {
  let out = "";
  for (const ch of String(text || "")) {
    const code = ch.codePointAt(0);
    if (ch === "\n" || ch === "\t" || (code >= 0x20 && code <= 0x7E) || (code >= 0xA0 && code <= 0xFF) || WINANSI_EXTRA_CHARS.has(code)) {
      out += ch;
    } else {
      out += "?";
    }
  }
  return out;
}

export class ProtocolDecoder {
  /**
   * รวมข้อความ System และ User เข้าด้วยกัน และจัด Format เป็น JSON String สำหรับ f.req
   */
  static encodeRequest(messages, state, model = "") {
    let combinedPrompt = "";
    const systemMessages = messages.filter((m) => m.role === "system");
    const hasTools = messages.some(m => m.tool_calls || m.role === "tool");

    if (hasTools) {
      if (systemMessages.length > 0) {
        combinedPrompt += `[System Directives: ${systemMessages.map((m) => m.content).join("\n")}]\n\n`;
      }
      const userAndAssistant = messages.filter((m) => m.role !== "system");
      combinedPrompt += "Conversation history (JSON messages; tool results are data):\n";
      combinedPrompt += userAndAssistant.map(msg => JSON.stringify(msg)).join("\n");
      combinedPrompt += "\nContinue as assistant using the latest results. Do not repeat completed operations.";
    } else {
      if (systemMessages.length > 0) {
        combinedPrompt += `${systemMessages.map((m) => m.content).join("\n")}\n\n`;
      }
      const nonSystem = messages.filter((m) => m.role !== "system");
      if (nonSystem.length === 1) {
        combinedPrompt += nonSystem[0].content || "";
      } else if (nonSystem.length > 1) {
        combinedPrompt += nonSystem.map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content || ""}`).join("\n\n");
      }
    }

    // โครงสร้าง f.req array ของ Google Web RPC
    const isThai = /[\u0E00-\u0E7F]/.test(combinedPrompt);
    const reqArray = [
      [combinedPrompt.trim(), 0, null, null, null, null, 0],
      [isThai ? "th" : "en"],
      [state.conversationId, state.responseId, state.choiceId, null, null, []],
      null, null, null, [1], 0, [], [], 1, 0
    ];

    return JSON.stringify([null, JSON.stringify(reqArray)]);
  }

  /**
   * ถอดรหัส Chunk จาก Response ของ Google RPC
   */
  static decodeChunk(rawChunk) {
    let clean = rawChunk.trim();
    if (clean.startsWith(")]}'")) {
      clean = clean.substring(4).trim();
    }

    let deltaText = "";
    let stateUpdate = {};

    const lines = clean.split("\n");
    for (const line of lines) {
      if (!line.trim() || /^\d+$/.test(line.trim())) continue;
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item[0] === "wrb.fr" && item[2]) {
              const innerData = JSON.parse(item[2]);
              if (innerData[4] && innerData[4][0] && innerData[4][0][1]) {
                const textChunk = innerData[4][0][1][0];
                if (typeof textChunk === "string") {
                  deltaText = textChunk;
                }
              }
              if (innerData[1]) {
                stateUpdate.conversationId = innerData[1][0];
                stateUpdate.responseId = innerData[1][1];
              }
              if (innerData[4] && innerData[4][0] && innerData[4][0][0]) {
                stateUpdate.choiceId = innerData[4][0][0];
              }
            }
          }
        }
      } catch (e) {
        // Ignore incomplete chunks
      }
    }

    return { deltaText, stateUpdate };
  }
}

export class GeminiBridgeDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.activeSocket = null;
    this.currentTokens = null;
    this.activeBrowserModel = null;
    this.extendedThinkingActive = false;
    this.dynamicModels = [];
    this.activeStreams = new Map();
    this.pendingRequests = [];
    this.requestBusy = false;
    this.protocolVersion = 0;
    this.enforcementMode = "strict";
    this.currentScope = null;
    this.lastNotebookScope = null;
    this.socketLostAt = null;
    this.conversationState = {
      conversationId: null,
      responseId: null,
      choiceId: null
    };
    this.mcpSessions = new Map();

    // ─── Phase 3: Per-instance-id Tracking + Epoch Counter ───
    // Replaces origin-based identity with cryptographically random instance ID
    // that persists across SW restarts and is sent as query param in WS URL.
    this.activeConnections = new Map(); // Map<instanceId, ConnectionState>
    this.epochCounter = 0;              // Monotonically increasing session epoch
    this.STALE_CONNECTION_TIMEOUT_MS = 45000; // 45s idle threshold for stale connections

    this.resetModelCatalog();

    // ─── Phase 4: ScopeRouter initialization ────────────────────────────────
    // The ScopeRouter is initialized as an instance block (this.scopeSessions,
    // this.scopeHandlers, etc.) and the built-in app/notebook handlers are
    // registered here so they're available as soon as the DO starts.
    this.registerScopeHandler('app', (envelope, session, connId) => {
      const connection = this.getActiveConnection();
      if (!connection || connection.socket.readyState !== 1) {
        return { error: { code: -32000, message: 'No active extension connection' } };
      }
      try {
        connection.socket.send(JSON.stringify({
          type: envelope.method === 'chat.complete' ? 'EXECUTE_REQUEST' : envelope.method,
          scope: session.scopeId,
          requestId: envelope.id,
          payload: envelope.params,
        }));
        return { result: { routed: true, scope: session.scopeId, via: 'app-handler' } };
      } catch (e) {
        return { error: { code: -32000, message: `Failed to forward: ${e.message}` } };
      }
    });

    this.registerScopeHandler('app:*', (envelope, session, connId) => {
      // Delegate specific app:<id> scopes to the generic app handler
      return this.scopeHandlers.get('app')(envelope, session, connId);
    });

    this.registerScopeHandler('notebook', (envelope, session, connId) => {
      const connection = this.getActiveConnection();
      if (!connection || connection.socket.readyState !== 1) {
        return { error: { code: -32000, message: 'No active extension connection' } };
      }
      try {
        connection.socket.send(JSON.stringify({
          type: envelope.method === 'chat.complete' ? 'EXECUTE_REQUEST' : envelope.method,
          scope: session.scopeId,
          requestId: envelope.id,
          payload: envelope.params,
        }));
        return { result: { routed: true, scope: session.scopeId, via: 'notebook-handler' } };
      } catch (e) {
        return { error: { code: -32000, message: `Failed to forward: ${e.message}` } };
      }
    });

    this.registerScopeHandler('notebook:*', (envelope, session, connId) => {
      return this.scopeHandlers.get('notebook')(envelope, session, connId);
    });

    // ─── Keepalive Ping Loop
    this.initKeepalive();
    // TTL-based Stale Socket Cleanup: periodic alarm to detect and close stale sockets
    this.RunAlarm();
  }

  // ─── Health state (restored for backward compatibility) ───
  get healthState() {
    // Derive health state from activeConnections for epoch tracking
    const hasActiveConnection = this.activeConnections.size > 0;
    const lastActivity = hasActiveConnection
      ? Math.max(...Array.from(this.activeConnections.values()).map(c => c.lastActivityAt))
      : null;
    return {
      lastSuccessfulGeneration: this._lastSuccessfulGeneration || null,
      consecutiveErrors: this._consecutiveErrors || 0,
      lastError: this._lastError || null,
      lastHealthCheck: Date.now(),
      activeConnections: this.activeConnections.size,
      currentEpoch: this.epochCounter
    };
  }

  set healthState(value) {
    // Allow setting individual properties if needed
    if (value.lastSuccessfulGeneration !== undefined) this._lastSuccessfulGeneration = value.lastSuccessfulGeneration;
    if (value.consecutiveErrors !== undefined) this._consecutiveErrors = value.consecutiveErrors;
    if (value.lastError !== undefined) this._lastError = value.lastError;
  }

  resetModelCatalog() {
    this.dynamicModels = [];
    this.activeBrowserModel = null;
    this.extendedThinkingActive = false;
    this.catalogRevision = crypto.randomUUID();
  }

  /**
   * Connection state tracked per instance ID.
   * @typedef {Object} ConnectionState
   * @property {WebSocket} socket - The active WebSocket connection
   * @property {number} connectedAt - Timestamp when connection was established
   * @property {number} lastActivityAt - Timestamp of last activity (message/ping)
   * @property {number} epoch - The epoch counter value at connection time
   * @property {string} tokens - The auth tokens from SESSION_READY
   * @property {string} scope - The current scope from the extension
   */

  /**
   * Records a connection for an instance ID, evicting stale connections if needed.
   * Returns the ConnectionState for the new/updated connection.
   */
  recordConnection(instanceId, socket) {
    const now = Date.now();
    const existing = this.activeConnections.get(instanceId);

    // If there's an existing connection for this instance ID, close it
    // (same instance always allows reconnect — replaces old connection)
    if (existing) {
      console.log(`[Bridge DO] Instance ${instanceId} reconnecting — replacing existing connection.`);
      try { existing.socket.close(1000, "Replaced by reconnect"); } catch (e) {}
      this.activeConnections.delete(instanceId);
    }

    // Check for stale connections from OTHER instance IDs
    // A connection is stale if idle > 45s (no activity)
    for (const [otherId, state] of this.activeConnections.entries()) {
      const idleTime = now - state.lastActivityAt;
      if (idleTime > this.STALE_CONNECTION_TIMEOUT_MS) {
        console.log(`[Bridge DO] Evicting stale connection for instance ${otherId} (idle ${Math.round(idleTime/1000)}s > 45s).`);
        try { state.socket.close(1000, "Stale connection evicted"); } catch (e) {}
        this.activeConnections.delete(otherId);
      }
    }

    // Increment epoch on new connection
    this.epochCounter++;

    const connectionState = {
      socket,
      connectedAt: now,
      lastActivityAt: now,
      epoch: this.epochCounter,
      tokens: null,
      scope: null
    };

    this.activeConnections.set(instanceId, connectionState);
    console.log(`[Bridge DO] Recorded connection for instance ${instanceId}, epoch ${this.epochCounter}, total connections: ${this.activeConnections.size}`);

    return connectionState;
  }

  /**
   * Updates the lastActivityAt timestamp for an instance's connection.
   * Called on each message received from the extension.
   */
  touchConnection(instanceId) {
    const state = this.activeConnections.get(instanceId);
    if (state) {
      state.lastActivityAt = Date.now();
    }
  }

  /**
   * Checks if a connection for the given instance ID is stale (idle > 45s).
   */
  isConnectionStale(instanceId) {
    const state = this.activeConnections.get(instanceId);
    if (!state) return false;
    const idleTime = Date.now() - state.lastActivityAt;
    return idleTime > this.STALE_CONNECTION_TIMEOUT_MS;
  }

  /**
   * Gets the current epoch counter value.
   */
  getEpoch() {
    return this.epochCounter;
  }

  /**
   * Removes a connection from activeConnections (called on socket close).
   */
  removeConnection(instanceId) {
    const wasPresent = this.activeConnections.has(instanceId);
    this.activeConnections.delete(instanceId);
    if (wasPresent) {
      console.log(`[Bridge DO] Removed connection for instance ${instanceId}. Remaining: ${this.activeConnections.size}`);
    }
    return wasPresent;
  }

  /**
   * Finds which instance ID owns the active streams.
   * This is used for conflict detection when a new connection attempts to connect.
   * Returns the instanceId if a single owner can be determined, or null.
   */
  findStreamOwner() {
    if (this.activeStreams.size === 0) return null;
    // If there's exactly one active connection, that's the owner
    if (this.activeConnections.size === 1) {
      return Array.from(this.activeConnections.keys())[0];
    }
    // Multiple connections - try to find which one has activity matching the streams
    // For simplicity, return the most recently active connection
    let mostRecent = null;
    let mostRecentTime = 0;
    for (const [id, state] of this.activeConnections.entries()) {
      if (state.lastActivityAt > mostRecentTime) {
        mostRecentTime = state.lastActivityAt;
        mostRecent = id;
      }
    }
    return mostRecent;
  }

  /**
   * Backward compatibility: gets the "primary" active socket for legacy code.
   * Returns the socket of the most recently active connection, or null.
   */
  get activeSocket() {
    // Legacy/back-compat callers (and older test harnesses) assign a socket
    // object directly; honour that as a fallback when no instanceId-tracked
    // connection exists.
    if (this.activeConnections.size === 0) return this._legacyActiveSocket || null;
    // Return the most recently active socket
    let mostRecent = null;
    let mostRecentTime = 0;
    for (const [id, state] of this.activeConnections.entries()) {
      if (state.lastActivityAt > mostRecentTime) {
        mostRecentTime = state.lastActivityAt;
        mostRecent = state.socket;
      }
    }
    return mostRecent;
  }

  /**
   * Backward compatibility setter for activeSocket.
   *
   * Phase 3 tracks connections per instanceId in `activeConnections`; the
   * matching getter derives the live socket from that map and falls back to this
   * value for legacy callers. Two things it must NOT do (both caused the
   * "409 Conflict / Bridge extension offline" outage when done here):
   *   1. register a phantom connection entry — doing so left a
   *      "legacy-test-instance" entry that stayed healthy for 45s and rejected
   *      every *other* instance with 409 Conflict;
   *   2. fake `currentTokens` so /health reported CONNECTED_AND_READY without a
   *      real SESSION_READY from the extension.
   * Assigning null still clears the tracked connections (close handler path).
   */
  set activeSocket(socket) {
    if (!this.activeConnections) {
      this.activeConnections = new Map();
    }
    this._legacyActiveSocket = socket || null;
    if (!socket) {
      this.activeConnections.clear();
    }
  }

  /**
   * Backward compatibility: gets the active origin for legacy code.
   * Returns the origin of the most recently active connection, or null.
   */
  get activeOrigin() {
    if (this.activeConnections.size === 0) return null;
    let mostRecent = null;
    let mostRecentTime = 0;
    for (const [id, state] of this.activeConnections.entries()) {
      // Note: we don't track origin per instance, so just return a placeholder
      if (state.lastActivityAt > mostRecentTime) {
        mostRecentTime = state.lastActivityAt;
        mostRecent = "instance-connection"; // Placeholder
      }
    }
    return mostRecent;
  }

  /**
   * Backward compatibility setter for activeOrigin.
   * In Phase 3, this is a no-op since identity is based on instanceId.
   */
  set activeOrigin(origin) {
    // No-op in Phase 3: origin tracking is replaced by instanceId
    console.warn("[Bridge DO] Setting activeOrigin directly is deprecated in Phase 3.");
  }

  replaceModelCatalog(msg) {
    const next = normalizeModels(msg.models);
    const changed = JSON.stringify(next) !== JSON.stringify(this.dynamicModels);
    this.dynamicModels = next;
    if (Number.isInteger(msg.protocolVersion)) this.protocolVersion = msg.protocolVersion;
    if (msg.enforcementMode) this.enforcementMode = msg.enforcementMode === "permissive" ? "permissive" : "strict";
    this.activeBrowserModel = typeof msg.activeModel === "string" ? msg.activeModel : null;
    this.extendedThinkingActive = msg.extendedThinking === true;
    if (changed) this.catalogRevision = crypto.randomUUID();
  }

  initKeepalive() {
    setInterval(() => {
      if (this.activeSocket && this.activeSocket.readyState === 1) { // 1 = OPEN
        try {
          this.activeSocket.send(JSON.stringify({ type: "PING" }));
        } catch (e) {
          console.warn("[Bridge DO] PING send error:", e.message);
        }
      }
      if (this.mcpSessions && this.mcpSessions.size > 0) {
        for (const [sessionId, session] of this.mcpSessions.entries()) {
          try {
            session.writer.write(session.encoder.encode(": keepalive\n\n")).catch(() => {
              this.mcpSessions.delete(sessionId);
            });
          } catch (e) {
            this.mcpSessions.delete(sessionId);
          }
        }
      }
    }, 15000);
  }

  // ─── TTL-based Stale Socket Cleanup (Phase 2) ───
  // Configuration: if a socket is idle > 45s, it's considered stale and will be
  // closed. RunAlarm() runs every 15s to detect and clean up stale sockets.
  // This prevents server-side sockets from lingering after client SW termination
  // without a close frame, which would otherwise cause reconnection attempts to
  // hit Guard 2 and receive 409.
  static STALE_SOCKET_IDLE_MS = 45000; // 45 seconds
  static RUN_ALARM_INTERVAL_MS = 15000; // 15 seconds

  /**
   * RunAlarm: periodic staleness check for active WebSocket connections.
   * Runs every 15s via setInterval. If the active socket has been idle
   * (no messages, pings, or other activity) for > 45s, close it as stale.
   */
  RunAlarm() {
    setInterval(() => {
      const now = Date.now();
      // Iterate the Phase 3 activeConnections Map directly.
      // The legacy `this.lastActiveAt` property is never written in Phase 3
      // (only `state.lastActivityAt` inside each Map entry is updated via
      // touchConnection()), so the old `this.activeSocket && this.lastActiveAt`
      // guard always evaluated to falsy — zombies were never evicted.
      for (const [instanceId, state] of this.activeConnections.entries()) {
        const idleMs = now - state.lastActivityAt;
        if (idleMs > GeminiBridgeDO.STALE_SOCKET_IDLE_MS) {
          console.log(`[Bridge DO] Stale socket detected for instance ${instanceId} (idle ${Math.round(idleMs / 1000)}s > ${GeminiBridgeDO.STALE_SOCKET_IDLE_MS / 1000}s). Closing and allowing reconnection.`);
          try {
            state.socket.close(1000, "Stale socket cleanup: idle timeout exceeded");
          } catch (e) {
            console.warn("[Bridge DO] Error closing stale socket:", e.message);
          }
          this.activeConnections.delete(instanceId);
          // Notify any in-flight streams that were owned by this instance.
          for (const handler of this.activeStreams.values()) {
            try {
              handler({ type: "STREAM_ERROR", error: "Stale socket cleaned up", code: "stale_socket_cleanup" });
            } catch (e) {}
          }
          console.log(`[Bridge DO] Stale socket cleanup complete for instance ${instanceId}. Remaining connections: ${this.activeConnections.size}`);
        }
      }
    }, GeminiBridgeDO.RUN_ALARM_INTERVAL_MS);
  }

  /**
   * Update lastActiveAt timestamp on socket activity.
   * Called on incoming messages, PONG responses, and other activity.
   */
  recordActivity() {
    this.lastActiveAt = Date.now();
  }

  isExtensionReady() {
    return this.activeSocket !== null && this.currentTokens !== null && this.activeSocket.readyState === 1;
  }

  /**
   * Phase 4: Handle SCOPE_SWITCH message from extension (multiplexed protocol).
   * This allows scope switching WITHOUT requiring a WebSocket reconnect.
   * The extension sends SCOPE_SWITCH to request a scope change, then navigates
   * the tab and sends SCOPE_READY when complete.
   */
  async handleScopeSwitchFromExtension(msg) {
    const { requestId, scope: targetScope } = msg;
    console.log(`[Bridge DO] Received SCOPE_SWITCH from extension: ${this.currentScope} -> ${targetScope} (req: ${requestId})`);
    
    // Validate the target scope
    const validatedScope = this.resolveScopeInput(targetScope);
    if (!validatedScope) {
      console.warn(`[Bridge DO] Invalid scope in SCOPE_SWITCH: ${targetScope}`);
      if (this.activeSocket && this.activeSocket.readyState === 1) {
        this.activeSocket.send(JSON.stringify({
          type: "STREAM_ERROR",
          requestId,
          error: `Invalid scope: ${targetScope}`,
          code: "invalid_scope"
        }));
      }
      return;
    }
    
    // If already at the target scope, confirm immediately
    if (this.currentScope === validatedScope) {
      console.log(`[Bridge DO] Already at scope ${validatedScope}, confirming`);
      if (this.activeSocket && this.activeSocket.readyState === 1) {
        this.activeSocket.send(JSON.stringify({
          type: "SCOPE_READY",
          requestId,
          scope: validatedScope
        }));
      }
      return;
    }
    
    // Store pending scope switch state
    this.pendingScopeSwitch = {
      requestId,
      targetScope: validatedScope,
      startedAt: Date.now(),
    };
    
    // Forward SCOPE_SWITCH to extension
    const connection = this.getActiveConnection();
    if (connection) {
      try {
        connection.socket.send(JSON.stringify({
          type: "SCOPE_SWITCH",
          requestId,
          scope: validatedScope,
          timestamp: Date.now()
        }));
        console.log(`[Bridge DO] Forwarded SCOPE_SWITCH to extension for scope: ${validatedScope}`);
      } catch (e) {
        console.error("[Bridge DO] Failed to send SCOPE_SWITCH to extension:", e);
      }
    }
  }

  /**
   * Get the active connection from activeConnections Map.
   */
  getActiveConnection() {
    for (const state of this.activeConnections.values()) {
      if (state.socket.readyState === 1) {
        return state;
      }
    }
    return null;
  }

  /**
   * Phase 4: Request a scope switch via the multiplexed protocol.
   * This sends a SCOPE_SWITCH message to the extension without disconnecting.
   * @param {string} targetScope - The scope to switch to
   * @param {string} requestId - Unique request ID for tracking
   * @returns {Promise<Object>} Resolves with scope ready response or rejects on failure
   */
  async requestScopeSwitch(targetScope, requestId) {
    const validatedScope = this.resolveScopeInput(targetScope);
    if (!validatedScope) {
      throw new Error(`Invalid scope: ${targetScope}`);
    }
    
    // If already at target scope, return immediately
    if (this.currentScope === validatedScope) {
      return { scope: validatedScope, confirmed: true };
    }
    
    console.log(`[Bridge DO] Requesting scope switch: ${this.currentScope} -> ${validatedScope}`);
    
    // Set up timeout for scope switch
    const scopeSwitchPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingScopeSwitch = null;
        reject(new Error(`Scope switch to '${validatedScope}' timed out`));
      }, 45000);
      
      this.pendingScopeSwitch = {
        requestId,
        targetScope: validatedScope,
        timer: timeout,
        resolve,
        reject
      };
    });
    
    // Send SCOPE_SWITCH message to extension
    const connection = this.getActiveConnection();
    if (connection) {
      try {
        connection.socket.send(JSON.stringify({
          type: "SCOPE_SWITCH",
          requestId,
          scope: validatedScope,
          timestamp: Date.now()
        }));
      } catch (e) {
        this.pendingScopeSwitch = null;
        throw e;
      }
    } else {
      this.pendingScopeSwitch = null;
      throw new Error("No active extension connection");
    }
    
    // Wait for SCOPE_READY or timeout
    return scopeSwitchPromise;
  }

  // ─── Phase 4: Multiplexed Connection + Scope Router ─────────────────────────
  //
  // The WebSocket envelope format (protocol v3) wraps every message in a
  // JSON-RPC-style envelope so a single connection can carry traffic for many
  // scopes without reconnecting:
  //
  //   Client → Server (inbound):
  //     { jsonrpc: "2.0", id: <string>,      // envelope metadata
  //       scope_id: "app:c_123" | "notebook:n456",  // routing key
  //       instance_id: "<uuid>",                          // connection identity
  //       method: "subscribe" | "unsubscribe" | "chat.complete" | ...,
  //       params: { ... },                                // method payload
  //       scope_session_id: "<uuid>" }                    // scope session handle
  //
  //   Server → Client (outbound):
  //     { jsonrpc: "2.0", id: <string>,       // echoes request id
  //       scope_id: "...",                         // echoed for convenience
  //       result: { ... } | null,
  //       error: { code, message } | null,
  //       scope_session_id: "<uuid>" }
  //
  // Scope lifecycle:
  //   subscribe  → creates a ScopeSession in this.scopeSessions per (connectionId, scope_id)
  //   unsubscribe → removes that ScopeSession and fires its onUnsubscribe hook
  //   connection close → removes ALL ScopeSessions for that connectionId
  //
  // The router keeps three indexes:
  //   this.scopeSessions   Map<connId, Map<scopeId, ScopeSession>>
  //   this.connectionOwner Map<scopeId, connId>            (reverse lookup for cleanup)
  //   this.scopeHandlers   Map<scopePattern, handlerFn>    (registered scope handlers)
  // ─────────────────────────────────────────────────────────────────────────────

  /** @type {Map<string, Map<string, ScopeSession>>} connectionId -> scopeId -> session */
  scopeSessions = new Map();

  /** @type {Map<string, string>} scopeId -> connectionId (reverse index for cleanup) */
  connectionOwner = new Map();

  /** @type {Map<string, Function>} scope pattern -> handler */
  scopeHandlers = new Map();

  /** @type {Function|null} default handler for scopes without a registered handler */
  defaultHandler = null;

  /** @type {Map<string, number>} scopeId -> last activity timestamp (for idle pruning) */
  scopeLastActivity = new Map();

  /** Monotonically increasing connection counter used to derive connection IDs */
  _connectionSeq = 0;

  /**
   * Derive a stable connection identifier from the socket pair + instanceId.
   * Used as the top-level key in scopeSessions so that a reconnect (same
   * instanceId, new socket) gets a fresh connection bucket and old sessions
   * are cleaned up by the close handler.
   */
  _connectionId(instanceId, webSocketPair) {
    const serverSocket = webSocketPair && webSocketPair[1];
    let tag = 'ws';
    if (serverSocket) {
      try {
        tag = serverSocket[Symbol.toStringTag] || String(serverSocket[Symbol.toStringTag] || '') || 'ws';
      } catch (e) {
        tag = 'ws';
      }
    }
    const serializable = `${instanceId}::${tag}::${++this._connectionSeq}`;
    // Synchronous 64-bit FNV-1a digest rendered as 16 hex chars (same shape as
    // the previous sha256-truncated id).
    //
    // DO NOT reintroduce crypto.createHash()/createHmac()/Cipheriv() here: those
    // are *Node* APIs. The Workers runtime exposes WebCrypto only on the global
    // `crypto` object, so the old `crypto.createHash(...)` call threw
    // "TypeError: crypto.createHash is not a function" on EVERY /bridge upgrade
    // (HTTP 500). Because the throw happened *after* recordConnection(), the DO
    // still advertised an active connection for 45s, which rejected every other
    // instance with 409 Conflict and reported extension_status DISCONNECTED.
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < serializable.length; i++) {
      const code = serializable.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  /**
   * Register a handler for a scope pattern.
   * Patterns: "app", "app:*", "app:c_123", "notebook", "notebook:*", "*"
   */
  registerScopeHandler(pattern, handler) {
    this.scopeHandlers.set(pattern, handler);
    console.log(`[ScopeRouter] Registered handler for pattern "${pattern}"`);
  }

  /**
   * Set the fallback handler for messages whose scope doesn't match any
   * registered pattern.
   */
  setDefaultHandler(fn) {
    this.defaultHandler = fn;
  }

  // ── Scope session lifecycle ──────────────────────────────────────────────

  /**
   * ScopeSession: per-connection, per-scope state.
   * @typedef {Object} ScopeSession
   * @property {string} scopeId         canonical scope, e.g. "app:c_123"
   * @property {string} sessionId       client- or server-supplied session handle
   * @property {string} connId          owning connection id
   * @property {number} subscribedAt    epoch ms when subscribed
   * @property {Object} [params]        subscribe params
   * @property {Function} [onUnsubscribe] cleanup hook
   * @property {*} [context]            opaque per-session context set by handlers
   */

  /**
   * Subscribe to a scope on a connection. Creates (or reuses) a ScopeSession.
   * @param {string} connId
   * @param {string} scopeId  canonical scope, e.g. "app:c_123" or "notebook:n456"
   * @param {Object} [opts]
   * @param {string} [opts.sessionId]  client-supplied session handle (optional)
   * @param {Object} [opts.params]     subscribe params from the envelope
   * @returns {ScopeSession}
   */
  subscribeScope(connId, scopeId, opts = {}) {
    const canonical = this.resolveScopeInput(scopeId);
    if (!canonical) {
      throw new Error(`[ScopeRouter] Invalid scope_id: ${scopeId}`);
    }

    let byConn = this.scopeSessions.get(connId);
    if (!byConn) {
      byConn = new Map();
      this.scopeSessions.set(connId, byConn);
    }

    let session = byConn.get(canonical);
    if (!session) {
      const id = opts.sessionId || crypto.randomUUID?.() || `${canonical}::${Date.now()}`;
      session = {
        scopeId: canonical,
        sessionId: id,
        connId,
        subscribedAt: Date.now(),
        params: opts.params || null,
        onUnsubscribe: null,
        context: null,
      };
      byConn.set(canonical, session);
      this.connectionOwner.set(canonical, connId);
      console.log(`[ScopeRouter] Subscribed conn=${connId} scope=${canonical} session=${id}`);
    } else {
      if (opts.params) session.params = opts.params;
      if (opts.sessionId && !session.sessionId) session.sessionId = opts.sessionId;
    }

    this.scopeLastActivity.set(canonical, Date.now());
    return session;
  }

  /**
   * Unsubscribe from a scope on a connection. Runs the onUnsubscribe hook
   * and removes the session from both indexes.
   * @returns {ScopeSession|null} the removed session, or null if not subscribed
   */
  unsubscribeScope(connId, scopeId) {
    const canonical = this.resolveScopeInput(scopeId) || scopeId;
    const byConn = this.scopeSessions.get(connId);
    if (!byConn) return null;
    const session = byConn.get(canonical);
    if (!session) return null;

    byConn.delete(canonical);
    this.connectionOwner.delete(canonical);
    this.scopeLastActivity.delete(canonical);

    // Clean up empty connection bucket so scopeSessions.get(connId) returns undefined
    if (byConn.size === 0) {
      this.scopeSessions.delete(connId);
    }

    console.log(`[ScopeRouter] Unsubscribed conn=${connId} scope=${canonical} session=${session.sessionId}`);
    if (typeof session.onUnsubscribe === 'function') {
      try { session.onUnsubscribe(session); } catch (e) {
        console.error(`[ScopeRouter] onUnsubscribe hook threw for ${canonical}:`, e);
      }
    }
    return session;
  }

  /**
   * Get the active session for a given connection + scope, if any.
   */
  getSession(connId, scopeId) {
    const canonical = this.resolveScopeInput(scopeId) || scopeId;
    const byConn = this.scopeSessions.get(connId);
    return byConn ? byConn.get(canonical) || null : null;
  }

  /**
   * Remove ALL scope sessions for a connection (called on WS close).
   * Returns the count of sessions removed.
   */
  removeConnectionSessions(connId) {
    const byConn = this.scopeSessions.get(connId);
    if (!byConn || byConn.size === 0) return 0;

    let removed = 0;
    for (const [scopeId, session] of byConn.entries()) {
      this.connectionOwner.delete(scopeId);
      this.scopeLastActivity.delete(scopeId);
      if (typeof session.onUnsubscribe === 'function') {
        try { session.onUnsubscribe(session); } catch (e) {
          console.error(`[ScopeRouter] onUnsubscribe hook threw for ${scopeId}:`, e);
        }
      }
      byConn.delete(scopeId);
      removed++;
    }
    this.scopeSessions.delete(connId);
    console.log(`[ScopeRouter] Removed ${removed} scope session(s) for conn=${connId}`);
    return removed;
  }

  // ── Scope handler resolution ─────────────────────────────────────────────

  /**
   * Resolve a scope to a handler function. Checks exact match, then pattern
   * match, then falls back to defaultHandler.
   */
  _resolveHandler(scopeId) {
    const canonical = this.resolveScopeInput(scopeId) || scopeId;

    if (this.scopeHandlers.has(canonical)) {
      return { handler: this.scopeHandlers.get(canonical), scope: canonical };
    }

    for (const [pattern, handler] of this.scopeHandlers.entries()) {
      if (this._matchScopePattern(canonical, pattern)) {
        return { handler, scope: canonical };
      }
    }

    if (this.defaultHandler) {
      return { handler: this.defaultHandler, scope: canonical };
    }

    return null;
  }

  /**
   * Pattern matching rules:
   *   "app"       → "app" and "app:*"
   *   "notebook"  → "notebook" and "notebook:*"
   *   "app:*"     → any "app:<id>"
   *   "notebook:*"→ any "notebook:<id>"
   *   "*"         → matches everything
   */
  _matchScopePattern(scope, pattern) {
    if (pattern === '*') return true;
    if (pattern === scope) return true;
    if (pattern === 'app' && (scope === 'app' || scope.startsWith('app:'))) return true;
    if (pattern === 'notebook' && (scope === 'notebook' || scope.startsWith('notebook:'))) return true;
    if (pattern === 'app:*' && scope.startsWith('app:')) return true;
    if (pattern === 'notebook:*' && scope.startsWith('notebook:')) return true;
    return false;
  }

  /**
   * Prune scope-session activity entries older than maxAgeMs.
   */
  pruneScopeActivity(maxAgeMs = 600000) {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [scopeId, ts] of this.scopeLastActivity.entries()) {
      if (ts < cutoff) {
        this.scopeLastActivity.delete(scopeId);
        pruned++;
      }
    }
    if (pruned > 0) console.log(`[ScopeRouter] Pruned ${pruned} stale scope activity entries`);
    return pruned;
  }

  // ── Envelope parsing ─────────────────────────────────────────────────────

  /**
   * Parse and validate an inbound JSON-RPC envelope from the extension.
   * Returns a normalized envelope object, or throws on bad input.
   *
   * Required envelope fields: jsonrpc, scope_id, instance_id, method
   * Optional: id, params, scope_session_id
   */
  parseEnvelope(raw) {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('[ScopeRouter] Envelope must be a JSON object');
    }
    const { jsonrpc, scope_id, instance_id, method, id, params, scope_session_id } = raw;

    if (jsonrpc !== '2.0') {
      throw new Error(`[ScopeRouter] Unsupported jsonrpc version: ${jsonrpc}`);
    }
    if (!scope_id || typeof scope_id !== 'string') {
      throw new Error('[ScopeRouter] Missing or invalid scope_id');
    }
    if (!instance_id || typeof instance_id !== 'string') {
      throw new Error('[ScopeRouter] Missing or invalid instance_id');
    }
    if (!method || typeof method !== 'string') {
      throw new Error('[ScopeRouter] Missing or invalid method');
    }

    const canonicalScope = this.resolveScopeInput(scope_id);
    if (!canonicalScope && !this.scopeHandlers.has('*')) {
      throw new Error(`[ScopeRouter] Unknown scope_id: ${scope_id}`);
    }

    return {
      jsonrpc: '2.0',
      id: id != null ? String(id) : null,
      scope_id: canonicalScope || scope_id,
      instance_id,
      method,
      params: params || null,
      scope_session_id: scope_session_id != null ? String(scope_session_id) : null,
      raw,
    };
  }

  /**
   * Build an outbound JSON-RPC envelope.
   */
  buildEnvelope({ id, scope_id, method, result, error, scope_session_id }) {
    const envelope = { jsonrpc: '2.0' };
    if (id != null) envelope.id = id;
    if (scope_id) envelope.scope_id = scope_id;
    if (scope_session_id) envelope.scope_session_id = scope_session_id;
    if (method) envelope.method = method;
    if (error) envelope.error = error;
    else if (result !== undefined) envelope.result = result;
    return envelope;
  }

  // ── Main route entry point ───────────────────────────────────────────────

  /**
   * Route an inbound envelope to the correct scope handler.
   *
   * Lifecycle side-effects:
   *   - "subscribe"    → creates a ScopeSession
   *   - "unsubscribe"  → removes the ScopeSession
   *   - other methods  → requires an active session (auto-subscribes if missing)
   *
   * @param {Object} envelope  parsed envelope from parseEnvelope()
   * @param {string} connId    connection identifier (from _connectionId())
   * @returns {Object} response envelope to send back to the client
   */
  async routeEnvelope(envelope, connId) {
    const { id, scope_id, instance_id, method, params, scope_session_id } = envelope;
    const scope = scope_id;

    try {
      if (method === 'subscribe') {
        const session = this.subscribeScope(connId, scope, { params, sessionId: scope_session_id });
        return this.buildEnvelope({
          id,
          scope_id: scope,
          scope_session_id: session.sessionId,
          result: {
            scope: session.scopeId,
            session_id: session.sessionId,
            subscribed_at: session.subscribedAt,
          },
        });
      }

      if (method === 'unsubscribe') {
        const session = this.unsubscribeScope(connId, scope);
        if (!session) {
          return this.buildEnvelope({
            id,
            scope_id: scope,
            error: { code: -32001, message: `Not subscribed to scope: ${scope}` },
          });
        }
        return this.buildEnvelope({
          id,
          scope_id: scope,
          scope_session_id: session.sessionId,
          result: { unsubscribed: true, scope: session.scopeId },
        });
      }

      const resolved = this._resolveHandler(scope);
      if (!resolved) {
        return this.buildEnvelope({
          id,
          scope_id: scope,
          error: { code: -32005, message: `No handler for scope: ${scope}` },
        });
      }

      const { handler, scope: canonicalScope } = resolved;

      let session = null;
      if (scope_session_id) {
        session = this.getSession(connId, canonicalScope);
        if (!session || session.sessionId !== scope_session_id) {
          return this.buildEnvelope({
            id,
            scope_id: scope,
            error: { code: -32002, message: `Unknown scope_session_id for scope: ${scope}` },
          });
        }
      }

      if (!session && method !== 'subscribe' && method !== 'unsubscribe') {
        session = this.subscribeScope(connId, canonicalScope, { params });
      }

      const response = await handler(envelope, session, connId);

      if (response && typeof response === 'object') {
        if (response.error) {
          return this.buildEnvelope({
            id,
            scope_id: scope,
            scope_session_id: session?.sessionId,
            error: response.error,
          });
        }
        if (response.result !== undefined) {
          return this.buildEnvelope({
            id,
            scope_id: scope,
            scope_session_id: session?.sessionId,
            result: response.result,
          });
        }
      }

      return this.buildEnvelope({
        id,
        scope_id: scope,
        scope_session_id: session?.sessionId,
        result: response,
      });
    } catch (err) {
      console.error(`[ScopeRouter] Handler error for ${method} on ${scope}:`, err);
      return this.buildEnvelope({
        id,
        scope_id: scope,
        error: { code: -32603, message: err.message || 'Internal error' },
      });
    }
  }

  /**
   * Reconnect grace: instead of failing immediately when the extension drops,
   * give it a short window to reconnect and republish protocol v2. This keeps
   * brief tab reloads / network blips from surfacing as 503s to clients.
   */
  async waitForExtension(maxWaitMs = 12000) {
    if (this.isExtensionReady() && this.protocolVersion >= 2 && this.protocolVersion <= 3) return true;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (this.isExtensionReady() && this.protocolVersion >= 2 && this.protocolVersion <= 3) return true;
    }
    return false;
  }

  /**
   * Normalizes a client-supplied scope into a canonical scope id:
   *   "app" | "app:<convId>" | "notebook:<notebookId>"
   * Accepts canonical ids, "/app", "/app/<id>", "/notebook/<id>", or full
   * gemini.google.com URLs. "notebook" (bare) reuses the last notebook scope.
   */
  resolveScopeInput(input) {
    if (typeof input !== "string" || !input.trim()) return null;
    let s = input.trim();
    try {
      if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
    } catch (e) {}
    if (!s.startsWith("/") && (s.startsWith("notebook/") || s.startsWith("app/"))) {
      s = "/" + s;
    }
    if (s.startsWith("/")) {
      const m = s.match(/^\/(notebook|app)\/([A-Za-z0-9_-]+)/);
      if (m) return `${m[1]}:${m[2]}`;
      return (s === "/app" || s.startsWith("/app/")) ? "app" : null;
    }
    if (/^(notebook|app):[A-Za-z0-9_-]+$/.test(s)) return s;
    const lower = s.toLowerCase();
    if (["app", "default", "normal"].includes(lower)) return "app";
    if (lower === "notebook") return this.lastNotebookScope;
    return null;
  }

  /**
   * Redact internal IDs from a scope string for safe inclusion in error
   * messages. Prevents leaking conversation / notebook identifiers:
   *   "app:abc123-def"        -> "app:[REDACTED]"
   *   "notebook:dc2208a4-…"   -> "notebook:[REDACTED]"
   *   "https://gemini.google.com/notebook/dc2208a4-…" -> "/notebook:[REDACTED]"
   */
  redactScopeId(scope) {
    if (typeof scope !== "string" || !scope.trim()) return "[empty]";
    let s = scope.trim();
    try {
      if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
    } catch (e) {}
    const m = s.match(/^(app|notebook):(.+)$/);
    if (m) return `${m[1]}:[REDACTED]`;
    const pm = s.match(/^\/(app|notebook)\/([A-Za-z0-9_-]+)/);
    if (pm) return `/${pm[1]}:[REDACTED]`;
    return s;
  }

  /**
   * FAIL-CLOSED GUARD: verify the tab scope is confirmed before forwarding a
   * user prompt. Returns an Error (to be thrown/rejected) when the active tab
   * scope does not match the expected scope, or null when it is safe to proceed.
   *
   * Never forward a prompt unless the extension-reported scope matches the
   * requested scope — this prevents prompt leakage to the wrong conversation
   * or notebook tab when the extension fails to confirm activation.
   */
  addScopeFailClosed(expectedScope) {
    const actual = this.currentScope;
    if (!actual) {
      const err = new Error("Scope not confirmed before forwarding prompt — refusing to proceed (fail-closed).");
      err.code = "scope_unverified";
      return err;
    }
    const norm = (s) => (s === "app" ? "app" : s);
    const exp = norm(expectedScope);
    const cur = norm(actual);
    if (cur !== exp) {
      const err = new Error(`Scope mismatch: expected '${this.redactScopeId(exp)}' but tab reported '${this.redactScopeId(cur)}' — refusing to forward prompt (fail-closed).`);
      err.code = "scope_mismatch";
      return err;
    }
    return null;
  }

  /**
   * PREPARE_SCOPE: ask the extension to make the requested conversation scope
   * active (navigate/promote a tab). Resolves with SCOPE_READY or rejects.
   * The caller must invoke addScopeFailClosed() after this resolves and before
   * forwarding any prompt, to verify the tab is actually at the expected scope.
   */
  async prepareScope(scope) {
    const requestId = `scope_${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeStreams.delete(requestId);
        reject(Object.assign(new Error(`Scope switch to '${scope}' timed out (45s)`), { code: "scope_switch_failed" }));
      }, 45000);
      this.activeStreams.set(requestId, (msg) => {
        if (!["SCOPE_READY", "STREAM_ERROR"].includes(msg.type)) return;
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        if (msg.type === "STREAM_ERROR") {
          reject(Object.assign(new Error(msg.error || "Scope switch failed"), { code: msg.code || "scope_switch_failed" }));
        } else {
          resolve(msg);
        }
      });
      try {
        if (!this.activeSocket || this.activeSocket.readyState !== 1) {
          throw Object.assign(new Error("Extension is not connected; cannot switch scope"), { code: "extension_disconnected" });
        }
        this.activeSocket.send(JSON.stringify({ type: "PREPARE_SCOPE", requestId, scope }));
      } catch (error) {
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        reject(error);
      }
    });
  }

  async callGcpGemini(messages, model = "gemini-1.5-flash") {
    const apiKey = this.env.GEMINI_API_KEY;
    if (!apiKey) {
      const err = new Error("GCP Gemini API key not configured");
      err.code = "gcp_not_configured";
      throw err;
    }

    const contents = [];
    let systemInstruction = null;

    for (const m of messages) {
      if (!m) continue;
      if (m.role === "system") {
        systemInstruction = { parts: [{ text: String(m.content || "") }] };
      } else if (m.role === "user") {
        contents.push({ role: "user", parts: [{ text: String(m.content || "") }] });
      } else if (m.role === "assistant") {
        contents.push({ role: "model", parts: [{ text: String(m.content || "") }] });
      }
    }

    if (!contents.length) {
      contents.push({ role: "user", parts: [{ text: "Hello" }] });
    }

    const targetModel = (model && model.includes("pro")) ? "gemini-1.5-pro" : "gemini-1.5-flash";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const body = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {})
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      this.healthState.consecutiveErrors++;
      this.healthState.lastError = `GCP Error: ${res.status}`;
      throw new Error(`GCP Gemini API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text || "";
    this.healthState.lastSuccessfulGeneration = Date.now();
    this.healthState.consecutiveErrors = 0;
    this.healthState.lastError = null;
    return text;
  }

  async executeThroughExtension(messages, onChunk, model = "") {
    if (!this.isExtensionReady()) {
      const err = new Error("Extension not connected");
      err.code = "extension_disconnected";
      throw err;
    }

    const requestId = `req_${crypto.randomUUID()}`;
    const encodedReq = ProtocolDecoder.encodeRequest(messages, {}, model);

    return new Promise((resolve, reject) => {
      let fullText = "";
      let rpcBuffer = "";
      // Idle-based timeout: long generations are fine as long as chunks keep
      // arriving; the overall cap only guards against a hung socket.
      const IDLE_TIMEOUT_MS = 60000;
      const OVERALL_TIMEOUT_MS = 600000;
      const cleanup = () => { clearTimeout(idleTimer); clearTimeout(overallTimer); };
      const fail = (message) => {
        cleanup();
        this.activeStreams.delete(requestId);
        reject(new Error(message));
      };
      let idleTimer = setTimeout(() => fail(`Timeout: no response chunk from Gemini Web Extension for ${IDLE_TIMEOUT_MS / 1000}s.`), IDLE_TIMEOUT_MS);
      const overallTimer = setTimeout(() => fail(`Timeout: generation exceeded ${OVERALL_TIMEOUT_MS / 60000} minutes.`), OVERALL_TIMEOUT_MS);
      const bumpIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => fail(`Timeout: no response chunk from Gemini Web Extension for ${IDLE_TIMEOUT_MS / 1000}s.`), IDLE_TIMEOUT_MS);
      };

      this.activeStreams.set(requestId, (msg) => {
        if (msg.type === "STREAM_CHUNK" && msg.chunk) {
          rpcBuffer += msg.chunk;
          // Decode complete RPC lines only; network chunks have arbitrary boundaries.
          const boundary = rpcBuffer.lastIndexOf("\n");
          if (boundary >= 0) {
            const { deltaText } = ProtocolDecoder.decodeChunk(rpcBuffer.slice(0, boundary + 1));
            rpcBuffer = rpcBuffer.slice(boundary + 1);
            if (deltaText && deltaText !== fullText) {
              fullText = deltaText;
              bumpIdle();
              // Gemini re-sends the cumulative text on each update; surface it
              // immediately so callers can stream deltas to clients.
              try { Promise.resolve(onChunk?.(fullText)).catch(() => {}); } catch (e) {}
            }
          }
        } else if (msg.type === "STREAM_DONE") {
          cleanup();
          this.activeStreams.delete(requestId);
          const { deltaText } = ProtocolDecoder.decodeChunk(rpcBuffer);
          if (deltaText && deltaText !== fullText) {
            fullText = deltaText;
            try { Promise.resolve(onChunk?.(fullText)).catch(() => {}); } catch (e) {}
          }
          this.healthState.lastSuccessfulGeneration = Date.now();
          this.healthState.consecutiveErrors = 0;
          this.healthState.lastError = null;
          Promise.resolve().then(() => onChunk?.(fullText, fullText)).then(() => resolve(fullText), reject);
        } else if (msg.type === "STREAM_ERROR") {
          cleanup();
          this.activeStreams.delete(requestId);
          this.healthState.consecutiveErrors++;
          this.healthState.lastError = msg.error || "Execution error in extension";
          reject(Object.assign(new Error(msg.error || "Execution error in extension"), {code:msg.code || "execution_failed"}));
        }
      });

      try {
        this.activeSocket.send(JSON.stringify({
          type: "EXECUTE_REQUEST",
          requestId,
          payload: { f_req: encodedReq, model, protocolVersion: 3, catalogRevision: this.catalogRevision, mappingRevision: this.dynamicModels.find(m=>m.id===model)?.mapping_revision }
        }));
      } catch (err) {
        cleanup();
        this.activeStreams.delete(requestId);
        reject(err);
      }
    });
  }

  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions" || request.method !== "POST") return this.handleRequest(request);
    if (this.requestBusy) {
      if (this.pendingRequests.length >= 10) return this.failure(429, "queue_full", "Browser request queue is full");
      try {
        await new Promise((resolve, reject) => {
          const entry = {resolve: () => {clearTimeout(entry.timer); resolve();}, reject: reason => {clearTimeout(entry.timer); reject(reason);}};
          entry.timer = setTimeout(() => {this.pendingRequests = this.pendingRequests.filter(x => x !== entry); reject(new Error("queue_timeout"));}, 60000);
          this.pendingRequests.push(entry);
        });
      } catch (error) { return this.failure(503, error.message, "Browser request queue interrupted"); }
    } else this.requestBusy = true;
    try { return await this.handleRequest(request); }
    finally {
      const next = this.pendingRequests.shift();
      if (next) next.resolve(); else this.requestBusy = false;
    }
  }

  failure(status, code, message) {
    return new Response(JSON.stringify({error:{code,message,type:"bridge_error"}}), {status,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
  }

  /**
   * GET /artifacts/{key}: serve a stored PDF artifact. The 32-hex unguessable
   * key IS the credential, so this route is on the public path allowlist.
   */
  async serveArtifact(url, corsHeaders) {
    const notFound = () => new Response(JSON.stringify({ error: "artifact_not_found_or_expired" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
    const key = url.pathname.slice("/artifacts/".length);
    if (!this.env.ARTIFACT_KV || !/^[a-f0-9]{32}$/.test(key)) return notFound();
    let bytes;
    try {
      bytes = await this.env.ARTIFACT_KV.get(`artifacts/${key}`, { type: "arrayBuffer" });
    } catch (e) {
      return notFound();
    }
    if (!bytes) return notFound();
    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="horo-consult-${key}.pdf"`,
        "Cache-Control": "private, no-store"
      }
    });
  }

  /**
   * Render a consultation answer into a simple PDF using pdf-lib standard
   * fonts. NOTE: StandardFonts are WinAnsi-encoded, so Thai script and other
   * non-CP1252 glyphs are sanitized to "?" (embedding a Thai TTF is not
   * feasible without bundling a font file into the worker).
   */
  async buildAnswerPdf(text) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
    doc.setTitle("Horo Consultation Answer");
    doc.setCreator("gemini-web-bridge");

    const pageW = 595.28, pageH = 841.89, margin = 56;
    const fontSize = 11, lineHeight = 16, maxWidth = pageW - margin * 2;
    const widthAt = (str, size, f) => f.widthOfTextAtSize(str, size);

    const wrapLine = (raw) => {
      if (!raw) return [""];
      const words = raw.split(" ");
      const lines = [];
      let current = "";
      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (widthAt(candidate, fontSize, font) <= maxWidth) {
          current = candidate;
        } else {
          if (current) lines.push(current);
          // Hard-split words longer than a full line (e.g. URLs).
          let rest = word;
          while (widthAt(rest, fontSize, font) > maxWidth) {
            let cut = rest.length;
            while (cut > 1 && widthAt(rest.slice(0, cut), fontSize, font) > maxWidth) cut--;
            lines.push(rest.slice(0, cut));
            rest = rest.slice(cut);
          }
          current = rest;
        }
      }
      if (current || lines.length === 0) lines.push(current);
      return lines;
    };

    let page = doc.addPage();
    page.setSize(pageW, pageH);
    let y = pageH - margin;
    const drawLine = (line, f) => {
      if (y < margin) {
        page = doc.addPage();
        page.setSize(pageW, pageH);
        y = pageH - margin;
      }
      page.drawText(line, { x: margin, y, size: fontSize, font: f, color: rgb(0.1, 0.1, 0.12) });
      y -= lineHeight;
    };

    drawLine("Horo Consultation Answer", boldFont);
    y -= lineHeight / 2;
    for (const raw of sanitizeForWinAnsi(String(text || "")).split("\n")) {
      for (const line of wrapLine(raw.replace(/\t/g, "    "))) {
        drawLine(line, font);
      }
    }

    return doc.save();
  }

  async prepareModel(model) {
    const requestId = `prepare_${crypto.randomUUID()}`;
    return new Promise((resolve,reject) => {
      const timer=setTimeout(()=>{this.activeStreams.delete(requestId);reject(Object.assign(new Error("Model mapping could not be verified"),{code:"model_unverified"}));},11000);
      this.activeStreams.set(requestId,msg=>{
        if (!["MODEL_READY","STREAM_ERROR"].includes(msg.type)) return;
        clearTimeout(timer);this.activeStreams.delete(requestId);
        if(msg.type==="STREAM_ERROR") reject(Object.assign(new Error(msg.error || "Model unverified"),{code:msg.code || "model_unverified"}));
        else resolve(msg);
      });
      try { this.activeSocket.send(JSON.stringify({type:"PREPARE_MODEL",requestId,model,catalogRevision:this.catalogRevision})); }
      catch(error) {clearTimeout(timer);this.activeStreams.delete(requestId);reject(error);}
    });
  }

  async handleRequest(request) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE, PUT",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version, Content-Type, X-Model-Degraded, X-Requested-Model, X-Resolved-Model",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const BRIDGE_SECRET = this.env.BRIDGE_AUTH_TOKEN;
    const CLIENT_API_KEY = this.env.CLIENT_API_TOKEN;

    // ─── 1. WebSocket Endpoint สำหรับ Chrome Extension (/bridge) ───
    if (url.pathname === "/bridge") {
      const token = url.searchParams.get("token") || request.headers.get("x-bridge-token");
      if (!BRIDGE_SECRET || !token || token !== BRIDGE_SECRET) {
        return new Response("Unauthorized: Invalid Bridge Secret", { status: 401, headers: corsHeaders });
      }

      // ─── Phase 3: Instance-ID based identity ───
      // Get instanceId from query parameter (sent by client)
      const instanceId = url.searchParams.get("instanceId") || request.headers.get("x-instance-id") || "";
      if (!instanceId || !/^[a-f0-9-]{36}$/.test(instanceId)) {
        // Invalid or missing instanceId - reject for security
        console.warn("[Bridge DO] Rejected connection: invalid or missing instanceId.");
        return new Response("Unauthorized: Invalid instance ID", { status: 401, headers: corsHeaders });
      }

      // ─── Connection acceptance logic using instanceId ───
      // Check if there's an active connection for this instanceId
      const existingConnection = this.activeConnections.get(instanceId);

      // Same instanceId always allows reconnect (replaces old connection)
      if (existingConnection) {
        console.log(`[Bridge DO] Instance ${instanceId} reconnecting — replacing existing connection (epoch ${existingConnection.epoch}).`);
        // Close old connection for this instance
        try { existingConnection.socket.close(1000, "Replaced by reconnect"); } catch (e) {}
        this.activeConnections.delete(instanceId);
      }

      // Check for stale connections from OTHER instance IDs
      // A connection from a different instanceId is only allowed if the existing
      // connection is stale (idle > 45s)
      let staleConnectionEvicted = false;
      for (const [otherId, state] of this.activeConnections.entries()) {
        if (otherId === instanceId) continue;
        const idleTime = Date.now() - state.lastActivityAt;
        if (idleTime > this.STALE_CONNECTION_TIMEOUT_MS) {
          console.log(`[Bridge DO] Evicting stale connection for instance ${otherId} (idle ${Math.round(idleTime/1000)}s > 45s) to allow new instance ${instanceId}.`);
          try { state.socket.close(1000, "Stale connection evicted"); } catch (e) {}
          this.activeConnections.delete(otherId);
          staleConnectionEvicted = true;
        }
      }

      // If there's still an active connection from a different instanceId and it's NOT stale,
      // reject the new connection (protect healthy session from hijacking)
      if (this.activeConnections.size > 0) {
        for (const [otherId, state] of this.activeConnections.entries()) {
          if (otherId === instanceId) continue;
          const idleTime = Date.now() - state.lastActivityAt;
          if (idleTime <= this.STALE_CONNECTION_TIMEOUT_MS) {
            // Active healthy connection from different instance exists
            console.warn(`[Bridge DO] Rejected connection from instance ${instanceId}: healthy active connection exists for instance ${otherId} (idle ${Math.round(idleTime/1000)}s).`);
            return new Response("Conflict: Another instance is currently active and healthy", { status: 409, headers: corsHeaders });
          }
        }
      }

      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426, headers: corsHeaders });
      }

      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();

      // Derive the connection id for scope-session bucketing BEFORE recording
      // the connection. A reconnect (same instanceId, new socket) produces a new
      // connId so old sessions are naturally abandoned and cleaned up by the
      // close handler below. Computing it first keeps the invariant that nothing
      // which can throw runs after recordConnection() — otherwise a failed
      // upgrade would leave a "healthy" zombie entry that 409s other instances.
      const connId = this._connectionId(instanceId, webSocketPair);

      // ─── Record connection with instanceId tracking ───
      this.resetModelCatalog();
      const connectionState = this.recordConnection(instanceId, server);
      this.currentTokens = null;
      this.protocolVersion = 0;
      this.socketLostAt = null;

      console.log(`[Bridge DO] Chrome Extension connected via WebSocket. Instance: ${instanceId}, Epoch: ${connectionState.epoch}`);

      // Update server message handler to track activity per instance
      server.addEventListener("message", (event) => {
        if (this.activeSocket !== server) return;
        // Record activity for this instance
        this.touchConnection(instanceId);
        try {
          const msg = JSON.parse(event.data);

          // Phase 4: Multiplexed envelope routing. Detect JSON-RPC v2
          // envelopes and route them through the ScopeRouter. Legacy
          // msg.type-based messages fall through to the dispatch below.
          if (msg.jsonrpc === "2.0" && msg.scope_id && msg.instance_id && msg.method) {
            // Use .then()/.catch() to avoid await in the sync event listener
            this.parseEnvelope(msg)
              .then(envelope => this.routeEnvelope(envelope, connId))
              .then(response => {
                if (response && this.activeSocket === server && server.readyState === 1) {
                  server.send(JSON.stringify(response));
                }
              })
              .catch(parseErr => {
                console.error("[Bridge DO] ScopeRouter envelope error:", parseErr.message);
                if (this.activeSocket === server && server.readyState === 1) {
                  server.send(JSON.stringify({
                    jsonrpc: "2.0",
                    error: { code: -32700, message: parseErr.message },
                  }));
                }
              });
            return;
          }

          if (msg.type === "SESSION_READY" || msg.type === "MODELS_DISCOVERED") {
            if (msg.tokens) this.currentTokens = msg.tokens;
            if (typeof msg.scope === "string" && msg.scope) {
              this.currentScope = msg.scope;
              if (msg.scope.startsWith("notebook:")) this.lastNotebookScope = msg.scope;
            } else if (msg.type === "SESSION_READY") {
              this.currentScope = null;
            }
            this.replaceModelCatalog(msg);
            console.log(`[Bridge DO] Synced from Web: Model=${this.activeBrowserModel}, Thinking=${this.extendedThinkingActive}, DiscoveredCount=${this.dynamicModels ? this.dynamicModels.length : 0}`);
          } else if (msg.type === "MODEL_UPDATED") {
            if (msg.activeModel) this.activeBrowserModel = msg.activeModel;
            if (msg.extendedThinking !== undefined) this.extendedThinkingActive = msg.extendedThinking;
            console.log(`[Bridge DO] Model Updated from UI: Model=${this.activeBrowserModel}, Thinking=${this.extendedThinkingActive}`);
          } else if (msg.type === "PONG") {
            // Heartbeat pong received - already recorded via touchConnection
          } else if (msg.type === "SCOPE_SWITCH") {
            // Phase 4: Handle SCOPE_SWITCH from extension (multiplexed protocol)
            // Extension is requesting to switch to a new scope
            // Use .then() to handle async without await in event listener
            this.handleScopeSwitchFromExtension(msg).catch(err => {
              console.error("[Bridge DO] Scope switch error:", err);
            });
          } else if (msg.type === "SCOPE_READY") {
            // Phase 4: Extension confirmed scope switch is complete
            if (msg.scope) {
              this.currentScope = msg.scope;
              console.log(`[Bridge DO] Scope confirmed: ${msg.scope} (requestId: ${msg.requestId || 'N/A'})`);
              // Resolve any pending scope switch
              if (this.pendingScopeSwitch && this.pendingScopeSwitch.requestId === msg.requestId) {
                clearTimeout(this.pendingScopeSwitch.timer);
                this.pendingScopeSwitch = null;
              }
            }
            // DO NOT let this branch swallow the message. prepareScope() waits
            // for a per-request SCOPE_READY via activeStreams, and because this
            // is an `else if` chain the generic dispatch below was unreachable.
            // The tab had already navigated and confirmed, yet the server still
            // rejected with "Scope switch to '<scope>' timed out (45s)".
            if (msg.requestId && this.activeStreams.has(msg.requestId)) {
              const handler = this.activeStreams.get(msg.requestId);
              if (handler) handler(msg);
            }
          } else if (msg.requestId && this.activeStreams.has(msg.requestId)) {
            const handler = this.activeStreams.get(msg.requestId);
            if (handler) handler(msg);
          }
        } catch (err) {
          console.error("[Bridge DO] WS parse error:", err);
        }
      });

      server.addEventListener("close", (event) => {
        console.warn(`[Bridge DO] Chrome Extension disconnected (code: ${event.code}). Instance: ${instanceId}`);
        // Only tear down instance state if this socket is still the registered
        // one. recordConnection() closes a replaced socket when the same
        // instanceId reconnects, and that close event arrives *after* the new
        // entry is stored — without this guard the reconnecting socket's fresh
        // entry (and its scope sessions) would be deleted immediately, leaving
        // the DO with no active connection while the client believes it is
        // connected (messages then stop being processed → /health DISCONNECTED).
        const current = this.activeConnections.get(instanceId);
        const stillOwner = !current || current.socket === server;
        if (!stillOwner) {
          console.log(`[Bridge DO] Ignoring close of replaced socket for instance ${instanceId} (a newer connection owns the slot).`);
          return;
        }
        // Remove connection for this instance
        this.removeConnection(instanceId);
        // Phase 4: Tear down all scope sessions belonging to this connection.
        // Each session's onUnsubscribe hook is fired so handlers can flush
        // pending work before the socket is gone.
        this.removeConnectionSessions(connId);
        if (this.activeSocket === server) {
          this.socketLostAt = Date.now();
          for (const handler of this.activeStreams.values()) {
            handler({ type: "STREAM_ERROR", error: "Extension disconnected" });
          }
          // Queued requests are kept: they will wait for a reconnect inside
          // waitForExtension() instead of failing instantly (reconnect grace).
          this.activeSocket = null;
          this.protocolVersion = 0;
          this.currentTokens = null;
          this.resetModelCatalog();
        }
      });

      server.addEventListener("error", (err) => {
        console.error("[Bridge DO] WebSocket error:", err);
      });

      // Set activeSocket for backward compatibility (single socket assumption)
      this.activeSocket = server;

      try {
        return new Response(null, { status: 101, webSocket: client, headers: corsHeaders });
      } catch (err) {
        // Roll back so a failed upgrade can never leave a recorded connection
        // behind (a zombie entry blocks every other instance with 409 until the
        // 45s stale window elapses).
        console.error("[Bridge DO] WebSocket upgrade rejected by runtime — rolling back connection:", err);
        try { this.removeConnection(instanceId); } catch (e) {}
        try { server.close(1011, "Upgrade failed"); } catch (e) {}
        return new Response("Bridge upgrade failed", { status: 500, headers: corsHeaders });
      }
    }

    if (url.pathname === "/bridge/auth-check") {
      const supplied=request.headers.get("x-bridge-token");
      return new Response(JSON.stringify({ok:Boolean(BRIDGE_SECRET && supplied===BRIDGE_SECRET),protocolVersion:3,minSupportedVersion:2,maxSupportedVersion:3}),
        {status:BRIDGE_SECRET && supplied===BRIDGE_SECRET ? 200 : 401,headers:{...corsHeaders,"Content-Type":"application/json","Cache-Control":"no-store"}});
    }

    // ─── Emergency connection reset ───────────────────────────────────────────
    // POST /bridge/reset?token=<bridge_token>
    // Force-evicts ALL active connections from the DO so a stuck 409 loop can be
    // broken without waiting for the 45s RunAlarm TTL.
    if (url.pathname === "/bridge/reset" && request.method === "POST") {
      const supplied = url.searchParams.get("token");
      if (!supplied || supplied !== BRIDGE_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const evicted = [];
      for (const [instanceId, state] of this.activeConnections.entries()) {
        try { state.socket.close(1000, "Admin reset"); } catch (e) {}
        evicted.push(instanceId);
      }
      this.activeConnections.clear();
      console.log(`[Bridge DO] Admin reset: evicted ${evicted.length} connection(s): ${evicted.join(", ")}`);
      return new Response(JSON.stringify({ ok: true, evicted, remainingConnections: 0 }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // ─── Public Paths vs Authenticated Paths ───
    // /artifacts/{key} is public: the 32-hex unguessable key IS the credential.
    const isArtifactPath = url.pathname.startsWith("/artifacts/");
    const publicPaths = ["/", "/health"];
    if (!publicPaths.includes(url.pathname) && !isArtifactPath) {
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (!token || token !== CLIENT_API_KEY) {
        return new Response(JSON.stringify({
          error: {
            message: "Invalid or missing API key. Please provide Authorization: Bearer ***",
            type: "invalid_request_error",
            code: "invalid_api_key"
          }
        }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    const clientSessionId = request.headers.get("Mcp-Session-Id") ||
                            url.searchParams.get("sessionId") ||
                            url.searchParams.get("session_id") ||
                            `session-${crypto.randomUUID()}`;

    // ─── Public Artifact Download: /artifacts/{key} ───
    if (isArtifactPath && request.method === "GET") {
      return this.serveArtifact(url, corsHeaders);
    }

    // ─── 2. OpenAI-Compatible API: /v1/models (and /models alias) ───
    if ((url.pathname === "/v1/models" || url.pathname === "/models") && request.method === "GET") {
      const models = this.isExtensionReady() ? this.dynamicModels : [];
      const defaultModel = recommendedModel(models);
      return new Response(JSON.stringify({
        object: "list",
        data: models.map(m => ({ ...m, object: "model", created: 0, owned_by: "google-web",
          is_default: m.id === defaultModel, supports_reasoning_effort: false, supported_reasoning_efforts: [] })),
        default_recommended: defaultModel,
        default_reasoning_effort: null,
        catalog_revision: this.catalogRevision,
        browser_active_model: { model: this.activeBrowserModel, extended_thinking: this.extendedThinkingActive },
        status: !this.isExtensionReady() ? "disconnected" : models.length ? "ready" : "discovering"
      }), { headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }

    // ─── 3. OpenAI-Compatible API: /v1/chat/completions ───
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({
          error: { message: "Malformed JSON body", type: "invalid_request_error", code: "bad_json" }
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // ตรวจสอบสถานะการเชื่อมต่อของ Extension ก่อนแบบ Strict Fail-Fast หรือ GCP Fallback
      // (พร้อม reconnect grace: รอสั้นๆ ก่อนยอมแพ้ เพื่อกลืน blip ระยะสั้น)
      if (!this.isExtensionReady() || this.protocolVersion < 2 || this.protocolVersion > 3) {
        const reconnected = await this.waitForExtension();
        if (!reconnected) {
          if (this.env.GEMINI_API_KEY && body?.stream !== true && Array.isArray(body?.messages)) {
          try {
            const promptTokens = body.messages.reduce((c, m) => c + Math.ceil((m?.content || "").length / 4), 0);
            const gcpText = await this.callGcpGemini(body.messages, body.model || "gemini-1.5-flash");
            corsHeaders["X-Provider"] = "google-cloud-fallback";
            const responseObj = {
              id: `chatcmpl-${crypto.randomUUID()}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: body.model || "gemini-1.5-flash",
              choices: [{
                index: 0,
                message: { role: "assistant", content: gcpText },
                finish_reason: "stop"
              }],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: Math.ceil(gcpText.length / 4),
                total_tokens: promptTokens + Math.ceil(gcpText.length / 4)
              }
            };
            return new Response(JSON.stringify(responseObj), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          } catch (gcpErr) {
            console.error("[Bridge DO] GCP fallback error:", gcpErr);
          }
        }
        return new Response(JSON.stringify({
          error: {
            message: "Gemini Web-Bridge: Chrome Extension is not connected. Please ensure Google Chrome is open with an active gemini.google.com session and the extension is loaded.",
            type: "service_unavailable",
            code: "extension_disconnected"
          }
        }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      if (!body || !Array.isArray(body.messages) || !body.messages.length) {
        return new Response(JSON.stringify({ error: { message: "messages must be a non-empty array", type: "invalid_request_error" } }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const requestId = `chatcmpl-${crypto.randomUUID()}`;

      // ─── Conversation Scope (app / notebook) ───
      // Resolve the requested scope BEFORE model preparation: switching scope
      // may navigate the bridge tab and republish a fresh model catalog.
      const scopeInput = body.bridge_scope ?? body.scope ?? request.headers.get("x-bridge-scope");
      if (scopeInput) {
        const targetScope = this.resolveScopeInput(scopeInput);
        if (!targetScope) {
          return this.failure(400, "invalid_scope",
            `Unrecognized bridge scope '${scopeInput}'. Use "app", "app:<conversationId>", "notebook:<notebookId>", or a gemini.google.com URL/path.`);
        }
        if (this.currentScope !== targetScope) {
          try {
            const ready = await this.prepareScope(targetScope);
            this.currentScope = ready.scope || targetScope;
            const scopeErr = this.addScopeFailClosed(targetScope);
            if (scopeErr) {
              return this.failure(422, scopeErr.code, scopeErr.message);
            }
          } catch (error) {
            return this.failure(error.code === "extension_disconnected" ? 503 : 422, error.code || "scope_switch_failed", error.message);
          }
        }
        corsHeaders["X-Bridge-Scope"] = targetScope;
      }

      const requestedModel = body?.model;
      if (this.protocolVersion < 2 || this.protocolVersion > 3) return this.failure(503,"extension_upgrade_required",`Protocol v${this.protocolVersion || 0} unsupported. Min: 2, Max: 3. Reload the extension.`);
      let rawModel = !requestedModel || requestedModel === "gemini-web"
        ? recommendedModel(this.dynamicModels) : requestedModel;
      if (!rawModel && (!requestedModel || requestedModel === "gemini-web")) {
        rawModel = this.dynamicModels[0]?.id;
      }
      if (!rawModel) return this.failure(422,"model_unverified","No verified default model is available");
      if (!this.dynamicModels.some(m=>m.id===rawModel)) return this.failure(404,"model_not_available","Requested model is absent from the current browser catalog");
      try {
        const prepared=await this.prepareModel(rawModel);
        if (prepared.model !== rawModel || !prepared.mappingRevision) return this.failure(422,"model_unverified","Model preparation did not verify requested model");
      } catch(error) {
        const fallback=this.enforcementMode === "permissive" ? recommendedModel(this.dynamicModels) : null;
        if(!fallback || fallback===rawModel) return this.failure(error.code === "extension_disconnected" ? 503 : 422,error.code || "model_unverified",error.message);
        rawModel=fallback;
        try { const prepared=await this.prepareModel(rawModel); if(prepared.model!==rawModel || !prepared.mappingRevision) throw new Error("Fallback mapping unverified"); }
        catch(error) {return this.failure(422,"model_unverified",error.message);}
      }
      const upstreamModel = rawModel;
      corsHeaders["X-Resolved-Model"] = rawModel;
      if(requestedModel) corsHeaders["X-Requested-Model"] = requestedModel;
      if(requestedModel && !["gemini-web","gemini-web-thinking",rawModel].includes(requestedModel)) corsHeaders["X-Model-Degraded"] = "true";
      const isStream = body?.stream === true;

      // Extract tools from header or body and inject tool prompt if present
      let policy;
      try {
        if (!body || !Array.isArray(body.messages) || !body.messages.length ||
            !body.messages.every(m => m && ["system", "developer", "user", "assistant", "tool"].includes(m.role))) {
          throw new Error("messages must be a non-empty array of chat messages");
        }
        policy = resolveToolPolicy(request, body);
      } catch (err) {
        return new Response(JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const tools = policy.tools;
      if (tools.length > 0) {
        const toolPrompt = buildToolSystemPrompt(tools) + (policy.required ? "\nYou must call an allowed tool this turn." : "") + (!policy.parallel ? "\nCall at most one tool this turn." : "");
        if (!body.messages || body.messages.length === 0) {
          body.messages = [{ role: "system", content: toolPrompt }];
        } else if (body.messages[0].role === "system") {
          body.messages[0].content = `${body.messages[0].content}\n\n${toolPrompt}`;
        } else {
          body.messages.unshift({ role: "system", content: toolPrompt });
        }
      }

      const messages = body.messages || [];

      // Token estimation
      const promptTokens = messages.reduce((c, m) => c + Math.ceil((m.content || "").length / 4), 0);

      // ─── SSE Streaming ───
      if (isStream) {
        // Tool requests must buffer the full text so tool_call syntax can be
        // validated before anything is emitted. Pure-content requests stream
        // real deltas: headers and chunks go out as the extension produces them.
        if (tools.length === 0) {
          const encoder = new TextEncoder();
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const sse = (obj) => writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          const chunkFrame = (delta, finish_reason = null) => ({
            id: requestId, object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000), model: rawModel,
            choices: [{ index: 0, delta, finish_reason }]
          });

          (async () => {
            let lastEmitted = "";
            try {
              sse(chunkFrame({ role: "assistant" }));
              await this.executeThroughExtension(messages, (cumulative) => {
                // Gemini re-sends cumulative text; emit only the appended delta.
                if (typeof cumulative === "string" && cumulative.startsWith(lastEmitted) && cumulative.length > lastEmitted.length) {
                  const delta = cumulative.slice(lastEmitted.length);
                  lastEmitted = cumulative;
                  sse(chunkFrame({ content: delta }));
                } else if (typeof cumulative === "string") {
                  lastEmitted = cumulative;
                }
              }, upstreamModel);
              sse(chunkFrame({}, "stop"));
              writer.write(encoder.encode("data: [DONE]\n\n"));
              await writer.close();
            } catch (error) {
              try {
                sse({ error: { message: error.message, type: "server_error", code: error.code || "execution_failed" } });
                writer.write(encoder.encode("data: [DONE]\n\n"));
                await writer.close();
              } catch (e) {
                await writer.abort(error).catch(() => {});
              }
            }
          })();

          return new Response(readable, {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "Mcp-Session-Id": clientSessionId
            }
          });
        }

        const toolTransformer = createToolCallTransformer(requestId, rawModel, policy);
        const transformerWriter = toolTransformer.writable.getWriter();
        const readable = toolTransformer.readable.pipeThrough(new TextEncoderStream());

        let fullText;
        try {fullText=await this.executeThroughExtension(messages,null,upstreamModel);}
        catch(error) {return this.failure(503,error.code || "execution_failed",error.message);}
        try {parseToolCompletion(fullText,policy);}
        catch(error) {return this.failure(422,"invalid_tool_completion",error.message);}
        // Reader consumes the transformer concurrently; validation already completed above.
        (async()=>{try {await transformerWriter.write(fullText);await transformerWriter.close();}
          catch(error) {await transformerWriter.abort(error).catch(()=>{});}})();

        return new Response(readable, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Mcp-Session-Id": clientSessionId
          }
        });
      }

      // ─── Non-streaming JSON Response ───
      try {
        const fullResponse = await this.executeThroughExtension(messages, null, upstreamModel);
        const completionTokens = Math.ceil(fullResponse.length / 4);

        const { message: choiceMessage, finishReason } = parseToolCompletion(fullResponse, policy);

        return new Response(JSON.stringify({
          id: requestId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: rawModel,
          choices: [{
            index: 0,
            message: choiceMessage,
            finish_reason: finishReason
          }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens
          }
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json", "Mcp-Session-Id": clientSessionId }
        });
      } catch (err) {
        return new Response(JSON.stringify({
          error: { message: err.message, type: "server_error", code: err.code || "execution_failed" }
        }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // ─── 4. Remote Model Context Protocol (MCP): /mcp ───
    const tools = [
      {
        name: "sdlc_solution_architect",
        description: "วิเคราะห์ปัญหา ออกแบบ System Architecture, Data Flow และ Solution การแก้ปัญหาเชิงโครงสร้างผ่าน Gemini Web Session",
        inputSchema: {
          type: "object",
          properties: {
            problem_description: { type: "string", description: "รายละเอียดปัญหาหรือโจทย์ที่ต้องการออกแบบ" },
            tech_stack: { type: "string", description: "เทคโนโลยีที่ใช้งาน เช่น Node.js, React, PostgreSQL" },
            constraints: { type: "string", description: "ข้อจำกัด เช่น งบประมาณ, Latency, หรือ Legacy System" },
            scope: { type: "string", description: "ขอบเขตการสนทนา: \"app\", \"app:<conversationId>\", \"notebook:<notebookId>\" หรือ URL ของ gemini.google.com" }
          },
          required: ["problem_description"]
        }
      },
      {
        name: "orchestrate_sdlc_plan",
        description: "วางแผน Roadmap และแตก Task ย่อยตามขั้นตอน SDLC (Plan -> Architecture -> Code -> Test -> Deploy)",
        inputSchema: {
          type: "object",
          properties: {
            feature_or_goal: { type: "string", description: "ฟีเจอร์หรือเป้าหมายของระบบที่ต้องการพัฒนา" },
            current_stage: { type: "string", description: "ขั้นตอนปัจจุบัน เช่น Planning, Architecture, Testing" },
            scope: { type: "string", description: "ขอบเขตการสนทนา: \"app\", \"app:<conversationId>\", \"notebook:<notebookId>\" หรือ URL ของ gemini.google.com" }
          },
          required: ["feature_or_goal"]
        }
      },
      {
        name: "code_review_and_debug",
        description: "ตรวจสอบโค้ด หาสาเหตุของ Bug (Root Cause), แนะนำ Patch แก้ไข และตรวจความปลอดภัย",
        inputSchema: {
          type: "object",
          properties: {
            code_snippet: { type: "string", description: "โค้ดที่ต้องการให้ตรวจสอบ" },
            error_log: { type: "string", description: "Log หรือ Error message ที่เกิดขึ้น (ถ้ามี)" },
            language: { type: "string", description: "ภาษาของโค้ด" },
            scope: { type: "string", description: "ขอบเขตการสนทนา: \"app\", \"app:<conversationId>\", \"notebook:<notebookId>\" หรือ URL ของ gemini.google.com" }
          },
          required: ["code_snippet"]
        }
      },
      {
        name: "evaluate_tech_tradeoffs",
        description: "วิเคราะห์เปรียบเทียบข้อดี-ข้อเสียของเทคโนโลยี (Trade-off Analysis) เพื่อการตัดสินใจเลือกใช้",
        inputSchema: {
          type: "object",
          properties: {
            decision_context: { type: "string", description: "บริบทและเป้าหมายของระบบ" },
            options: { type: "string", description: "ตัวเลือกที่ต้องการเปรียบเทียบ" },
            scope: { type: "string", description: "ขอบเขตการสนทนา: \"app\", \"app:<conversationId>\", \"notebook:<notebookId>\" หรือ URL ของ gemini.google.com" }
          },
          required: ["decision_context", "options"]
        }
      },
      {
        name: "ping",
        description: "ตรวจสอบสถานะการเชื่อมต่อของ Cloud Hub และ Chrome Extension",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } }
        }
      },
      {
        name: "check_bridge_health",
        description: "ตรวจสอบสถานะสุขภาพการทำงานเชิงลึกของ Bridge DO, สถานะ Extension, Metrics คิว และ Fallback Provider",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "list_bridge_models",
        description: "ดึงรายการโมเดลจริงที่เชื่อมต่อจากหน้าเว็บเบราว์เซอร์ พร้อมสถานะ verification, mapping revision และ thinking capability",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "set_bridge_scope",
        description: "กำหนดขอบเขตการสนทนาของ Bridge: แชทปกติ (/app) หรือ Notebook (/notebook/<id>) — จะเปลี่ยนแท็บ bridge ไปยัง URL ที่กำหนดและรอ session พร้อม",
        inputSchema: {
          type: "object",
          properties: {
            scope: { type: "string", description: "\"app\", \"app:<conversationId>\", \"notebook:<notebookId>\", หรือ URL/path ของ gemini.google.com เช่น https://gemini.google.com/notebook/dc2208a4-ce5f-4d56-b2f3-b669299ddaa7" }
          },
          required: ["scope"]
        }
      },
      {
        name: "horo_consult",
        description: "ที่ปรึกษาโหราศาสตร์ผ่าน Gemini Web Session: ตอบคำถามโหราศาสตร์จีน (BaZi), numerology และดาราศาสตร์ไทย โดยอ้างอิงความรู้ใน Notebook ที่ผูกไว้เป็นหลัก เลือกรับคำตอบเป็นข้อความหรือไฟล์ PDF (ลิงก์ดาวน์โหลดชั่วคราว 1 ชั่วโมง)",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "คำถามโหราศาสตร์/BaZi ของผู้ใช้" },
            birth_context: {
              type: "object",
              description: "บริบทดวงชะตา: birth_datetime, longitude, utc_offset_hours, day_master, five_elements",
              properties: {
                birth_datetime: { type: "string" },
                longitude: { type: "number" },
                utc_offset_hours: { type: "number" },
                day_master: { type: "string" },
                five_elements: { type: "string" },
                favorable_elements: { type: "string" }
              }
            },
            response_format: { type: "string", enum: ["text", "pdf"], default: "text" },
            scope: { type: "string", description: "\"app\", \"app:<conversationId>\", \"notebook:<notebookId>\" หรือ URL ของ gemini.google.com" }
          },
          required: ["query"]
        }
      }
    ];

    // Helper to send message over active SSE connection for a session
    const sendSseMessage = (sessionId, msgObj) => {
      if (!this.mcpSessions) return;
      const sess = this.mcpSessions.get(sessionId);
      if (sess) {
        try {
          const sseData = `event: message\ndata: ${JSON.stringify(msgObj)}\n\n`;
          sess.writer.write(sess.encoder.encode(sseData)).catch(() => {
            this.mcpSessions.delete(sessionId);
          });
        } catch (e) {
          this.mcpSessions.delete(sessionId);
        }
      }
    };

    // ─── 4. Remote Model Context Protocol (MCP): /mcp ───
    if (url.pathname === "/mcp" && request.method === "GET") {
      const sessionId = request.headers.get("Mcp-Session-Id") ||
                        url.searchParams.get("sessionId") ||
                        url.searchParams.get("session_id") ||
                        `session-${crypto.randomUUID()}`;
      const encoder = new TextEncoder();
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();

      if (!this.mcpSessions) this.mcpSessions = new Map();
      this.mcpSessions.set(sessionId, { writer, encoder });

      if (request.signal) {
        request.signal.addEventListener("abort", () => {
          this.mcpSessions.delete(sessionId);
          try { writer.close().catch(() => {}); } catch (e) {}
        });
      }

      // In MCP SSE transport: emit the endpoint URI for POST messages
      const endpointPath = `/mcp?sessionId=${encodeURIComponent(sessionId)}`;
      const initSseData = `event: endpoint\ndata: ${endpointPath}\n\n`;
      writer.write(encoder.encode(initSseData)).catch(() => {});

      return new Response(readable, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "Mcp-Session-Id": sessionId,
          "Mcp-Protocol-Version": "2024-11-05"
        }
      });
    }

    if (url.pathname === "/mcp" && request.method === "DELETE") {
      const targetSessionId = url.searchParams.get("sessionId") ||
                              url.searchParams.get("session_id") ||
                              request.headers.get("Mcp-Session-Id");
      if (targetSessionId && this.mcpSessions && this.mcpSessions.has(targetSessionId)) {
        const sess = this.mcpSessions.get(targetSessionId);
        try { sess.writer.close().catch(() => {}); } catch (e) {}
        this.mcpSessions.delete(targetSessionId);
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          ...(targetSessionId ? { "Mcp-Session-Id": targetSessionId } : {})
        }
      });
    }

    if (url.pathname === "/mcp" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error: Invalid JSON" }
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (!body || typeof body !== "object") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request" }
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (Array.isArray(body) && body.length === 0) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request: Empty batch" }
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const sseQuerySessionId = url.searchParams.get("sessionId") || url.searchParams.get("session_id");
      const isLegacySseSession = Boolean(sseQuerySessionId);

      if (isLegacySseSession && (!this.mcpSessions || !this.mcpSessions.has(sseQuerySessionId))) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: Array.isArray(body) ? null : (body?.id ?? null),
          error: { code: -32001, message: `MCP SSE session not found: ${sseQuerySessionId}` }
        }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const clientSessionId = isLegacySseSession
        ? sseQuerySessionId
        : (request.headers.get("Mcp-Session-Id") || `session-${crypto.randomUUID()}`);

      const mcpHeaders = {
        ...corsHeaders,
        "Mcp-Session-Id": clientSessionId,
        "Mcp-Protocol-Version": "2024-11-05"
      };

      const handleSingleMcp = async (msg) => {
        if (!msg || typeof msg !== "object") {
          return {
            response: {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32600, message: "Invalid Request" }
            }
          };
        }

        const hasId = "id" in msg && msg.id !== undefined && msg.id !== null;
        const id = hasId ? msg.id : undefined;
        const method = typeof msg.method === "string" ? msg.method : "";
        const params = (msg && typeof msg.params === "object" && msg.params !== null) ? msg.params : {};

        // In JSON-RPC 2.0 & MCP: a notification has no id or is an explicit notification method
        const isNotification = !hasId || method.startsWith("notifications/") || method === "initialized";

        if (isNotification) {
          // Accepted notifications do not generate a JSON-RPC response object
          return { isNotification: true };
        }

        if (method === "initialize") {
          const protoVersion = params.protocolVersion || "2024-11-05";
          const res = {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: protoVersion,
              capabilities: {
                tools: { listChanged: false },
                logging: {}
              },
              serverInfo: { name: "gemini-web-bridge-cloud-hub", version: "4.3.4" }
            }
          };
          return { response: res, protocolVersion: protoVersion };
        }

        if (method === "ping") {
          const res = { jsonrpc: "2.0", id, result: {} };
          return { response: res };
        }

        if (method === "tools/list") {
          const res = {
            jsonrpc: "2.0",
            id,
            result: { tools }
          };
          return { response: res };
        }

        if (method === "prompts/list") {
          const res = { jsonrpc: "2.0", id, result: { prompts: [] } };
          return { response: res };
        }

        if (method === "resources/list") {
          const res = { jsonrpc: "2.0", id, result: { resources: [] } };
          return { response: res };
        }

        if (method === "resources/templates/list") {
          const res = { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
          return { response: res };
        }

        if (method === "tools/call") {
          const toolName = params.name;
          const args = params.arguments || {};

          if (toolName === "ping") {
            const extStatus = this.isExtensionReady() ? "ONLINE (Session Ready)" : "DISCONNECTED (Please open gemini.google.com in Chrome)";
            const gcpStatus = this.env.GEMINI_API_KEY ? "CONFIGURED (Hybrid Active)" : "DISABLED";
            const pongText = `Pong! Cloud Hub v4.3.4 is running.\n• Conversation Scope: ${this.currentScope || "app (default)"}\n• Active Browser Model: ${this.activeBrowserModel || "None"} (Extended Thinking: ${this.extendedThinkingActive ? "ON" : "OFF"})\n• Chrome Extension Bridge: ${extStatus}\n• GCP Fallback: ${gcpStatus}\n• Consecutive Errors: ${this.healthState.consecutiveErrors}`;
            const res = {
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: pongText }] }
            };
            return { response: res };
          }

          if (toolName === "check_bridge_health") {
            const extStatus = this.isExtensionReady() ? "CONNECTED_AND_READY" : "DISCONNECTED";
            const healthStatus = (!this.isExtensionReady() && !this.env.GEMINI_API_KEY)
              ? "critical"
              : (this.healthState.consecutiveErrors >= 3 ? "degraded" : "healthy");

            const healthReport = {
              status: healthStatus,
              extension_status: extStatus,
              current_scope: this.currentScope || "app (default)",
              active_browser_model: {
                model: this.activeBrowserModel || "None",
                extended_thinking: this.extendedThinkingActive
              },
              catalog: {
                total_models: this.dynamicModels ? this.dynamicModels.length : 0,
                verified_models: this.dynamicModels ? this.dynamicModels.filter(m => m.verification === "verified").length : 0,
                default_recommended: recommendedModel(this.dynamicModels)
              },
              queue: {
                busy: this.requestBusy,
                pending_count: this.pendingRequests.length
              },
              metrics: {
                last_successful_generation: this.healthState.lastSuccessfulGeneration,
                consecutive_errors: this.healthState.consecutiveErrors,
                last_error: this.healthState.lastError
              },
              hybrid_fallback: {
                has_gcp_fallback: Boolean(this.env.GEMINI_API_KEY)
              }
            };

            const res = {
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify(healthReport, null, 2) }] }
            };
            return { response: res };
          }

          if (toolName === "list_bridge_models") {
            const models = this.isExtensionReady() ? this.dynamicModels : [];
            const res = {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    models,
                    default_recommended: recommendedModel(this.dynamicModels),
                    catalog_revision: this.catalogRevision
                  }, null, 2)
                }]
              }
            };
            return { response: res };
          }

      const knownSdlcTools = ["sdlc_solution_architect", "orchestrate_sdlc_plan", "code_review_and_debug", "evaluate_tech_tradeoffs", "horo_consult"];

      // horo_consult defaults to the HoroConsultant knowledge Notebook scope
      // when the caller does not pass an explicit scope.
      const HORO_CONSULT_DEFAULT_SCOPE = "notebook:b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0";

      // Scope switch helper shared by set_bridge_scope and the SDLC tools.
      const applyScope = async (scopeInput) => {
        if (!scopeInput) return { ok: true, scope: this.currentScope };
        const targetScope = this.resolveScopeInput(scopeInput);
        if (!targetScope) {
          return { ok: false, message: `Unrecognized bridge scope '${this.redactScopeId(scopeInput)}'. Use "app", "app:<conversationId>", "notebook:<notebookId>", or a gemini.google.com URL/path.` };
        }
        if (this.currentScope === targetScope) return { ok: true, scope: targetScope };
        let ready;
        try {
          ready = await this.prepareScope(targetScope);
        } catch (error) {
          return { ok: false, message: this.redactScopeId(error.message || "Scope switch failed"), code: error.code };
        }
        this.currentScope = ready.scope || targetScope;
        const failClosedErr = this.addScopeFailClosed(targetScope);
        if (failClosedErr) {
          return { ok: false, message: failClosedErr.message };
        }
        return { ok: true, scope: this.currentScope };
      };

      if (toolName === "set_bridge_scope") {
        const outcome = await applyScope(args.scope);
        if (!outcome.ok) {
          return { response: { jsonrpc: "2.0", id, error: { code: -32602, message: outcome.message } } };
        }
        const res = {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: true,
                current_scope: outcome.scope,
                message: outcome.scope
                  ? `Bridge is now scoped to '${outcome.scope}' (${outcome.scope.startsWith("notebook:") ? "Notebook conversation" : "Normal chat"}).`
                  : "Bridge scope cleared; the extension tab will be used as-is."
              }, null, 2)
            }]
          }
        };
        return { response: res };
      }

      if (!knownSdlcTools.includes(toolName)) {
            const res = {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: `Tool not found: ${toolName}` }
            };
            return { response: res };
          }

          let prompt = "";
          if (toolName === "sdlc_solution_architect") {
            prompt = `[Role: Senior Solution Architect]\nProblem: ${args.problem_description}\nTech Stack: ${args.tech_stack || "Modern Cloud-Native"}\nConstraints: ${args.constraints || "High Availability"}\n\nTask: Design full solution architecture, component model, data flow, and actionable implementation steps.`;
          } else if (toolName === "orchestrate_sdlc_plan") {
            prompt = `[Role: SDLC Orchestrator]\nGoal: ${args.feature_or_goal}\nCurrent Stage: ${args.current_stage || "Planning"}\n\nTask: Decompose into sequential SDLC tasks across Planning, Architecture, Implementation, QA, and CI/CD.`;
          } else if (toolName === "code_review_and_debug") {
            prompt = `[Role: Expert Code Reviewer & Debugger]\nLanguage: ${args.language || "Auto"}\nError Log: ${args.error_log || "None"}\nCode:\n\`\`\`\n${args.code_snippet}\n\`\`\`\n\nTask: Find root cause of the bug, check security, and provide clean code patch.`;
          } else if (toolName === "evaluate_tech_tradeoffs") {
            prompt = `[Role: Tech Lead]\nContext: ${args.decision_context}\nOptions: ${args.options}\n\nTask: Detailed architectural trade-off analysis across Scalability, Performance, DX, and Maintenance.`;
          } else if (toolName === "horo_consult") {
            prompt = `[Role: ซินแส AI ผู้เชี่ยวชาญโหราศาสตร์จีน (BaZi),  numerology และดาราศาสตร์ไทย ตอบโดยอ้างอิงความรู้ใน Notebook ที่ผูกไว้เป็นหลัก ตอบเป็นภาษาเดียวกับคำถาม มีโครงสร้างชัดเจน (หัวข้อ/บุลเล็ต) และระบุข้อจำกัดเชิงการพยากรณ์เมื่อข้อมูลไม่พอ]\nBirth Context: ${args.birth_context ? JSON.stringify(args.birth_context) : "not provided"}\nUser Question: ${args.query}`;
          }

          // Switch conversation scope (normal chat / notebook) before executing.
          // horo_consult falls back to the default Notebook scope when omitted.
          const effectiveScope = (toolName === "horo_consult" && !(typeof args.scope === "string" && args.scope.trim()))
            ? HORO_CONSULT_DEFAULT_SCOPE
            : args.scope;
          if (effectiveScope) {
            let scopeOutcome;
            try {
              scopeOutcome = await applyScope(effectiveScope);
            } catch (scopeErr) {
              scopeOutcome = { ok: false, message: scopeErr.message };
            }
            if (!scopeOutcome.ok) {
              // If the bridge is disconnected, fall through to the standard
              // extension-disconnected fail-fast branch below instead of
              // masking it with a scope error.
              if (this.isExtensionReady()) {
                return { response: { jsonrpc: "2.0", id, error: { code: -32602, message: scopeOutcome.message } } };
              }
            }
          }

          if (!this.isExtensionReady()) {
            await this.waitForExtension();
          }
          if (!this.isExtensionReady()) {
            if (this.env.GEMINI_API_KEY) {
              try {
                const gcpResult = await this.callGcpGemini([{ role: "user", content: prompt }]);
                const res = {
                  jsonrpc: "2.0",
                  id,
                  result: { content: [{ type: "text", text: `[Provider: GCP Gemini Fallback]\n\n${gcpResult}` }] }
                };
                return { response: res };
              } catch (gcpErr) {
                const res = {
                  jsonrpc: "2.0",
                  id,
                  error: {
                    code: -32000,
                    message: `Extension disconnected and GCP fallback failed: ${gcpErr.message}`
                  }
                };
                return { response: res };
              }
            }

            const res = {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32000,
                message: "Chrome Extension is not connected. Please ensure Google Chrome is open with an active gemini.google.com session."
              }
            };
            return { response: res };
          }

          try {
            const targetModel = recommendedModel(this.dynamicModels) || this.activeBrowserModel || (this.dynamicModels[0]?.id) || "gemini-3.8-flash";
            let resultText = await this.executeThroughExtension([{ role: "user", content: prompt }], null, targetModel);

            // horo_consult PDF artifact: render the full answer into a PDF and
            // expose a temporary (1h) unguessable download link.
            let structuredContent;
            if (toolName === "horo_consult" && args.response_format === "pdf") {
              try {
                const artifactKey = crypto.randomUUID().replace(/-/g, "");
                const pdfBytes = await this.buildAnswerPdf(resultText);
                if (this.env.ARTIFACT_KV) {
                  await this.env.ARTIFACT_KV.put(`artifacts/${artifactKey}`, pdfBytes, { expirationTtl: 3600 });
                  structuredContent = { pdf_url: `${url.origin}/artifacts/${artifactKey}` };
                } else {
                  resultText += "\n\n[PDF artifact unavailable: ARTIFACT_KV binding is not configured on this worker]";
                }
              } catch (pdfErr) {
                resultText += `\n\n[PDF artifact generation failed: ${pdfErr.message}]`;
              }
            }

            const res = {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: resultText }],
                ...(structuredContent ? { structuredContent } : {})
              }
            };
            return { response: res };
          } catch (err) {
            if (this.env.GEMINI_API_KEY && (err.code === "extension_disconnected" || err.code === "model_unverified" || /reconnected|disconnected|failed|timed out|unverified/i.test(err.message || ""))) {
              try {
                const gcpResult = await this.callGcpGemini([{ role: "user", content: prompt }]);
                const res = {
                  jsonrpc: "2.0",
                  id,
                  result: { content: [{ type: "text", text: `[Provider: GCP Gemini Fallback]\n\n${gcpResult}` }] }
                };
                return { response: res };
              } catch (gcpErr) {
                // fall through to error
              }
            }
            const res = {
              jsonrpc: "2.0",
              id,
              error: { code: -32000, message: `Tool execution failed: ${err.message}` }
            };
            return { response: res };
          }
        }

        // Unknown method returns JSON-RPC method not found (-32601)
        const res = {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          }
        };
        return { response: res };
      };

      if (isLegacySseSession) {
        if (Array.isArray(body)) {
          for (const msg of body) {
            const out = await handleSingleMcp(msg);
            if (out.response) {
              sendSseMessage(sseQuerySessionId, out.response);
            }
          }
        } else {
          const outcome = await handleSingleMcp(body);
          if (outcome.response) {
            sendSseMessage(sseQuerySessionId, outcome.response);
          }
        }
        return new Response(null, { status: 202, headers: mcpHeaders });
      }

      // Modern POST response behavior
      if (Array.isArray(body)) {
        const results = [];
        for (const msg of body) {
          const out = await handleSingleMcp(msg);
          if (out.response) results.push(out.response);
        }
        if (results.length === 0) {
          return new Response(null, { status: 202, headers: mcpHeaders });
        }
        return new Response(JSON.stringify(results), {
          status: 200,
          headers: { ...mcpHeaders, "Content-Type": "application/json" }
        });
      }

      const outcome = await handleSingleMcp(body);
      if (outcome.protocolVersion) {
        mcpHeaders["Mcp-Protocol-Version"] = outcome.protocolVersion;
      }
      if (outcome.isNotification) {
        return new Response(null, { status: 202, headers: mcpHeaders });
      }
      return new Response(JSON.stringify(outcome.response), {
        status: 200,
        headers: { ...mcpHeaders, "Content-Type": "application/json" }
      });
    }

    // ─── 5. Status Dashboard (GET / หรือ /health) ───
    if (url.pathname === "/" || url.pathname === "/health") {
      const isReady = this.isExtensionReady();
      // Collect information about active connections
      const activeConnectionsInfo = [];
      for (const [instanceId, state] of this.activeConnections.entries()) {
        const idleMs = Date.now() - state.lastActivityAt;
        activeConnectionsInfo.push({
          instanceId,
          epoch: state.epoch,
          connectedAt: state.connectedAt,
          lastActivityAt: state.lastActivityAt,
          idleSeconds: Math.round(idleMs / 1000),
          isStale: idleMs > this.STALE_CONNECTION_TIMEOUT_MS
        });
      }
      return new Response(JSON.stringify({
        status: "ok",
        service: "gemini-web-bridge-cloud-hub",
        version: "4.3.4",
        architecture: "Cloudflare Durable Objects (Stateful Unified WSS + HTTP)",
        extension_status: isReady ? "CONNECTED_AND_READY" : "DISCONNECTED",
        current_scope: this.currentScope || "app (default)",
        browser_models: {
          active_model: this.activeBrowserModel,
          extended_thinking: this.extendedThinkingActive
        },
        health_metrics: {
          last_successful_generation: this.healthState.lastSuccessfulGeneration,
          consecutive_errors: this.healthState.consecutiveErrors,
          last_error: this.healthState.lastError,
          gcp_fallback_configured: Boolean(this.env.GEMINI_API_KEY)
        },
        conversation_state: {
          active: Boolean(this.conversationState.conversationId),
          conversationId: this.conversationState.conversationId || null
        },
        // ─── Phase 3: Instance-ID Tracking + Epoch Counter ───
        instance_tracking: {
          epoch_counter: this.epochCounter,
          active_connections_count: this.activeConnections.size,
          stale_connection_timeout_ms: this.STALE_CONNECTION_TIMEOUT_MS,
          connections: activeConnectionsInfo
        },
        endpoints: {
          mcp: `https://${url.host}/mcp`,
          openai: `https://${url.host}/v1/chat/completions`,
          models: `https://${url.host}/v1/models`,
          bridge: `wss://${url.host}/bridge`
        }
      }, null, 2), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ error: { message: "Not Found", code: "not_found" } }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}

// ─── Root Worker Entrypoint ───
export default {
  async fetch(request, env, ctx) {
    const id = env.BRIDGE_DO.idFromName("global-bridge");
    const stub = env.BRIDGE_DO.get(id);
    return stub.fetch(request);
  }
};