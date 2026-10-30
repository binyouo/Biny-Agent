/** CI 选择计划：PR 比较合并结果与 base，push 累计成功祖先后的改动。 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const sourcePath = /^src\/.*\.[cm]?[jt]sx?$/u;
const testPath = /^tests\/[^/]+\.test\.ts$/u;
const documentation = /^(?:README(?:\.[\w-]+)?\.md|CONTRIBUTING\.md|docs\/.*\.md)$/u;

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function changedFilesBetween(root, base, head = "HEAD") {
  // --no-renames 保留旧路径；删除文件不能仅用当前树的依赖图推断。
  return git(root, "diff", "--no-renames", "--name-only", "-z", base, head).split("\0").filter(Boolean);
}

export function successfulAncestor(root, runs, head, branch, currentRunId) {
  for (const run of runs) {
    if (run.conclusion !== "success" || run.head_branch !== branch || String(run.id) === String(currentRunId)
      || !["push", "schedule", "workflow_dispatch"].includes(run.event) || !/^[a-f0-9]{40}$/u.test(run.head_sha)) continue;
    try {
      git(root, "merge-base", "--is-ancestor", run.head_sha, head);
      return { sha: run.head_sha, runId: run.id };
    } catch { /* 已被重写或不在 checkout 中的成功提交不能成为基准。 */ }
  }
  return undefined;
}

