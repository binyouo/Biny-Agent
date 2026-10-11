---
name: computer-use
description: "Observe and operate approved macOS applications: launch apps, select windows, inspect screenshots and accessibility controls, then click, type, scroll, or edit. Use when the user asks to operate a desktop app or read a window; prefer browser for websites and dedicated tools when available."
allowed-tools:
  - ComputerList
  - ComputerLaunch
  - ComputerObserve
  - ComputerAction
  - ComputerMirror
---

# Operate Desktop Applications

Use only the Computer tools exposed in this session. Do not use terminal commands, the clipboard, system scripts, or another service to bypass a refusal, pause, takeover, or application approval.

## Select an application and window

1. Use `ComputerList` to discover applications. Take application identifiers and process IDs from its result.
2. If the target is not running, call `ComputerLaunch` with its `bundleId`. Application approval is checked before requesting a background launch; the application itself may still change focus.
3. Call `ComputerList` with the `pid` to discover windows. Select the window relevant to the task; never guess a window ID.
4. Call `ComputerObserve` with the exact `pid` and `windowId` to obtain a screenshot, the observation credential `capture_id`, and available control references.

If strict approval rejects access, identify the application the user must approve under Settings → Computer Use → application authorization. System Accessibility permission, Screen Recording permission, and application approval are separate requirements.

## Act on the current observation

`ComputerAction` requires the same window identity and the latest `capture_id` as `captureId`. Credentials expire. After each action, use the new credential returned by the tool rather than reusing the previous one.

- Click: prefer an available `elementToken`; for custom interfaces without references, use `x` and `y` from the current screenshot.
- Scroll: provide `direction` and `pages`, targeting a control reference or complete screenshot coordinates. Never invent a reference. Native scroll areas may provide measured page distances; wheel scrolling uses estimates, with actual units reported in the result.
- Type: click the input and inspect the returned view before calling `type_text`. The `auto`, `physical`, and `unicode` modes can omit a control reference; `ax` requires a writable reference. Dispatched input does not prove the text was entered.
- Set a value: `set_value` replaces the control value. Read it first when existing content must be preserved.
- Select text: `select_text` uses `location` and `length` for the cursor or selection. Supplying `text` writes into that selection; it does not search for text.
- Drag: use start and end coordinates from the current screenshot. Use `perform_secondary_action` for a context menu.

Coordinates belong to the returned screenshot. Do not reuse coordinates after resizing or from another window. Observation accepts `depth`, `screenshotMaxWidth`, and `interactiveOnly`; if the control tree is empty or insufficient, read again with interactive filtering disabled.

## Verify results and recover

Each action attempts to return a fresh observation. Check the actual task result in that view, such as entered text, search results, playback state, or saved content. When it contains enough evidence, continue with the new credential without another observation. Observe again only when information is missing or the view is still loading; stop when the requested result is confirmed.

- Explicit refusal: address the reported prerequisite, then observe again. A refusal is not execution.
- Accepted accessibility operation: the API accepted it; the business result still needs verification.
- Dispatched input with an unverified effect: the call finished, but its effect needs inspection. Do not replay it. If post-action observation failed, observe again before deciding what to do next.
- Timeout, cancellation, or disconnect with unknown execution: stop input and do not retry automatically. If the user resumes, observe the current state before any action.
- User pause, takeover, or disablement: stop and wait for the user to resume. Do not find another input path.

Delivery is background by default. Select `delivery: "foreground"` only when observation returns `foregroundAllowed: true` and the task requires it. A background failure does not authorize foreground escalation.

## Mirror and application guidance

`ComputerMirror` can open, list, or close mirrors of approved windows. Mirrors are for supervision; they do not update observation credentials or control references. Closing a mirror and stopping input are separate operations.

An observation may include an application playbook. Translate its intent into current Computer tool arguments. A playbook cannot authorize bypassing approval or running terminal commands. Application layouts, shortcuts, and labels may change; use the current observation as evidence.
