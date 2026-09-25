// ============================================================
// Gemini Web-Bridge: Multiplexed Message Protocol + Scope Router
// Phase 4: Single WebSocket handles all scopes via message routing
// ============================================================

// ─── Scope Session Manager (Extension Side) ─────────────────
/**
 * ScopeSessionManager — Phase 4 multiplexed connection manager (client side).
 *
 * Responsibilities:
 *  1. Singleton awareness: it does NOT own the WebSocket; it is given a write
 *     callback (`sendFn`) by BridgeSocketManager so it can emit protocol messages
 *     over the single shared connection.
 *  2. Scope registry: scopes (app, notebook, and future kinds) register/unregister
 *     themselves with the manager. Registration binds a scope id to a handler
 *     object that receives routed messages and subscribe/unsubscribe events.
 *  3. Message routing: incoming messages that carry an envelope `scope` / `scope_id`
 *     are dispatched to the matching registered scope handler. Messages without a
 *     scope fall through to the default handler (usually the active-tab forwarder).
 *  4. Subscribe / unsubscribe: scopes can express interest in message types; the
 *     manager tracks interest per scope and emits SUBSCRIBE_CONFIRMED /
 *     UNSUBSCRIBED notifications through the same sendFn when the server acknowledges
 *     (server-side acknowledgement is out of scope for the client manager; here we
 *     model the client intent and local state, and bridge-layer code maps it to
 *     wire messages).
 *
 * Design notes:
 *  - Tii/Fk are model capabilities, NOT scopes. They are delivered through
 *    MODEL_UPDATED / MODELS_DISCOVERED and are orthogonal to this manager.
 *  - The manager is scope-agnostic: adding a new Gemini page type only requires
 *    registering a scope handler, never touching routing code.
 *  - The manager is deliberately decoupled from BridgeSocketManager; it only
 *    depends on `sendFn` and optionally a `nowFn` for testability.
 */
export class ScopeSessionManager {
  /**
   * @param {Object} [options]
   * @param {Function} [options.sendFn]  Called as sendFn(messageObject) to emit
   *   protocol messages over the shared WebSocket. Required for subscribe/unsubscribe
   *   and scope-ready notifications to have effect; the manager still works locally
   *   without it but those operations become no-ops.
   * @param {Function} [options.nowFn]  Optional override for Date.now (testing).
   */
  constructor(options = {}) {
    this._sendFn = options.sendFn || null;
    this._nowFn = options.nowFn || (() => Date.now());

    // Canonical current scope (validated). Starts at the generic app scope.
    this.currentScope = 'app';

    // Pending scope switch, if any.
    this.targetScope = null;
    this.scopeSwitching = false;
    this.lastScopeChangeAt = this._nowFn();

    // Scope registry: scopeId (canonical, validated) -> ScopeHandler instance.
    this._scopes = new Map();

    // Per-scope subscription interest: scopeId -> Set<messageType>.
    this._subscriptions = new Map();

    // Scope switch request callbacks: requestId -> {callback, data}.
    this._scopeListeners = new Map();

    // Default handler for messages that carry no scope or don't match a
    // registered scope. Usually the BridgeSocketManager's forward-to-active-tab
    // logic is plugged in here.
    this._defaultHandler = null;
  }

  // ── Current-state queries ──────────────────────────────────────────

  /** @returns {string} Current active scope (canonical, validated). */
  getCurrentScope() {
    return this.currentScope;
  }

  /** @returns {boolean} Whether a scope switch is in flight. */
  isSwitching() {
    return this.scopeSwitching;
  }

  /** @returns {string|null} Pending target scope, or null. */
  getTargetScope() {
    return this.targetScope;
  }

  /**
   * @returns {Array<{scope: string, handler: ScopeHandler, subscribedTypes: Array<string>}>}
   *   Snapshot of registered scopes for debugging / diagnostics.
   */
  getRegisteredScopes() {
    const out = [];
    for (const [scopeId, handler] of this._scopes.entries()) {
      out.push({
        scope: scopeId,
        handler: handler,
        subscribedTypes: Array.from(this._subscriptions.get(scopeId) || []),
      });
    }
    return out;
  }

  /**
   * @returns {Object} Diagnostic snapshot (current + pending + switching + listeners).
   */
  getScopeInfo() {
    return {
      currentScope: this.currentScope,
      targetScope: this.targetScope,
      isSwitching: this.scopeSwitching,
      lastScopeChangeAt: this.lastScopeChangeAt,
      timeInCurrentScope: this._nowFn() - this.lastScopeChangeAt,
      registeredScopes: this.getRegisteredScopes(),
      pendingListeners: this._scopeListeners.size,
    };
  }

