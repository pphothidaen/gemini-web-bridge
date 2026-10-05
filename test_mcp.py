import asyncio
import json
import httpx2
from mcp.client.streamable_http import streamable_http_client
from mcp import ClientSession

async def main():
    http_client = httpx2.AsyncClient(
        headers={"Authorization": "Bearer 080784d5629e5ec10da8d44aaf60d2a60260cb031fac1d2e"}
    )
    async with streamable_http_client(
        "https://prod.gemini-web-bridge.workers.dev/mcp",
        http_client=http_client
    ) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            tools = await session.list_tools()
            print(json.dumps([{"name": t.name, "description": t.description} for t in tools.tools], indent=2))

asyncio.run(main())
