/**
 * Untrusted display text, before Markdown or theme code adds terminal styling.
 * Keep LF/TAB as layout whitespace. OSC/APC payloads may remain printable, but
 * their ESC/BEL/C1 controls cannot reach the terminal through this boundary.
 * This is not a filter for rendered ANSI or deliberate PTY passthrough.
 */
export function sanitizeTerminalText(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
}

/** Preserve Markdown's existing CRLF/bare-CR line semantics before filtering. */
export function sanitizeMarkdownText(text: string): string {
  return sanitizeTerminalText(text.replace(/\r\n|\r/gu, "\n"));
}