  // ── Scope lifecycle: register / unregister ────────────────────────

  /**
   * Register a scope handler with the multiplexed connection.
   *
   * @param {string} scopeId  Canonical validated scope (e.g. "app" or "notebook:abc").
   * @param {ScopeHandler} handler  Object with optional hooks:
   *   - onMessage(msg, scopeId): receives routed incoming messages for this scope.
   *   - onSubscribe(msgType, scopeId): called when the scope is subscribed to a type.
   *   - onUnsubscribe(msgType, scopeId): called when the scope is unsubscribed.
   *   - onScopeActivate(scopeId, previousScope): called when this scope becomes current.
   *   - onScopeDeactivate(scopeId, newScope): called when this scope is no longer current.
   * @returns {boolean} true when registered; false when scopeId is invalid or already
   *   registered (idempotency: re-registering the same scope returns false).
   */
  registerScope(scopeId, handler) {
    const validated = validateScope(scopeId);
    if (!validated) {
      console.warn('[ScopeSessionManager] registerScope: invalid scope:', scopeId);
      return false;
    }
    if (this._scopes.has(validated)) {
      console.warn('[ScopeSessionManager] registerScope: scope already registered:', validated);
      return false;
    }
    this._scopes.set(validated, handler);
    if (!this._subscriptions.has(validated)) {
      this._subscriptions.set(validated, new Set());
    }
    console.log(`[ScopeSessionManager] Registered scope: ${validated}`);
    return true;
  }

  /**
   * Unregister a previously registered scope.
   * If the scope is the current scope, the manager does NOT auto-switch away — the
   * caller is responsible for picking a new scope (usually by initiating a SCOPE_SWITCH).
   *
   * @param {string} scopeId
   * @returns {boolean} true when unregistered; false when not found or invalid.
   */
  unregisterScope(scopeId) {
    const validated = validateScope(scopeId);
    if (!validated || !this._scopes.has(validated)) {
      return false;
    }
    this._scopes.delete(validated);
    this._subscriptions.delete(validated);
    console.log(`[ScopeSessionManager] Unregistered scope: ${validated}`);
    return true;
  }

  /**
   * Replace the registered handler for an already-registered scope (for hot reloads
   * or evolution of a handler without unregistering).
   *
   * @param {string} scopeId
   * @param {ScopeHandler} handler
   * @returns {boolean} true when replaced; false when not registered or invalid.
   */
  updateScopeHandler(scopeId, handler) {
    const validated = validateScope(scopeId);
    if (!validated || !this._scopes.has(validated)) {
      return false;
    }
    this._scopes.set(validated, handler);
    console.log(`[ScopeSessionManager] Updated handler for scope: ${validated}`);
    return true;
  }

  /**
   * Set the default handler for messages that don't match a registered scope.
   * @param {Function} handler  (msg, scopeId) => void | Promise<void>
   */
  setDefaultHandler(handler) {
    this._defaultHandler = handler;
  }

  // ── Subscription interest (per scope) ─────────────────────────────

  /**
   * Express interest in a message type for a given scope. The manager tracks this
   * locally and, when `sendFn` is available, emits a client→server SUBSCRIBE intent
   * so the server can route matching messages to this WebSocket/scope.
   *
   * @param {string} scopeId
   * @param {string} messageType
   * @returns {boolean} true when interest was (re)registered.
   */
  subscribe(scopeId, messageType) {
    const validated = validateScope(scopeId);
    if (!validated || !this._scopes.has(validated)) {
      console.warn('[ScopeSessionManager] subscribe: scope not registered:', scopeId);
      return false;
    }
    const set = this._subscriptions.get(validated);
    if (!set.has(messageType)) {
      set.add(messageType);
      const handler = this._scopes.get(validated);
      if (handler && typeof handler.onSubscribe === 'function') {
        handler.onSubscribe(messageType, validated);
      }
      this._emitSubscribeIntent(validated, messageType);
      console.log(`[ScopeSessionManager] Subscribed scope ${validated} to ${messageType}`);
    }
    return true;
  }

