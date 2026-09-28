// ============================================================
// Gemini Web-Bridge: Shared Settings & Diagnostics
// Shared effective settings resolver and backoff utilities
// ============================================================

(function (root) {
  "use strict";

  // ═══ DEFAULTS — injected at build time ═══
  // Secrets/URLs are injected by scripts/build-extension.py at build time.
  // NEVER hardcode real values here — this file is committed and zipped.
  const DEFAULT_BRIDGE_SECRET = "__BRIDGE_SECRET__";
  const DEFAULT_CLIENT_API_KEY = "__CLIENT_API_KEY__";
  const DEFAULT_WORKER_URL = "__WORKER_URL__";
  const DEFAULT_MCP_ENDPOINT = "__MCP_ENDPOINT__";
  const DEFAULT_WSS_ENDPOINT = "__WSS_ENDPOINT__";
  const DEFAULT_OPENAI_ENDPOINT = "__OPENAI_ENDPOINT__";

  const MAX_BACKOFF_DELAY = 30000;
  const INITIAL_BACKOFF_DELAY = 1000;

  /**
   * Resolves effective settings from storage object.
   * Empty bridgeToken = use default from environment.
   * Empty clientApiToken = use default from environment.
   * Default enforcementMode is 'strict'.
   */
  function resolveSettings(stored = {}) {
    const rawUrl = typeof stored.workerUrl === "string" ? stored.workerUrl.trim() : "";
    const workerUrl = rawUrl || DEFAULT_WORKER_URL;

    const rawToken = typeof stored.bridgeToken === "string" ? stored.bridgeToken.trim() : "";
    const bridgeToken = rawToken || DEFAULT_BRIDGE_SECRET;

    const rawClientToken = typeof stored.clientApiToken === "string" ? stored.clientApiToken.trim() : "";
    const clientApiToken = rawClientToken || DEFAULT_CLIENT_API_KEY;

    const enforcementMode = stored.enforcementMode === "permissive" ? "permissive" : "strict";

    return {
      workerUrl,
      bridgeToken,
      clientApiToken,
      rawBridgeToken: rawToken,
      rawClientToken: rawClientToken,
      mcpEndpoint: DEFAULT_MCP_ENDPOINT,
      wssEndpoint: DEFAULT_WSS_ENDPOINT,
      openaiEndpoint: DEFAULT_OPENAI_ENDPOINT,
      enforcementMode,
      isDefaultToken: !rawToken,
      isDefaultClientToken: !rawClientToken
    };
  }

  /**
   * Computes reconnect backoff with full jitter, capped at maxDelay.
   *
   * KAN-165: this used to be `min(exponential + floor(rnd() * 1000), maxDelay)`.
   * Adding jitter on top and then clipping by the cap meant every attempt once
   * the cap was reached returned exactly maxDelay — the randomness disappeared
   * precisely when clients were parked in a long outage and synchronised
   * retries matter most. Sampling the whole window keeps the spread alive.
   */
  function computeBackoff(attempt, baseDelay = INITIAL_BACKOFF_DELAY, maxDelay = MAX_BACKOFF_DELAY, randomFn = Math.random) {
    const ceiling = Math.min(baseDelay * Math.pow(2, Math.max(0, attempt)), maxDelay);
    return Math.floor(randomFn() * ceiling);
  }

  const Settings = {
    DEFAULT_BRIDGE_SECRET,
    DEFAULT_CLIENT_API_KEY,
    DEFAULT_WORKER_URL,
    DEFAULT_MCP_ENDPOINT,
    DEFAULT_WSS_ENDPOINT,
    DEFAULT_OPENAI_ENDPOINT,
    MAX_BACKOFF_DELAY,
    INITIAL_BACKOFF_DELAY,
    resolveSettings,
    computeBackoff
  };

  root.GeminiBridgeSettings = Settings;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Settings;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
