import { OpenAIMessage, ConversationState } from "./types";

export class ProtocolDecoder {
  /**
   * รวมข้อความ System และ User เข้าด้วยกัน และจัด Format เป็น JSON String สำหรับ f.req
   */
  public static encodeRequest(
    messages: OpenAIMessage[],
    state: ConversationState
  ): string {
    let combinedPrompt = "";
    const systemMessages = messages.filter((m) => m.role === "system");
    const userAndAssistant = messages.filter((m) => m.role !== "system");

    if (systemMessages.length > 0) {
      combinedPrompt += `[System Directives: ${systemMessages.map((m) => m.content).join("\n")}]\n\n`;
    }

    const latestUserMsg = userAndAssistant.reverse().find((m) => m.role === "user");
    combinedPrompt += latestUserMsg ? latestUserMsg.content : "";

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
  public static decodeChunk(rawChunk: string): { deltaText: string; stateUpdate?: Partial<ConversationState> } {
    let clean = rawChunk.trim();
    if (clean.startsWith(")]}'")) {
      clean = clean.substring(4).trim();
    }

    let deltaText = "";
    let stateUpdate: Partial<ConversationState> = {};

    const lines = clean.split("\n");
    for (const line of lines) {
      if (!line.trim() || /^\d+$/.test(line.trim())) continue;
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed)) {
          // โครงสร้าง nested payload ภายใน RPC wrapper
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
        // ข้าม chunk ที่ตัดมาไม่สมบูรณ์
      }
    }

    return { deltaText, stateUpdate };
  }
}