  /**
   * Revoke interest in a message type for a given scope. When `sendFn` is available,
   * emits an UNSUBSCRIBE intent.
   *
   * @param {string} scopeId
   * @param {string} messageType
   * @returns {boolean} true when interest was removed (or was absent).
   */
  unsubscribe(scopeId, messageType) {
    const validated = validateScope(scopeId);
    if (!validated || !this._scopes.has(validated)) {
      return false;
    }
    const set = this._subscriptions.get(validated);
    if (set.has(messageType)) {
      set.delete(messageType);
      const handler = this._scopes.get(validated);
      if (handler && typeof handler.onUnsubscribe === 'function') {
        handler.onUnsubscribe(messageType, validated);
      }
      this._emitUnsubscribeIntent(validated, messageType);
      console.log(`[ScopeSessionManager] Unsubscribed scope ${validated} from ${messageType}`);
    }
    return true;
  }

  /**
   * Convenience: subscribe a scope to a batch of message types.
   * @param {string} scopeId
   * @param {Array<string>} messageTypes
   */
  subscribeBatch(scopeId, messageTypes) {
    for (const t of messageTypes) {
      this.subscribe(scopeId, t);
    }
  }

  /**
   * Return the set of message types the given scope is currently interested in.
   * @param {string} scopeId
   * @returns {Set<string>} (may be empty)
   */
  getSubscriptions(scopeId) {
    const validated = validateScope(scopeId);
    if (!validated) return new Set();
    return new Set(this._subscriptions.get(validated) || []);
  }

  // ── Scope switching (multiplexed, no reconnect) ───────────────────

  /**
   * Initiate a scope switch. Validates the target, marks switching state, notifies
   * the previous/next scope handlers of activation/deactivation, and emits a
   * SCOPE_SWITCH message over the wire when `sendFn` is available.
   *
   * @param {string} targetScope  Desired canonical scope.
   * @param {string} [requestId]  Optional request id for tracking; passed to listeners.
   * @returns {string|null} Validated target scope, or null when invalid / already current.
   */
  requestScopeSwitch(targetScope, requestId) {
    const validated = validateScope(targetScope);
    if (!validated) {
      console.warn('[ScopeSessionManager] requestScopeSwitch: invalid scope:', targetScope);
      return null;
    }
    if (validated === this.currentScope) {
      // Already there — nothing to do, but treat as a success for callers that
      // want a boolean answer.
      return validated;
    }

    const previousScope = this.currentScope;
    this.targetScope = validated;
    this.scopeSwitching = true;

    // Notify handlers of the pending transition.
    const prevHandler = this._scopes.get(previousScope);
    if (prevHandler && typeof prevHandler.onScopeDeactivate === 'function') {
      prevHandler.onScopeDeactivate(previousScope, validated);
    }

    const nextHandler = this._scopes.get(validated);
    if (nextHandler && typeof nextHandler.onScopeActivate === 'function') {
      nextHandler.onScopeActivate(validated, previousScope);
    }

    // Emit the wire message when the bridge is wired in.
    this._emitScopeSwitch(validated, requestId);

    console.log(
      `[ScopeSessionManager] Scope switch requested: ${previousScope} -> ${validated}${requestId ? ` (req: ${requestId})` : ''}`
    );
    return validated;
  }

  /**
   * Confirm that a scope switch completed (called when SCOPE_READY arrives or when
   * the content script reports the actual active scope).
   *
   * @param {string} confirmedScope  The scope that is now actually active.
   * @param {string} [requestId]    If provided, resolves the matching pending listener.
   */
  confirmScope(confirmedScope, requestId) {
    const validated = validateScope(confirmedScope);
    if (!validated) {
      console.warn('[ScopeSessionManager] confirmScope: invalid scope:', confirmedScope);
      return;
    }

    const previousScope = this.currentScope;
    this.currentScope = validated;
    this.targetScope = null;
    this.scopeSwitching = false;
    this.lastScopeChangeAt = this._nowFn();

    // Notify handlers of the completed transition.
    const prevHandler = this._scopes.get(previousScope);
    if (prevHandler && typeof prevHandler.onScopeDeactivate === 'function') {
      prevHandler.onScopeDeactivate(previousScope, validated);
    }
    const nextHandler = this._scopes.get(validated);
    if (nextHandler && typeof nextHandler.onScopeActivate === 'function') {
      nextHandler.onScopeActivate(validated, previousScope);
    }

    // Emit confirmation over the wire when wired in.
    this._emitScopeReady(validated, requestId);

    // Resolve any pending scope-switch listener for this request id.
    this._resolveScopeListener(requestId, validated);

    console.log(
      `[ScopeSessionManager] Scope confirmed: ${previousScope} -> ${validated}${requestId ? ` (req: ${requestId})` : ''}`
    );
  }

