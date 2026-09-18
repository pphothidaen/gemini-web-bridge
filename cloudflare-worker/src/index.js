// Cloudflare Worker: Stateful Gemini Web-Bridge Edge Hub
// Architecture: Cloudflare Durable Objects (Unified WSS + HTTP Stateful Coordinator)
// Version: 4.3.4 (Stability Patch - Exclusive SW Channel & Rogue Socket Elimination)

import { normalizeModels, recommendedModel } from "./model-catalog.js";
import { DurableObject } from "cloudflare:workers";
import { 
  buildToolSystemPrompt, 
  createToolCallTransformer,
  resolveToolPolicy,
  parseToolCompletion
} from "./tool-emulator.ts";

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

    this.healthState = {
      lastSuccessfulGeneration: null,
      consecutiveErrors: 0,
      lastError: null,
      lastHealthCheck: Date.now()
    };

    this.resetModelCatalog();

    // Keepalive Ping Loop
    this.initKeepalive();
  }

  resetModelCatalog() {
    this.dynamicModels = [];
    this.activeBrowserModel = null;
    this.extendedThinkingActive = false;
    this.catalogRevision = crypto.randomUUID();
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

  isExtensionReady() {
    return this.activeSocket !== null && this.currentTokens !== null && this.activeSocket.readyState === 1;
  }

  /**
   * Reconnect grace: instead of failing immediately when the extension drops,
   * give it a short window to reconnect and republish protocol v2. This keeps
   * brief tab reloads / network blips from surfacing as 503s to clients.
   */
  async waitForExtension(maxWaitMs = 12000) {
    if (this.isExtensionReady() && this.protocolVersion === 2) return true;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (this.isExtensionReady() && this.protocolVersion === 2) return true;
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
   * PREPARE_SCOPE: ask the extension to make the requested conversation scope
   * active (navigate/promote a tab). Resolves with SCOPE_READY or rejects.
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
          payload: { f_req: encodedReq, model, protocolVersion: 2, catalogRevision: this.catalogRevision, mappingRevision: this.dynamicModels.find(m=>m.id===model)?.mapping_revision }
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

      const incomingOrigin = request.headers.get("origin") || "";
      const isCurrentDevice = (!this.activeOrigin || !incomingOrigin || this.activeOrigin === incomingOrigin);

      // Protect healthy active bridge session from being hijacked by a secondary device/node
      if (this.activeSocket && this.activeSocket.readyState === 1 && this.isExtensionReady()) {
        if (!isCurrentDevice) {
          console.warn(`[Bridge DO] Rejected connection from secondary device (${incomingOrigin}) because primary (${this.activeOrigin}) is healthy.`);
          return new Response("Conflict: Primary bridge device is currently active and healthy", { status: 409, headers: corsHeaders });
        }
      }

      // Protect in-flight active streams from duplicate connection collisions
      if (this.activeSocket && this.activeSocket.readyState === 1 && this.activeStreams.size > 0) {
        console.warn("[Bridge DO] Rejected duplicate WebSocket connection: active stream in flight.");
        return new Response("Conflict: Bridge is currently streaming an active request", { status: 409, headers: corsHeaders });
      }

      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426, headers: corsHeaders });
      }

      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();
      for (const handler of this.activeStreams.values()) handler({ type: "STREAM_ERROR", error: "Extension reconnected", code: "extension_reconnected" });
      if (this.activeSocket) this.activeSocket.close(1000, "Replaced by new connection");
      this.currentTokens = null;
      this.protocolVersion = 0;
      this.socketLostAt = null;
      // Queued requests are NOT rejected here: a reconnect is good news for
      // them and handleRequest() now waits out a short reconnect grace period.
      this.resetModelCatalog();
      this.activeSocket = server;
      this.activeOrigin = incomingOrigin;
      console.log("[Bridge DO] Chrome Extension connected via WebSocket. Device origin:", incomingOrigin || "local");

      server.addEventListener("message", (event) => {
        if (this.activeSocket !== server) return;
        try {
          const msg = JSON.parse(event.data);
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
            // Heartbeat pong received
          } else if (msg.requestId && this.activeStreams.has(msg.requestId)) {
            const handler = this.activeStreams.get(msg.requestId);
            if (handler) handler(msg);
          }
        } catch (err) {
          console.error("[Bridge DO] WS parse error:", err);
        }
      });

      server.addEventListener("close", (event) => {
        console.warn(`[Bridge DO] Chrome Extension disconnected (code: ${event.code}).`);
        if (this.activeSocket === server) {
          this.socketLostAt = Date.now();
          for (const handler of this.activeStreams.values()) {
            handler({ type: "STREAM_ERROR", error: "Extension disconnected" });
          }
          // Queued requests are kept: they will wait for a reconnect inside
          // waitForExtension() instead of failing instantly (reconnect grace).
          this.activeSocket = null;
          this.activeOrigin = null;
          this.protocolVersion = 0;
          this.currentTokens = null;
          this.resetModelCatalog();
        }
      });

      server.addEventListener("error", (err) => {
        console.error("[Bridge DO] WebSocket error:", err);
      });

      return new Response(null, { status: 101, webSocket: client, headers: corsHeaders });
    }

    if (url.pathname === "/bridge/auth-check") {
      const supplied=request.headers.get("x-bridge-token");
      return new Response(JSON.stringify({ok:Boolean(BRIDGE_SECRET && supplied===BRIDGE_SECRET),protocolVersion:2}),
        {status:BRIDGE_SECRET && supplied===BRIDGE_SECRET ? 200 : 401,headers:{...corsHeaders,"Content-Type":"application/json","Cache-Control":"no-store"}});
    }

    // ─── Public Paths vs Authenticated Paths ───
    const publicPaths = ["/", "/health"];
    if (!publicPaths.includes(url.pathname)) {
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (!token || token !== CLIENT_API_KEY) {
        return new Response(JSON.stringify({
          error: {
            message: "Invalid or missing API key. Please provide Authorization: Bearer <CLIENT_API_KEY>",
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

    // ─── 2. OpenAI-Compatible API: /v1/models ───
    if (url.pathname === "/v1/models" && request.method === "GET") {
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
      if (!this.isExtensionReady() || this.protocolVersion !== 2) {
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
          } catch (error) {
            return this.failure(error.code === "extension_disconnected" ? 503 : 422, error.code || "scope_switch_failed", error.message);
          }
        }
        corsHeaders["X-Bridge-Scope"] = targetScope;
      }

      const requestedModel = body?.model;
      if (this.protocolVersion !== 2) return this.failure(503,"extension_upgrade_required","Reload the updated extension (protocol v2 required)");
      let rawModel = !requestedModel || ["gemini-web", "gemini-web-thinking"].includes(requestedModel)
        ? recommendedModel(this.dynamicModels) : requestedModel;
      if (!rawModel && requestedModel === "gemini-web-thinking") {
        rawModel = this.dynamicModels.find(m => m.thinking)?.id || (this.dynamicModels.some(m => m.id === "gemini-web-thinking") ? "gemini-web-thinking" : null);
      }
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

      const knownSdlcTools = ["sdlc_solution_architect", "orchestrate_sdlc_plan", "code_review_and_debug", "evaluate_tech_tradeoffs"];

      // Scope switch helper shared by set_bridge_scope and the SDLC tools.
      const applyScope = async (scopeInput) => {
        if (!scopeInput) return { ok: true, scope: this.currentScope };
        const targetScope = this.resolveScopeInput(scopeInput);
        if (!targetScope) {
          return { ok: false, message: `Unrecognized bridge scope '${scopeInput}'. Use "app", "app:<conversationId>", "notebook:<notebookId>", or a gemini.google.com URL/path.` };
        }
        if (this.currentScope === targetScope) return { ok: true, scope: targetScope };
        const ready = await this.prepareScope(targetScope);
        this.currentScope = ready.scope || targetScope;
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
          }

          // Switch conversation scope (normal chat / notebook) before executing.
          if (args.scope) {
            let scopeOutcome;
            try {
              scopeOutcome = await applyScope(args.scope);
            } catch (scopeErr) {
              scopeOutcome = { ok: false, message: scopeErr.message };
            }
            if (!scopeOutcome.ok) {
              return { response: { jsonrpc: "2.0", id, error: { code: -32602, message: scopeOutcome.message } } };
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
            const resultText = await this.executeThroughExtension([{ role: "user", content: prompt }], null, targetModel);
            const res = {
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: resultText }] }
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