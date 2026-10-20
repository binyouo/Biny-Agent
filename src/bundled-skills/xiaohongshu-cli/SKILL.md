---
name: xiaohongshu-cli
description: "Use for Xiaohongshu / 小红书 / Rednote tasks: check login, search and read notes or profiles, inspect comments, browse feeds, manage follows, favorites and comments, publish image notes, or delete your own notes."
license: Apache-2.0
allowed-tools:
  - Bash
---

# Xiaohongshu CLI

This skill uses the upstream `xiaohongshu-cli` command through the listed `scripts/xhs` resource. Read that resource's absolute path into `XHS`, then invoke it with `bash "$XHS"`; commands run from the current workspace.

```bash
bash "$XHS" --help
bash "$XHS" status --yaml
bash "$XHS" search "美食" --sort popular --type video --json
```

The wrapper uses an installed `xhs` command, then `uvx`, then `uv tool run`. If none is available, explain how to install `xiaohongshu-cli`; do not install it without a user request.

## Authentication

Check authentication before a write action or a longer read workflow:

```bash
bash "$XHS" status --yaml
bash "$XHS" whoami --yaml
```

If authentication is missing and the user wants to continue, use `login` for browser cookie extraction or `login --qrcode`. Browser cookie access may show a macOS Keychain prompt; explain it and wait for the user's decision while it is pending. Never ask the user to paste cookies into chat.

Common errors include `not_authenticated`, `verification_required`, `ip_blocked`, `signature_error`, and `api_error`. For a captcha, ask the user to complete it in a browser before retrying. For an IP block, explain that the service refused this network and wait for direction.

## Read and discover

```bash
bash "$XHS" search "美食" --sort popular --type video --json
bash "$XHS" read "<note URL or ID>" --json
bash "$XHS" comments "<note URL or ID>" --all --json
bash "$XHS" sub-comments <note-id> <comment-id> --json
bash "$XHS" user <user-id> --json
bash "$XHS" user-posts <user-id> --json
bash "$XHS" topics "旅行" --json
bash "$XHS" search-user "摄影" --json
bash "$XHS" feed --json
bash "$XHS" hot -c food --json
bash "$XHS" my-notes --json
bash "$XHS" favorites --json
bash "$XHS" unread --json
bash "$XHS" notifications --type mentions --json
```

Prefer a complete note URL when available; it can carry the token needed to read the note and comments. Parse structured output and cite the original note URL in summaries. The CLI does not download media.

## Actions

Like, favorite, comment, reply, follow, post, and delete change the user's account or publish content. Perform an action only when the user explicitly requests that specific action. Do not infer permission from a general request to review, summarize, or research a note.

```bash
bash "$XHS" like <note URL or ID>
bash "$XHS" favorite <note URL or ID>
bash "$XHS" comment <note URL or ID> -c "<comment>"
bash "$XHS" reply <note URL or ID> --comment-id <comment-id> -c "<reply>"
bash "$XHS" follow <user-id>
bash "$XHS" post --title "<title>" --body "<body>" --images <image-path>
bash "$XHS" delete <note-id>
```

Posting currently supports image notes. For paragraph breaks, pass actual newlines in the body. The CLI has no direct messages, livestream tools, follower/following lists, or media downloads, and uses one account session at a time.