  /**
   * Handle an incoming SCOPE_SWITCH message from the server. This is the server
   * asking the extension to move to a different scope. The manager validates the
   * target, updates local switching state, notifies handlers, and (when wired) emits
   * a SCOPE_READY confirmation once the tab navigation completes.
   *
   * @param {Object} msg
   * @param {string} msg.scope      Target scope.
   * @param {string} [msg.requestId]
   * @param {Function} [navigateFn] Optional async function(url, scope) the caller uses
   *   to perform the actual tab navigation. When provided, the manager awaits it before
   *   returning so the caller can chain the subsequent SCOPE_READY flow.
   * @returns {Promise<string|null>} Resolves with the validated target scope, or null
   *   when the target is invalid.
   */
  async handleScopeSwitch(msg, navigateFn) {
    const { scope: targetScope, requestId } = msg;
    const validated = validateScope(targetScope);
    if (!validated) {
      console.warn('[ScopeSessionManager] handleScopeSwitch: invalid scope:', targetScope);
      return null;
    }

    if (validated === this.currentScope) {
      console.log(`[ScopeSessionManager] Already at scope ${validated}, confirming`);
      this._emitScopeReady(validated, requestId);
      this._resolveScopeListener(requestId, validated);
      return validated;
    }

    const previousScope = this.currentScope;
    this.targetScope = validated;
    this.scopeSwitching = true;

    const prevHandler = this._scopes.get(previousScope);
    if (prevHandler && typeof prevHandler.onScopeDeactivate === 'function') {
      prevHandler.onScopeDeactivate(previousScope, validated);
    }
    const nextHandler = this._scopes.get(validated);
    if (nextHandler && typeof nextHandler.onScopeActivate === 'function') {
      nextHandler.onScopeActivate(validated, previousScope);
    }

    this._emitScopeSwitch(validated, requestId);

    if (navigateFn && typeof navigateFn === 'function') {
      const url = scopeToUrl(validated);
      console.log(`[ScopeSessionManager] Navigating to ${url}`);
      await navigateFn(url, validated);
    }

    console.log(
      `[ScopeSessionManager] Handling SCOPE_SWITCH: ${previousScope} -> ${validated}${requestId ? ` (req: ${requestId})` : ''}`
    );
    return validated;
  }

  /**
   * Detect scope from a URL pathname (SPA navigation). When the detected scope differs
   * from the current scope, treat it as an automatic scope switch and confirm it.
   *
   * @param {string} pathname
   * @returns {string} Detected canonical scope.
   */
  detectScopeFromPath(pathname) {
    const detected = scopeFromPath(pathname);
    if (detected !== this.currentScope) {
      console.log(`[ScopeSessionManager] SPA navigation detected: ${this.currentScope} -> ${detected}`);
      this.confirmScope(detected);
    }
    return detected;
  }

  // ── Incoming message routing (by envelope scope_id) ───────────────

  /**
   * Route an incoming message to the correct scope handler based on the envelope's
   * `scope` (or `scope_id`) field. Messages without a scope are handed to the default
   * handler when one is set; otherwise they are ignored (caller can fall back to a
   * legacy path).
   *
   * @param {Object} msg   Incoming protocol message.
   * @returns {Object|null} The handler that received the message (for logging/telemetry),
   *   or null when no handler handled it.
   */
  routeMessage(msg) {
    if (!msg || typeof msg !== 'object') return null;

    const scopeId = msg.scope || msg.scope_id || null;
    if (!scopeId) {
      if (this._defaultHandler) {
        this._defaultHandler(msg, null);
        return { scope: null, handler: this._defaultHandler };
      }
      return null;
    }

    const validated = validateScope(scopeId);
    if (!validated) {
      console.warn('[ScopeSessionManager] routeMessage: invalid scope in envelope:', scopeId);
      return null;
    }

    const handler = this._scopes.get(validated) || this._defaultHandler;
    if (!handler) {
      console.warn('[ScopeSessionManager] routeMessage: no handler for scope:', validated);
      return null;
    }

    if (typeof handler.onMessage === 'function') {
      handler.onMessage(msg, validated);
    } else {
      console.warn(
        `[ScopeSessionManager] routeMessage: handler for ${validated} has no onMessage; dropping ${msg.type}`
      );
    }
    return { scope: validated, handler };
  }

  // ── Pending scope-switch listeners ────────────────────────────────

