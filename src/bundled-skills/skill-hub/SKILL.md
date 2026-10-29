---
name: skill-hub
description: Search, install, and manage Biny skills from the skills.sh ecosystem. Use when the user needs a capability Biny doesn't have yet, or when you encounter a task you can't do with current skills.
allowed-tools:
  - Bash
  - Read
  - Write
---

# Skill Hub

Discover, install, and manage skills to extend Biny's capabilities.

## Search for Skills

```bash
# Search the skills.sh ecosystem
biny skill search <query>

# Examples:
biny skill search weather
biny skill search email
biny skill search calendar
```

## Install a Skill

```bash
biny skill install "<owner/repository@skill-name>" --json
biny skill install "<exact GitHub tree URL from discovery>" --json
```

Use the actual repository, branch, and full directory returned by search. A bare `owner/repository` works only when discovery finds one Skill. If multiple skills or duplicate names exist, select the exact directory with its GitHub tree URL; do not guess a short directory or repository name.

After installation, inspect the returned status and run `biny skill check <installed-name>` for declared dependencies. Installation does not prove that external tools or accounts are ready.

## List Installed Skills

```bash
biny skill list
```

## Uninstall a Skill

```bash
biny skill uninstall <skill-name>
```

## Update Skills

```bash
biny skill update <installed-name>
```

Omit the name only when the user wants to update all managed skills.

## When to Use

- User asks you to do something you can't do with current tools/skills
- You encounter a task that would benefit from a specialized skill
- User explicitly asks to install or find new capabilities
- **Be proactive**: if a task fails because you lack a capability, search for a skill before giving up

## Self-Evolution Flow

1. User asks: "Check the weather for me"
2. You don't have a weather skill → search: `biny skill search weather`
3. Choose the actual matching source returned by search and install it within the user's request.
4. Check its dependencies, load the new Skill, and use it to complete the task.
5. Next time, the skill is already available

## Create a Custom Skill

```bash
biny skill create my-skill --file - << 'EOF'
---
name: my-skill
description: What this skill does
allowed-tools:
  - Bash
  - Read
---

# My Skill

Instructions for the AI on how to use this skill...
EOF
```

## Tips

- Skills installed through `biny skill install` are stored in Biny's managed skill directory (default `~/.config/biny/skills/`; `BINY_AGENT_DIR` can redirect it). They are not symlinked from `~/.agents/skills/`.
- Project-local skills can live in `.biny/skills/` or `.agents/skills/` within any project directory (`.biny/skills/` wins on a name clash)
- After installing a skill, it's available in the next conversation turn
- **Don't give up on the first failure** — search for skills, install them, and try again
