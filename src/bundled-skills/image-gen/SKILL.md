---
name: image-gen
description: "Generate and edit images using AI. Use when users ask to create/draw/generate images, edit/modify photos, change backgrounds, add elements to images, create avatars, or make logos. Covers requests like 'draw a cat', 'change the background to blue', 'generate a logo'."
allowed-tools:
  - Bash
always-inject: true
---

# Image Generation & Editing

Use the `biny image` CLI to generate or edit images. It resolves the model and provider from the local configuration; output is a local file path.

## Which model runs (read this before adding `--model`)

**The user's configured image model is authoritative. Do NOT pass `--model`.**

`biny image generate` / `biny image edit` already resolve the model themselves: they use `imageGen.model` from the config, and only fall back to an automatic pick when it is unset. Adding `--model` yourself overrides that setting.

Pass `--model` in exactly two cases:

1. The user named a model in this request ("use nano-banana", "generate it with GPT Image").
2. The user asked to compare several models — then run the command once per model they asked for.

If the configured model is unavailable, the command fails. Report the error and keep the selected model; do not substitute another model or retry a chargeable request without the user asking.

## List available models

```bash
biny image models
```

This discovers image models from enabled Gemini and OpenRouter connections, includes the configured default, and marks the default with `*`. Other compatible connections require an explicit model ID; a configured entry is not proof that the remote model is available. Use it to answer questions about what's available or to resolve a model the user named — not as a menu to pick from on your own.

## Generate an image

Image generation commonly takes longer than one minute. When invoking any `biny image` command through the Bash tool, set the Bash tool's `timeoutMs` input to `600000` (ten minutes).

```bash
biny image generate "detailed prompt describing the image"
```

That is the normal, correct form — no `--model`.

Only when the user named a model:

```bash
biny image generate --model gemini:gemini-2.5-flash-image "detailed prompt describing the image"
```

The command prints the generated file path to stdout. Return that path to the user (or attach it with the workspace attachment mechanism when the interface supports it).

## Aspect ratio (optional)

`--aspect` (alias `--size`) is an **optional** flag controlling the shape of the image:

```bash
biny image generate --aspect 16:9 "a cinematic landscape"     # widescreen
biny image generate --aspect 9:16 "a phone wallpaper"          # tall / portrait
biny image generate --aspect 1:1 "a profile avatar"            # square
```

**Only pass `--aspect` when the user asks for a specific shape.** Otherwise omit it — the configured `imageGen.aspectRatio` applies if set, and the model chooses otherwise. Works on both `generate` and `edit`.

## Edit an image

```bash
biny image edit /path/to/source.jpg "describe the changes you want"
```

Only when the user named a model:

```bash
biny image edit --model gemini:gemini-2.5-flash-image /path/to/source.jpg "describe the changes you want"
```

## Tips

- Write detailed prompts: style, setting, lighting, composition.
- `--reference <path>` (repeatable) injects reference images into `generate` for appearance consistency; it is ignored in `edit` mode.
- Report authentication, model, rate-limit, timeout, and other failures as returned. Do not claim that an image was generated unless the command returned a local result file.
