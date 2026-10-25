// Source-only regression. Reads repository TypeScript as text, never imports product modules.
// Native records are documented provider fixtures, not measured ripgrep output.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { stripTypeScriptTypes } from 'node:module';



interface NativeMatch { line: number; column: number; text: string }
interface ContextLine { line: number; text: string }
interface SearchMatch extends NativeMatch { path: string; anchor: string; before: ContextLine[]; after: ContextLine[] }
interface RunResult { matches: SearchMatch[]; unreadableFiles: string[]; matchedLines: number; hasMore: boolean; stopSearch: boolean }
interface Snapshot { device: bigint; inode: bigint; size: bigint; mode: bigint; links: bigint; modifiedAt: bigint; changedAt: bigint }
interface Fixture {
  name: string;
  raw: string;
  native: Array<[number, string, number]>;
  columns?: number[];
  offset?: number;
  limit?: number;
  contextLines?: number;
  chunkBytes?: number;
  changedSnapshot?: boolean;
  changedBinding?: boolean;
  reject?: boolean;
  hasMore?: boolean;
}
type CompiledFactory<T> = (...args: unknown[]) => T;
interface HashlineFunctions {
  hashlineAnchor: (line: string, lineNumber: number) => string;
  applyHashlineEdits: (content: string, edits: Array<{op: 'replace'; pos: string; lines: string[]}>) => {content: string; firstChangedLine: number};
}

// Optional source root is for out-of-tree review; checked-in usage defaults to repository root.
const root = process.env.BINY_SOURCE_ROOT ? pathToFileURL(process.env.BINY_SOURCE_ROOT.replace(/\/$/, '') + '/') : new URL('../', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, root), 'utf8');
const rg = read('src/tools/search/ripgrep.ts');
const grep = read('src/tools/search/searchFiles.ts');
const io = read('src/tools/file/safeFileIo.ts');
const hash = read('src/tools/file/hashline.ts');
function select(source: string, start: string, end: string): string {
  assert.equal(source.split(start).length, 2, `source selection must be unique: ${start}`);
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(last > first, `source selection must have terminator: ${end}`);
  return source.slice(first, last);
}
const sources = {
  parser: select(rg, '    const matches = new Map<string, RipgrepMatch[]>();', '  } finally {'),
  verifier: select(grep, '              const hits = new Map(found.map', '              if (stopSearch) break;'),
  iterator: select(io, 'export async function visitBoundUtf8Lines(', 'export class FileReadLimitError'),
  binding: select(io, 'async function assertFileBinding(', '/** 取目标文件快照'),
  snapshot: select(io, 'function fileSnapshot(', 'export function sameOptionalFileSnapshot'),
  same: select(io, 'export function sameFileSnapshot(', '/**\n * 比 `sameFileSnapshot`'),
  hash: hash.replace('import { createHash } from "node:crypto";', '')
};

const compile = <T>(source: string, args: readonly string[] = []): T => new Function('return (' + stripTypeScriptTypes('function extracted (' + args.join(',') + ') {\n' + source.replace(/\bexport /g, '') + '\n}') + ')')() as T;
class RipgrepError extends Error {}
const { hashlineAnchor, applyHashlineEdits } = compile<CompiledFactory<HashlineFunctions>>(sources.hash + '\nreturn { hashlineAnchor, applyHashlineEdits };', ['createHash'])(createHash);
const parse = compile<(stdout: string, nativeFiles: Map<string,string>, error: typeof RipgrepError) => Map<string,NativeMatch[]>>(sources.parser, ['stdout', 'nativeFiles', 'RipgrepError']);
const sameFileSnapshot = compile<() => (left: Snapshot, right: Snapshot) => boolean>(sources.same + '\nreturn sameFileSnapshot;')();

function nativeRows(records: Fixture["native"]): string {
  return records.map(([line, text, byteStart]) => JSON.stringify({type:'match', data:{path:{text:'./fixture.txt'},lines:{text},line_number:line,submatches:[{start:byteStart}]}})).join('\n');
}

async function run(fixture: Fixture): Promise<RunResult> {
  const file = 'fixture.txt';
  const raw = Buffer.from(fixture.raw);
  const stat = {dev:1n,ino:2n,size:BigInt(raw.length),mode:33188n,nlink:1n,mtimeNs:10n,ctimeNs:10n,isFile:()=>true,isSymbolicLink:()=>false};
  let statCalls = 0;
  let closed = false;
  const currentStat = () => fixture.changedSnapshot && statCalls >= 2 ? {...stat,mtimeNs:11n} : stat;
  const handle = {
    async stat() { statCalls++; return currentStat(); },
    async read(buffer: Buffer, offset: number, length: number, position: number) {
      const count = Math.min(length, fixture.chunkBytes ?? 2, raw.length - position);
      raw.copy(buffer, offset, position, position + count);
      return {bytesRead:count};
    },
    async close() { closed = true; }
  };
  const fakeFs = {
    async lstat() { return fixture.changedBinding && statCalls >= 2 ? {...currentStat(),ino:3n} : currentStat(); },
    async realpath(name: string) { return name; }
  };
  const iterator = compile<CompiledFactory<unknown>>(sources.snapshot + sources.binding + sources.iterator + '\nreturn visitBoundUtf8Lines;',
    ['fs','path','openBoundRegularFile','StringDecoder','maxStreamedLineBytes','sameFileSnapshot'])(
      fakeFs,{resolve:(x: string)=>x},async()=>handle,StringDecoder,1024*1024,sameFileSnapshot);
  const initial = {device:1n,inode:2n,size:BigInt(raw.length),mode:33188n,links:1n,modifiedAt:10n,changedAt:10n};
  const found = parse(nativeRows(fixture.native), new Map([['./fixture.txt',file]]), RipgrepError).get(file) ?? [];
  const body = sources.verifier;
  const wrapper = `return (async () => {
    let matches = [], unreadableFiles = [], matchedLines = 0, hasMore = false, stopSearch = false;
    ${body}
    return {matches,unreadableFiles,matchedLines,hasMore,stopSearch};
  })();`;
  const result = await compile<CompiledFactory<Promise<RunResult>>>(wrapper, ['found','file','initial','offset','limit','contextLines','signal','context','resolveWorkspacePath','visitBoundUtf8Lines','sameFileSnapshot','hashlineAnchor','RipgrepError'])(
    found,file,initial,fixture.offset??0,fixture.limit??50,fixture.contextLines??1,undefined,{workspaceRoot:'/inert',ignore:[]},()=>'/inert/fixture.txt',iterator,sameFileSnapshot,hashlineAnchor,RipgrepError);
  assert.equal(closed,true);
  for (const hit of result.matches) {
    assert.equal(hit.anchor,hashlineAnchor(hit.text,hit.line));
    assert.doesNotThrow(()=>applyHashlineEdits(fixture.raw,[{op:'replace',pos:hit.anchor,lines:['proof replacement']}]),'raw anchor remains accepted by actual pure Edit implementation');
  }
  return result;
}