  /**
   * Register a callback to be invoked when a scope switch completes (SCOPE_READY).
   * @param {string} requestId
   * @param {Function} callback  (confirmedScope) => void
   */
  onScopeReady(requestId, callback) {
    this._scopeListeners.set(requestId, callback);
  }

  /**
   * Remove a pending scope-switch listener.
   * @param {string} requestId
   */
  removeScopeListener(requestId) {
    this._scopeListeners.delete(requestId);
  }

  // ── Wire helpers (no-op when unforced) ────────────────────────────

  /** @returns {Function|null} The currently wired send function, if any. */
  getSendFn() {
    return this._sendFn;
  }

  /**
   * Wire the manager to the shared connection. Call once from BridgeSocketManager
   * after the socket is up (or earlier — messages are queued conceptually by the
   * socket layer; the manager just calls sendFn and trusts the socket layer to
   * deliver or drop).
   *
   * @param {Function} sendFn  (messageObject) => boolean
   */
  setSendFn(sendFn) {
    this._sendFn = sendFn;
  }

  // ── Internal: emit intents over the wire (when wired) ─────────────

  _emitScopeSwitch(scope, requestId) {
    if (!this._sendFn) return;
    try {
      this._sendFn(
        buildScopeSwitchMessage(scope, requestId || `scope_switch_${this._nowFn()}`)
      );
    } catch (e) {
      console.warn('[ScopeSessionManager] Failed to emit SCOPE_SWITCH:', e);
    }
  }

  _emitScopeReady(scope, requestId) {
    if (!this._sendFn) return;
    try {
      this._sendFn(buildScopeReadyMessage(scope, requestId || null));
    } catch (e) {
      console.warn('[ScopeSessionManager] Failed to emit SCOPE_READY:', e);
    }
  }

  _emitSubscribeIntent(scope, messageType) {
    if (!this._sendFn) return;
    try {
      this._sendFn(buildMessage('SUBSCRIBE', { scope, messageType }));
    } catch (e) {
      console.warn('[ScopeSessionManager] Failed to emit SUBSCRIBE intent:', e);
    }
  }

  _emitUnsubscribeIntent(scope, messageType) {
    if (!this._sendFn) return;
    try {
      this._sendFn(buildMessage('UNSUBSCRIBE', { scope, messageType }));
    } catch (e) {
      console.warn('[ScopeSessionManager] Failed to emit UNSUBSCRIBE intent:', e);
    }
  }

  _resolveScopeListener(requestId, confirmedScope) {
    if (!requestId) return;
    const cb = this._scopeListeners.get(requestId);
    if (cb) {
      try {
        cb(confirmedScope);
      } catch (e) {
        console.warn('[ScopeSessionManager] Scope listener error:', e);
      }
      this._scopeListeners.delete(requestId);
    }
  }
}

/**
 * @typedef {Object} ScopeHandler
 * @property {Function} [onMessage]     (msg, scopeId) => void
 * @property {Function} [onSubscribe]   (messageType, scopeId) => void
 * @property {Function} [onUnsubscribe] (messageType, scopeId) => void
 * @property {Function} [onScopeActivate]   (scopeId, previousScope) => void
 * @property {Function} [onScopeDeactivate] (scopeId, newScope) => void
 */

// Message type constant for client→server subscription intents (Phase 4 addition).
/** @type {Object<string,string>} */
export const MessageTypes = Object.freeze({
  // Heartbeat
  PING: 'PING',
  PONG: 'PONG',

  // Scope management (multiplexed protocol — Phase 4)
  SCOPE_SWITCH: 'SCOPE_SWITCH', // server → extension: request to switch scope
  SCOPE_READY: 'SCOPE_READY', // extension → server: scope now active
  SCOPE_NAVIGATE: 'SCOPE_NAVIGATE', // extension → server: request navigation to scope URL
  SUBSCRIBE: 'SUBSCRIBE', // extension → server: register interest in a message type for a scope
  UNSUBSCRIBE: 'UNSUBSCRIBE', // extension → server: revoke interest

  // Session state
  SESSION_READY: 'SESSION_READY',
  SESSION_STATE: 'SESSION_STATE',

  // Model management
  MODELS_DISCOVERED: 'MODELS_DISCOVERED',
  MODEL_READY: 'MODEL_READY',
  MODEL_UPDATED: 'MODEL_UPDATED',

  // Request/Response (JSON-RPC style)
  EXECUTE_REQUEST: 'EXECUTE_REQUEST',
  EXECUTE_RESPONSE: 'EXECUTE_RESPONSE',
  STREAM_CHUNK: 'STREAM_CHUNK',
  STREAM_DONE: 'STREAM_DONE',
  STREAM_ERROR: 'STREAM_ERROR',

  // Preparation
  PREPARE_MODEL: 'PREPARE_MODEL',
  PREPARE_SCOPE: 'PREPARE_SCOPE',

  // Control
  CANCEL_REQUEST: 'CANCEL_REQUEST',
  REFRESH_MODELS: 'REFRESH_MODELS',
  AUTO_SELECT_MODEL: 'AUTO_SELECT_MODEL',
  ENABLE_THINKING: 'ENABLE_THINKING',

  // Scope detection
  REQUEST_SCOPE_DETECTION: 'REQUEST_SCOPE_DETECTION',

  // Extension-to-extension coordination (via background)
  COORDINATOR_STATE: 'COORDINATOR_STATE',
  CLAIM_LEADERSHIP: 'CLAIM_LEADERSHIP',

  // Protocol versioning
  PROTOCOL_INFO: 'PROTOCOL_INFO',
});

