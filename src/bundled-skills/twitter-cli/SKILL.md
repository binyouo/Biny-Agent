---
name: twitter-cli
description: "Use for Twitter / X tasks that need a logged-in account: search tweets by keyword or advanced filters (from/to user, language, date range, min likes, media), read a tweet with its replies, browse a user's posts/profile/followers, the home timeline, bookmarks, lists and Articles, and like/retweet/bookmark/follow/post/reply/quote/delete. For simply reading one shared x.com / twitter.com link, the twitter-media skill (no login) is enough."
license: Apache-2.0
allowed-tools:
  - Bash
---

# Twitter / X CLI Skill

This bundled skill wraps the upstream `twitter-cli` project by `jackwener` (same author as the bundled `xiaohongshu-cli`).
Project: https://github.com/jackwener/twitter-cli. Check the installed command's help when a flag or response shape differs.

## Runtime

Resolve the absolute path of the listed `scripts/twitter` Skill resource into `TWITTER_CLI`. Invoke it with `bash "$TWITTER_CLI"`; the packaged script need not be executable. Set this path in each Bash invocation and keep the current working directory in the user's workspace.

- It prefers a locally installed `twitter` (only if it is this CLI).
- If missing, it falls back to `uvx --from twitter-cli twitter`.
- If only `uv` exists, it falls back to `uv tool run --from twitter-cli twitter`.

Examples:

```bash
bash "$TWITTER_CLI" --help
bash "$TWITTER_CLI" status --yaml
bash "$TWITTER_CLI" search "Claude Code" --max 20 --yaml
```

The wrapper may download dependencies through uv on first use. Install or upgrade persistently only when the user requests that change:

```bash
uv tool install twitter-cli
uv tool upgrade twitter-cli
```

## Operating Rules

- Do not parallelize requests. The upstream client adds request jitter and rate-limit backoff for account safety; bursts get the account rate-limited.
- Always pass `--max` to bound list commands (default comes from `fetch.count`, up to 200).
- Prefer `--yaml` (or `--json` when a strict parser is needed). Non-TTY stdout already defaults to YAML.
- Prefer a full `x.com/.../status/<id>` URL or numeric id for `tweet`; `user-posts` / `user` take the handle without `@`.
- Treat cookies as secrets. Never ask the user to paste `auth_token` / `ct0` into chat.
- Write actions (post, reply, quote, delete, like, retweet, follow, bookmark) act on the user's real account: only run them when the user explicitly asked for that exact action.

## Authentication

X has no anonymous search, so this CLI uses the user's own logged-in browser session. Auth priority:

1. Environment variables `TWITTER_AUTH_TOKEN` + `TWITTER_CT0`
2. Browser cookies, auto-extracted from Arc / Chrome / Edge / Firefox / Brave

Check before longer workflows:

```bash
bash "$TWITTER_CLI" status --yaml
```

Notes:

- The user must be logged in to x.com in one of those browsers.
- On macOS the first extraction from a Chromium browser may show a Keychain prompt ("Chrome Safe Storage"). Tell the user to expect it and allow it; do not retry in a loop while it is pending.
- Pick a browser or profile explicitly when needed:

```bash
TWITTER_BROWSER=chrome bash "$TWITTER_CLI" status --yaml
TWITTER_CHROME_PROFILE="Profile 2" bash "$TWITTER_CLI" status --yaml
```

- Proxy: `bash "$TWITTER_CLI"` sets `TWITTER_PROXY` automatically when unset, from `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY`, else from the enabled macOS system proxy (`scutil --proxy`, HTTPS then SOCKS). If x.com is still unreachable (DNS timeout, connection reset), ask the user for their proxy and pass it explicitly: `TWITTER_PROXY=http://127.0.0.1:7890 bash "$TWITTER_CLI" ...` (or `socks5://...`).

Common recovery paths:

- `not_authenticated`: ask the user to log in to x.com in their browser, then retry `status`
- `rate_limited`: wait a few minutes or lower `--max`
- `not_found`: wrong handle / id, or the tweet was deleted or is protected

## Command Guide

### Search

```bash
bash "$TWITTER_CLI" search "AI agent" --max 30 --yaml
bash "$TWITTER_CLI" search "AI agent" -t latest --max 50 --yaml       # top | latest | photos | videos
bash "$TWITTER_CLI" search "python" --from elonmusk --lang en --since 2026-01-01 --yaml
bash "$TWITTER_CLI" search "rust" --has links --min-likes 100 --yaml
bash "$TWITTER_CLI" search --from bbc --exclude retweets --exclude replies --yaml
bash "$TWITTER_CLI" search "机器学习" --until 2026-06-30 --min-retweets 20 --yaml
```

`--has`: `links | images | videos | media` (repeatable). `--exclude`: `retweets | replies | links` (repeatable).

### Read

```bash
bash "$TWITTER_CLI" tweet https://x.com/user/status/1234567890 --max 20 --yaml   # tweet + replies
bash "$TWITTER_CLI" show 2 --yaml                 # item #2 from the last feed/search output
bash "$TWITTER_CLI" article 1234567890 --markdown # X Article as Markdown
bash "$TWITTER_CLI" user elonmusk --yaml
bash "$TWITTER_CLI" user-posts elonmusk --max 20 --yaml
bash "$TWITTER_CLI" followers elonmusk --max 50 --yaml
bash "$TWITTER_CLI" following elonmusk --max 50 --yaml
bash "$TWITTER_CLI" feed -t following --max 30 --yaml   # for-you | following
bash "$TWITTER_CLI" bookmarks --max 30 --yaml
bash "$TWITTER_CLI" list 1539453138322673664 --yaml
```

### Write (only on explicit request)

```bash
bash "$TWITTER_CLI" post "Hello" --yaml
bash "$TWITTER_CLI" post "Gallery" -i a.png -i b.jpg
bash "$TWITTER_CLI" reply 1234567890 "Nice!"
bash "$TWITTER_CLI" quote 1234567890 "Look"
bash "$TWITTER_CLI" like 1234567890
bash "$TWITTER_CLI" retweet 1234567890
bash "$TWITTER_CLI" bookmark 1234567890
bash "$TWITTER_CLI" follow somehandle
bash "$TWITTER_CLI" delete 1234567890
```

Newlines in post text: use `printf`, e.g. `bash "$TWITTER_CLI" post "$(printf 'line one\n\nline two')"`.

## Structured Output

```yaml
ok: true
schema_version: "1"
data: ...
pagination:
  nextCursor: "optional-cursor"
```

Errors:

```yaml
ok: false
schema_version: "1"
error:
  code: not_authenticated
  message: ...
```

Error codes: `not_authenticated`, `not_found`, `invalid_input`, `rate_limited`, `api_error`.

## Recommended Flow

Search, then drill into the interesting tweets:

```bash
bash "$TWITTER_CLI" search "Biny app" -t latest --max 20 --json |
  jq -r '.data[] | "\(.id)\t\(.author.screenName)\t\(.text[0:80])"'
bash "$TWITTER_CLI" tweet <id> --max 30 --yaml
```

When summarizing results, cite each tweet with its `https://x.com/<screenName>/status/<id>` link.

## Limitations

- No DM support
- `likes` only works for the logged-in account's own likes (X made likes private)
- One account session at a time
- Subject to X rate limits; large crawls are not appropriate
