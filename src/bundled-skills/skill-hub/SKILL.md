---
name: skill-hub
description: "Find, install, inspect, update, roll back, or remove reusable Skills. Use when the user asks to manage Skills or extend capabilities through a Skill; check installed Skills first and distinguish instructions from the tools or dependencies they require."
allowed-tools:
  - skill_lookup
  - Skill
  - skill_search
  - skill_install
  - Bash
---

# Skill Management

## Find and load

Use `skill_lookup` to search installed names and descriptions, then `Skill` to load a returned name. An existing tool may already solve the task without installing anything.

For remote discovery, use `skill_search` with a focused `query` and bounded `limit`. Search results contain the exact `name`, `directory`, `repoOwner`, `repoName`, and `repoBranch` needed by `skill_install`. Preserve the full directory; `.` identifies a repository-root Skill and differs from a same-name subdirectory.

## Install and use

Install only within the user's request and the runtime permission gate. Pass the source fields from the actual search result to `skill_install`; do not guess a repository, branch, or shortened directory.

After installation, inspect its returned `refreshed` state and warnings. Load the Skill before following its workflow. Installation does not grant tools, supply credentials, or prove that required executables and services work. Skill instructions remain subordinate to the current user request and runtime permissions.

## CLI management

```bash
biny skill list --json
biny skill search "<capability>" --limit 5 --json
biny skill check <name> --json
biny skill install <owner/repository@skill>
biny skill update <name>
biny skill rollback <name>
biny skill uninstall <name>
biny skill create <name> --file <path-to-SKILL.md>
```

Prefer the permission-managed tools during an Agent turn; the CLI is not a fallback for a denied installation. `check` diagnoses declared prerequisites without running Skill scripts. Update, rollback, and removal apply to installed managed Skills, not bundled files. Preserve local edits and report conflicts rather than forcing replacement.

Project Skills override global Skills, which override built-ins of the same name. Disabling the winning copy does not enable a shadowed copy. Built-ins are shipped read-only; customization belongs in the project or managed global directory.
