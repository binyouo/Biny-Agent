---
name: image-gen
description: "Generate and edit images using AI. Use when users ask to: create/draw/generate images, edit/modify photos, change backgrounds, add elements to images, create avatars, make logos, etc. Covers requests like 'draw a cat', 'change the background to blue', 'generate a logo'. NOT for selfies — use the selfie skill for 'send a selfie', 'send me a selfie', 'take a selfie'."
allowed-tools:
    - Bash
always-inject: true
---

# Image Generation & Editing Skill

Use the `biny image` command to generate or edit images. It resolves the provider and model from local configuration and returns a local output file.

## Which Model Runs (READ THIS BEFORE ADDING `--model`)

**The user's configured image model is authoritative. Do NOT pass `--model`.**

`biny image generate` / `biny image edit` already resolve the model themselves:
they use the model the user chose in Settings → Image Generation
(`imageGen.model`), and only make an automatic pick when it is unset.
Adding `--model` yourself overrides that setting and silently generates
with a model the user did not ask for.

Pass `--model` in exactly two cases:

1. The user named a model in this request ("use nano-banana", "generate it with
   GPT Image").
2. The user asked to compare several models — then run the command once per
   model they asked for.

Everything else — including "the list showed a model that looks better", "the
first entry is Google", "being explicit seems safer" — is **not** a reason.
There is no "best" model to prefer; only the user's configuration decides.

If the configured model is unavailable, the command fails. Report the returned error; do not silently substitute a model. The CLI accepts explicit model overrides, so respecting the user's choice is your responsibility.

## List Available Models

```bash
biny image models
```

This discovers image models from enabled Gemini and OpenRouter connections, includes the configured default, and marks the default with `*`. Other compatible connections require an explicit model ID; a configured entry is not proof that the remote model is available. Use it to answer questions about what's available or to resolve a model the user named — not as a menu to pick from on your own.

## Generate an Image

Image generation can take several minutes. Set the Bash tool's `timeoutMs` input to `600000` (ten minutes); this is a tool input, not a shell argument.

```bash
biny image generate "detailed prompt describing the image"
```

That is the normal, correct form — no `--model`.

Only when the user named a model:

```bash
biny image generate --model gemini:nano-banana-2 "detailed prompt describing the image"
```

The command prints the generated file path to stdout. Display it with `![Generated image](<actual absolute output path>)`, or attach that actual file when the interface supports attachments.

## Image Size / Aspect Ratio (OPTIONAL)

`--aspect` (alias `--size`) is an **optional** flag controlling the shape of the image. Accepts an aspect ratio:

```bash
biny image generate --aspect 16:9 "a cinematic landscape"     # widescreen
biny image generate --aspect 9:16 "a phone wallpaper"          # tall / portrait
biny image generate --aspect 1:1 "a profile avatar"           # square
```

Common ratios: `1:1` (square), `16:9` / `4:3` / `3:2` (landscape), `9:16` / `3:4` / `2:3` (portrait), or `auto`.

**Only pass `--aspect` when the user requests a particular shape.** Otherwise omit it: `imageGen.aspectRatio` applies if configured, and the model chooses otherwise. Both `generate` and `edit` support it; providers map ratios to their supported sizes.

## Edit an Image

```bash
biny image edit /path/to/source.jpg "describe the changes you want"
```

Only when the user named a model:

```bash
biny image edit --model gemini:gemini-2.5-flash-image /path/to/source.jpg "describe the changes you want"
```

## Selfies

For selfies, use the **selfie** skill instead — it handles face consistency, album management, and photorealistic prompting automatically.

## Tips

- Write detailed prompts: style, setting, lighting, composition.
- Display the actual output image; a text-only promise is not a generated image.
- Omit `--model` unless the user named a model or asked for a comparison.
- `--reference <path>` is repeatable for `generate`; it is not supported by `edit`.
- Report authentication, model, rate-limit, timeout, and other errors as returned. Do not claim success without a local result file or retry a chargeable request without authorization.
- Do not infer a current outage from a past failure. Inspect the current command's result.
