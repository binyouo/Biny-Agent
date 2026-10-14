# Nowledge Mem

This plugin uses a configured Nowledge Mem MCP server to retrieve context before a new Biny prompt and sync the visible conversation after a completed turn.

## Enable

Configure the local MCP server and add the plugin directory to Biny's project plugin paths:

```json
{
  "extensions": {
    "mcp": {
      "nowledge-mem": {
        "type": "http",
        "url": "http://127.0.0.1:14242/mcp",
        "transportProtocol": "streamable-http",
        "enabled": true
      }
    },
    "plugins": ["plugins/nowledge-mem"]
  }
}
```

The server alias should contain `nowledge-mem`. For another alias, set `BINY_NOWLEDGE_MEM_SERVER` to that exact configured alias in Biny's environment. If no unambiguous matching server is configured, the plugin remains inactive.

## Behavior

- Before a non-empty prompt, it reads the context bundle and searches up to five relevant memories. Retrieved text is added as transient, untrusted prompt context; it does not change the saved user message.
- After a completed turn, it calls `sync_thread` with the active conversation's stable message IDs and visible user/assistant text. Tool calls, tool results, and reasoning are excluded.
- Biny's chat memory controls apply: disabling memory recall skips retrieval, and disabling memory contribution skips thread sync.
- MCP failures do not fail the Biny turn. Each automatic request has a five-second timeout. Thread sync is bounded to the service's 5,000-message and 8 MiB limits.
- Automatic MCP calls use Biny's normal schema validation, permission prompts, per-turn tool budget, session events, and result archive.

The conversation is sent to the configured Nowledge Mem service by `sync_thread`; use a local server endpoint if the data should stay on this machine.
