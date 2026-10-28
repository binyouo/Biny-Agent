---
name: xiaohongshu-cli
description: "Use for ANY Xiaohongshu / 小红书 / Rednote / Little Red Book task: login, account status, search notes/users/topics, read note details/comments, browse feed and hot lists, like/favorite/comment/reply, follow/unfollow, check favorites/notifications/my-notes, post image notes, and delete your own notes."
license: Apache-2.0
allowed-tools:
  - Bash
---

# Xiaohongshu CLI Skill

This bundled skill wraps the upstream `xiaohongshu-cli` project by `jackwener`.
Project: https://github.com/jackwener/xiaohongshu-cli. Check the installed command's help when a flag or response shape differs.

## Runtime

Resolve the absolute path of the listed `scripts/xhs` Skill resource into `XHS`. Invoke it with `bash "$XHS"`; the current working directory remains the user's workspace.

- It prefers a locally installed `xhs`.
- If `xhs` is missing, it falls back to `uvx --from xiaohongshu-cli xhs`.
- If only `uv` exists, it falls back to `uv tool run --from xiaohongshu-cli xhs`.

Examples:

```bash
bash "$XHS" --help
bash "$XHS" status --yaml
bash "$XHS" search "美食" --json
```

The wrapper may download dependencies through uv on first use. For heavy or repeated use, these commands install or upgrade the tool when the user requests that change:

```bash
uv tool install xiaohongshu-cli
uv tool upgrade xiaohongshu-cli
```

## Operating Rules

- Do not parallelize `xhs` requests. The upstream client adds jitter, captcha cooldowns, and retry logic for account safety.
- Prefer `--json` or `--yaml` when the result will be parsed. Non-TTY stdout already defaults to YAML.
- Prefer a full Xiaohongshu URL over a bare note ID when the user has one. `read` and `comments` can extract and cache the `xsec_token` from the URL.
- Treat cookies as secrets. Never ask the user to paste raw cookies into chat. Browser extraction may show a macOS Keychain prompt; explain it and let the user decide.
- Likes, comments, replies, follows, publishing, and deletion change the account. Perform only the action the user requested on the identified target; a search or reading request does not authorize an interaction.

## Authentication Workflow

Always check auth before any write action, and before longer read workflows:

```bash
bash "$XHS" status --yaml
```

If authentication is missing or expired:

```bash
# Browser cookie extraction
bash "$XHS" login

# Optional: choose a browser explicitly
bash "$XHS" login --cookie-source arc

# QR login if browser cookie extraction is unavailable
bash "$XHS" login --qrcode
```

Verify after login:

```bash
bash "$XHS" whoami --yaml
```

Common recovery paths:

- `not_authenticated`: rerun `bash "$XHS" login`
- `verification_required`: ask the user to complete the captcha in a browser, then retry
- `ip_blocked`: report that the service refused this network and wait for the user's direction

## Command Guide

### Read and Discover

```bash
bash "$XHS" search "美食" --sort popular --type video --json
bash "$XHS" read "<note_url_or_id>" --json
bash "$XHS" comments "<note_url_or_id>" --all --json
bash "$XHS" sub-comments <note_id> <comment_id> --json
bash "$XHS" user <user_id> --json
bash "$XHS" user-posts <user_id> --json
bash "$XHS" topics "旅行" --json
bash "$XHS" search-user "摄影" --json
bash "$XHS" feed --json
bash "$XHS" hot -c food --json
```

`hot` categories: `fashion`, `food`, `cosmetics`, `movie`, `career`, `love`, `home`, `gaming`, `travel`, `fitness`

### Interactions and Social

```bash
bash "$XHS" like <note_id_or_url>
bash "$XHS" like <note_id_or_url> --undo
bash "$XHS" favorite <note_id_or_url>
bash "$XHS" unfavorite <note_id_or_url>
bash "$XHS" comment <note_id_or_url> -c "好看"
bash "$XHS" reply <note_id_or_url> --comment-id <comment_id> -c "谢谢"
bash "$XHS" delete-comment <note_id> <comment_id>
bash "$XHS" follow <user_id>
bash "$XHS" unfollow <user_id>
bash "$XHS" favorites --json
bash "$XHS" favorites <user_id> --json
```

### Creator and Inbox

```bash
bash "$XHS" my-notes --json
bash "$XHS" post --title "标题" --body "正文" --images /path/to/a.jpg --images /path/to/b.jpg
bash "$XHS" delete <note_id> -y
```

**Newlines in post body**: Bash single-quoted strings do NOT interpret `\n`.
Use `printf` to produce real newlines:

```bash
BODY=$(printf '第一段落\n\n第二段落\n\n第三段落')
bash "$XHS" post --title "标题" --body "$BODY" --images /path/to/img.jpg
bash "$XHS" unread --json
bash "$XHS" notifications --type mentions --json
bash "$XHS" notifications --type likes --json
bash "$XHS" notifications --type connections --json
```

## Structured Output

Machine-readable output uses this envelope:

```yaml
ok: true
schema_version: "1"
data: ...
```

Errors use:

```yaml
ok: false
schema_version: "1"
error:
  code: not_authenticated
  message: ...
```

Common `error.code` values:

- `not_authenticated`
- `verification_required`
- `ip_blocked`
- `signature_error`
- `unsupported_operation`
- `api_error`

## Recommended Flows

Search and inspect first. Only perform the final interaction if the user requested it and the returned item is the intended target:

```bash
bash "$XHS" search "露营" --json
bash "$XHS" read "<selected-note-url-or-id>" --json
bash "$XHS" like "<verified-note-id>"
```

Use pasted URLs for richer analysis:

```bash
bash "$XHS" read "https://www.xiaohongshu.com/explore/xxx?xsec_token=yyy" --json
bash "$XHS" comments "https://www.xiaohongshu.com/explore/xxx?xsec_token=yyy" --all --json
```

## Limitations

- No DM support
- No live-stream features
- No following/followers list API
- No media download support in the upstream CLI
- One account session at a time
- Posting support is centered on image notes
