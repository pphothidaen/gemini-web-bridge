// Cloudflare Worker: Stateful Gemini Web-Bridge Edge Hub
// Architecture: Cloudflare Durable Objects (Unified WSS + HTTP Stateful Coordinator)
// Version: 4.7.16 (see WORKER_VERSION below — this comment is informational only)

import { normalizeModels, recommendedModel } from "./model-catalog.js";
import { PONG_GRACE_MS, isKeepaliveMissed, isEvictable } from "./liveness.js";
import {
  classifyGeminiReply,
  isRetryWorthwhile,
  RETRY_BACKOFF_MS,
  REFUSAL_KIND
} from "./gemini-refusal.js";
import { buildToolPrompt } from "./prompt-templates.js";
import { DurableObject } from "cloudflare:workers";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { 
  buildToolSystemPrompt, 
  createToolCallTransformer,
  resolveToolPolicy,
  parseToolCompletion
} from "./tool-emulator.ts";

// ─── Single Source of Truth for the worker version ───────────────────────────
// Every user-visible version string (/health, MCP serverInfo, ping) reads this
// constant, so the surface can never drift the way it did before (hardcoded
// 4.3.4 in three places while package.json said 4.3.7 and the extension
// manifest said 4.4.3).
//
// KEEP IN SYNC with:
//   • cloudflare-worker/package.json          (npm test → version-consistency)
//   • cloudflare-worker/package-lock.json
//   • extension-cloudflare/manifest.json
//
// tests/version-consistency.test.mjs fails the build if any of them drift.
const WORKER_VERSION = "4.7.16";

// ─── Verbose logging gate ────────────────────────────────────────
// console.log is not free in Workers: each call formats its arguments,
// serialises them, and enqueues a log entry, all charged to the same CPU
// budget that produced "Exceeded allowed duration in Durable Objects free
// tier". The per-request and per-frame sites below fire on traffic the
// DO cannot avoid, so they are the ones worth gating.
//
// Errors and warnings are deliberately NOT gated. They are rare, and
// they are the signal that matters when something is actually wrong —
// a gate that silenced them would trade a real diagnostic for a
// millisecond.
//
// Set BRIDGE_VERBOSE=1 to restore full logging when debugging:
//   wrangler deploy --var BRIDGE_VERBOSE:1
//   (or add "vars": { "BRIDGE_VERBOSE": "1" } to wrangler.toml locally)
const VERBOSE = (typeof BRIDGE_VERBOSE !== "undefined" && BRIDGE_VERBOSE === "1")
  || (typeof process !== "undefined" && process.env && process.env.BRIDGE_VERBOSE === "1");

/**
 * Log only when verbose mode is on. No-op otherwise, and the arguments
 * are not evaluated when it returns early.
 */
function vlog(...args) {
  if (VERBOSE) console.log(...args);
}

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
   *
   * Robustness notes (v4.4.3):
   *  - Google re-sends the CUMULATIVE answer on each update, so the caller
   *    replaces (not appends) its accumulator. A single decodeChunk() call
   *    can therefore contain SEVERAL `wrb.fr` entries, and the last one is
   *    NOT necessarily the longest one: Gemini appends a private
   *    conversation link (https://googleusercontent.com/lmdx_content/...)
   *    and can emit LMDX UI-component entries in their own `wrb.fr`.
   *    Taking the last entry (old behaviour) replaced a finished answer
   *    with that trailing link, which is what made long SDLC tool output
   *    (orchestrate_sdlc_plan) come back empty/link-only.
   *  - The text slot is positional and has changed shape over time:
   *      innerData[4][0][1]        = [ "text" ]  (array of text segments)
   *      innerData[4][0][1]        = "text"      (plain string)
   *      innerData[4][0][1][0]     = { lmdx_content: ... } (structured block)
   *    All three are handled; anything else is ignored rather than
   *    corrupting the accumulated text.
   *  - A malformed innerData payload must not discard the rest of the
   *    line, otherwise conversationId/responseId (state) is lost too.
   *
   * @returns {{ deltaText: string, stateUpdate: object }}
   */
  static decodeChunk(rawChunk) {
    let clean = String(rawChunk || "").trim();
    if (clean.startsWith(")]}'")) {
      clean = clean.substring(4).trim();
    }

    // Longest coherent text wins: cumulative resends grow monotonically, so
    // the longest string in the buffer is the most complete answer.
    let deltaText = "";
    let stateUpdate = {};

    const lines = clean.split("\n");
    for (const line of lines) {
      if (!line.trim() || /^\d+$/.test(line.trim())) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        continue; // incomplete / not-JSON line — skip it, keep scanning
      }
      if (!Array.isArray(parsed)) continue;

      for (const item of parsed) {
        if (!Array.isArray(item) || item[0] !== "wrb.fr" || !item[2]) continue;
        let innerData;
        try {
          innerData = JSON.parse(item[2]);
        } catch (e) {
          continue; // broken inner payload: state below is unreachable anyway
        }
        if (!Array.isArray(innerData)) continue;

        // Choice slot holds the answer text; extract defensively.
        const choice = Array.isArray(innerData[4]) && Array.isArray(innerData[4][0])
          ? innerData[4][0]
          : null;
        const candidate = ProtocolDecoder._extractText(choice ? choice[1] : undefined);
        if (candidate.length > deltaText.length) {
          deltaText = candidate;
        }

        if (Array.isArray(innerData[1])) {
          if (innerData[1][0]) stateUpdate.conversationId = innerData[1][0];
          if (innerData[1][1]) stateUpdate.responseId = innerData[1][1];
        }
        if (choice && choice[0]) {
          stateUpdate.choiceId = choice[0];
        }
      }
    }

    return { deltaText: ProtocolDecoder._stripPrivateLink(deltaText), stateUpdate };
  }

  /**
   * Pull plain text out of whatever shape Gemini put in the text slot.
   * Returns "" when there is no usable text (e.g. pure structured blocks).
   */
  static _extractText(slot) {
    if (typeof slot === "string") return slot;
    if (!Array.isArray(slot)) return "";

    const parts = [];
    const walk = (node, depth) => {
      if (depth > 4 || node == null) return;
      if (typeof node === "string") {
        if (node) parts.push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const child of node) walk(child, depth + 1);
        return;
      }
      if (typeof node === "object") {
        // LMDX / structured blocks: walk for a text-bearing field rather than
        // dropping the segment entirely.
        for (const key of ["text", "content", "body", "html", "lmdx_content"]) {
          if (key in node) walk(node[key], depth + 1);
        }
      }
    };
    walk(slot, 0);
    return parts.join("");
  }

  /**
   * Gemini sometimes appends a private conversation link to the answer text
   * (https://googleusercontent.com/lmdx_content/<id>). It is noise for API
   * clients and leaks a private resource identifier, so strip it.
   */
  static _stripPrivateLink(text) {
    return String(text || "")
      .replace(/\s*https?:\/\/[^\s]*googleusercontent\.com\/lmdx_content\/[^\s]*\s*$/i, "")
      .trim();
  }
}

