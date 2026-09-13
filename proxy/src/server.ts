import express, { Request, Response } from "express";
import cors from "cors";
import { WebSocketBridge } from "./ws-bridge";
import { RequestQueue } from "./queue";
import { ProtocolDecoder } from "./protocol-decoder";
import { OpenAIChatRequest, ConversationState, BridgeMessage } from "./types";
import crypto from "crypto";

export function createServer(bridge: WebSocketBridge, queue: RequestQueue) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  let conversationState: ConversationState = {
    conversationId: null,
    responseId: null,
    choiceId: null
  };

  app.get("/health", (req: Request, res: Response) => {
    res.json({
      status: "ok",
      bridgeReady: bridge.isReady(),
      uptime: process.uptime()
    });
  });

  app.get("/v1/models", (req: Request, res: Response) => {
    res.json({
      object: "list",
      data: [
        { id: "gemini-web", object: "model", created: 1700000000, owned_by: "google-web" },
        { id: "gemini-web-thinking", object: "model", created: 1700000000, owned_by: "google-web" }
      ]
    });
  });

  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    if (!bridge.isReady()) {
      return res.status(503).json({
        error: {
          message: "Gemini Web-Bridge is not connected to any active gemini.google.com browser session.",
          type: "service_unavailable"
        }
      });
    }

    const body: OpenAIChatRequest = req.body;
    const isStream = body.stream === true;
    const requestId = `req_${crypto.randomUUID()}`;

    queue.enqueue(async () => {
      return new Promise<void>((resolve) => {
        const encodedReq = ProtocolDecoder.encodeRequest(body.messages, conversationState);

        if (isStream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
        }

        let fullText = "";

        const handleBridgeMessage = (msg: BridgeMessage) => {
          if (msg.type === "STREAM_CHUNK" && msg.chunk) {
            const { deltaText, stateUpdate } = ProtocolDecoder.decodeChunk(msg.chunk);
            if (stateUpdate) {
              conversationState = { ...conversationState, ...stateUpdate };
            }
            if (deltaText) {
              const diff = deltaText.substring(fullText.length);
              fullText = deltaText;

              if (isStream && diff) {
                const sseChunk = {
                  id: requestId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: body.model || "gemini-web",
                  choices: [{ index: 0, delta: { content: diff }, finish_reason: null }]
                };
                res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
              }
            }
          } else if (msg.type === "STREAM_DONE") {
            bridge.cleanupStream(requestId);
            if (isStream) {
              res.write("data: [DONE]\n\n");
              res.end();
            } else {
              res.json({
                id: requestId,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: body.model || "gemini-web",
                choices: [{
                  index: 0,
                  message: { role: "assistant", content: fullText },
                  finish_reason: "stop"
                }]
              });
            }
            resolve();
          } else if (msg.type === "STREAM_ERROR") {
            bridge.cleanupStream(requestId);
            if (!res.headersSent) {
              res.status(500).json({ error: { message: msg.error || "Execution failed" } });
            } else {
              res.end();
            }
            resolve();
          }
        };

        bridge.execute(requestId, encodedReq, handleBridgeMessage);
      });
    });
  });

  return app;
}
