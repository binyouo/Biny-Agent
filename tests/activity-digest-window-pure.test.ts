// Actual complete digest module, native type stripping, inert dependency boundaries only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/activity/digest.ts', import.meta.url), 'utf8');
let isolated = source;
for (const declaration of [
  'import type { ActivityHttpSessionRecord, ActivityStore } from "./store.js";\n',
  'import { buildActivitySummary } from "./summary.js";\n'
]) {
  assert.equal(isolated.split(declaration).length, 2, 'Expected exactly one original dependency import.');
  isolated = isolated.replace(declaration, '');
}
assert.doesNotMatch(isolated, /^import\b/mu);
const javascript = stripTypeScriptTypes(isolated, { mode: 'strip' }).replace(/^export /gmu, '');
assert.doesNotMatch(javascript, /\b(?:import|require)\s*\(/u);
interface DigestRow {
  id: string;
  startedAt: number;
  durationMs: number;
  analysisStatus: string;
  analysisTitle: string;
  analysisDescription: string;
}
interface ActiveRow {
  id: string;
  startedAt: number;
  appNames: string[];
  eventCount: number;
  snapshotCount: number;
}
interface Query { since: number; limit: number }
interface Stats { totalActiveMs: number; sessionCount: number; apps: Array<{ app: string; durationMs: number }> }
interface InertStore {
  sourceRows: readonly Readonly<DigestRow>[];
  queries: Query[];
  activeCalls: number[];
  ocrCalls: Array<{ id: string; limit: number }>;
  stats: Stats;
  listHttpSessions(options: Query): DigestRow[];
  listOpenHttpSessions(limit: number): ActiveRow[];
  listSessionOcrExcerpts(id: string, limit: number): string[];
}
interface DigestResult { markdown: string; lookbackMin: number; sinceIso: string; sessions: number; analyzed: number }
interface DigestApi {
  buildActivityDigest(deps: { store: InertStore; now: () => Date; limit?: number; maxAnalyzed?: number }, lookbackMin?: number): Promise<DigestResult>;
  resolveDigestWindow(lookbackMin: number, now: Date): string;
}
const summaryCalls: Array<{ store: InertStore; kind: string; dateKey: string; now: Date; limit: number }> = [];
const api = runInNewContext(`${javascript}\n({ buildActivityDigest, resolveDigestWindow });`, {
  Date,
  Math,
  String,
  buildActivitySummary: (store: InertStore, kind: string, dateKey: string, now: Date, limit: number) => {
    summaryCalls.push({ store, kind, dateKey, now, limit });
    return { stats: store.stats };
  }
}, { contextCodeGeneration: { strings: false, wasm: false }, timeout: 1000 }) as DigestApi;
const now = new Date('2026-10-24T12:00:00.000Z');
const minute = 60000;
const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
function makeStore({ empty = false, extras = false }: { empty?: boolean; extras?: boolean } = {}): InertStore {
  const queries: Query[] = [];
  const activeCalls: number[] = [];
  const ocrCalls: Array<{ id: string; limit: number }> = [];
  const rows = Object.freeze([3, 30, 170, 1500].map(age => Object.freeze({
    id: `age-${age}`, startedAt: now.getTime() - age * minute,
    durationMs: 2 * minute, analysisStatus: 'analyzed', analysisTitle: `Title ${age}`,
    analysisDescription: '  detail\n text  '
  })));
  return {
    sourceRows: rows, queries, activeCalls, ocrCalls,
    stats: extras ? { totalActiveMs: 10 * minute, sessionCount: 2, apps: [{ app: 'Example', durationMs: 10 * minute }] }
      : { totalActiveMs: 0, sessionCount: 0, apps: [] },
    listHttpSessions(options) {
      queries.push({ since: options.since, limit: options.limit });
      return empty ? [] : rows.filter(row => row.startedAt >= options.since).slice(0, options.limit);
    },
    listOpenHttpSessions(limit) {
      activeCalls.push(limit);
      return extras ? [{ id: 'active', startedAt: now.getTime() - 7 * minute, appNames: ['Editor'], eventCount: 2, snapshotCount: 3 }] : [];
    },
    listSessionOcrExcerpts(id, limit) {
      ocrCalls.push({ id, limit });
      return [' first\n frame ', '', 'x'.repeat(201), 'fourth'];
    }
  };
}
for (const [name, input, effective] of [
  ['CLI lower clamp', 1, 5], ['CLI upper clamp', 2880, 1440],
  ['lower boundary', 5, 5], ['upper boundary', 1440, 1440],
  ['default', undefined, 120], ['ordinary', 180, 180],
  ['direct fractional truncation', 180.9, 180], ['direct zero', 0, 5],
  ['direct negative', -3, 5], ['direct positive infinity', Infinity, 1440],
  ['direct negative infinity', -Infinity, 5]
] satisfies Array<[string, number | undefined, number]>) test(name, async () => {
  const store = makeStore();
  const originalRows = JSON.stringify(store.sourceRows);
  const summaryBefore = summaryCalls.length;
  const result = await api.buildActivityDigest({ store, now: () => now }, input);
  const since = now.getTime() - effective * minute;
  assert.deepEqual(store.queries, [{ since, limit: 200 }], 'Actual query clamp and source cap must stay unchanged.');
  assert.equal(api.resolveDigestWindow(input ?? 120, now), new Date(since).toISOString(), 'Public window function must stay unchanged.');
  assert.equal(result.sinceIso, new Date(since).toISOString());
  assert.equal(JSON.stringify(store.sourceRows), originalRows, 'Input records must not change.');
  assert.equal(summaryCalls.length, summaryBefore + 1);
  assert.deepEqual(summaryCalls.at(-1), { store, kind: 'daily', dateKey, now, limit: 500 });
  assert.deepEqual(store.activeCalls, [1]);
  const ids = [3, 30, 170, 1500].filter(age => age <= effective).map(age => `age-${age}`);
  assert.equal(result.sessions, ids.length);
  assert.equal(result.analyzed, ids.length);
  assert.deepEqual(store.ocrCalls, ids.map(id => ({ id, limit: 4 })));
  for (const id of ids) assert.ok(result.markdown.includes(`\`${id}\``));
  assert.equal(result.lookbackMin, effective, 'Reported lookback must be the actual query window.');
  assert.ok(result.markdown.includes(`**Recent sessions (last ${effective} min):**`), 'Displayed window must equal actual query window.');
  assert.equal(JSON.parse(JSON.stringify(result)).lookbackMin, effective);
});
test('NaN retains RangeError before store queries', async () => {
  const store = makeStore();
  const before = summaryCalls.length;
  assert.throws(() => api.resolveDigestWindow(NaN, now), RangeError);
  await assert.rejects(api.buildActivityDigest({ store, now: () => now }, NaN), RangeError);
  assert.deepEqual(store.queries, []);
  assert.deepEqual(store.activeCalls, []);
  assert.equal(summaryCalls.length, before);
});
test('empty recent result stays empty', async () => {
  const store = makeStore({ empty: true });
  const result = await api.buildActivityDigest({ store, now: () => now }, 120);
  assert.equal(result.markdown, '_No recent activity recorded._');
  assert.equal(result.sessions, 0);
  assert.equal(result.analyzed, 0);
  assert.deepEqual(store.ocrCalls, []);
});
test('active, today, limits, descriptions and OCR stay unchanged', async () => {
  const store = makeStore({ extras: true });
  const result = await api.buildActivityDigest({ store, now: () => now, limit: 3, maxAnalyzed: 1 }, 180);
  assert.deepEqual(store.queries, [{ since: now.getTime() - 180 * minute, limit: 3 }]);
  assert.equal(result.sessions, 1);
  assert.equal(result.analyzed, 1);
  assert.deepEqual(store.ocrCalls, [{ id: 'age-3', limit: 4 }]);
  const started = new Date(now.getTime() - 3 * minute);
  const localTime = `${String(started.getHours()).padStart(2, '0')}:${String(started.getMinutes()).padStart(2, '0')}`;
  assert.equal(result.markdown, [
    '# Recent activity digest', '',
    '**Active session** (active) — Editor, started 7 min ago, 2 events / 3 snapshots.', '',
    '**Today**: 10 min active across 2 sessions. Top apps: Example (10m).', '',
    '**Recent sessions (last 180 min):**',
    `- \`age-3\` — ${localTime} (2m) **Title 3**`,
    '  -  detail text ',
    '  - OCR:  first frame ',
    `  - OCR: ${'x'.repeat(200)}…`,
    '  - OCR: fourth'
  ].join('\n'));
});