export async function resolveComparison(root, eventName, event, env = process.env, fetchRuns = async branch => {
  const url = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(branch)}&status=success&per_page=100`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Actions API returned ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.workflow_runs)) throw new Error("Actions API omitted workflow_runs");
  return body.workflow_runs;
}) {
  const head = git(root, "rev-parse", "HEAD");
  const full = ["schedule", "workflow_dispatch"].includes(eventName);
  let branch = env.GITHUB_REF_NAME;
  let ancestorHead = head;
  let prBase;
  if (eventName === "pull_request") {
    const pr = event.pull_request;
    const number = event.number;
    const sha = /^[a-f0-9]{40}$/u;
    const parents = git(root, "show", "-s", "--format=%P", "HEAD").split(" ").filter(Boolean);
    if (!Number.isSafeInteger(number) || number <= 0
      || env.GITHUB_REF !== `refs/pull/${number}/merge`
      || !sha.test(env.GITHUB_SHA ?? "") || head !== env.GITHUB_SHA
      || !sha.test(pr?.head?.sha ?? "") || !sha.test(pr?.base?.sha ?? "")
      || parents.length !== 2 || parents[1] !== pr.head.sha) {
      throw new Error("Checkout is not the requested PR merge result");
    }
    ancestorHead = parents[0];
    // GitHub can refresh refs/pull/N/merge after the event's base snapshot.
    // Preserve exact merge/head identity and accept only a proven forward base.
    try {
      git(root, "merge-base", "--is-ancestor", pr.base.sha, ancestorHead);
    } catch {
      throw new Error("Checkout is not the requested PR merge result");
    }
    prBase = ancestorHead;
    branch = event.pull_request.base.ref;
  } else if (eventName !== "push" && !full) {
    return { head, reason: "unknown event" };
  }
  try {
    const runs = await fetchRuns(branch);
    const baseline = successfulAncestor(root, runs.filter(run => full || run.head_sha !== head), ancestorHead, branch, env.GITHUB_RUN_ID);
    // PR 不承担 main 的累计验证；历史成功运行只用于分片耗时。
    if (prBase) return { head, base: prBase, runId: baseline?.runId, reason: "PR changes against the current base in the merge result" };
    return baseline ? { head, base: baseline.sha, runId: baseline.runId, full,
      reason: full ? "scheduled or manual full validation" : undefined }
      : { head, reason: "no successful ancestor available" };
  } catch (error) {
    if (prBase) return { head, base: prBase, reason: `PR changes against the current base; timing history unavailable: ${error.message}` };
    return { head, reason: `successful baseline unavailable: ${error.message}` };
  }
}

function walk(root, directory) {
  const files = [];
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walk(root, file));
    else if (/\.[cm]?[jt]sx?$/u.test(file)) files.push(file);
  }
  return files;
}

async function dependencyGraph(root) {
  const ts = (await import("typescript")).default;
  const files = [...walk(root, "src"), ...walk(root, "tests")];
  const testFiles = new Set(files.filter(file => testPath.test(file)));
  const canonicalRoot = realpathSync(root);
  const dependents = new Map();
  const opaque = new Set();
  const unresolved = [];
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, resolveJsonModule: true };
  const cache = ts.createModuleResolutionCache(root, file => file, options);
  for (const file of files) {
    const absolute = path.join(root, file);
    const source = ts.createSourceFile(absolute, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) throw new Error(`Cannot parse ${file}`);
    const readers = new Set();
    const filesystemNamespaces = new Set();
    const requireFactories = new Set();
    const requires = new Set();
    // 此助手的文件读取只处理经过临时根目录校验的 owner 记录和清理诊断。
    const externalFileReads = file === "tests/helpers/memoryOwnerCleanup.ts";
    const addEdge = dependency => {
      if (!dependents.has(dependency)) dependents.set(dependency, new Set());
      dependents.get(dependency).add(file);
    };
    const addBuiltin = (specifier, node) => {
      const bindings = node?.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings) && !node.importClause.name && /^(?:node:)?fs\/promises$/u.test(specifier)) {
        filesystemNamespaces.add(bindings.name.text);
        return;
      }
      if (!bindings || !ts.isNamedImports(bindings) || node.importClause.name) { opaque.add(file); return; }
      for (const binding of bindings.elements) {
        if (binding.isTypeOnly || node.importClause.isTypeOnly) continue;
        const imported = binding.propertyName?.text ?? binding.name.text;
        if (/^(?:node:)?module$/u.test(specifier)) {
          if (imported === "createRequire") requireFactories.add(binding.name.text);
          else opaque.add(file);
        } else if (imported === "promises" && /^(?:node:)?fs$/u.test(specifier)) {
          filesystemNamespaces.add(binding.name.text);
        } else if (/^(?:readFile|exists|stat|lstat|access|readdir|opendir|realpath)(?:Sync)?$/u.test(imported)) {
          readers.add(binding.name.text);
        } else if (!/^(?:mkdtemp|mkdir|rm|rmdir|unlink|writeFile|appendFile)(?:Sync)?$/u.test(imported)) {
          opaque.add(file);
        }
      }
    };
    const addImport = (specifier, node) => {
      // Vite 的 SSR loader 在导入图之外读取源码；其消费者也必须保守保留。
      if (specifier === "vite" || (file.startsWith("tests/") && /^(?:node:)?(?:child_process|vm)$/u.test(specifier))) opaque.add(file);
      if (/^(?:node:)?module$/u.test(specifier)
        || (file.startsWith("tests/") && /^(?:node:)?fs(?:\/promises)?$/u.test(specifier))) addBuiltin(specifier, node);
      if (path.isAbsolute(specifier) || /^(?:file:|[A-Za-z]:[\\/])/u.test(specifier)) { opaque.add(file); return; }
      if (!specifier.startsWith(".")) return;
      const modulePath = specifier.split("?")[0];
      const resolved = ts.resolveModuleName(modulePath, absolute, options, ts.sys, cache).resolvedModule;
      const assetPath = path.resolve(path.dirname(absolute), modulePath);
      const resolvedFile = resolved?.resolvedFileName ?? (existsSync(assetPath) ? assetPath : undefined);
      if (!resolvedFile) {
        // E2E 的 dist 输入由 CI 构建，源码变更始终运行整个 E2E 层。
        if (file.endsWith("-e2e.test.ts")) opaque.add(file);
        else unresolved.push(`${file}: ${specifier}`);
        return;
      }
      const dependency = path.relative(root, resolvedFile).split(path.sep).join("/");
      addEdge(dependency);
    };
    const factoryCall = node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && requireFactories.has(node.expression.text);
    const requireExpression = node => ts.isIdentifier(node) ? node.text === "require" || requires.has(node.text) : factoryCall(node);
    const readInput = argument => {
      let input;
      if (argument && ts.isStringLiteralLike(argument)) input = path.resolve(root, argument.text);
      else if (argument && ts.isNewExpression(argument) && ts.isIdentifier(argument.expression) && argument.expression.text === "URL"
        && argument.arguments?.length === 2 && ts.isStringLiteralLike(argument.arguments[0])
        && argument.arguments[1].getText(source) === "import.meta.url") {
        try { input = fileURLToPath(new URL(argument.arguments[0].text, pathToFileURL(absolute))); }
        catch { /* 非文件 URL 不证明项目输入范围。 */ }
      }
      if (!input || !existsSync(input)) {
        if (!externalFileReads) opaque.add(file);
        return;
      }
      const relative = path.relative(root, input).split(path.sep).join("/");
      let target;
      try { target = path.relative(canonicalRoot, realpathSync(input)).split(path.sep).join("/"); }
      catch { opaque.add(file); return; }
      if ([relative, target].some(value => value.startsWith("../") || path.isAbsolute(value))) { opaque.add(file); return; }
      // 符号链接的路径和真实目标都可能影响读取结果。
      for (const inputPath of new Set([relative, target])) {
        addEdge(inputPath);
        for (const candidate of files) if (!inputPath || candidate.startsWith(`${inputPath}/`)) addEdge(candidate);
      }
    };
    // 先登记绑定，使别名调用和声明顺序不改变选择结果。
    for (const node of source.statements) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        // 类型引用由全仓 typecheck 验证；它不会加载模块或执行被引用源码。
        if (node.importClause?.isTypeOnly) continue;
        addImport(node.moduleSpecifier.text, node);
      } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)
        && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
        addImport(node.moduleReference.expression.text);
      }
    }
    let expandsTestNames = false;
    const collectRequires = node => {
      if ((ts.isTemplateExpression(node) && node.templateSpans.some(span => span.literal.text.endsWith(".test.ts")))
        || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
          && ts.isStringLiteralLike(node.right) && node.right.text.endsWith(".test.ts"))) expandsTestNames = true;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && factoryCall(node.initializer)) requires.add(node.name.text);
      ts.forEachChild(node, collectRequires);
    };
    collectRequires(source);
    const visit = node => {
      if (file.startsWith("tests/") && ts.isStringLiteralLike(node)) {
        // 仅在显式拼接测试路径的文件中展开 suite 名；普通标签不代表测试依赖。
        const candidates = [node.text, `tests/${node.text}`, path.posix.join(path.posix.dirname(file), node.text)];
        if (expandsTestNames) candidates.push(`tests/${node.text}.test.ts`);
        for (const candidate of candidates) {
          if (!testFiles.has(candidate) || candidate === file) continue;
          if (!dependents.has(candidate)) dependents.set(candidate, new Set());
          dependents.get(candidate).add(file);
        }
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!node.isTypeOnly) addImport(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || requireExpression(node.expression)
        || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "resolve" && requireExpression(node.expression.expression)))) {
        const argument = node.arguments[0];
        if (ts.isPropertyAccessExpression(node.expression) && node.arguments.length !== 1) opaque.add(file);
        if (argument && ts.isStringLiteralLike(argument)) addImport(argument.text);
        // 插件导入目标来自受约束的用户工作区 pluginRoot，不属于仓库源码。
        else if (!(file === "src/extensions/plugins.ts" && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && argument?.getText(source) === "pathToFileURL(filePath).href")) opaque.add(file);
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && readers.has(node.expression.text)) {
        readInput(node.arguments[0]);
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && filesystemNamespaces.has(node.expression.expression.text)) {
        const method = node.expression.name.text;
        if (/^(?:readFile|exists|stat|lstat|access|readdir|opendir|realpath)(?:Sync)?$/u.test(method)) readInput(node.arguments[0]);
        else if (!/^(?:mkdtemp|mkdir|rm|rmdir|unlink|writeFile|appendFile)(?:Sync)?$/u.test(method)) opaque.add(file);
      } else if (factoryCall(node)) {
        if (node.arguments.length !== 1 || node.arguments[0].getText(source) !== "import.meta.url") opaque.add(file);
        const parent = node.parent;
        if (!((ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && parent.initializer === node)
          || (ts.isCallExpression(parent) && parent.expression === node)
          || (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "resolve"
            && ts.isCallExpression(parent.parent) && parent.parent.expression === parent))) opaque.add(file);
      } else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression)
        && ["eval", "Function"].includes(node.expression.text)) {
        opaque.add(file);
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === "process.chdir") opaque.add(file);
      if (ts.isIdentifier(node) && filesystemNamespaces.has(node.text)) {
        const parent = node.parent;
        const declaration = (ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)) && parent.name === node;
        const directCall = ts.isPropertyAccessExpression(parent) && parent.expression === node
          && ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
        if (!declaration && !directCall && !ts.isTypeQueryNode(parent)) opaque.add(file);
      }
      if (ts.isIdentifier(node) && (readers.has(node.text) || requireFactories.has(node.text) || requires.has(node.text))) {
        const parent = node.parent;
        const declaration = (ts.isImportSpecifier(parent) || ts.isVariableDeclaration(parent)) && parent.name === node;
        const invocation = ts.isCallExpression(parent) && parent.expression === node;
        const resolve = requires.has(node.text) && ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "resolve"
          && ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
        const propertyName = (ts.isPropertyAccessExpression(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyAssignment(parent)) && parent.name === node;
        if (!declaration && !invocation && !resolve && !propertyName && !ts.isImportSpecifier(parent) && !ts.isTypeQueryNode(parent)
          && !(externalFileReads && readers.has(node.text))) opaque.add(file);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { dependents, opaque, unresolved };
}

function closure(seeds, dependents) {
  const selected = new Set(seeds);
  for (const file of selected) for (const dependent of dependents.get(file) ?? []) selected.add(dependent);
  return selected;
}

export async function createPlan(root, changedFiles, { full = false } = {}) {
  const tests = readdirSync(path.join(root, "tests")).filter(file => file.endsWith(".test.ts")).sort();
  const all = reason => ({ full: true, reasons: [reason], standard: tests.filter(file => !file.endsWith("-e2e.test.ts")),
    e2e: tests.filter(file => file.endsWith("-e2e.test.ts")), build: true, renderer: true, windows: true, windowsPackage: true });
  if (full) return all("explicit full validation");
  const changed = [...new Set(changedFiles)];
  for (const file of changed) {
    if (documentation.test(file)) continue;
    if ((!sourcePath.test(file) && !testPath.test(file)) || !existsSync(path.join(root, file))) return all(`unknown, shared, or removed input: ${file}`);
  }
  const code = changed.filter(file => !documentation.test(file));
  if (!code.length) return { full: false, reasons: ["documentation only or unchanged tree"], standard: [], e2e: [], build: false, renderer: false, windows: false, windowsPackage: false };
  const graph = await dependencyGraph(root);
  if (graph.unresolved.length) return all(`unresolved dependencies: ${graph.unresolved.slice(0, 5).join("; ")}`);
  const affected = closure(code, graph.dependents);
  const sources = code.filter(file => sourcePath.test(file));
  for (const file of sources) {
    if (![...closure([file], graph.dependents)].some(candidate => testPath.test(candidate))) return all(`no test dependency proves coverage of ${file}`);
  }
  if (sources.length) for (const file of closure(graph.opaque, graph.dependents)) affected.add(file);
  const selected = tests.filter(file => affected.has(`tests/${file}`));
  return {
    full: false,
    reasons: [...code.map(file => `changed: ${file}`), ...(sources.length ? ["include opaque file/process/dynamic consumers and all runtime E2E"] : [])],
    standard: selected.filter(file => !file.endsWith("-e2e.test.ts")),
    e2e: (sources.length ? tests : selected).filter(file => file.endsWith("-e2e.test.ts")),
    build: sources.length > 0, renderer: affected.has("tests/fixtures/memory-disclosure/main.tsx"),
    windows: sources.length > 0 || selected.some(file => /^(?:windows|runtime-host-(?:lock|connection-options|lifecycle)|desktop-host-startup-e2e)/u.test(file)),
    windowsPackage: false
  };
}

export function checkResults(plan, needs) {
  const required = { plan: true, static: true, test: plan.standard.length > 0, e2e: plan.e2e.length > 0,
    build: plan.build, renderer: plan.renderer, windows: plan.windows };
  for (const [lane, selected] of Object.entries(required)) {
    const expected = selected ? "success" : "skipped";
    if (needs[lane]?.result !== expected) throw new Error(`${lane}: expected ${expected}, received ${needs[lane]?.result ?? "missing"}`);
  }
}

function readTimings(directory) {
  const timings = {};
  if (!existsSync(directory)) return timings;
  const previousPlan = path.join(directory, "ci-plan/plan.json");
  if (existsSync(previousPlan)) {
    try {
      const previous = JSON.parse(readFileSync(previousPlan, "utf8")).timings;
      for (const [file, duration] of Object.entries(previous ?? {})) {
        if (testPath.test(`tests/${file}`) && Number.isFinite(duration) && duration > 0) timings[file] = duration;
      }
    } catch (error) { console.error(`Ignoring unusable previous timings: ${error.message}`); }
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^test-timings-[1-8]$/u.test(entry.name)) continue;
    const file = path.join(directory, entry.name, "test-timings.json");
    if (!existsSync(file)) continue;
    try {
      for (const result of JSON.parse(readFileSync(file, "utf8")).results) {
        if (testPath.test(`tests/${result.file}`) && result.exitCode === 0 && Number.isFinite(result.durationMs) && result.durationMs > 0) timings[result.file] = result.durationMs;
      }
    } catch (error) { console.error(`Ignoring unusable timing report ${file}: ${error.message}`); }
  }
  return timings;
}

async function main() {
  const { parseArgs } = await import("node:util");
  const { values } = parseArgs({ options: { base: { type: "string" },
    full: { type: "boolean" }, ci: { type: "boolean" }, output: { type: "string", default: ".ci/plan.json" },
    "check-results": { type: "boolean" } } });
  if (values["check-results"]) {
    checkResults(JSON.parse(readFileSync(values.output, "utf8")), JSON.parse(process.env.NEEDS_JSON));
    console.log("All selected validation lanes passed; unselected lanes were skipped.");
    return;
  }
  if (!values.ci && !values.full && !values.base) throw new Error("Use --base <commit>, --full, or --ci");
  const comparison = values.ci
    ? await resolveComparison(repository, process.env.GITHUB_EVENT_NAME, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")))
    : { base: values.base, head: git(repository, "rev-parse", "HEAD") };
  if (comparison.base) git(repository, "merge-base", "--is-ancestor", comparison.base, comparison.head);
  const plan = await createPlan(repository, comparison.base ? changedFilesBetween(repository, comparison.base, comparison.head) : [], { full: values.full || comparison.full || !comparison.base });
  if (comparison.reason) plan.reasons.unshift(comparison.reason);
  let timings = {};
  if (values.ci && comparison.runId) {
    // 历史耗时只改变排序；过期或无法下载时不减少任何测试。
    try {
      execFileSync("gh", ["run", "download", String(comparison.runId), "--repo", process.env.GITHUB_REPOSITORY,
        "--pattern", "test-timings-*", "--pattern", "ci-plan", "--dir", ".ci/history"], { cwd: repository, stdio: "pipe", timeout: 60_000 });
      timings = readTimings(path.join(repository, ".ci/history"));
    } catch { console.error("No usable timing artifact; using deterministic equal-count shards."); }
  }
  const output = { ...plan, base: comparison.base ?? null, head: comparison.head, timings };
  mkdirSync(path.dirname(values.output), { recursive: true });
  writeFileSync(values.output, JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify({ ...output, standard: output.standard.length, e2e: output.e2e.length, timings: Object.keys(timings).length }, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    const lanes = { standard: plan.standard.length > 0, e2e: plan.e2e.length > 0, build: plan.build, renderer: plan.renderer, windows: plan.windows };
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(lanes).map(([key, value]) => `${key}=${value}\n`).join(""));
    const maxShards = process.env.GITHUB_EVENT_NAME === "pull_request" && plan.standard.length >= 400 ? 8 : 4;
    const shards = Array.from({ length: Math.max(1, Math.min(maxShards, plan.standard.length)) }, (_, index) => index + 1);
    appendFileSync(process.env.GITHUB_OUTPUT, `shards=${JSON.stringify(shards)}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `windows_package=${plan.windowsPackage}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