// Fixtures deliberately spell native text/byte offsets separately from raw source.
// rg15 removes one initial EF BB BF, not an embedded/later FEFF; CRLF stays in JSON.
const fixtures: Fixture[] = [
  {name:'first BOM',raw:'\uFEFFneedle\n',native:[[1,'needle\n',0]],columns:[2]},
  {name:'BOM CRLF astral',raw:'\uFEFF😀 needle\r\nnext\r\n',native:[[1,'😀 needle\r\n',5]],columns:[5]},
  {name:'BOM EOF',raw:'\uFEFFneedle',native:[[1,'needle',0]],columns:[2]},
  {name:'double FEFF removes one',raw:'\uFEFF\uFEFFneedle\n',native:[[1,'\uFEFFneedle\n',3]],columns:[3]},
  {name:'second FEFF literal query',raw:'\uFEFF\uFEFFneedle\n',native:[[1,'\uFEFFneedle\n',0]],columns:[2]},
  {name:'empty first line',raw:'\uFEFF\nneedle\n',native:[[2,'needle\n',0]],columns:[1]},
  {name:'empty first line regex hit',raw:'\uFEFF\nneedle\n',native:[[1,'\n',0]],columns:[2]},
  {name:'later FEFF is literal',raw:'first\n\uFEFFneedle\n',native:[[2,'\uFEFFneedle\n',3]],columns:[2]},
  {name:'embedded FEFF is literal',raw:'a\uFEFFneedle\n',native:[[1,'a\uFEFFneedle\n',4]],columns:[3]},
  {name:'non-BOM astral',raw:'😀 needle\n',native:[[1,'😀 needle\n',5]],columns:[4]},
  {name:'context and pagination',raw:'\uFEFFneedle\nneedle two\nneedle three\n',native:[[1,'needle\n',0],[2,'needle two\n',0],[3,'needle three\n',0]],offset:1,limit:1,columns:[1],hasMore:true},
  {name:'actual first-line mutation',raw:'\uFEFFchanged\n',native:[[1,'needle\n',0]],reject:true},
  {name:'later FEFF cannot be removed',raw:'first\n\uFEFFneedle\n',native:[[2,'needle\n',0]],reject:true},
  {name:'double FEFF cannot both be removed',raw:'\uFEFF\uFEFFneedle\n',native:[[1,'needle\n',0]],reject:true},
  {name:'synthetic invalid provider: unstripped native BOM is rejected',raw:'\uFEFFneedle\n',native:[[1,'\uFEFFneedle\n',3]],reject:true},
  {name:'snapshot invalidation',raw:'needle\n',native:[[1,'needle\n',0]],changedSnapshot:true,reject:true},
  {name:'path-binding invalidation',raw:'needle\n',native:[[1,'needle\n',0]],changedBinding:true,reject:true},
  {name:'rollback previously collected line',raw:'needle\nchanged\n',native:[[1,'needle\n',0],[2,'needle\n',0]],reject:true}
];

for (const fixture of fixtures) test(`Grep raw BOM alignment: ${fixture.name}`, async () => {
  const result = await run(fixture);
  if (fixture.reject) {
    assert.deepEqual(result.unreadableFiles,['fixture.txt'],fixture.name);
    assert.deepEqual(result.matches,[]);
    assert.equal(result.matchedLines,0);
    assert.equal(result.hasMore,false);
  } else {
    assert.deepEqual(result.unreadableFiles,[],fixture.name);
    assert.deepEqual(result.matches.map(x=>x.column),fixture.columns,fixture.name);
    assert.equal(result.hasMore,fixture.hasMore??false);
    const rawLines=fixture.raw.split('\n').map(x=>x.endsWith('\r')?x.slice(0,-1):x);
    if (fixture.raw.endsWith('\n')) rawLines.pop();
    for (const hit of result.matches) {
      assert.equal(hit.text,rawLines[hit.line-1]);
      const contextLines = fixture.contextLines ?? 1;
      const beforeStart = Math.max(0,hit.line-1-contextLines);
      assert.deepEqual(hit.before,rawLines.slice(beforeStart,hit.line-1).map((text,index)=>({line:beforeStart+index+1,text})));
      assert.deepEqual(hit.after,rawLines.slice(hit.line,hit.line+contextLines).map((text,index)=>({line:hit.line+index+1,text})));
    }
  }
});
