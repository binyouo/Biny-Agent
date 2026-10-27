import type { EventEmitter } from "node:events";

// Only for serialized CLI imports whose entrypoint registers one fresh error
// handler per stream. An ambiguous delta is diagnosed, never swept away.
export function trackCliErrorListener(stream: Pick<EventEmitter, "rawListeners" | "removeListener">) {
  const previous = stream.rawListeners("error");
  let owned: (typeof previous)[number] | undefined;
  let diagnostic: string | undefined;
  return {
    capture(): void {
      const added = stream.rawListeners("error").filter((listener) => !previous.includes(listener));
      if (added.length === 1) owned = added[0];
      else diagnostic = `Expected one fresh CLI error listener, received ${String(added.length)}.`;
    },
    dispose(): string | undefined {
      if (owned) stream.removeListener("error", owned as Parameters<typeof stream.removeListener>[1]);
      const retained = stream.rawListeners("error").filter((listener) => previous.includes(listener));
      if (retained.length !== previous.length || retained.some((listener, index) => listener !== previous[index])) {
        diagnostic ??= "Preexisting error listeners changed during the CLI invocation.";
      }
      return diagnostic;
    }
  };
}
