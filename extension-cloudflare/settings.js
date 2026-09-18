// ============================================================
// Gemini Web-Bridge: Shared Settings & Diagnostics
// Shared effective settings resolver and backoff utilities
// ============================================================

(function (root) {
  "use strict";

  // ═══ DEFAULTS — synced from production environment ═══
  // Source order: Doppler (prd_worker) > Cloudflare Worker > .env > Hermes config
  const DEFAULT_BRIDGE_SECRET = "gemini-bridge-5ee24807fa35c8bca88ef89cc6401240";
  const DEFAULT_CLIENT_API_TOKEN = "hermes-392e28325564158e53712649fdc86d0e";
  const DEFAULT_WORKER_URL = "https://gemini-web-bridge.pansakorn-pho.workers.dev";
  const DEFAULT_MCP_ENDPOINT = "https://gemini-web-bridge.pansakorn-pho.workers.dev/mcp";
  const DEFAULT_WSS_ENDPOINT = "wss://gemini-web-bridge.pansakorn-pho.workers.dev/bridge";
  const DEFAULT_OPENAI_ENDPOINT = "https://gemini-web-bridge.pansakorn-pho.workers.dev/v1/chat/completions";

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
    const clientApiToken = rawClientToken || DEFAULT_CLIENT_API_TOKEN;

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
   * Computes exponential backoff delay with randomized jitter, capped at maxDelay.
   */
  function computeBackoff(attempt, baseDelay = INITIAL_BACKOFF_DELAY, maxDelay = MAX_BACKOFF_DELAY, randomFn = Math.random) {
    const exponential = Math.min(baseDelay * Math.pow(2, Math.max(0, attempt)), maxDelay);
    const jitter = Math.floor(randomFn() * 1000);
    return Math.min(exponential + jitter, maxDelay);
  }

  const Settings = {
    DEFAULT_BRIDGE_SECRET,
    DEFAULT_CLIENT_API_TOKEN,
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
