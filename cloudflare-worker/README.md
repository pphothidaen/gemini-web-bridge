# Cloudflare bridge tool calling

Hermes owns tool execution and the agent loop. Send OpenAI chat `messages` and
`tools` to `/v1/chat/completions`. After executing returned calls, append the
assistant message and one `role: "tool"` message with its `tool_call_id` per result.
The bridge preserves this history and starts a fresh upstream conversation for
each request to avoid sharing conversation state between clients.

Both response modes use the same tool parser. Calls have unique IDs; streaming
calls have distinct indices and one final finish reason. The bridge buffers the
completion before emitting SSE so an invalid later call cannot partially dispatch
a batch. This increases time to first output. Malformed or disallowed calls fail;
`tool_choice` (auto, none, required, named) and `parallel_tool_calls: false` are
checked. Body tool schemas take precedence over the legacy header. Validation
covers object arguments, type, required, enum, properties, additionalProperties,
and array items; this is not a complete JSON Schema validator. Hermes must retain
its own execution validation and permission controls.

Configure secrets before deployment (the old plaintext defaults were removed):

```sh
npx wrangler secret put BRIDGE_AUTH_TOKEN
npx wrangler secret put CLIENT_API_TOKEN
```

Set matching credentials in the extension and Hermes. No deployment is performed
by the local tests. Run tests with Node 26 (native TypeScript stripping):

```sh
node --test tests/tool-loop.test.mjs
```

Tests use a simulated extension and exercise the HTTP handlers; live browser RPC
compatibility and real Hermes execution still require integration verification.

## Dynamic models

Every extension connection clears the previous catalog and browser state. The
extension sends a fresh DOM snapshot even when reconnecting with cached tokens.
Snapshots replace the entire catalog, including empty snapshots. Messages from
superseded sockets are ignored. `/v1/models` uses `Cache-Control: no-store`, returns
`catalog_revision`, and contains no hardcoded fallback or alias entries.

The first entry and `default_recommended` are the highest numeric model version
among discovered thinking variants (e.g. 3.10 sorts after 3.9). This is a version
ordering heuristic, not a verified release date. `default_reasoning_effort` is
null and `supports_reasoning_effort` is false: this transport cannot control effort. With no thinking candidate, the default is null. Omitted model IDs and
legacy `gemini-web-thinking` / `gemini-web` aliases resolve to the current default;
explicit obsolete IDs fail instead of silently using a different model.

Browser discovery currently recognizes versioned Flash/Pro labels and an English
Extended thinking control. Closed menus or changed/localized DOM can yield an
empty catalog; no fabricated fallback is returned. The default and effort fields
are bridge recommendations: the existing browser RPC transport does not yet
select a browser model or configure a numeric reasoning budget. Naming a model
in a prompt does not guarantee upstream model selection.

Hermes also has its own disk model cache. HTTP cache headers cannot invalidate
that cache or rewrite Hermes config remotely. The client integration must refresh
its provider catalog on reconnect, replace rather than append cached IDs, and
select the dynamic alias or the new `default_recommended`. This requires changes
in the actual Hermes installation, separate from the Worker deployment.


### Hermes effort visibility

The local Hermes installation now supports an explicit UI capability override:

```yaml
providers:
  gemini-web-bridge:
    capabilities:
      reasoning: false
```

The shared model inventory uses this override to hide the desktop model effort
controls; the dashboard model-info route uses the same value for its sidebar.
Other providers retain their normal capability discovery. This does not disable
Gemini's own thinking in the browser and does not change the profile-wide effort
setting used by other providers. Restart the Hermes backend to load Python edits.
These are local Hermes source changes; an upstream update may replace them.
