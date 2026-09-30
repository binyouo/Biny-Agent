import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSessionEvents } from "../src/session/events.js";
import { activeSessionMessageIds, sessionMessageTree } from "../src/session/messageTree.js";
import { clearSessionParseCache } from "../src/session/parseCache.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { measureSessionRead } from "./helpers/sessionReadMetrics.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-history-bench-"));
const baseline = process.env.HISTORY_BASELINE === "1";
try {
  for (const count of [20, 20_000]) {
    clearSessionParseCache();
    const file = path.join(root, `${count}.jsonl`);
    const events: SessionEvent[] = Array.from({ length: count }, (_, index) => ({
      type: "user_message", content: "history benchmark ".repeat(16), messageId: `u${index}`, parentMessageId: index ? `u${index - 1}` : undefined
    }));
    await fs.writeFile(file, events.map((event) => JSON.stringify(event) + "\n").join(""));
    const sendHistory = async (): Promise<number> => {
      const loaded = await readSessionEvents(file);
      const nodes = baseline ? undefined : sessionMessageTree(loaded);
      const active = nodes ? activeSessionMessageIds(loaded, nodes) : activeSessionMessageIds(loaded);
      return (nodes ?? sessionMessageTree(loaded)).filter((node) => active.has(node.id)).length;
    };
    const cold = await measureSessionRead(sendHistory);
    const unchanged = await measureSessionRead(sendHistory);
    const appended = [];
    for (let i = 0; i < 5; i++) {
      await fs.appendFile(file, JSON.stringify({ type: "user_message", content: "next question", messageId: `u${count + i}`, parentMessageId: `u${count + i - 1}` }) + "\n");
      appended.push((await measureSessionRead(sendHistory)).metrics);
    }
    console.log(JSON.stringify({ mode: baseline ? "before" : "after", events: count, sourceBytes: (await fs.stat(file)).size, cold: cold.metrics, unchanged: unchanged.metrics, appended }));
  }
} finally { await fs.rm(root, { recursive: true, force: true }); }
