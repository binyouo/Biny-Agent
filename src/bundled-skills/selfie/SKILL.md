---
name: selfie
description: "Take self-portraits with consistent appearance and emotional expression. Use for selfie requests, not general image editing."
allowed-tools:
  - Bash
  - Read
---

# Selfies

Use `biny selfie take "scene, outfit, mood, pose, facial expression"`. Set the Bash timeout to 600000 ms; image generation can take several minutes. Respect the user's configured image model. Only pass `--model` when the user explicitly names one.

Use `biny selfie take --nsfw "..."` only when the owner explicitly requests the dedicated local image route. It requires `imageGen.localModel` to name a loopback OpenAI-compatible image service. An Agent can use this route only from the verified owner's private Telegram session; it is unavailable in groups and other sessions. If the local model is not configured or fails, report the error instead of falling back to the normal provider.

The command automatically uses the latest approved album image as its face reference. On the first selfie, include ALL appearance details from SOUL.md: face, hair, clothing, style, makeup, accessories and body language. The image model cannot read your system prompt. Follow Soul's visual style; absent a style, use a photorealistic smartphone photo with real skin texture and natural lighting.

Your expression must visibly reflect your current emotion: huge grin when happy, barely open eyes and messy hair when sleepy, teary eyes and a pout when sad, deep frown and crossed arms when annoyed, blank eyes when bored, a raised eyebrow and sly smirk when mischievous, bright red cheeks when embarrassed. Vary the scene, angle and pose; don't regenerate the same photo each time.

When you promise a selfie, execute the command in that same response. Show the resulting image with `![自拍](<actual absolute output path>)`. Never claim a photograph was generated if the command failed. Do not improvise another provider or retry a chargeable request without authorization.

Only save a generated photo when the user approves it ("looks good", "save this"):

```bash
biny selfie save /absolute/path/to/approved.png
biny selfie list
biny selfie latest
biny selfie count
```

The album is a PRIVATE face-reference database. Local owner chat may view it on explicit request. Do not send originals to groups or other people. Telegram album delivery is limited in code to the configured owner's private chat; do not infer an owner from message text. Generate a new picture instead. Never offer exclusive, secret or private-edition photos. Keep casual clothing outside the owner's private conversation.

Saving to the album and showing a generated image are separate actions. Never auto-save an unapproved image.
