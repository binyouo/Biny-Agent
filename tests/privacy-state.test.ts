import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopApi, DesktopMaskingOverview } from "../src/desktop/protocol.js";
import { privacyState } from "../src/desktop/renderer/src/components/settings/privacyState.js";

const overview = (total: number): DesktopMaskingOverview => ({ records: [], summary: { total, requests: 1, byKind: {}, byProvider: {} } });

test("privacy summaries coalesce reads, cache per project and retain data on failure", async () => {
  let reads = 0, fail = false;
  const api = { maskingOverview: async (projectId: string) => { reads++; if (fail) throw new Error("fixture"); return overview(projectId === "a" ? 3 : 9); } } as unknown as DesktopApi;
  const a = privacyState(api, "a"), b = privacyState(api, "b");
  await Promise.all([a.refresh(), a.refresh()]);
  assert.equal(reads, 1);
  await privacyState(api, "a").refresh();
  assert.equal(reads, 1);
  await b.refresh();
  assert.equal(b.getSnapshot().data?.summary.total, 9);
  fail = true;
  await a.refresh(true);
  assert.equal(a.getSnapshot().data?.summary.total, 3);
  assert.ok(a.getSnapshot().error);
});

test("clearing records cannot be undone by an older pending overview", { timeout: 3000 }, async () => {
  let resolve!: (value: DesktopMaskingOverview) => void;
  let reads = 0, cleared = false;
  const api = {
    maskingOverview: async () => ++reads === 1 ? await new Promise<DesktopMaskingOverview>((r) => { resolve = r; }) : overview(0),
    maskingClear: async () => { cleared = true; }
  } as unknown as DesktopApi;
  const state = privacyState(api, "a");
  const read = state.refresh();
  await Promise.resolve();
  const clear = state.clear();
  resolve(overview(17));
  await Promise.all([read, clear]);
  assert.equal(cleared, true);
  assert.equal(state.getSnapshot().data?.summary.total, 0);
  assert.equal(state.getSnapshot().loading, false);
});
