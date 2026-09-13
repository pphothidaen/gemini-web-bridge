import { WebSocketServer, WebSocket } from "ws";
import { BridgeMessage, BridgeSessionTokens } from "./types";

export class WebSocketBridge {
  private wss: WebSocketServer;
  private heartbeatInterval: NodeJS.Timeout;
  private activeSocket: WebSocket | null = null;
  private currentTokens: BridgeSessionTokens | null = null;
  private activeStreams = new Map<string, (msg: BridgeMessage) => void>();

  constructor(port: number) {
    this.wss = new WebSocketServer({ port, path: "/bridge" });
    this.heartbeatInterval = setInterval(() => {
      if (this.activeSocket && this.activeSocket.readyState === WebSocket.OPEN) {
        this.activeSocket.send(JSON.stringify({ type: "PING" }));
      }
    }, 15000);
    this.init();
  }

  private init() {
    this.wss.on("connection", (ws) => {
      console.log("[Proxy Bridge] Chrome Extension connected.");
      this.activeSocket = ws;

      ws.on("message", (data) => {
        try {
          const msg: BridgeMessage = JSON.parse(data.toString());
          if (msg.type === "SESSION_READY" && msg.tokens) {
            this.currentTokens = msg.tokens;
            console.log("[Proxy Bridge] Active session tokens synchronized (at token acquired).");
          } else if (msg.type === "PONG") {
            // hearbeat ACK — silently drop, client is alive
          } else if (msg.requestId && this.activeStreams.has(msg.requestId)) {
            const handler = this.activeStreams.get(msg.requestId);
            if (handler) handler(msg);
          }
        } catch (e) {
          console.error("[Proxy Bridge] Invalid incoming WS frame:", e);
        }
      });

      ws.on("close", () => {
        console.warn("[Proxy Bridge] Chrome Extension disconnected.");
        if (this.activeSocket === ws) this.activeSocket = null;
      });
    });
  }

  public isReady(): boolean {
    return this.activeSocket !== null && this.currentTokens !== null;
  }

  public execute(requestId: string, f_req: string, onEvent: (msg: BridgeMessage) => void) {
    if (!this.activeSocket || this.activeSocket.readyState !== WebSocket.OPEN) {
      throw new Error("Chrome extension is not currently connected.");
    }
    this.activeStreams.set(requestId, onEvent);
    this.activeSocket.send(JSON.stringify({
      type: "EXECUTE_REQUEST",
      requestId,
      payload: { f_req }
    }));
  }

  public cleanupStream(requestId: string) {
    this.activeStreams.delete(requestId);
  }

  public close(): void {
    clearInterval(this.heartbeatInterval);
    this.wss.close(() => {
      console.log("[Proxy Bridge] WebSocket server closed.");
    });
  }
}
