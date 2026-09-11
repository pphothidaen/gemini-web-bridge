import { WebSocketBridge } from "./ws-bridge";
import { RequestQueue } from "./queue";
import { createServer } from "./server";

const PORT = 8787;
const bridge = new WebSocketBridge(PORT);
const queue = new RequestQueue();
const app = createServer(bridge, queue);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`=================================================`);
  console.log(` Gemini Web-Bridge Proxy running on 127.0.0.1:${PORT}`);
  console.log(` Endpoint: http://127.0.0.1:${PORT}/v1/chat/completions`);
  console.log(` Ready for aichat, mods, and OpenAI SDK.`);
  console.log(`=================================================`);
});