/**
 * Scope kinds supported by the protocol.
 * Future scopes (Tii/fk, deepmind, etc.) can be added here.
 * Note: Tii/fk are model capabilities, NOT scopes - they belong in MODEL_UPDATED.
 */
export const ScopeKinds = {
  APP: 'app',
  NOTEBOOK: 'notebook',
  // Future scope types can be registered here
  // TII: 'tii',    // NOT a scope - Tii is a model capability
  // FK: 'fk',      // NOT a scope - fk is a model variant/capability
};

/**
 * Validates a scope string.
 * @param {string|null} scope - The scope to validate
 * @returns {string|null} Canonical scope or null if invalid
 */
export function validateScope(scope) {
  if (!scope) return null;
  const s = String(scope);
  
  // "app" - generic app scope
  if (s === 'app') return 'app';
  
  // "app:<id>" or "notebook:<id>"
  const m = /^(app|notebook):([A-Za-z0-9_-]+)$/.exec(s);
  if (m) return `${m[1]}:${m[2]}`;
  
  return null;
}

/**
 * Maps a pathname to a canonical scope.
 * @param {string} pathname - The URL pathname (e.g., "/app/abc123" or "/notebook/def456")
 * @returns {string} Canonical scope
 */
export function scopeFromPath(pathname) {
  const p = pathname || '';
  let m = /^\/notebook\/([A-Za-z0-9_-]+)/.exec(p);
  if (m) return `notebook:${m[1]}`;
  m = /^\/app\/([A-Za-z0-9_-]+)/.exec(p);
  if (m) return `app:${m[1]}`;
  return 'app';
}

/**
 * Maps a canonical scope to a gemini.google.com URL.
 * @param {string} scope - Canonical scope (e.g., "app:abc123" or "notebook:def456")
 * @returns {string} URL to navigate to
 */
export function scopeToUrl(scope) {
  if (!scope || scope === 'app') return 'https://gemini.google.com/app';
  const [kind, id] = String(scope).split(':');
  if ((kind === 'app' || kind === 'notebook') && id && /^[A-Za-z0-9_-]+$/.test(id)) {
    return `https://gemini.google.com/${kind}/${encodeURIComponent(id)}`;
  }
  return 'https://gemini.google.com/app';
}

// ─── Scope Router (Server Side) ─────────────────────────────
/**
 * Server-side scope router that routes requests by scope in message body.
 * Enables a single WebSocket to handle multiple scopes without reconnect.
 */
export class ScopeRouter {
  constructor(doInstance) {
    this.do = doInstance;  // Reference to the Durable Object instance
    this.scopeHandlers = new Map();  // scope -> handler map
    this.defaultHandler = null;
    this.scopeHistory = new Map();   // scope -> last used timestamp
  }

  /**
   * Register a handler for a specific scope.
   * @param {string} scopePattern - Scope pattern (e.g., "app", "notebook:*", or exact scope)
   * @param {Function} handler - Function to handle requests for this scope
   */
  registerScopeHandler(scopePattern, handler) {
    this.scopeHandlers.set(scopePattern, handler);
    console.log(`[ScopeRouter] Registered handler for scope pattern: ${scopePattern}`);
  }

  /**
   * Set the default handler for scopes without specific handlers.
   * @param {Function} handler
   */
  setDefaultHandler(handler) {
    this.defaultHandler = handler;
  }

