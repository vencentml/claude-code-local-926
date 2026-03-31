# Run Claude Code with a local Kimi bridge

This repository ships the published Claude Code bundle in `package/cli.js`.
The easiest way to run it against Kimi is to keep Claude Code unchanged and
put a local Anthropic-compatible proxy in front of Kimi.

## Local setup

1. Copy `.env.kimi.example` to `.env.kimi`.
2. Fill in `KIMI_API_KEY`.
3. Set `KIMI_MODEL` to a model your Kimi account can access.
4. Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-claude-with-kimi.ps1
```

You can pass normal Claude Code flags through the script, for example:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-claude-with-kimi.ps1 --help
```

## What the bridge does

- Exposes `POST /v1/messages` locally in Anthropic format.
- Translates Anthropic message history and tool schemas into OpenAI-style
  `/chat/completions` requests for Kimi.
- Converts non-streaming and streaming tool-call responses back into Anthropic
  message events so `package/cli.js` can run unchanged.

## Notes

- `.env.kimi` is ignored by git.
- The proxy defaults to `https://api.moonshot.cn/v1`.
- If Claude Code requests Anthropic model names, the proxy will use
  `KIMI_MODEL` unless `KIMI_STRICT_MODEL=true` is set.
- This bridge is intended to get the published CLI running quickly. It does
  not add a native Kimi provider to the recovered source tree.
