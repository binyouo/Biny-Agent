import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the complete source through its spawn argument, without importing the
// ripgrep package or starting a process. The sentinel stops before child handlers.
const source = readFileSync(path.join(process.env.BINY_GREP_SOURCE_ROOT ?? process.cwd(), "src/tools/search/ripgrep.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
});
assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

interface Fixture {
  name: string;
  binary: string;
  resources?: string;
  electron?: string;
  windows?: boolean;
  expected?: string;
}
const posixResources = "/Applications/Biny.app/Contents/Resources";
const suffix = "/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg";
const windowsResources = "C:\\tools.asar\\Biny\\resources";
const windowsSuffix = "\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe";
const fixtures: Fixture[] = [
  { name: "plain CLI installation", binary: `/opt/biny${suffix}` },
  { name: "plain CLI directory ending in .asar", binary: `/opt/tools.asar${suffix}` },
  { name: "CLI does not infer Electron from resourcesPath alone", binary: `${posixResources}/app.asar${suffix}`, resources: posixResources },
  { name: "packaged Electron", binary: `${posixResources}/app.asar${suffix}`, resources: posixResources, electron: "43.8.3",
    expected: `${posixResources}/app.asar.unpacked${suffix}` },
  { name: "packaged Electron below an earlier .asar ancestor", binary: `/opt/tools.asar${posixResources}/app.asar${suffix}`,
    resources: `/opt/tools.asar${posixResources}`, electron: "43.8.3", expected: `/opt/tools.asar${posixResources}/app.asar.unpacked${suffix}` },
  { name: "Electron development directory ending in .asar", binary: `/opt/source.asar${suffix}`, resources: posixResources, electron: "43.8.3" },
  { name: "already unpacked path", binary: `${posixResources}/app.asar.unpacked${suffix}`, resources: posixResources, electron: "43.8.3" },
  { name: "unpacked app directory", binary: `${posixResources}/app${suffix}`, resources: posixResources, electron: "43.8.3" },
  { name: "archive sibling prefix", binary: `${posixResources}/app.asar-other${suffix}`, resources: posixResources, electron: "43.8.3" },
  { name: "archive root itself", binary: `${posixResources}/app.asar`, resources: posixResources, electron: "43.8.3" },
  { name: "archive parent itself", binary: posixResources, resources: posixResources, electron: "43.8.3" },
  { name: "missing resourcesPath", binary: `${posixResources}/app.asar${suffix}`, electron: "43.8.3" },
  { name: "relative resourcesPath", binary: `${posixResources}/app.asar${suffix}`, resources: "resources", electron: "43.8.3" },
  { name: "relative binary", binary: `app.asar${suffix}`, resources: posixResources, electron: "43.8.3" },
  { name: "lexical escape from archive", binary: `${posixResources}/app.asar/../outside/rg`, resources: posixResources, electron: "43.8.3" },
  { name: "unrelated symlink alias is not guessed", binary: `/alias/Resources/app.asar${suffix}`, resources: posixResources, electron: "43.8.3" },
  { name: "Windows CLI .asar directory", binary: `C:\\tools.asar${windowsSuffix}`, windows: true },
  { name: "Windows packaged earlier ancestor", binary: `${windowsResources}\\app.asar${windowsSuffix}`, resources: windowsResources,
    electron: "43.8.3", windows: true, expected: `${windowsResources}\\app.asar.unpacked${windowsSuffix}` },
  { name: "Windows case-insensitive archive root", binary: `c:\\TOOLS.ASAR\\biny\\RESOURCES\\APP.ASAR${windowsSuffix}`, resources: windowsResources,
    electron: "43.8.3", windows: true, expected: `${windowsResources}\\app.asar.unpacked${windowsSuffix}` },
  { name: "Windows other drive", binary: `D:\\tools.asar\\Biny\\resources\\app.asar${windowsSuffix}`, resources: windowsResources, electron: "43.8.3", windows: true },
  { name: "Windows sibling prefix", binary: `${windowsResources}\\app.asar-other${windowsSuffix}`, resources: windowsResources, electron: "43.8.3", windows: true },
  { name: "Windows exact archive root", binary: `${windowsResources}\\app.asar`, resources: windowsResources, electron: "43.8.3", windows: true },
  { name: "Windows UNC packaged archive", binary: `\\\\server\\share\\Biny\\resources\\app.asar${windowsSuffix}`, resources: "\\\\server\\share\\Biny\\resources",
    electron: "43.8.3", windows: true, expected: `\\\\server\\share\\Biny\\resources\\app.asar.unpacked${windowsSuffix}` },
  { name: "Windows UNC different share", binary: `\\\\server\\other\\Biny\\resources\\app.asar${windowsSuffix}`, resources: "\\\\server\\share\\Biny\\resources",
    electron: "43.8.3", windows: true }
];

for (const fixture of fixtures) {
  test(`bundled ripgrep path: ${fixture.name}`, async () => {
    const stopped = new Error("inert spawn boundary");
    let executable: string | undefined;
    let calls = 0;
    const exports = {} as { searchRipgrepFiles: (options: unknown) => Promise<unknown> };
    runInNewContext(compiled.outputText, {
      exports, Buffer,
      process: { versions: { electron: fixture.electron }, resourcesPath: fixture.resources },
      require: (id: string) => {
        if (id === "node:path") return fixture.windows ? path.win32 : path.posix;
        if (id === "@vscode/ripgrep") return { rgPath: fixture.binary };
        if (id === "node:child_process") return { spawn: (file: string) => {
          executable = file;
          calls += 1;
          throw stopped;
        } };
        throw new Error(`Unexpected production dependency: ${id}`);
      }
    }, { timeout: 1000 });
    await assert.rejects(exports.searchRipgrepFiles({ query: "needle", mode: "literal", caseSensitive: true,
      workspaceRoot: "/unused", files: ["input.txt"], maxMatches: 1 }), error => error === stopped);
    assert.equal(calls, 1);
    assert.equal(executable, fixture.expected ?? fixture.binary);
  });
}
