import { WebSocketBridge } from "./ws-bridge";
import { RequestQueue } from "./queue";
import { createServer } from "./server";

const PORT = 8790;
const bridge = new WebSocketBridge(PORT);
const queue = new RequestQueue();
const app = createServer(bridge, queue);

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`=================================================`);
  console.log(` Gemini Web-Bridge Proxy running on 127.0.0.1:${PORT}`);
  console.log(` Endpoint: http://127.0.0.1:${PORT}/v1/chat/completions`);
  console.log(` Health:   http://127.0.0.1:${PORT}/health`);
  console.log(` Ready for aichat, mods, and OpenAI SDK.`);
  console.log(`=================================================`);
});

function shutdown() {
  console.log("\n[Shutdown] Received signal. Shutting down gracefully...");
  bridge.close();
  server.close(() => {
    console.log("[Shutdown] HTTP server closed. Exiting.");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("[Shutdown] Force exit after timeout.");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