  /**
   * Route a request to the appropriate handler based on scope.
   * @param {Object} msg - The message to route
   * @param {string} msg.scope - The scope for this request
   * @param {string} msg.type - Message type
   * @param {string} msg.requestId - Request ID (optional)
   * @returns {Promise<Object>} Result from the handler
   */
  async routeMessage(msg) {
    const { scope, type, requestId } = msg;
    
    if (!scope) {
      // No scope specified, use default handler or current scope
      const currentScope = this.do.currentScope || 'app';
      console.log(`[ScopeRouter] No scope in message ${type}, using current scope: ${currentScope}`);
      return this.routeToScope(currentScope, msg);
    }
    
    // Validate and normalize scope
    const validatedScope = validateScope(scope);
    if (!validatedScope) {
      console.warn(`[ScopeRouter] Invalid scope in message: ${scope}`);
      return {
        success: false,
        error: `Invalid scope: ${scope}`,
        code: 'invalid_scope'
      };
    }
    
    // Update scope history
    this.scopeHistory.set(validatedScope, Date.now());
    
    return this.routeToScope(validatedScope, msg);
  }

  /**
   * Route a message to a specific scope's handler.
   * @param {string} scope - The target scope
   * @param {Object} msg - The message to route
   * @returns {Promise<Object>} Result from the handler
   */
  async routeToScope(scope, msg) {
    const { type, requestId, payload } = msg;
    
    // Try exact match first
    if (this.scopeHandlers.has(scope)) {
      const handler = this.scopeHandlers.get(scope);
      console.log(`[ScopeRouter] Routing ${type} (req: ${requestId || 'N/A'}) to scope ${scope} (exact match)`);
      return handler(msg, scope);
    }
    
    // Try pattern match (e.g., "notebook:*" matches any notebook scope)
    for (const [pattern, handler] of this.scopeHandlers.entries()) {
      if (this.matchScopePattern(scope, pattern)) {
        console.log(`[ScopeRouter] Routing ${type} (req: ${requestId || 'N/A'}) to scope ${scope} (pattern: ${pattern})`);
        return handler(msg, scope);
      }
    }
    
    // Fall back to default handler
    if (this.defaultHandler) {
      console.log(`[ScopeRouter] Routing ${type} (req: ${requestId || 'N/A'}) to scope ${scope} (default handler)`);
      return this.defaultHandler(msg, scope);
    }
    
    // No handler found
    console.warn(`[ScopeRouter] No handler for scope ${scope}, type ${type}`);
    return {
      success: false,
      error: `No handler registered for scope: ${scope}`,
      code: 'no_handler'
    };
  }

  /**
   * Check if a scope matches a pattern.
   * @param {string} scope - The scope to check
   * @param {string} pattern - The pattern to match against
   * @returns {boolean} Whether the scope matches the pattern
   */
  matchScopePattern(scope, pattern) {
    if (pattern === scope) return true;
    
    // Pattern "app" matches "app" and "app:*"
    if (pattern === 'app' && scope.startsWith('app:')) return true;
    
    // Pattern "notebook" matches "notebook" and "notebook:*"
    if (pattern === 'notebook' && scope.startsWith('notebook:')) return true;
    
    // Pattern "notebook:*" matches any notebook scope
    if (pattern === 'notebook:*' && scope.startsWith('notebook:')) return true;
    
    // Pattern "app:*" matches any app scope
    if (pattern === 'app:*' && scope.startsWith('app:')) return true;
    
    // Wildcard matches everything
    if (pattern === '*') return true;
    
    return false;
  }

  /**
   * Get the handler for a specific scope.
   * @param {string} scope - The scope to look up
   * @returns {Function|null} The handler or null if not found
   */
  getHandlerForScope(scope) {
    const validated = validateScope(scope);
    if (!validated) return null;
    
    if (this.scopeHandlers.has(validated)) {
      return this.scopeHandlers.get(validated);
    }
    
    for (const [pattern, handler] of this.scopeHandlers.entries()) {
      if (this.matchScopePattern(validated, pattern)) {
        return handler;
      }
    }
    
    return this.defaultHandler;
  }

  /**
   * Get statistics about scope usage.
   * @returns {Object} Scope statistics
   */
  getScopeStats() {
    const scopes = Array.from(this.scopeHistory.entries());
    return {
      registeredHandlers: Array.from(this.scopeHandlers.keys()),
      hasDefaultHandler: !!this.defaultHandler,
      activeScopes: scopes.map(([scope, lastUsed]) => ({
        scope,
        lastUsedAt: lastUsed,
        idleTimeMs: Date.now() - lastUsed,
      })),
      scopeCount: scopes.length,
    };
  }

