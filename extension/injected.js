(function() {
  console.log("[Bridgehead Injected] Main World Execution Initialized.");

  function extractTokens() {
    try {
      const wizData = window.WIZ_global_data;
      if (!wizData) {
        return { error: "WIZ_global_data not found" };
      }
      return {
        at: wizData.SNlM0e || null,
        fdrfje: wizData.FdrFJe || null,
        cfb2h: wizData.cfb2h || null
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ส่งโทเคนตั้งต้นให้ Content Script ทันทีที่โหลดเสร็จ
  const tokens = extractTokens();
  window.postMessage({
    source: "GEMINI_INJECTED",
    type: "TOKENS_EXTRACTED",
    payload: tokens
  }, "*");

  // ดักรับคำสั่งการสร้างคำขอจาก Content Script
  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.source !== "GEMINI_CONTENT") {
      return;
    }

    const { type, requestId, payload } = event.data;

    if (type === "EXECUTE_STREAM") {
      try {
        const latestTokens = extractTokens();
        if (!latestTokens.at) {
          throw new Error("Missing SNlM0e CSRF token from page session.");
        }

        const url = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${latestTokens.cfb2h || 'boq_assistant-bard-web-server_20260901.00_p0'}&_reqid=${Math.floor(Math.random() * 900000) + 100000}&rt=c`;

        const bodyParams = new URLSearchParams();
        bodyParams.append("f.req", payload.f_req);
        bodyParams.append("at", latestTokens.at);

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "X-Same-Domain": "1"
          },
          body: bodyParams.toString(),
          credentials: "include"
        });

        if (!response.ok) {
          throw new Error(`Google Web Endpoint returned status ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            window.postMessage({
              source: "GEMINI_INJECTED",
              type: "STREAM_DONE",
              requestId
            }, "*");
            break;
          }

          const rawChunk = decoder.decode(value, { stream: true });
          window.postMessage({
            source: "GEMINI_INJECTED",
            type: "STREAM_CHUNK",
            requestId,
            chunk: rawChunk
          }, "*");
        }
      } catch (err) {
        window.postMessage({
          source: "GEMINI_INJECTED",
          type: "STREAM_ERROR",
          requestId,
          error: err.message
        }, "*");
      }
    }
  });
})();
