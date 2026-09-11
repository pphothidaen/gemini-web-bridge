(function() {
  console.log("[Bridgehead Content] Content Script loaded.");

  // ฝัง injected.js ลงใน Main World ของหน้าเว็บ
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected.js");
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();

  let socket = null;
  let isConnected = false;
  let latestTokens = null;

  function connectBridge() {
    socket = new WebSocket("ws://127.0.0.1:8787/bridge");

    socket.onopen = () => {
      console.log("[Bridgehead Content] WebSocket connection to Local Proxy established.");
      isConnected = true;
      if (latestTokens) {
        socket.send(JSON.stringify({
          type: "SESSION_READY",
          tokens: latestTokens
        }));
      }
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "EXECUTE_REQUEST") {
          window.postMessage({
            source: "GEMINI_CONTENT",
            type: "EXECUTE_STREAM",
            requestId: msg.requestId,
            payload: msg.payload
          }, "*");
        } else if (msg.type === "PING") {
          socket.send(JSON.stringify({ type: "PONG" }));
        }
      } catch (err) {
        console.error("[Bridgehead Content] Failed to parse message from Proxy:", err);
      }
    };

    socket.onclose = () => {
      isConnected = false;
      console.warn("[Bridgehead Content] Bridge connection dropped. Reconnecting in 3s...");
      setTimeout(connectBridge, 3000);
    };

    socket.onerror = (err) => {
      console.error("[Bridgehead Content] WebSocket error:", err);
      socket.close();
    };
  }

  // ดักฟังข้อความจาก Main World (injected.js)
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "GEMINI_INJECTED") {
      return;
    }

    const { type, payload, requestId, chunk, error } = event.data;

    if (type === "TOKENS_EXTRACTED") {
      latestTokens = payload;
      if (isConnected && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: "SESSION_READY",
          tokens: latestTokens
        }));
      }
    } else if (type === "STREAM_CHUNK" || type === "STREAM_DONE" || type === "STREAM_ERROR") {
      if (isConnected && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type,
          requestId,
          chunk,
          error
        }));
      }
    }
  });

  connectBridge();
})();