  /**
   * Prune scope history entries older than the given age.
   * @param {number} maxAgeMs - Maximum age in milliseconds
   */
  pruneOldScopes(maxAgeMs = 300000) { // 5 minutes default
    const cutoff = Date.now() - maxAgeMs;
    for (const [scope, lastUsed] of this.scopeHistory.entries()) {
      if (lastUsed < cutoff) {
        this.scopeHistory.delete(scope);
      }
    }
  }
}

// ─── Protocol Version ──────────────────────────────────────────
export const PROTOCOL_VERSION = 3; // Multiplexed protocol version (Phase 4)

// ─── Message Builder Helpers ────────────────────────────────
/**
 * Build a standardized protocol message.
 * @param {string} type - Message type
 * @param {Object} [params] - Additional parameters
 * @returns {Object} Standardized message
 */
export function buildMessage(type, params = {}) {
  const message = {
    type,
    protocolVersion: PROTOCOL_VERSION,
    ...params,
  };
  
  // requestId is optional but recommended for request/response messages
  if (params.requestId) {
    message.requestId = params.requestId;
  }
  
  // scope is optional but used for routing
  if (params.scope) {
    message.scope = validateScope(params.scope) || params.scope;
  }
  
  return message;
}

/**
 * Build a SCOPE_SWITCH message (server → extension).
 * @param {string} targetScope - The scope to switch to
 * @param {string} requestId - Unique request ID
 * @returns {Object} SCOPE_SWITCH message
 */
export function buildScopeSwitchMessage(targetScope, requestId) {
  return buildMessage(MessageTypes.SCOPE_SWITCH, {
    requestId,
    scope: targetScope,
    timestamp: Date.now(),
  });
}

/**
 * Build a SCOPE_READY message (extension → server).
 * @param {string} scope - The confirmed scope
 * @param {string} requestId - The request ID being confirmed (optional)
 * @returns {Object} SCOPE_READY message
 */
export function buildScopeReadyMessage(scope, requestId = null) {
  return buildMessage(MessageTypes.SCOPE_READY, {
    scope,
    requestId,
    timestamp: Date.now(),
  });
}

/**
 * Build a SESSION_READY message with scope information (extension → server).
 * @param {Object} params - Session parameters
 * @returns {Object} SESSION_READY message
 */
export function buildSessionReadyMessage(params = {}) {
  return buildMessage(MessageTypes.SESSION_READY, {
    protocolVersion: PROTOCOL_VERSION,
    scope: params.scope || 'app',
    sessionReady: true,
    buildLabel: params.buildLabel || null,
    sessionEpoch: params.sessionEpoch || null,
    models: params.models || [],
    activeModel: params.activeModel || null,
    extendedThinking: params.extendedThinking || false,
    capabilities: params.capabilities || { verifiedRpc: true },
    enforcementMode: params.enforcementMode || 'strict',
    timestamp: Date.now(),
  });
}

/**
 * Build an EXECUTE_REQUEST message with scope routing (server → extension).
 * @param {string} requestId - Unique request ID
 * @param {Object} payload - The execution payload
 * @param {string} scope - Target scope for this execution
 * @returns {Object} EXECUTE_REQUEST message
 */
export function buildExecuteRequestMessage(requestId, payload, scope) {
  return buildMessage(MessageTypes.EXECUTE_REQUEST, {
    requestId,
    payload,
    scope: validateScope(scope) || scope,
  });
}

// ─── Protocol Version Negotiation ────────────────────────────
/**
 * Check if the extension supports the multiplexed protocol (v3).
 * @param {number} protocolVersion - The extension's protocol version
 * @returns {boolean} Whether multiplexed protocol is supported
 */
export function supportsMultiplexedProtocol(protocolVersion) {
  return protocolVersion >= 3;
}

/**
 * Get protocol compatibility info.
 * @returns {Object} Protocol info
 */
export function getProtocolInfo() {
  return {
    version: PROTOCOL_VERSION,
    supportedScopes: ['app', 'app:*', 'notebook', 'notebook:*'],
    messageTypes: Object.values(MessageTypes),
    features: {
      multiplexedProtocol: true,
      scopeSwitchWithoutReconnect: true,
      scopeRouting: true,
      jsonRpcStyle: true,
    },
    note: 'Tii/fk are model capabilities, not scopes. They are reported via MODEL_UPDATED.',
  };
}
