# Gemini Web Bridge — Client Configuration Guide

คู่มือการตั้งค่า Client ต่างๆ เพื่อเชื่อมต่อกับ Gemini Web Bridge (Cloudflare Worker)

## Base Endpoints

- **Status Dashboard:** `https://gemini-web-bridge.pphothidaen.workers.dev/` (Public)
- **OpenAI Compatible API:** `https://gemini-web-bridge.pphothidaen.workers.dev/v1`
- **MCP Endpoint:** `https://gemini-web-bridge.pphothidaen.workers.dev/mcp`
- **WebSocket Bridge:** `wss://gemini-web-bridge.pphothidaen.workers.dev/bridge`

---

## 1. Hermes Agent

### ก. ตั้งเป็น Primary Model Provider
ไฟล์ `~/.hermes/config.yaml`:
```yaml
model:
  default: gemini-web-thinking
  provider: gemini-web-bridge
  base_url: https://gemini-web-bridge.pphothidaen.workers.dev/v1
  api_key: REPLACE_WITH_GITHUB_SECRET_CLIENT_API_TOKEN

providers:
  gemini-web-bridge:
    capabilities:
      reasoning: false
    type: custom
    name: gemini-web-bridge
    base_url: https://gemini-web-bridge.pphothidaen.workers.dev/v1
    api_key: REPLACE_WITH_GITHUB_SECRET_CLIENT_API_TOKEN
    discover_models: true
    refresh_models_on_connect: true
    default_model: gemini-web-thinking
    models: []
    timeout: 120
    connect_timeout: 30
```

> [!NOTE]
> `capabilities.reasoning: false` ซ่อนการปรับแต่ง reasoning effort ที่ฝั่ง Hermes UI เนื่องจาก Gemini Web ควบคุม thinking budget จากฝั่งเบราว์เซอร์โดยตรง และ `discover_models: true` พร้อม `refresh_models_on_connect: true` จะดึงโมเดลจริงที่เปิดใช้งานในเบราว์เซอร์อัตโนมัติ (เช่น `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro`)

### ข. รองรับ Tool Emulation สำหรับ Hermes Agentic Loops
Cloudflare Worker มาพร้อมกับ **Tool Emulator Engine** ที่แปลงการเรียกเครื่องมือตามมาตรฐาน OpenAI Function Calling / Tools API (`terminal`, `git`, `read_file`, `write_file`, หรือ Custom Tools) ให้กลายเป็น Prompt Directives และแปลงผลลัพธ์จาก Gemini กลับเป็น OpenAI SSE Tool Call Chunks โดยอัตโนมัติ ทำให้ Hermes สามารถรัน Multi-turn Agentic Tool Loop ได้อย่างราบรื่น

### ค. ตั้งเป็น MCP Tool Server
ไฟล์ `~/.hermes/config.yaml`:
```yaml
mcp_servers:
  gemini-web-bridge:
    url: https://gemini-web-bridge.pphothidaen.workers.dev/mcp
    headers:
      Authorization: "Bearer REPLACE_WITH_GITHUB_SECRET_CLIENT_API_TOKEN"
```

---

## 2. Cursor / VS Code (Continue / Cline)

### Cursor
- **Settings** → **Models** → **Add Custom Model**
- **Model Name:** `gemini-web-thinking` หรือ `gemini-web`
- **Base URL:** `https://gemini-web-bridge.pphothidaen.workers.dev/v1`
- **API Key:** `REPLACE_WITH_GITHUB_SECRET_CLIENT_API_TOKEN`

### Cline / Claude Code (MCP Configuration)
ไฟล์ `claude_desktop_config.json` หรือ cline MCP settings:
```json
{
  "mcpServers": {
    "gemini-web-bridge": {
      "url": "https://gemini-web-bridge.pphothidaen.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer REPLACE_WITH_GITHUB_SECRET_CLIENT_API_TOKEN"
      }
    }
  }
}
```

---

## 3. OpenAI Python / Node.js SDK

### Python
```python
from openai import OpenAI

client = OpenAI(
    base_url="https://gemini-web-bridge.pphothidaen.workers.dev/v1",
    api_key="REPLACE_WITH_GITHUB_SECRET_CLIENT_API_TOKEN"
)

response = client.chat.completions.create(
    model="gemini-web-thinking",
    messages=[
        {"role": "system", "content": "You are an expert system architect."},
        {"role": "user", "content": "Design a high-throughput event processing pipeline"}
    ],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

#### Python (Function / Tool Calling)
```python
response = client.chat.completions.create(
    model="gemini-web-thinking",
    messages=[
        {"role": "user", "content": "What files are in the current directory?"}
    ],
    tools=[
        {
            "type": "function",
            "function": {
                "name": "terminal",
                "description": "Execute a shell command",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "Shell command"}
                    },
                    "required": ["command"]
                }
            }
        }
    ],
    tool_choice="auto"
)

# Bridge returns OpenAI-compatible tool_calls structure
print(response.choices[0].message.tool_calls)
```

### cURL
```bash
curl -N -X POST https://gemini-web-bridge.pphothidaen.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer REPLACE_WITH_GITHUB_SECRET_CLIENT_API_TOKEN" \
  -d '{
    "model": "gemini-web-thinking",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Hello Gemini Web Bridge!"}
    ]
  }'
```
