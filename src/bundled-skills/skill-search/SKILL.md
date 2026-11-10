---
name: skill-search
description: "Find and install skills when the user asks for new capabilities or a task requires a capability missing from the available tools and installed skills."
allowed-tools:
  - Bash
---

# Skill Search

Use existing tools and installed skills when they can complete the request. Search for an additional skill only when the user asks or a required capability is actually missing; a failed request alone does not establish that a skill is missing.

## Search Priority

Always search in this order:

1. **Check available tools and <available_skills> first** — use an existing tool when it can complete the task. Skills listed in the prompt can be loaded through Skill directly; do not remotely search for something already available.

2. **Local second** — if nothing in <available_skills> fits, check all installed skills:
   ```bash
   biny skill list
   ```
   A skill you need may already be installed but not selected for this conversation.

3. **Remote last** — search the skills.sh ecosystem for new skills:
   ```bash
   biny skill search <query>
   ```

## Install a Skill

```bash
biny skill install "<owner/repository@skill-name>" --json
```

Use a source returned by search. For an exact nested directory or an ambiguous name, pass the returned GitHub tree URL with its full path. Inspect the installation result and `biny skill check <installed-name>`, then load the installed Skill before executing its workflow.

## When to Use

- You're asked to do something beyond your current capabilities
- A task fails because you lack a specialized skill
- The user asks to find or add new capabilities
