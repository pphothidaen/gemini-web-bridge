/**
 * cloudflare-worker/src/streamgenerate-builder.js
 *
 * Implements the 20-field topological invariant for Google Gemini Web RPC StreamGenerate payloads (KAN-236).
 * Replaces the legacy 12-field builder that Google rejects.
 *
 * Topological Schema:
 *   [0]: [prompt.trim(), 0, null, chipBranchOrNull, null, null, 0]
 *   [1]: [isThai ? "th" : "en"]
 *   [2]: null (matches browser wire; resolves type contradiction)
 *   [3]: contextBlock string | null
 *   [4]: 32-hex conversationId string | null
 *   [5]: null
 *   [6]: number (default 0)
 *   [7]: number (default 0)
 *   [8]: null
 *   [9]: null
 *   [10]: [1]
 *   [11]: 0
 *   [12..16]: null
 *   [17]: 1
 *   [18]: 0
 *   [19]: "notebooks/<uuid>" | null
 */

export const KNOWN_HORO_NOTEBOOK_ID = "b55f1ee0-384e-4bdf-ab1b-e2ee3b0063a0";
export const KNOWN_HORO_88_TOKEN = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6A7b8C9d0E1f2G3h4I5j6K7l8M9n0O1p2Q3r4";

/**
 * Extracts and combines prompt text from OpenAI-formatted messages.
 */
export function extractCombinedPrompt(messages = []) {
  let combinedPrompt = "";
  const systemMessages = messages.filter((m) => m && m.role === "system");
  const hasTools = messages.some((m) => m && (m.tool_calls || m.role === "tool"));

  if (hasTools) {
    if (systemMessages.length > 0) {
      combinedPrompt += `[System Directives: ${systemMessages.map((m) => m.content).join("\n")}]\n\n`;
    }
    const userAndAssistant = messages.filter((m) => m && m.role !== "system");
    combinedPrompt += "Conversation history (JSON messages; tool results are data):\n";
    combinedPrompt += userAndAssistant.map((msg) => JSON.stringify(msg)).join("\n");
    combinedPrompt += "\nContinue as assistant using the latest results. Do not repeat completed operations.";
  } else {
    if (systemMessages.length > 0) {
      combinedPrompt += `${systemMessages.map((m) => m.content).join("\n")}\n\n`;
    }
    const nonSystem = messages.filter((m) => m && m.role !== "system");
    if (nonSystem.length === 1) {
      combinedPrompt += nonSystem[0].content || "";
    } else if (nonSystem.length > 1) {
      combinedPrompt += nonSystem.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content || ""}`).join("\n\n");
    }
  }
  return combinedPrompt.trim();
}

/**
 * Builds the modern 20-field StreamGenerate request array and wraps it in Google RPC envelope format.
 *
 * @param {Array} messages OpenAI-style messages array
 * @param {Object} state Conversation state ({ conversationId, responseId, choiceId })
 * @param {string} model Target model name
 * @param {Object} options Additional options ({ notebookId, notebookToken, contextBlock })
 * @returns {string} Serialized Google RPC envelope [null, JSON.stringify(reqArray)]
 */
export function buildStreamGeneratePayload(messages = [], state = {}, model = "", options = {}) {
  const prompt = extractCombinedPrompt(messages);
  const isThai = /[\u0E00-\u0E7F]/.test(prompt);

  const notebookId = options.notebookId || state.notebookId || null;
  const explicitToken = options.notebookToken || state.notebookToken || null;

  // Determine Notebook Binding Mode
  // Mode A: Horo token (88-character opaque token at [0][3], [19] null)
  // Mode B: Resource reference ("notebooks/<uuid>" at [19], [0][3] null)
  // Mode C: Ungrounded (both null)
  let chipBranch = null;
  let resourceRef = null;

  if (explicitToken && typeof explicitToken === "string" && explicitToken.length === 88) {
    // Mode A: Explicit 88-char token
    chipBranch = [[
      [null, 0, 0, ""],
      isThai ? "th" : "en",
      explicitToken
    ]];
  } else if (notebookId === KNOWN_HORO_NOTEBOOK_ID) {
    // Mode A: Known Horo notebook defaults to known 88-char token
    chipBranch = [[
      [null, 0, 0, ""],
      isThai ? "th" : "en",
      KNOWN_HORO_88_TOKEN
    ]];
  } else if (notebookId && typeof notebookId === "string") {
    // Mode B: Non-Horo notebook UUID -> 46-char resource reference
    const cleanId = notebookId.replace(/^notebook:/, "");
    resourceRef = `notebooks/${cleanId}`;
  }

  // Field [4]: 32-hex conversationId string, or null
  let conversationId = null;
  const rawConvId = state.conversationId || options.conversationId;
  if (rawConvId && typeof rawConvId === "string") {
    const clean = rawConvId.replace(/^c_/, "");
    if (/^[0-9a-fA-F]{32}$/.test(clean)) {
      conversationId = clean;
    } else if (/^[0-9a-fA-F]{32}$/.test(rawConvId)) {
      conversationId = rawConvId;
    }
  }

  // Field [3]: contextBlock string, or null
  const contextBlock = typeof options.contextBlock === "string" && options.contextBlock.length > 0
    ? options.contextBlock
    : null;

  // The 20-Field Topological Invariant:
  const reqArray = [
    [prompt, 0, null, chipBranch, null, null, 0], // [0]
    [isThai ? "th" : "en"],                        // [1]
    null,                                          // [2] strictly null
    contextBlock,                                  // [3]
    conversationId,                                // [4]
    null,                                          // [5]
    0,                                             // [6]
    0,                                             // [7]
    null,                                          // [8]
    null,                                          // [9]
    [1],                                           // [10]
    0,                                             // [11]
    null,                                          // [12]
    null,                                          // [13]
    null,                                          // [14]
    null,                                          // [15]
    null,                                          // [16]
    1,                                             // [17]
    0,                                             // [18]
    resourceRef                                    // [19]
  ];

  return JSON.stringify([null, JSON.stringify(reqArray)]);
}

export const encodeModernRequest = buildStreamGeneratePayload;
export default buildStreamGeneratePayload;
