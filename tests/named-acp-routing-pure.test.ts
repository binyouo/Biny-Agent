/** Source-bound routing regression; all runtime collaborators are inert. No ACP/process/storage imports. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const root = process.cwd();
function load(file: string, dependencies: Record<string, unknown>, suffix = ''): Record<string, any> {
  const source = readFileSync(path.join(root, file), 'utf8');
  const result = ts.transpileModule(source + suffix, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  assert.equal((result.diagnostics?.length ?? 0), 0);
  const exports: Record<string, any> = {};
  const context = vm.createContext({ exports, require(id: string) { if (!(id in dependencies)) throw Error('Unexpected import ' + id); return dependencies[id]; }, Buffer, AbortController, AbortSignal, setTimeout() { return 1; }, clearTimeout() {} }, { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(result.outputText, { filename: file }).runInContext(context, { timeout: 1000 });
  return exports;
}
const agents = load('src/extensions/agents.ts', { 'node:fs': { promises: {} }, 'node:os': { default: { homedir: () => '/synthetic' } }, 'node:path': { default: path }, '../config/paths.js': { globalConfigDir: () => '/synthetic/config' } }, '\nexport const testParseDefinition = parseDefinition;');
let launches: Array<{ launch: { command: string } }> = [], turns: Array<{ model: string }> = [];
const external = load('src/extensions/externalSubagent.ts', {
  './subagentCli.js': { runSubagentCli: async () => 'cli' }, 'node:crypto': { randomUUID: () => 'synthetic' },
  '../acp/client.js': { AcpClient: class { constructor(options: { launch: { command: string } }) { launches.push(options); } async close() {} }, acpMcpServers: () => [] },
  '../acp/turn.js': { async *runAcpTurn(_client: unknown, options: { model: string }) { turns.push(options); yield { type: 'done', content: 'reply', outcome: { status: 'completed' } }; } },
  '../permission/PermissionManager.js': { PermissionManager: class { constructor() { throw Error('Permission collaborator should be injected'); } } },
  '../runtime/WorkerSession.js': { WorkerSession: { open() { throw Error('Persistent worker must not open'); } } },
  '../runtime/SubagentTaskManager.js': { SubagentTaskIncompleteError: class extends Error {} }
});
const config = (): any => ({ permission: { denyPaths: [] }, sandbox: { mode: 'off', allowNetwork: true }, extensions: { subagent: { runtime: 'acp', providerAlias: 'A', inactivityTimeoutMs: 1000 } }, models: { a: { provider: 'A', model: 'wire-A' }, b: { provider: 'B', model: 'wire-B' }, native: { provider: 'N', model: 'native' } }, providers: { A: { type: 'acp', acp: { command: 'A' } }, B: { type: 'acp', acp: { command: 'B' } }, N: { type: 'openai' }, disabled: { type: 'acp', enabled: false, acp: { command: 'disabled' } } } });
const parse = (text: string) => agents.testParseDefinition(`---\nname: coder\ndescription: finite task\nruntime: acp\n${text}\n---\nDo task.`, '/synthetic', '/synthetic/coder.md', 'project');
async function run(definition: unknown, cfg = config()) { launches = []; turns = []; const worker = await external.prepareExternalSubagent({ config: cfg, workspaceRoot: '/synthetic', permissionManager: { getStatus: () => ({ mode: 'full-access' }) } }, 'task', 'workspace', 'acp', definition); try { await worker.run(); } finally { await worker.close(); } return [launches[0]!.launch.command, turns[0]!.model]; }
// Extract the actual public preparation function; stop at inert collaborators.
const subSource = readFileSync(path.join(root, 'src/extensions/subagent.ts'), 'utf8');
const subAst = ts.createSourceFile('subagent.ts', subSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const prepNode = subAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'prepareSubagentTask');
assert.ok(prepNode);
const subExports: Record<string, any> = {};
const subContext = vm.createContext({ exports: subExports, structuredClone,
 ToolRegistry: class { register() {} }, PermissionManager: class {},
 resolveSubagentDefinition: async (options: { loadAgentDefinitions(): Promise<unknown[]> }) => (await options.loadAgentDefinitions())[0],
 findClaudeSubagentCli: async () => { throw Error('UNEXPECTED CLI lookup'); },
 prepareExternalSubagent: async () => { throw Error('UNEXPECTED external preparation'); }
}, { codeGeneration: { strings: false, wasm: false } });
new vm.Script(ts.transpileModule(prepNode.getText(subAst), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText).runInContext(subContext, {timeout:1000});
const cases: Array<[string, () => Promise<void>]> = [
 ['parser preserves connection', async () => assert.equal(parse('providerAlias: B').providerAlias, 'B')],
 ['named connection overrides global connection', async () => assert.deepEqual(await run(parse('providerAlias: B')), ['B','default'])],
 ['named connection overrides global model', async () => { const c=config(); c.extensions.subagent.model='a'; assert.deepEqual(await run(parse('providerAlias: B'), c), ['B','default']); }],
 ['named connection with no global ACP selection', async () => { const c=config(); delete c.extensions.subagent.providerAlias; assert.deepEqual(await run(parse('providerAlias: B'), c), ['B','default']); }],
 ...['toString', 'constructor'].map((model): [string, () => Promise<void>] => [`inherited model ${model} refuses before construction`, async () => { await assert.rejects(run(parse('model: '+model)), /Unknown subagent model/); assert.equal(launches.length,0); }]),
 ['unknown model refuses before construction', async () => { await assert.rejects(run(parse('model: typo')), /Unknown subagent model/); assert.equal(launches.length,0); }],
 ['named model and connection mismatch refuses', async () => { await assert.rejects(run(parse('providerAlias: B\nmodel: a')), /must belong/); assert.equal(launches.length,0); }],
 ['disabled named connection refuses', async () => { await assert.rejects(run(parse('providerAlias: disabled')), /enabled launch/); assert.equal(launches.length,0); }],
 ['unknown named connection refuses', async () => { await assert.rejects(run(parse('providerAlias: missing')), /enabled launch/); assert.equal(launches.length,0); }],
 ['named model selects its own connection', async () => assert.deepEqual(await run(parse('model: b')), ['B','wire-B'])],
 ['matched named pair preserves wire model', async () => assert.deepEqual(await run(parse('providerAlias: B\nmodel: b')), ['B','wire-B'])],
 ['global default unchanged', async () => assert.deepEqual(await run(parse('')), ['A','default'])],
 ['global model unchanged', async () => { const c=config(); c.extensions.subagent.model='a'; assert.deepEqual(await run(parse(''),c), ['A','wire-A']); }],
 ['named native model refuses ACP', async () => { await assert.rejects(run(parse('model: native')), /enabled launch/); assert.equal(launches.length,0); }],
 ['deny paths still reject before construction', async () => { const c=config(); c.permission.denyPaths=['secret']; await assert.rejects(run(parse('providerAlias: B'),c), /denyPaths/); assert.equal(launches.length,0); }],
 ['named tools still reject before construction', async () => { await assert.rejects(run(parse('providerAlias: B\ntools: Read')), /restrictions/); assert.equal(launches.length,0); }]
];
for (const runtime of ['builtin','auto','codex','claude-code']) cases.push([`provider with ${runtime} rejects before runtime selection`, async () => {
  await assert.rejects(subExports.prepareSubagentTask({ config: config(), toolRegistry: { listEntries: () => [] },
    loadAgentDefinitions: async () => [{ runtime, providerAlias: 'B' }],
    getModelSettings: () => { throw Error('UNEXPECTED native resolution'); }
  }, 'task', 'workspace', 'coder'), /providerAlias requires the ACP runtime/);
}]);
for (const [name, check] of cases) test(name, { concurrency: false }, check);
