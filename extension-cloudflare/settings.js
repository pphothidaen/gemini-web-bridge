// ============================================================
// Gemini Web-Bridge: Shared Settings & Diagnostics
// Shared effective settings resolver and backoff utilities
// ============================================================

(function (root) {
  "use strict";

  const DEFAULT_BRIDGE_SECRET = "gemini-bridge-secret-2026";
  const DEFAULT_WORKER_URL = "https://gemini-web-bridge.taijustarrett417.workers.dev";
  const MAX_BACKOFF_DELAY = 30000;
  const INITIAL_BACKOFF_DELAY = 1000;

  /**
   * Resolves effective settings from storage object.
   * Empty bridgeToken retains built-in compatibility secret.
   * Default enforcementMode is 'strict'.
   */
  function resolveSettings(stored = {}) {
    const rawUrl = typeof stored.workerUrl === "string" ? stored.workerUrl.trim() : "";
    const workerUrl = rawUrl || DEFAULT_WORKER_URL;

    const rawToken = typeof stored.bridgeToken === "string" ? stored.bridgeToken.trim() : "";
    const bridgeToken = rawToken || DEFAULT_BRIDGE_SECRET;

    const enforcementMode = stored.enforcementMode === "permissive" ? "permissive" : "strict";

    return {
      workerUrl,
      bridgeToken,
      rawBridgeToken: rawToken,
      enforcementMode,
      isDefaultToken: !rawToken
    };
  }

  /**
   * Computes exponential backoff delay with randomized jitter, capped at maxDelay.
   */
  function computeBackoff(attempt, baseDelay = INITIAL_BACKOFF_DELAY, maxDelay = MAX_BACKOFF_DELAY, randomFn = Math.random) {
    const exponential = Math.min(baseDelay * Math.pow(2, Math.max(0, attempt)), maxDelay);
    const jitter = Math.floor(randomFn() * 1000);
    return Math.min(exponential + jitter, maxDelay);
  }

  const Settings = {
    DEFAULT_BRIDGE_SECRET,
    DEFAULT_WORKER_URL,
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
