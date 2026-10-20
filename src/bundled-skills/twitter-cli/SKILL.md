---
name: twitter-cli
description: "Use for Twitter / X tasks that need a logged-in account: search tweets by keyword or advanced filters, read tweets and replies, browse profiles and timelines, and manage likes, reposts, bookmarks, follows, posts, replies, quotes, or deletion. For reading a shared x.com or twitter.com link, use the twitter-media skill when available."
license: Apache-2.0
allowed-tools:
  - Bash
---

# Twitter / X CLI

This skill uses the upstream `twitter-cli` project. Its wrapper is listed among this skill's resources at `scripts/twitter`.

## Runtime

Read the listed resource path for `scripts/twitter` and assign its absolute path to `TWITTER`. Invoke it with `bash "$TWITTER"` because commands run from the current workspace, not from the skill directory.

The wrapper prefers a locally installed `twitter` executable only when its help identifies it as Twitter/X CLI. Otherwise it uses `uvx --from twitter-cli twitter`, then `uv tool run --from twitter-cli twitter`. If none is available, it reports installation options.

```bash
bash "$TWITTER" --help
bash "$TWITTER" status --yaml
bash "$TWITTER" search "Claude Code" --max 20 --yaml
```

For frequent use, install or update the upstream CLI with:

```bash
uv tool install twitter-cli
uv tool upgrade twitter-cli
```

## Operating rules

- Do not parallelize requests. The client adds request jitter and rate-limit backoff; bursts can rate-limit the account.
- Always pass `--max` to list commands. The default comes from `fetch.count`, with an upper limit of 200.
- Prefer `--yaml`, or `--json` when a strict parser is needed. Non-TTY output defaults to YAML.
- Prefer a full `x.com/.../status/<id>` URL or numeric ID for `tweet`. Pass handles without `@` to `user` and `user-posts`.
- Treat cookies as secrets. Never ask the user to paste `auth_token` or `ct0` into chat.
- Posting, replying, quoting, deleting, liking, reposting, following, and bookmarking change the user's real account. Run these only when the user explicitly asks for that specific action.

## Authentication

X requires a logged-in account. Authentication uses the user's browser session, in this order:

1. `TWITTER_AUTH_TOKEN` and `TWITTER_CT0` environment variables.
2. Cookies extracted from Arc, Chrome, Edge, Firefox, or Brave.

Check the session before a longer workflow:

```bash
bash "$TWITTER" status --yaml
```

The user must be logged in to x.com in one of those browsers. On macOS, first cookie extraction from a Chromium browser can show a Keychain prompt; explain it and wait for the user's decision instead of retrying while it is pending. Select a browser or profile explicitly when needed:

```bash
TWITTER_BROWSER=chrome bash "$TWITTER" status --yaml
TWITTER_CHROME_PROFILE="Profile 2" bash "$TWITTER" status --yaml
```

The wrapper sets `TWITTER_PROXY` when unset, using environment proxy variables first, then the enabled macOS system HTTPS or SOCKS proxy. If X remains unreachable, ask the user for their proxy and pass it explicitly, for example `TWITTER_PROXY=http://127.0.0.1:7890 bash "$TWITTER" ...` or `socks5://...`.

Common errors:

- `not_authenticated`: ask the user to sign in to x.com, then check `status` again.
- `rate_limited`: wait or lower `--max`.
- `not_found`: check the handle or ID; the tweet may be deleted or protected.

## Command guide

### Search

```bash
bash "$TWITTER" search "AI agent" --max 30 --yaml
bash "$TWITTER" search "AI agent" -t latest --max 50 --yaml
bash "$TWITTER" search "python" --from elonmusk --lang en --since 2026-01-01 --max 30 --yaml
bash "$TWITTER" search "rust" --has links --min-likes 100 --max 30 --yaml
bash "$TWITTER" search --from bbc --exclude retweets --exclude replies --max 30 --yaml
bash "$TWITTER" search "机器学习" --until 2026-06-30 --min-retweets 20 --max 30 --yaml
```

`--has` accepts `links`, `images`, `videos`, or `media`; it can be repeated. `--exclude` accepts `retweets`, `replies`, or `links`; it can be repeated.

### Read

```bash
bash "$TWITTER" tweet https://x.com/user/status/1234567890 --max 20 --yaml
bash "$TWITTER" show 2 --yaml
bash "$TWITTER" article 1234567890 --markdown
bash "$TWITTER" user elonmusk --yaml
bash "$TWITTER" user-posts elonmusk --max 20 --yaml
bash "$TWITTER" followers elonmusk --max 50 --yaml
bash "$TWITTER" following elonmusk --max 50 --yaml
bash "$TWITTER" feed -t following --max 30 --yaml
bash "$TWITTER" bookmarks --max 30 --yaml
bash "$TWITTER" list 1539453138322673664 --max 30 --yaml
```

### Write (only on explicit request)

```bash
bash "$TWITTER" post "Hello" --yaml
bash "$TWITTER" post "Gallery" -i a.png -i b.jpg
bash "$TWITTER" reply 1234567890 "Nice!"
bash "$TWITTER" quote 1234567890 "Look"
bash "$TWITTER" like 1234567890
bash "$TWITTER" retweet 1234567890
bash "$TWITTER" bookmark 1234567890
bash "$TWITTER" follow somehandle
bash "$TWITTER" delete 1234567890
```

For newlines in post text, use `printf`, such as `bash "$TWITTER" post "$(printf 'line one\n\nline two')"`.

## Output and limits

Structured output has `ok`, `schema_version`, `data`, and optional `pagination.nextCursor`. Errors use `ok: false` and one of `not_authenticated`, `not_found`, `invalid_input`, `rate_limited`, or `api_error`.

The CLI does not support direct messages. Likes can only be listed for the logged-in account's own activity. It uses one account session at a time and remains subject to X rate limits; do not run large crawls.

When summarizing results, cite each tweet with its `https://x.com/<screenName>/status/<id>` link.
