export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
}

export interface BridgeSessionTokens {
  at: string;
  fdrfje?: string;
  cfb2h?: string;
}

export interface ConversationState {
  conversationId: string | null;
  responseId: string | null;
  choiceId: string | null;
}

export interface BridgeMessage {
  type: "SESSION_READY" | "EXECUTE_REQUEST" | "STREAM_CHUNK" | "STREAM_DONE" | "STREAM_ERROR" | "PING" | "PONG";
  tokens?: BridgeSessionTokens;
  requestId?: string;
  payload?: any;
  chunk?: string;
  error?: string;
}
