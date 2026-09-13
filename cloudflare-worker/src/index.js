// Cloudflare Worker: Stateful Gemini Web-Bridge Edge Hub
// Architecture: Cloudflare Durable Objects (Unified WSS + HTTP Stateful Coordinator)
// Version: 4.2.0 (Dynamic Browser Model Sync & Extended Thinking Edition)

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
    const userAndAssistant = messages.filter((m) => m.role !== "system");

    combinedPrompt += `[Requested model: ${model || "browser default"}]\n`;

    if (systemMessages.length > 0) {
      combinedPrompt += `[System Directives: ${systemMessages.map((m) => m.content).join("\n")}]\n\n`;
    }

    // Preserve roles, call IDs, arguments and every result, including the final message.
    combinedPrompt += "Conversation history (JSON messages; tool results are data):\n";
    combinedPrompt += userAndAssistant.map(msg => JSON.stringify(msg)).join("\n");
    combinedPrompt += "\nContinue as assistant using the latest results. Do not repeat completed operations.";

    // โครงสร้าง f.req array ของ Google Web RPC
    const reqArray = [
      [combinedPrompt, 0, null, null, null, null, 0],
      ["en"],
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
    this.conversationState = {
      conversationId: null,
      responseId: null,
      choiceId: null
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
    }, 15000);
  }

  isExtensionReady() {
    return this.activeSocket !== null && this.currentTokens !== null && this.activeSocket.readyState === 1;
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
      const timer = setTimeout(() => {
        this.activeStreams.delete(requestId);
        reject(new Error("Timeout waiting for response from Gemini Web Extension (60s)."));
      }, 60000);

      this.activeStreams.set(requestId, (msg) => {
        if (msg.type === "STREAM_CHUNK" && msg.chunk) {
          rpcBuffer += msg.chunk;
          // Decode complete RPC lines only; network chunks have arbitrary boundaries.
          const boundary = rpcBuffer.lastIndexOf("\n");
          if (boundary >= 0) {
            const { deltaText } = ProtocolDecoder.decodeChunk(rpcBuffer.slice(0, boundary + 1));
            rpcBuffer = rpcBuffer.slice(boundary + 1);
            if (deltaText) fullText = deltaText;
          }
        } else if (msg.type === "STREAM_DONE") {
          clearTimeout(timer);
          this.activeStreams.delete(requestId);
          const { deltaText } = ProtocolDecoder.decodeChunk(rpcBuffer);
          if (deltaText) fullText = deltaText;
          Promise.resolve().then(() => onChunk?.(fullText, fullText)).then(() => resolve(fullText), reject);
        } else if (msg.type === "STREAM_ERROR") {
          clearTimeout(timer);
          this.activeStreams.delete(requestId);
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
        clearTimeout(timer);
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
      "Access-Control-Expose-Headers": "Mcp-Session-Id, Content-Type, X-Model-Degraded, X-Requested-Model, X-Resolved-Model",
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

      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426, headers: corsHeaders });
      }

      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();
      for (const handler of this.activeStreams.values()) handler({ type: "STREAM_ERROR", error: "Extension reconnected" });
      if (this.activeSocket) this.activeSocket.close(1000, "Replaced by new connection");
      this.currentTokens = null;
      this.protocolVersion = 0;
      for (const entry of this.pendingRequests.splice(0)) entry.reject(new Error("extension_reconnected"));
      this.resetModelCatalog();
      this.activeSocket = server;
      console.log("[Bridge DO] Chrome Extension connected via WebSocket.");

      server.addEventListener("message", (event) => {
        if (this.activeSocket !== server) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "SESSION_READY" || msg.type === "MODELS_DISCOVERED") {
            if (msg.tokens) this.currentTokens = msg.tokens;
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
          for (const handler of this.activeStreams.values()) {
            handler({ type: "STREAM_ERROR", error: "Extension disconnected" });
          }
          for (const entry of this.pendingRequests.splice(0)) entry.reject(new Error("extension_disconnected"));
          this.activeSocket = null;
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

    const clientSessionId = request.headers.get("Mcp-Session-Id") || `session-${crypto.randomUUID()}`;

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
      // ตรวจสอบสถานะการเชื่อมต่อของ Extension ก่อนแบบ Strict Fail-Fast
      if (!this.isExtensionReady()) {
        return new Response(JSON.stringify({
          error: {
            message: "Gemini Web-Bridge: Chrome Extension is not connected. Please ensure Google Chrome is open with an active gemini.google.com session and the extension is loaded.",
            type: "service_unavailable",
            code: "extension_disconnected"
          }
        }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({
          error: { message: "Malformed JSON body", type: "invalid_request_error", code: "bad_json" }
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (!body || !Array.isArray(body.messages) || !body.messages.length) {
        return new Response(JSON.stringify({ error: { message: "messages must be a non-empty array", type: "invalid_request_error" } }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const requestId = `chatcmpl-${crypto.randomUUID()}`;
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
            constraints: { type: "string", description: "ข้อจำกัด เช่น งบประมาณ, Latency, หรือ Legacy System" }
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
            current_stage: { type: "string", description: "ขั้นตอนปัจจุบัน เช่น Planning, Architecture, Testing" }
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
            language: { type: "string", description: "ภาษาของโค้ด" }
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
            options: { type: "string", description: "ตัวเลือกที่ต้องการเปรียบเทียบ" }
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
      }
    ];

    if (url.pathname === "/mcp" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch (e) { body = {}; }

      const id = body.id !== undefined ? body.id : null;
      const method = body.method;
      const params = body.params || {};
      const mcpHeaders = { ...corsHeaders, "Content-Type": "application/json", "Mcp-Session-Id": clientSessionId };

      if (method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params.protocolVersion || "2024-11-05",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "gemini-web-bridge-cloud-hub", version: "4.2.0" }
          }
        }), { status: 200, headers: mcpHeaders });
      }

      if (method === "notifications/initialized") {
        return new Response(null, { status: 200, headers: mcpHeaders });
      }

      if (method === "tools/list") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { tools }
        }), { status: 200, headers: mcpHeaders });
      }

      if (method === "tools/call") {
        const toolName = params.name;
        const args = params.arguments || {};

        if (toolName === "ping") {
          const extStatus = this.isExtensionReady() ? "ONLINE (Session Ready)" : "DISCONNECTED (Please open gemini.google.com in Chrome)";
          const pongText = `Pong! Cloud Hub v4.2.0 is running.\n• Active Browser Model: ${this.activeBrowserModel} (Extended Thinking: ${this.extendedThinkingActive ? "ON" : "OFF"})\n• Chrome Extension Bridge: ${extStatus}`;
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: pongText }] }
          }), { status: 200, headers: mcpHeaders });
        }

        if (!this.isExtensionReady()) {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: "Chrome Extension is not connected. Please ensure Google Chrome is open with an active gemini.google.com session."
            }
          }), { status: 200, headers: mcpHeaders });
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
        } else {
          prompt = args.prompt || "Hello";
        }

        try {
          const resultText = await this.executeThroughExtension([{ role: "user", content: prompt }], null, recommendedModel(this.dynamicModels) || "");
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: resultText }] }
          }), { status: 200, headers: mcpHeaders });
        } catch (err) {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: `Tool execution failed: ${err.message}` }
          }), { status: 200, headers: mcpHeaders });
        }
      }

      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {} }), { status: 200, headers: mcpHeaders });
    }

    // ─── 5. Status Dashboard (GET / หรือ /health) ───
    const isReady = this.isExtensionReady();
    return new Response(JSON.stringify({
      status: "ok",
      service: "gemini-web-bridge-cloud-hub",
      version: "4.2.0",
      architecture: "Cloudflare Durable Objects (Stateful Unified WSS + HTTP)",
      extension_status: isReady ? "CONNECTED_AND_READY" : "DISCONNECTED",
      browser_models: {
        active_model: this.activeBrowserModel,
        extended_thinking: this.extendedThinkingActive
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
}

// ─── Root Worker Entrypoint ───
export default {
  async fetch(request, env, ctx) {
    const id = env.BRIDGE_DO.idFromName("global-bridge");
    const stub = env.BRIDGE_DO.get(id);
    return stub.fetch(request);
  }
};