export class GeminiBridgeDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;   // DO alarm API requires this reference
    this.env = env;
    this.activeSocket = null;
    this.currentTokens = null;
    this.activeBrowserModel = null;
    this.extendedThinkingActive = false;
    this.dynamicModels = [];
    this.activeStreams = new Map();
    this.pendingRequests = [];
    this.requestBusy = false;
    // True only while a generation is actually being produced. Read by
    // scheduleAlarm() to pick the fast (15s) vs idle (60s) alarm interval.
    // activeStreams/pendingRequests already cover most in-flight work, but a
    // generation in progress with no stream registered is exactly the case
    // that must not back off.
    this._generationInFlight = false;
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

    // KAN-177: outcome of the most recent notebook attach, surfaced by
    // check_bridge_health. Starts "unknown" rather than "ok" so a health
    // report can never imply grounding was verified when no attach has ever
    // been attempted.
    //
    // KAN-182: `groundingStatus` is tracked separately from `status`, because
    // the two answer different questions. "The chip was accepted" is a UI
    // fact; "the answer came from the notebook" is the one that decides
    // whether a horo_consult result is worth anything. Reporting one under
    // the other's label is how an ungrounded answer came back marked
    // `attached: true`.
    this.notebookAttachState = {
      status: "unknown",
      at: null,
      reason: null,
      failures: 0,
      groundingStatus: "unknown",
      groundingAt: null,
      groundingReason: null
    };

    // ─── Phase 3: Per-instance-id Tracking + Epoch Counter ───
    // Replaces origin-based identity with cryptographically random instance ID
    // that persists across SW restarts and is sent as query param in WS URL.
    this.activeConnections = new Map(); // Map<instanceId, ConnectionState>
    this.epochCounter = 0;              // Monotonically increasing session epoch
    // 180s, matching STALE_AFTER_MS in src/liveness.js. This must stay ABOVE
    // IDLE_ALARM_INTERVAL_MS (120s) plus a margin: the keepalive only PINGs once
    // per alarm tick, so a healthy idle connection is always past a 45s
    // threshold when the sweep runs, and the raw-idle fallback then swept live
    // sockets. The alarm is a memory-hygiene sweep, not a gate — the 409 guard on
    // the upgrade path runs its own inline check, so reaping a genuinely dead
    // socket at 180-300s instead of 45-60s is not user-visible.
    this.STALE_CONNECTION_TIMEOUT_MS = 180000; // 180s idle threshold for stale connections

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

    // ─── DO Alarm: Keepalive + Stale Socket Cleanup ───
    // Uses the native DurableObject alarm API instead of setInterval,
    // which would keep the DO hot indefinitely and exhaust the free-tier CPU quota.
    // The alarm fires every 15s while there are active connections/sessions,
    // and is NOT scheduled when the DO is idle — allowing proper eviction.
    this.scheduleAlarm("constructor");
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

  // ─── Health metric writers ────────────────────────────────────────────────
  // `healthState` is a DERIVED getter: it builds a fresh object on every read,
  // so `this.healthState.consecutiveErrors++` mutated a throwaway copy and the
  // counters stayed pinned at 0/null forever (visible in production /health and
  // in the `check_bridge_health` "degraded" threshold, which could never fire).
  // Always write through these helpers, never through the getter.
  recordHealthError(message) {
    this._consecutiveErrors = (this._consecutiveErrors || 0) + 1;
    this._lastError = message ?? null;
  }

  recordHealthSuccess() {
    this._lastSuccessfulGeneration = Date.now();
    this._consecutiveErrors = 0;
    this._lastError = null;
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
      vlog(`[Bridge DO] Instance ${instanceId} reconnecting — replacing existing connection.`);
      try { existing.socket.close(1000, "Replaced by reconnect"); } catch (e) {}
      this.activeConnections.delete(instanceId);
    }

    // Check for unresponsive connections from OTHER instance IDs.
    // Liveness is decided by the keepalive (did it answer our PING), not by raw
    // idle time — a connection that answers the PING is healthy even when it has
    // been quiet for longer than the threshold. See src/liveness.js.
    for (const [otherId, state] of this.activeConnections.entries()) {
      if (isEvictable(state, now, { staleAfterMs: this.STALE_CONNECTION_TIMEOUT_MS })) {
        vlog(`[Bridge DO] Evicting unresponsive connection for instance ${otherId} (idle ${Math.round((now - state.lastActivityAt) / 1000)}s).`);
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
      // Keepalive bookkeeping: the DO stamps lastPingAt when it probes, and
      // touchConnection stamps lastPongAt when the extension answers.
      lastPingAt: 0,
      lastPongAt: 0,
      epoch: this.epochCounter,
      tokens: null,
      scope: null
    };

    this.activeConnections.set(instanceId, connectionState);
    vlog(`[Bridge DO] Recorded connection for instance ${instanceId}, epoch ${this.epochCounter}, total connections: ${this.activeConnections.size}`);

    // KAN-168: arm the alarm on every arriving connection.
    //
    // scheduleAlarm() is otherwise called from the constructor, from inside
    // alarm() itself, and around generation — never from here. That left a
    // permanent-death path: the constructor arms the alarm once, and if that
    // first tick finds no active work the re-arm at the end of alarm() is
    // skipped. A client connecting afterwards re-armed nothing, so the DO
    // silently stopped PINGing, stopped sweeping dead sockets, and stopped
    // writing MCP keepalives until the next deploy or eviction.
    //
    // Measured on production 2026-09-27: zero keepalives over a 231s SSE
    // stream that was demonstrably live, a connection 209s past the 180s
    // stale threshold and not reaped, `idle` climbing monotonically with no
    // reset, and zero alarm invocations in 23 minutes of `wrangler tail`.
    //
    // Arming here makes permanent death impossible regardless of which tick
    // failed: any connection restarts the cadence.
    this.scheduleAlarm("recordConnection");

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
      // Any inbound traffic is also the answer to the keepalive we sent.
      state.lastPongAt = state.lastActivityAt;
    }
  }

  /**
   * Checks if a connection for the given instance ID may be evicted.
   * Liveness comes from the keepalive exchange, not raw idle time — see
   * src/liveness.js for why raw idle time closed healthy connections.
   */
  isConnectionStale(instanceId) {
    const state = this.activeConnections.get(instanceId);
    if (!state) return false;
    return isEvictable(state, Date.now(), { staleAfterMs: this.STALE_CONNECTION_TIMEOUT_MS });
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
      vlog(`[Bridge DO] Removed connection for instance ${instanceId}. Remaining: ${this.activeConnections.size}`);
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

  /**
   * Schedule a DO alarm for keepalive + stale connection cleanup.
   * Uses the native alarm API instead of setInterval to avoid keeping the
   * DO hot indefinitely (which exhausts free-tier CPU quota).
   * See: https://developers.cloudflare.com/durable-objects/learn/alarms/
   *
   * The interval is adaptive. While a generation or stream is in flight the
   * short interval applies, because that is when a dropped socket must be
   * noticed quickly. When the DO is only holding an idle connection it backs
   * off to IDLE_ALARM_INTERVAL_MS, cutting wakeups from 5,760/day to
   * 1,440/day for the overwhelmingly common case of a connected but unused
   * bridge. The stale threshold is unchanged, so eviction still happens
   * within STALE_SOCKET_IDLE_MS; only the granularity of detection coarsens.
   *
   * The trade-off, stated plainly: with a 120s alarm and a 180s stale
   * threshold, a dead socket is now reaped after 180-300s rather than
   * 45-60s. Nothing user-visible depends on that latency — a dead socket
   * produces no traffic either way, and the 409 guard on the upgrade path
   * runs its own inline staleness check, so a new connection never waits
   //  on the alarm. The alarm is a memory-hygiene sweep, not a gate.
   */
  scheduleAlarm(reason = "unspecified") {
    if (typeof this.ctx === "undefined" || this.ctx === null) {
      vlog(`[Bridge DO] scheduleAlarm(${reason}) ABORTED — no ctx bound.`);
      return;
    }
    // Re-arm unconditionally. Previously this only fired when alarm === null,
    // which meant an interval change could never take effect on a DO that
    // already had a pending alarm.
    const busy =
      (this.activeStreams && this.activeStreams.size > 0) ||
      (this.pendingRequests && this.pendingRequests.length > 0) ||
      this._generationInFlight === true;
    const ms = busy ? GeminiBridgeDO.RUN_ALARM_INTERVAL_MS
                    : GeminiBridgeDO.IDLE_ALARM_INTERVAL_MS;

    // KAN-168 — THE ROOT CAUSE. This used to read:
    //
    //     this.ctx.alarm = Math.max(1, Math.round(ms / 1000));
    //
    // DurableObjectState has no `alarm` property. That line therefore only
    // created a plain own-property on the ctx object: the runtime never saw
    // it, and no alarm was ever scheduled. Because reading the property back
    // returned the number just written, the KAN-168 read-back instrumentation
    // logged "read back ctx.alarm=120 type=number" and looked like proof the
    // arm had succeeded. It proved only that the assignment reached a JS
    // object — a getAlarm() check in wrangler dev returned null for exactly
    // that arm while a setAlarm() arm fired normally.
    //
    // The real API is ctx.storage.setAlarm(scheduledTime), and it takes an
    // ABSOLUTE time (epoch ms or a Date), not a delay in seconds. A delay of
    // 120 is therefore a timestamp in 1970 — in the past, so it can never
    // produce a future wakeup even where the property did exist.
    const fireAt = Date.now() + ms;

    // setAlarm is async. scheduleAlarm is called from synchronous contexts
    // (the constructor, recordConnection, the generation brackets) that cannot
    // await, so the promise is handled here rather than left to reject
    // unobserved. A failed arm is precisely the silent-death condition this
    // bug was, so it is logged ungated: errors are never vlog-gated in this
    // file, and one warning per failed arm is worth the CPU.
    const armed = this.ctx.storage.setAlarm(fireAt);
    if (armed && typeof armed.catch === "function") {
      armed.catch((e) => {
        console.warn(
          `[Bridge DO] scheduleAlarm(${reason}) FAILED to arm alarm:`, e && e.message
        );
      });
    }

    vlog(
      `[Bridge DO] scheduleAlarm(${reason}): armed in ${Math.round(ms / 1000)}s ` +
      `(mode=${busy ? "busy" : "idle"}, fires at ${fireAt}, ` +
      `conns=${this.activeConnections ? this.activeConnections.size : 0}, ` +
      `mcpSessions=${this.mcpSessions ? this.mcpSessions.size : 0})`
    );
  }

  // Liveness thresholds. See src/liveness.js for the rules these feed.
  //
  // KAN-161: STALE_SOCKET_IDLE_MS was 45000 while IDLE_ALARM_INTERVAL_MS was
  // 120000 — the keepalive only PINGs once per alarm tick, so a healthy idle
  // connection is always past 45s by the time the sweep runs and the raw-idle
  // fallback could not tell "quiet but answering" from "dead". That is what made
  // the lease flap. The invariant is now STALE_SOCKET_IDLE_MS > IDLE_ALARM_INTERVAL_MS
  // with margin, and the eviction code reads the LIVE value from
  // STALE_AFTER_MS (liveness.js) / this.STALE_CONNECTION_TIMEOUT_MS rather than
  // from this static, so the two can no longer drift apart silently again.
  static STALE_SOCKET_IDLE_MS = 180000; // 180s — must exceed the alarm interval
  static RUN_ALARM_INTERVAL_MS = 15000; // 15s while work is in flight
  static IDLE_ALARM_INTERVAL_MS = 120000; // 120s when only holding a connection
  // Minimum gap between SSE keepalive writes to a single MCP session. The
  // alarm can fire as often as every 15s while work is in flight; without
  // this floor a busy-but-idle client would be pinged on every wakeup.
  // 30s is comfortably under the ~60s idle timeout of typical proxies.
  static MCP_KEEPALIVE_MIN_MS = 30000;

  /**
   * RunAlarm: periodic keepalive + liveness check for active WebSocket connections.
   * Previously ran every 15s via setInterval (which kept the DO hot indefinitely
   * and exhausted the free-tier CPU quota). Now fires via the native DO alarm API.
   *
   * A connection is closed when it fails to answer the PING sent in step 1, not
   * when it merely looks idle. With a 120s idle cadence every healthy connection
   * is "idle" past 45s when the sweep runs, and the sweep used to run in the same
   * tick as the PING — so it closed a live socket roughly every two minutes.
   * See src/liveness.js.
   */
  async alarm() {
    // KAN-168: the alarm is real now (it never fired before — see the note in
    // scheduleAlarm). getAlarm() is read first, before any of the work below,
    // so that if this handler ever throws, the log still shows whether the
    // runtime had actually delivered an alarm. A null here would mean the
    // handler was invoked without a scheduled alarm, which is the signature
    // of a runtime problem rather than an application one.
    try {
      vlog(`[Bridge DO] alarm() fired. getAlarm()=${await this.ctx.storage.getAlarm()}`);
    } catch (e) {
      console.warn("[Bridge DO] alarm() getAlarm() read failed:", e && e.message);
    }

    // ─── 1. Keepalive PING (from former initKeepalive) ───
    // Probe EVERY tracked connection, not just the "primary" one: the sweep below
    // judges liveness by whether a connection answered, so a connection that is
    // never probed can never be proven dead. Stamping lastPingAt is what gives
    // the sweep something to compare the answer against.
    const pingFrame = JSON.stringify({ type: "PING" });
    for (const [instanceId, state] of this.activeConnections.entries()) {
      if (!state.socket || state.socket.readyState !== 1) continue;
      try {
        state.socket.send(pingFrame);
        state.lastPingAt = Date.now();
      } catch (e) {
        console.warn(`[Bridge DO] PING send error for ${instanceId}:`, e.message);
      }
    }
    // Legacy path: harnesses that assign activeSocket directly have no map entry.
    if (this.activeConnections.size === 0 && this.activeSocket && this.activeSocket.readyState === 1) {
      try {
        this.activeSocket.send(pingFrame);
      } catch (e) {
        console.warn("[Bridge DO] PING send error:", e.message);
      }
    }
    // SSE keepalive. Written per session, so N parked MCP clients meant N
    // writes on every wakeup — and the streams that most need it are
    // exactly the ones doing nothing.
    //
    // lastWriteAt is set by the real-traffic write sites too, so a session
    // that just received a message is skipped here. Proxies drop an idle
    // SSE connection after roughly 60s, so a keepalive interval above that
    // would be pointless anyway; this keeps the write cadence bounded by
    // what the protocol actually requires rather than by the alarm.
    if (this.mcpSessions && this.mcpSessions.size > 0) {
      const now = Date.now();
      for (const [sessionId, session] of this.mcpSessions.entries()) {
        if (now - (session.lastWriteAt || 0) < GeminiBridgeDO.MCP_KEEPALIVE_MIN_MS) {
          continue; // written recently by real traffic or a prior keepalive
        }
        session.lastWriteAt = now;
        try {
          session.writer.write(session.encoder.encode(": keepalive\n\n")).catch(() => {
            this.mcpSessions.delete(sessionId);
          });
        } catch (e) {
          this.mcpSessions.delete(sessionId);
        }
      }
    }

    // ─── 2. Stale connection cleanup (Phase 3 activeConnections) ───
    // Sweep a connection only when it failed to answer the keepalive sent in
    // step 1 (or its socket is no longer OPEN). Raw idle time is deliberately
    // NOT the criterion: the idle alarm runs every 120s, so a healthy
    // connection always looks idle by then and used to be closed every cycle.
    const now = Date.now();
    for (const [instanceId, state] of this.activeConnections.entries()) {
      if (!isKeepaliveMissed(state, now, { graceMs: PONG_GRACE_MS })) continue;
      const idleSec = Math.round((now - state.lastActivityAt) / 1000);
      const pingAgeSec = state.lastPingAt ? Math.round((now - state.lastPingAt) / 1000) : null;
      vlog(`[Bridge DO] Unresponsive connection for instance ${instanceId} (idle ${idleSec}s, last PING ${pingAgeSec === null ? "never sent" : pingAgeSec + "s ago"} unanswered). Closing and allowing reconnection.`);
      try {
        state.socket.close(1000, "Stale socket cleanup: keepalive unanswered");
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
      vlog(`[Bridge DO] Stale socket cleanup complete for instance ${instanceId}. Remaining connections: ${this.activeConnections.size}`);
    }

    // ─── 3. Reschedule alarm only if there is still active work ───
    const hasActiveWork =
      (this.activeSocket && this.activeSocket.readyState === 1) ||
      (this.mcpSessions && this.mcpSessions.size > 0) ||
      this.activeConnections.size > 0;

    if (hasActiveWork) {
      this.scheduleAlarm("alarm-rerarm");
    } else {
      // KAN-168 diagnostic. This branch is where the alarm dies permanently:
      // the one alarm the constructor armed reaches this tick with no active
      // work, the re-arm is skipped, and nothing ever sets it again. Previously
      // this was a silent no-op.
      vlog(
        `[Bridge DO] alarm() tick: NOT re-arming — no active work ` +
        `(conns=${this.activeConnections ? this.activeConnections.size : 0}, ` +
        `mcpSessions=${this.mcpSessions ? this.mcpSessions.size : 0}, ` +
        `activeSocket=${Boolean(this.activeSocket && this.activeSocket.readyState === 1)}). ` +
        'The alarm is now unset; only a new connection, generation, or DO ' +
        'recreation will start it again.'
      );
    }
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
    vlog(`[Bridge DO] Received SCOPE_SWITCH from extension: ${this.currentScope} -> ${targetScope} (req: ${requestId})`);
    
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
      vlog(`[Bridge DO] Already at scope ${validatedScope}, confirming`);
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
        vlog(`[Bridge DO] Forwarded SCOPE_SWITCH to extension for scope: ${validatedScope}`);
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
    
    vlog(`[Bridge DO] Requesting scope switch: ${this.currentScope} -> ${validatedScope}`);
    
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
    vlog(`[ScopeRouter] Registered handler for pattern "${pattern}"`);
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
      vlog(`[ScopeRouter] Subscribed conn=${connId} scope=${canonical} session=${id}`);
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

    vlog(`[ScopeRouter] Unsubscribed conn=${connId} scope=${canonical} session=${session.sessionId}`);
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
    vlog(`[ScopeRouter] Removed ${removed} scope session(s) for conn=${connId}`);
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
    if (pruned > 0) vlog(`[ScopeRouter] Pruned ${pruned} stale scope activity entries`);
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
      this.recordHealthError(`GCP Error: ${res.status}`);
      throw new Error(`GCP Gemini API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text || "";
    this.recordHealthSuccess();
    return text;
  }

  async executeThroughExtension(messages, onChunk, model = "", opts = {}) {
    // KAN-182: `requireGrounding` forces the typing path and skips replay.
    //
    // Replay is NOT a neutral fallback — it is architecturally incapable of
    // grounding. It POSTs `f.req=[null,"[[\"<prompt>\",0,…]]"]` with no
    // `notebook://…/sources/…` reference, confirmed on the wire 2026-09-29:
    // the request went out as `fetch` (not the page's own `xhr`), carried the
    // bare prompt, and returned a perfectly good answer. So a replayed answer
    // is written from general knowledge by construction, and — because the
    // page never renders it — there is no `model-response` for the grounding
    // check to read either.
    //
    // For a tool whose whole purpose is a notebook-grounded answer, replay can
    // therefore only produce a wrong result, and it would bypass the attach the
    // caller just paid for. The typed path is not a fallback there; it is the
    // only path in which the PAGE builds the request, and the page is what
    // carries the attachment.
    const { requireGrounding = false } = opts;

    if (!this.isExtensionReady()) {
      const err = new Error("Extension not connected");
      err.code = "extension_disconnected";
      throw err;
    }

    // One logical request keeps ONE requestId for its whole life, so a native
    // retry and the replay attempt it replaces stay correlated in activeStreams.
    const requestId = `req_${crypto.randomUUID()}`;
    const encodedReq = ProtocolDecoder.encodeRequest(messages, {}, model);

    // Stage 1: the replay attempt. If Gemini answers with a refusal or an
    // upstream error, escalate to the native retry button below.
    //
    // KAN-182: if the replay never receives a chunk at all, the question never
    // left the browser — Google rejects the assembled payload outright. A
    // timeout is the signature of that, and it is a hard failure rather than a
    // refusal, so the typing fallback runs before the retry button (clicking
    // "regenerate" on a conversation that has no answer does nothing).
    let text;
    // KAN-182: when the answer must be notebook-grounded, go straight to the
    // typed path. Replay is skipped rather than tried-then-fallen-back-from,
    // because a replayed answer can never be grounded (see `requireGrounding`
    // above) — so attempting it first would spend the attach and still return
    // an ungrounded result.
    const useTypedOnly = requireGrounding;
    try {
      if (useTypedOnly) {
        vlog(`[Bridge DO] Grounding required; using the typed path (replay cannot carry a notebook reference).`);
        throw Object.assign(new Error("replay_skipped_for_grounding"), { __typedOnly: true });
      }
      text = await this.runReplayAttempt({ requestId, encodedReq, model, onChunk });
    } catch (replayErr) {
      const forced = replayErr?.__typedOnly === true;
      const timedOut = /no response chunk|Timeout/i.test(replayErr?.message || "");
      if (!forced && !timedOut) throw replayErr;

      const prompt = messages?.[0]?.content || "";
      vlog(forced
        ? `[Bridge DO] Grounding required; typing into Gemini's input (KAN-182).`
        : `[Bridge DO] Replay produced no chunk; falling back to typing into Gemini's input (KAN-182).`);
      const typed = await this.typePromptThroughUi({
        requestId: `${requestId}:typed`,
        prompt
      });
      if (!typed.ok) {
        this.recordHealthError(`type_prompt_failed:${typed.reason}@${typed.step}`);
        throw new Error(
          `${forced ? "Grounding requires the typed path" : "Replay produced no response chunk"} and the typed path failed ` +
          `(step=${typed.step || "unknown"}, reason=${typed.reason || "unknown"}). ` +
          `The Gemini tab must be in the foreground for a typed prompt to be submitted.`
        );
      }
      // The page now renders the answer itself; read it back from the DOM via
      // the native path, which is already proven to work.
      //
      // KAN-182: the `ok` flag was ignored here, so a collection that failed —
      // or that timed out and returned the PREVIOUS response's text — was
      // adopted as this call's answer. Live on 2026-09-29: the typed prompt
      // never landed (editor empty, chip unconsumed), yet horo_consult
      // answered with the text of the test prompt from the previous turn and
      // then failed grounding on it. An unreadable answer must not be
      // reported as an ungrounded one — the two need different fixes.
      const collected = await this.collectTypedAnswer({
        requestId,
        timeoutMs: 120000,
        responsesBefore: typed.responsesBefore
      });
      if (!collected.ok) {
        this.recordHealthError(`collect_answer_failed:${collected.reason}`);
        throw new Error(
          `The prompt was submitted but no new answer was rendered for it ` +
          `(reason=${collected.reason || "unknown"}, responses on screen=${collected.responses}). ` +
          `This means Gemini never produced a reply to THIS question — the text already on ` +
          `screen belongs to an earlier turn and is deliberately not reused. ` +
          `Check the Gemini tab is still open and in the foreground.`
        );
      }
      text = collected.text;
    }

    // Stage 1 escalation: re-ask through Gemini's own retry control.
    // Our assembled StreamGenerate payload is rejected by a schema change on
    // Google's side, so replaying it again can only fail identically. A native
    // click makes Gemini rebuild the request itself.
    for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
      const verdict = classifyGeminiReply(text);
      if (!isRetryWorthwhile(verdict.kind)) break;
      if (!text || !text.trim()) break;

      const delay = RETRY_BACKOFF_MS[attempt];
      vlog(`[Bridge DO] Gemini replied "${verdict.kind}"; native retry ${attempt + 1}/${RETRY_BACKOFF_MS.length} after ${delay}ms.`);
      await new Promise((resolve) => setTimeout(resolve, delay));

      const retried = await this.runNativeRetry({ requestId, attempt: attempt + 1, onChunk });
      if (!retried.ok) {
        vlog(`[Bridge DO] Native retry ${attempt + 1} unavailable (${retried.reason}); keeping previous text.`);
        break;
      }
      text = retried.text;
    }

    // Surface a classified verdict to the caller so a refusal can never again
    // be mistaken for a successful answer (the defect that let every Gemini
    // refusal score as a PASS).
    const finalVerdict = classifyGeminiReply(text);
    if (finalVerdict.kind !== REFUSAL_KIND.ANSWERED) {
      this.recordHealthError(`gemini_${finalVerdict.kind}: ${text.slice(0, 160)}`);
    }
    return text;
  }

  /**
   * Asks the extension to re-ask via Gemini's own retry control and waits for
   * the new answer. Resolves {ok:false} rather than throwing so a missing
   * button degrades to the previous text instead of failing the request.
   */
  runNativeRetry({ requestId, attempt, onChunk, timeoutMs = 45000 }) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.activeStreams.delete(requestId);
        resolve({ ok: false, reason: "native_retry_timeout", text: "" });
      }, timeoutMs);

      this.activeStreams.set(requestId, (msg) => {
        if (msg.type !== "NATIVE_RETRY_RESULT") return;
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        if (msg.ok && typeof msg.text === "string" && msg.text.trim()) {
          try { Promise.resolve(onChunk?.(msg.text, msg.text)).catch(() => {}); } catch (e) {}
        }
        resolve({
          ok: Boolean(msg.ok && typeof msg.text === "string" && msg.text.trim()),
          reason: msg.reason || "",
          text: typeof msg.text === "string" ? msg.text : ""
        });
      });

      try {
        this.activeSocket.send(JSON.stringify({
          type: "NATIVE_RETRY",
          requestId,
          attempt,
          timeoutMs: Math.min(timeoutMs - 5000, 40000)
        }));
      } catch (err) {
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        resolve({ ok: false, reason: "native_retry_send_failed", text: "" });
      }
    });
  }

  /**
   * Ask the extension to attach a NotebookLM notebook to the conversation
   * that is already open, and wait for the result.
   *
   * Why this is not a scope switch
   * ------------------------------
   * The obvious approach is `set_bridge_scope("notebook:<id>")`, which
   * navigates the tab to gemini.google.com/notebook/<id>. That page is not
   * a chat surface: submitting a question there wraps it in a
   * "คุณบอกว่า…" preamble and spawns a NEW conversation under /app/<new-id>.
   * The requested scope is therefore gone before the answer streams, and
   * the caller sees a refusal or an empty answer while the real reply sits
   * in a different element.
   *
   * Attaching through Gemini's own "+ > more uploads > Notebooks" menu
   * keeps the conversation, the URL, and the scope exactly as they are and
   * grounds the answer in the notebook — which is the whole point of
   * `horo_consult`.
   *
   * Resolves {ok:false} rather than throwing, so a failed attach degrades
   * into an explicit, reportable state instead of an opaque error.
   */
  runNotebookAttach({ requestId, notebookName, timeoutMs = 45000 }) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.activeStreams.delete(requestId);
        resolve({ ok: false, reason: "notebook_attach_timeout", step: "timeout", attached: [] });
      }, timeoutMs);

      this.activeStreams.set(requestId, (msg) => {
        if (msg.type !== "NOTEBOOK_ATTACH_RESULT") return;
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        resolve({
          ok: Boolean(msg.ok),
          reason: msg.reason || "",
          step: msg.step || "",
          // KAN-182: `alreadyAttached` is no longer sent. The extension now
          // always performs a fresh attach, because grounding is
          // per-message and a chip left over from an earlier turn is gone
          // from the request by the time the next one is sent.
          attached: Array.isArray(msg.attached) ? msg.attached : []
        });
      });

      try {
        this.activeSocket.send(JSON.stringify({
          type: "ATTACH_NOTEBOOK",
          requestId,
          notebookName,
          timeoutMs: Math.min(timeoutMs - 5000, 40000)
        }));
      } catch (err) {
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        resolve({ ok: false, reason: "notebook_attach_send_failed", step: "send", attached: [] });
      }
    });
  }

  /**
   * Ask the extension whether the answer that just streamed is actually
   * grounded in the notebook (KAN-182).
   *
   * Why this cannot be folded into the attach
   * -----------------------------------------
   * A successful attach proves only that Gemini's UI accepted the chip. It
   * says nothing about the request that was ultimately sent, because the
   * attachment is consumed per message. Measured from real
   * `StreamGenerate` payloads on 2026-09-29:
   *
   *   attach -> send            payload HAS notebook://…/sources/…
   *   send again, no re-attach  payload has NO notebook reference
   *
   * The second case produces a fluent, plausible, entirely ungrounded
   * BaZi answer. Nothing in the returned text distinguishes it from a
   * grounded one, so the caller cannot detect the failure — which is why
   * this is a first-class result rather than a log line.
   *
   * The check is scoped by the extension to the NEWEST `model-response`,
   * so citation chips left in the DOM by earlier replies cannot stand in
   * for this one.
   *
   * Resolves {ok:false} rather than throwing: a failed check is reported
   * as unverified, never as a transport error, so the caller still gets
   * the answer text and decides what to do with it.
   */
  verifyNotebookGrounding({ requestId, timeoutMs = 35000 }) {
    // KAN-182: the extension now polls until the response stops changing,
    // because a grounded answer's citations arrive after its text. The budget
    // has to cover that wait, or a correctly grounded answer is reported as
    // ungrounded — which is exactly the false negative seen live on 2026-09-29
    // (nine citations present, verdict `no_citations_in_response`).
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.activeStreams.delete(requestId);
        resolve({
          ok: false,
          verified: false,
          reason: "grounding_check_timeout",
          chipCount: 0,
          citeMarkers: 0,
          sources: []
        });
      }, timeoutMs);

      this.activeStreams.set(requestId, (msg) => {
        if (msg.type !== "GROUNDING_RESULT") return;
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        resolve({
          ok: Boolean(msg.ok),
          verified: Boolean(msg.verified),
          reason: msg.reason || "",
          chipCount: Number(msg.chipCount) || 0,
          citeMarkers: Number(msg.citeMarkers) || 0,
          sources: Array.isArray(msg.sources) ? msg.sources : []
        });
      });

      try {
        this.activeSocket.send(JSON.stringify({
          type: "VERIFY_GROUNDING",
          requestId,
          timeoutMs: Math.min(timeoutMs - 2000, 15000)
        }));
      } catch (err) {
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        resolve({
          ok: false,
          verified: false,
          reason: "grounding_check_send_failed",
          chipCount: 0,
          citeMarkers: 0,
          sources: []
        });
      }
    });
  }

  /**
   * Ask through Gemini's own input box and wait for the extension to confirm
   * the prompt was submitted.
   *
   * KAN-182. The replay path POSTs an assembled `StreamGenerate` payload that
   * Google now rejects, so the question never leaves the browser: the caller
   * sees a 60s timeout with 0 user-queries rendered. Typing the prompt makes
   * the page build the request itself, so the stale schema is bypassed.
   *
   * Resolves {ok:false} rather than throwing, so a failed submit degrades into
   * a reportable state instead of an opaque error.
   */
  typePromptThroughUi({ requestId, prompt, timeoutMs = 60000 }) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.activeStreams.delete(requestId);
        resolve({ ok: false, reason: "type_prompt_timeout", step: "timeout" });
      }, timeoutMs);

      this.activeStreams.set(requestId, (msg) => {
        if (msg.type !== "TYPE_PROMPT_RESULT") return;
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        resolve({
          ok: Boolean(msg.ok),
          reason: msg.reason || "",
          step: msg.step || "",
          // KAN-182: response count from BEFORE the send, carried into the
          // collect step so it can demand an answer newer than the request.
          responsesBefore: Number.isFinite(msg.responsesBefore) ? msg.responsesBefore : null
        });
      });

      try {
        this.activeSocket.send(JSON.stringify({
          type: "TYPE_PROMPT",
          requestId,
          prompt,
          timeoutMs: Math.min(timeoutMs - 5000, 40000)
        }));
      } catch (err) {
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        resolve({ ok: false, reason: "type_prompt_send_failed", step: "send" });
      }
    });
  }

  /**
   * Read the answer back out of the page after a typed prompt (KAN-182).
   *
   * Once the prompt is submitted through Gemini's own input box, the PAGE
   * streams the answer and the bridge is not on the wire for it, so there is
   * no chunk stream to read. The extension polls the rendered
   * `model-response` instead.
   *
   * Resolves {ok:false} rather than throwing, so the caller keeps whatever
   * text it already has instead of losing everything to a collection error.
   */
  collectTypedAnswer({ requestId, timeoutMs = 120000, responsesBefore = null }) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.activeStreams.delete(requestId);
        resolve({ ok: false, reason: "collect_answer_timeout", text: "" });
      }, timeoutMs);

      this.activeStreams.set(requestId, (msg) => {
        if (msg.type !== "COLLECT_ANSWER_RESULT") return;
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        resolve({
          ok: Boolean(msg.ok),
          reason: msg.reason || "",
          text: typeof msg.text === "string" ? msg.text : "",
          // KAN-182: how many responses the page held when the wait ended.
          // Carried so `no_new_response_rendered` can say "still N" instead of
          // leaving the operator to guess whether a reply was ever produced.
          responses: Number(msg.responses) || 0
        });
      });

      try {
        this.activeSocket.send(JSON.stringify({
          type: "COLLECT_ANSWER",
          requestId,
          timeoutMs: Math.max(timeoutMs - 5000, 10000),
          // KAN-182: the pre-send baseline. Without it the extension snapshots
          // on arrival, which can already include the answer being waited for.
          responsesBefore
        }));
      } catch (err) {
        clearTimeout(timer);
        this.activeStreams.delete(requestId);
        resolve({ ok: false, reason: "collect_answer_send_failed", text: "" });
      }
    });
  }

  /**
   * A single replay attempt through the extension's verified-replay path.
   */
  runReplayAttempt({ requestId, encodedReq, model, onChunk }) {
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

      // Gemini re-sends the CUMULATIVE text on each update, so a decoded
      // update REPLACES the accumulator instead of appending to it. Only
      // accept the replacement when it is at least as complete as what we
      // already hold. A shorter/divergent update means Gemini emitted a side
      // entry (LMDX component block, the trailing
      // googleusercontent.com/lmdx_content link, a re-render) and blindly
      // replacing truncates long answers — this is what made
      // orchestrate_sdlc_plan return link-only or empty text.
      const adoptText = (candidate) => {
        if (!candidate) return false;
        if (candidate.length < fullText.length && !candidate.startsWith(fullText)) return false;
        if (candidate === fullText) return false;
        fullText = candidate;
        return true;
      };

      this.activeStreams.set(requestId, (msg) => {
        if (msg.type === "STREAM_CHUNK" && msg.chunk) {
          rpcBuffer += msg.chunk;
          // Decode complete RPC lines only; network chunks have arbitrary boundaries.
          const boundary = rpcBuffer.lastIndexOf("\n");
          if (boundary >= 0) {
            const { deltaText } = ProtocolDecoder.decodeChunk(rpcBuffer.slice(0, boundary + 1));
            rpcBuffer = rpcBuffer.slice(boundary + 1);
            if (adoptText(deltaText)) {
              bumpIdle();
              // Surface the cumulative text immediately so callers can stream
              // deltas to clients.
              try { Promise.resolve(onChunk?.(fullText)).catch(() => {}); } catch (e) {}
            }
          }
        } else if (msg.type === "STREAM_DONE") {
          cleanup();
          this.activeStreams.delete(requestId);
          const { deltaText } = ProtocolDecoder.decodeChunk(rpcBuffer);
          adoptText(deltaText);
          this.recordHealthSuccess();
          Promise.resolve().then(() => onChunk?.(fullText, fullText)).then(() => resolve(fullText), reject);
        } else if (msg.type === "STREAM_ERROR") {
          cleanup();
          this.activeStreams.delete(requestId);
          this.recordHealthError(msg.error || "Execution error in extension");
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
    // Bracket the whole generation so scheduleAlarm() keeps the fast interval
    // while a request is being produced, and drops to the idle interval the
    // moment it finishes. The finally block guarantees the flag is cleared on
    // throw as well as on success.
    this._generationInFlight = true;
    this.scheduleAlarm("generation-start");
    try { return await this.handleRequest(request); }
    finally {
      this._generationInFlight = false;
      this.scheduleAlarm("generation-end");
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

    const BRIDGE_SECRET = this.env.BRIDGE_SECRET;
    const CLIENT_API_KEY = this.env.CLIENT_API_KEY;

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
        vlog(`[Bridge DO] Instance ${instanceId} reconnecting — replacing existing connection (epoch ${existingConnection.epoch}).`);
        // Close old connection for this instance
        try { existingConnection.socket.close(1000, "Replaced by reconnect"); } catch (e) {}
        this.activeConnections.delete(instanceId);
      }

      // Check for unresponsive connections from OTHER instance IDs.
      // A connection from a different instanceId is only allowed in if the
      // existing one failed to answer our keepalive — a connection that answers
      // the PING is healthy even when it has been quiet past the stale threshold.
      // See src/liveness.js for why raw idle time was the wrong criterion.
      let staleConnectionEvicted = false;
      const now = Date.now();
      for (const [otherId, state] of this.activeConnections.entries()) {
        if (otherId === instanceId) continue;
        if (isEvictable(state, now, { staleAfterMs: this.STALE_CONNECTION_TIMEOUT_MS })) {
          vlog(`[Bridge DO] Evicting unresponsive connection for instance ${otherId} to allow new instance ${instanceId}.`);
          try { state.socket.close(1000, "Stale connection evicted"); } catch (e) {}
          this.activeConnections.delete(otherId);
          staleConnectionEvicted = true;
        }
      }

      // If there's still an active connection from a different instanceId and it
      // is responsive, reject the new connection (protect the healthy session
      // from being hijacked).
      if (this.activeConnections.size > 0) {
        for (const [otherId, state] of this.activeConnections.entries()) {
          if (otherId === instanceId) continue;
          const idleTime = Date.now() - state.lastActivityAt;
          console.warn(`[Bridge DO] Rejected connection from instance ${instanceId}: responsive connection exists for instance ${otherId} (idle ${Math.round(idleTime/1000)}s).`);
          return new Response("Conflict: Another instance is currently active and healthy", { status: 409, headers: corsHeaders });
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

      vlog(`[Bridge DO] Chrome Extension connected via WebSocket. Instance: ${instanceId}, Epoch: ${connectionState.epoch}`);

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
            vlog(`[Bridge DO] Synced from Web: Model=${this.activeBrowserModel}, Thinking=${this.extendedThinkingActive}, DiscoveredCount=${this.dynamicModels ? this.dynamicModels.length : 0}`);
          } else if (msg.type === "MODEL_UPDATED") {
            if (msg.activeModel) this.activeBrowserModel = msg.activeModel;
            if (msg.extendedThinking !== undefined) this.extendedThinkingActive = msg.extendedThinking;
            vlog(`[Bridge DO] Model Updated from UI: Model=${this.activeBrowserModel}, Thinking=${this.extendedThinkingActive}`);
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
              vlog(`[Bridge DO] Scope confirmed: ${msg.scope} (requestId: ${msg.requestId || 'N/A'})`);
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
          vlog(`[Bridge DO] Ignoring close of replaced socket for instance ${instanceId} (a newer connection owns the slot).`);
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
        // stale window elapses).
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
    // broken without waiting for the stale-connection TTL.
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
      vlog(`[Bridge DO] Admin reset: evicted ${evicted.length} connection(s): ${evicted.join(", ")}`);
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

      // Validate request shape BEFORE the extension-readiness gate below.
      //
      // A malformed request is malformed regardless of whether a browser
      // happens to be attached, so the answer must not depend on it. Checking
      // this afterwards meant an empty `messages` array from a client with no
      // extension attached sat in waitForExtension() for the full 12s grace
      // window and then came back 503 "Chrome Extension is not connected" —
      // sending the caller to debug their browser instead of their payload,
      // and holding a slot in the wait queue for a request that could never
      // succeed. It also meant this validation was untestable without a live
      // browser, because the 400 it returns was unreachable whenever the
      // extension was absent.
      if (!body || !Array.isArray(body.messages) || !body.messages.length) {
        return new Response(JSON.stringify({ error: { message: "messages must be a non-empty array", type: "invalid_request_error" } }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
        if (policy?.error) {
          return new Response(JSON.stringify({ error: { message: policy.error, type: "invalid_request_error" } }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
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
            scope: { type: "string", description: "ขอบเขตการสนทนา: \"app\", \"app:<conversationId>\", \"notebook:<notebookId>\" หรือ URL ของ gemini.google.com — ถ้าไม่ระบุ ระบบจะใช้ค่าเริ่มต้นคือ App (https://gemini.google.com/app)" }
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
            problem_description: { type: "string", description: "Alias ของ feature_or_goal (รองรับ client ที่ใช้ชื่อตามเอกสาร README/HANDOFF เดิม) — ต้องระบุอย่างน้อยหนึ่งค่า" },
            current_stage: { type: "string", description: "ขั้นตอนปัจจุบัน เช่น Planning, Architecture, Testing" },
            scope: { type: "string", description: "ขอบเขตการสนทนา: \"app\", \"app:<conversationId>\", \"notebook:<notebookId>\" หรือ URL ของ gemini.google.com — ถ้าไม่ระบุ ระบบจะใช้ค่าเริ่มต้นคือ App (https://gemini.google.com/app)" }
          },
          required: []
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
            scope: { type: "string", description: "ขอบเขตการสนทนา: \"app\", \"app:<conversationId>\", \"notebook:<notebookId>\" หรือ URL ของ gemini.google.com — ถ้าไม่ระบุ ระบบจะใช้ค่าเริ่มต้นคือ App (https://gemini.google.com/app)" }
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
            scope: { type: "string", description: "ขอบเขตการสนทนา: \"app\", \"app:<conversationId>\", \"notebook:<notebookId>\" หรือ URL ของ gemini.google.com — ถ้าไม่ระบุ ระบบจะใช้ค่าเริ่มต้นคือ App (https://gemini.google.com/app)" }
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
            scope: { type: "string", description: "\"app\", \"app:<conversationId>\", \"notebook:<notebookId>\" หรือ URL ของ gemini.google.com — ถ้าไม่ระบุ ระบบจะใช้ค่าเริ่มต้นคือ App (https://gemini.google.com/app) ส่วน horo_consult เท่านั้น ที่จะแนบ Notebook ความรู้ HoroConsultant (notebook:b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0) เข้ากับบทสนทนาที่เปิดอยู่ โดยไม่เปลี่ยน URL (ผลลัพธ์จะรายงาน notebookGrounding และ bridgeScope.attachedInPlace=true)" }
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
          // Stamp on real traffic too: this is the write the keepalive
          // throttle in alarm() is skipping, so without it a session that
          // is actively streaming would still be pinged 30s later.
          sess.lastWriteAt = Date.now();
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
      this.mcpSessions.set(sessionId, { writer, encoder, lastWriteAt: Date.now() });

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
              serverInfo: { name: "gemini-web-bridge-cloud-hub", version: WORKER_VERSION }
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

        // ─── horo_consult grounding constants ──────────────────────────────
        // Declared here, before every tool branch, because check_bridge_health
        // reports them too. Declaring them further down left them in the
        // temporal dead zone for any tool that ran first.
        //
        // The notebook's canonical scope id, used to report the scope that
        // served a horo_consult answer.
        const HORO_CONSULT_DEFAULT_SCOPE = "notebook:b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0";

        // KAN-177: the notebook's DISPLAY NAME, used by the attach flow.
        //
        // The attach dialog (`+ > more uploads > Notebooks > เพิ่ม Notebook`)
        // lists notebooks by name and exposes no id, so the name is the only
        // key available there. It is matched exactly, never by list position:
        // this account has six notebooks and the target is not always first.
        // The id above stays the canonical scope identifier reported to
        // callers; the two are deliberately separate concerns.
        const HORO_CONSULT_NOTEBOOK_NAME = "Horo";

        if (method === "tools/call") {
          const toolName = params.name;
          const args = params.arguments || {};

          if (toolName === "ping") {
            const extStatus = this.isExtensionReady() ? "ONLINE (Session Ready)" : "DISCONNECTED (Please open gemini.google.com in Chrome)";
            const gcpStatus = this.env.GEMINI_API_KEY ? "CONFIGURED (Hybrid Active)" : "DISABLED";
            const pongText = `Pong! Cloud Hub v${WORKER_VERSION} is running.\n• Conversation Scope: ${this.currentScope || "app (default)"}\n• Active Browser Model: ${this.activeBrowserModel || "None"} (Extended Thinking: ${this.extendedThinkingActive ? "ON" : "OFF"})\n• Chrome Extension Bridge: ${extStatus}\n• GCP Fallback: ${gcpStatus}\n• Consecutive Errors: ${this.healthState.consecutiveErrors}`;
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
              },
              // KAN-177: notebook grounding state.
              //
              // The attach only happens inside a horo_consult call, so
              // without a record of it there is no way to tell "never
              // asked" from "asked and failed" without spending a Gemini
              // round-trip — which is exactly what a health check must not
              // do. lastAttach is written by the attach path; nothing here
              // polls the browser, so this stays free.
              notebook: {
                target_name: HORO_CONSULT_NOTEBOOK_NAME,
                target_scope: HORO_CONSULT_DEFAULT_SCOPE,
                // "unknown" until the first horo_consult attach runs, so an
                // operator is never told grounding is fine on the strength
                // of no evidence at all.
                last_attach_status: this.notebookAttachState.status,
                last_attach_at: this.notebookAttachState.at,
                last_attach_reason: this.notebookAttachState.reason,
                attach_failures: this.notebookAttachState.failures,

                // KAN-182. Grounding is the number that matters: an attach can
                // succeed while the answer that follows is ungrounded, because
                // the attachment is consumed per message. Reading only
                // `last_attach_status` would call that healthy.
                last_grounding_status: this.notebookAttachState.groundingStatus,
                last_grounding_at: this.notebookAttachState.groundingAt,
                last_grounding_reason: this.notebookAttachState.groundingReason
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
        // `scope` is declared required in the inputSchema. Enforce it here:
        // applyScope() treats a falsy scope as "keep the current scope" and
        // returns ok:true, so a call with a missing/blank argument used to
        // report "Bridge is now scoped to '<current>'" while changing
        // nothing — a silent no-op the caller cannot detect. A typo'd
        // argument name must be a loud -32602, not a fake success.
        if (typeof args.scope !== "string" || !args.scope.trim()) {
          return {
            response: {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: `Missing required argument 'scope' for tool '${toolName}'.` }
            }
          };
        }
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

          // Argument normalization. README.md/HANDOFF.md documented
          // `problem_description` for all four SDLC tools, while the tool
          // schemas use per-tool names (orchestrate_sdlc_plan requires
          // `feature_or_goal`). Clients built from the docs therefore sent an
          // argument the worker never read and the prompt silently became
          // "Goal: undefined". Accept the documented aliases and fail loudly
          // when the required argument is genuinely missing.
          const firstString = (...values) => {
            for (const value of values) {
              if (typeof value === "string" && value.trim()) return value;
            }
            return undefined;
          };
          const problemText = firstString(args.problem_description, args.feature_or_goal, args.goal, args.description);

          const missingArg = (argName) => ({
            response: {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: `Missing required argument '${argName}' for tool '${toolName}'.` }
            }
          });

          let prompt = "";
          if (toolName === "sdlc_solution_architect") {
            if (!problemText) return missingArg("problem_description");
            prompt = buildToolPrompt(toolName, args);
          } else if (toolName === "orchestrate_sdlc_plan") {
            if (!problemText) return missingArg("feature_or_goal");
            prompt = buildToolPrompt(toolName, args);
          } else if (toolName === "code_review_and_debug") {
            const snippet = firstString(args.code_snippet, args.problem_description);
            if (!snippet) return missingArg("code_snippet");
            prompt = buildToolPrompt(toolName, args);
          } else if (toolName === "evaluate_tech_tradeoffs") {
            if (!firstString(args.decision_context, args.problem_description)) return missingArg("decision_context");
            prompt = buildToolPrompt(toolName, args);
          } else if (toolName === "horo_consult") {
            // `query` is declared required in the inputSchema. Check it before
            // anything expensive happens: without this the prompt was built
            // with "User Question: undefined" and the worker still switched the
            // session to the HoroConsultant Notebook and spent a full Gemini
            // round-trip, only to surface an upstream -32000 ("Active Gemini
            // session is not ready") that points the caller at their browser
            // instead of at the missing payload field.
            if (!firstString(args.query)) return missingArg("query");
            prompt = buildToolPrompt(toolName, args);
          }

          // KAN-177 — horo_consult grounds its answer in the HoroConsultant
          // notebook, but it must NOT navigate to /notebook/<id>: that page
          // is not a chat surface, so the query is re-issued into a fresh
          // /app/<new-id> conversation and the scope the bridge resolved is
          // gone before the answer arrives. Instead the notebook is attached
          // to the conversation already open, which preserves the URL, the
          // conversation, and the scope.
          //
          // An explicit `scope` argument still wins and still means a real
          // scope switch — this only replaces the implicit default.
          const wantsDefaultNotebook =
            toolName === "horo_consult" && !(typeof args.scope === "string" && args.scope.trim());

          // Switch conversation scope (normal chat / notebook) before executing.
          const effectiveScope = wantsDefaultNotebook ? null : args.scope;

          // horo_consult pins the bridge to a Notebook scope, so remember where
          // the session came from and put it back once the call is done.
          // Without this, one unscoped horo_consult call silently re-scopes
          // every following unscoped tool call onto the Notebook.
          const scopeBeforeCall = this.currentScope;
          let scopeUsed = scopeBeforeCall;
          let switchedScope = false;

          // KAN-177: what the notebook attach actually did, reported back to
          // the MCP client. Stays null for every tool except a
          // default-scoped horo_consult, so other results are unchanged.
          let notebookGrounding = null;

          const restorePreCallScope = async () => {
            // Nothing to restore to (fresh session that never had a scope) or
            // no switch happened (caller passed an explicit scope equal to
            // the current one, or the tool inherited the current scope).
            if (!switchedScope || !scopeBeforeCall) return;
            try {
              const restored = await applyScope(scopeBeforeCall);
              if (!restored.ok) {
                console.warn(`[Bridge DO] Scope restore to '${scopeBeforeCall}' failed: ${restored.message}`);
              }
            } catch (restoreErr) {
              console.warn(`[Bridge DO] Scope restore to '${scopeBeforeCall}' threw: ${restoreErr.message}`);
            }
          };

          if (effectiveScope) {
            let scopeOutcome;
            try {
              scopeOutcome = await applyScope(effectiveScope);
            } catch (scopeErr) {
              scopeOutcome = { ok: false, message: scopeErr.message };
            }
            // applyScope can navigate and still report a fail-closed error, so
            // derive "did we move?" from session state rather than from ok.
            switchedScope = this.currentScope !== scopeBeforeCall;
            scopeUsed = this.currentScope || scopeBeforeCall;
            if (!scopeOutcome.ok) {
              // If the bridge is disconnected, fall through to the standard
              // extension-disconnected fail-fast branch below instead of
              // masking it with a scope error.
              if (this.isExtensionReady()) {
                await restorePreCallScope();
                return { response: { jsonrpc: "2.0", id, error: { code: -32602, message: scopeOutcome.message } } };
              }
            }
          }

          // Run the tool inside the prepared scope, then always put the session
          // back on the scope it was on before this call. Wrapping the whole
          // execution in a single inner function guarantees the restore also
          // happens on the early-return, GCP-fallback and error paths.
          const runInPreparedScope = async () => {
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
              // KAN-177: attach the HoroConsultant notebook to this
              // conversation before asking, so the answer is grounded in
              // it. The attach is idempotent on the extension side, so a
              // repeat call costs nothing.
              //
              // A failed attach is reported rather than swallowed: an
              // ungrounded BaZi answer that looks grounded is worse than
              // an honest error, because the caller cannot tell the two
              // apart from the text alone.
              if (wantsDefaultNotebook) {
                const attach = await this.runNotebookAttach({
                  requestId: `${id}:notebook-attach`,
                  notebookName: HORO_CONSULT_NOTEBOOK_NAME
                });
                notebookGrounding = {
                  requested: HORO_CONSULT_NOTEBOOK_NAME,
                  attached: attach.ok,
                  attachedNames: attach.attached,
                  step: attach.step || null,
                  reason: attach.reason || null,
                  // KAN-182: `verified` is decided AFTER the answer
                  // streams, from the citations in that answer. Until
                  // then an attach is only a UI success, so it is left
                  // explicitly unknown rather than reported as grounded.
                  verified: null,
                  verifiedReason: null
                };
                // KAN-177: record the outcome so check_bridge_health can
                // answer "is notebook grounding working?" without spending a
                // Gemini round-trip to find out. A failure is recorded even
                // though the call then returns an error — that is precisely
                // the case an operator needs to see.
                this.notebookAttachState = {
                  // Spread first: this assignment used to replace the whole
                  // object, which would silently reset KAN-182's grounding
                  // fields to undefined on every attach.
                  ...this.notebookAttachState,
                  status: attach.ok ? "ok" : "failed",
                  at: new Date().toISOString(),
                  reason: attach.ok ? null : (attach.reason || attach.step || "unknown"),
                  failures: attach.ok
                    ? this.notebookAttachState.failures
                    : this.notebookAttachState.failures + 1
                };
                if (!attach.ok) {
                  this.recordHealthError(`notebook_attach_failed:${attach.reason}@${attach.step}`);
                  console.warn(`[Bridge DO] Notebook attach failed: ${attach.reason} (step=${attach.step})`);
                  return {
                    response: {
                      jsonrpc: "2.0",
                      id,
                      error: {
                        code: -32000,
                        message:
                          `Could not attach the HoroConsultant notebook "${HORO_CONSULT_NOTEBOOK_NAME}" ` +
                          `to the Gemini tab (step=${attach.step || "unknown"}, reason=${attach.reason || "unknown"}). ` +
                          `horo_consult answers must be grounded in that notebook, so it will not answer ungrounded. ` +
                          `Make sure the Gemini tab is in the foreground and open, then retry.`
                      }
                    }
                  };
                }
              }

              const targetModel = recommendedModel(this.dynamicModels) || this.activeBrowserModel || (this.dynamicModels[0]?.id) || "gemini-3.8-flash";
              // KAN-182: a notebook-grounded answer must come from the page, so
              // replay is skipped for it — see `requireGrounding`. Attempting
              // replay first would spend the attach and still return an
              // ungrounded answer.
              let resultText = await this.executeThroughExtension(
                [{ role: "user", content: prompt }],
                null,
                targetModel,
                { requireGrounding: Boolean(notebookGrounding) }
              );

              // Never hand an empty/blank answer back to the MCP client. Gemini
              // answers that are entirely LMDX components or an empty model
              // reply decode to "" and previously surfaced as a successful but
              // contentless tool result, which is indistinguishable from a
              // broken bridge to the caller. The private lmdx_content link is
              // stripped here too so this guard holds for any text source.
              const usableText = ProtocolDecoder._stripPrivateLink(resultText);
              if (!usableText) {
                this.recordHealthError(`Empty model response for tool '${toolName}'`);
                console.warn(`[Bridge DO] Empty model response for tool '${toolName}' — returning error instead of blank content.`);
                if (this.env.GEMINI_API_KEY) {
                  try {
                    const gcpResult = await this.callGcpGemini([{ role: "user", content: prompt }]);
                    return {
                      response: {
                        jsonrpc: "2.0",
                        id,
                        result: { content: [{ type: "text", text: `[Provider: GCP Gemini Fallback]\n\n${gcpResult}` }] }
                      }
                    };
                  } catch (gcpErr) {
                    console.warn(`[Bridge DO] GCP fallback after empty response failed: ${gcpErr.message}`);
                  }
                }
                return {
                  response: {
                    jsonrpc: "2.0",
                    id,
                    error: {
                      code: -32000,
                      message: `Empty model response from Gemini Web for tool '${toolName}'. The browser session returned no decodable text; retry or re-open the Gemini tab.`
                    }
                  }
                };
              }
              resultText = usableText;

              // KAN-182: now that the answer exists, check whether it is
              // actually grounded. This cannot be skipped for a default-scoped
              // horo_consult, because "the chip was accepted" and "this answer
              // came from the notebook" are different claims: the attachment is
              // consumed per message, so a call that reused a stale chip sends a
              // request with no notebook reference and gets a fluent,
              // ungrounded answer that the caller cannot detect from the text.
              if (notebookGrounding && notebookGrounding.attached) {
                const grounding = await this.verifyNotebookGrounding({
                  requestId: `${id}:grounding`
                });
                notebookGrounding.verified = Boolean(grounding.verified);
                notebookGrounding.verifiedReason = grounding.reason || null;
                notebookGrounding.citationCount = grounding.chipCount;
                notebookGrounding.citeMarkers = grounding.citeMarkers;
                notebookGrounding.citedSources = grounding.sources;

                // KAN-177 recorded the attach outcome; the grounding outcome is
                // the one that actually decides answer quality, so health
                // tracks it separately rather than inheriting the attach's "ok".
                this.notebookAttachState = {
                  ...this.notebookAttachState,
                  groundingStatus: grounding.verified ? "grounded" : "ungrounded",
                  groundingAt: new Date().toISOString(),
                  groundingReason: grounding.verified ? null : (grounding.reason || "unknown")
                };

                if (!grounding.verified) {
                  this.recordHealthError(`notebook_grounding_unverified:${grounding.reason}`);
                  console.warn(
                    `[Bridge DO] Answer for '${toolName}' carries no notebook citations ` +
                    `(reason=${grounding.reason}); refusing to return it as a grounded horo_consult answer.`
                  );
                  return {
                    response: {
                      jsonrpc: "2.0",
                      id,
                      error: {
                        code: -32000,
                        message:
                          `horo_consult attached the "${HORO_CONSULT_NOTEBOOK_NAME}" notebook, but the answer ` +
                          `came back with no citations from it (reason=${grounding.reason || "unknown"}). ` +
                          `That means the question was answered from general knowledge rather than the notebook, ` +
                          `and horo_consult will not present that as a grounded reading. ` +
                          `Start a fresh conversation and retry — the attachment is consumed per message, so a ` +
                          `conversation that has already used the notebook cannot ground the next question in it.`
                      }
                    }
                  };
                }
              }

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
          };

          let outcome;
          try {
            outcome = await runInPreparedScope();
          } finally {
            await restorePreCallScope();
          }

          // Report the scope that actually served the answer (and where the
          // session ended up) so MCP clients can see the horo_consult
          // Notebook default without having to read the bridge source.
          const resultScope = outcome?.response?.result;
          if (resultScope && Array.isArray(resultScope.content)) {
            // KAN-177: for a default-scoped horo_consult the notebook is
            // ATTACHED to the conversation, not navigated to, so the live
            // tab scope is still whatever /app/ conversation it was on.
            // Reporting that as `used` would tell the caller the notebook
            // was never involved — the opposite of the truth. The intent
            // scope is reported instead, and `browserUrl` carries the real
            // one for anyone debugging.
            const reportedScope = wantsDefaultNotebook
              ? HORO_CONSULT_DEFAULT_SCOPE
              : (scopeUsed || null);
            resultScope.bridgeScope = {
              used: reportedScope,
              active: this.currentScope || null,
              restored: switchedScope
            };
            if (wantsDefaultNotebook) {
              resultScope.bridgeScope.attachedInPlace = true;
            }
          }
          // KAN-177: proof of grounding, so a caller can tell a notebook
          // answer from a general-knowledge one. Only ever set for a
          // successful default-scoped horo_consult.
          if (notebookGrounding) {
            const resultBody = outcome?.response?.result;
            if (resultBody && Array.isArray(resultBody.content)) {
              resultBody.notebookGrounding = notebookGrounding;
            }
          }
          return outcome;
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
        version: WORKER_VERSION,
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