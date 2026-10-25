/** CI 选择计划：成功祖先是比较基准；无法证明影响范围时扩大验证。 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const corePath = /^src\/(?:(?:agent|runtime|session|permission|config|llm|extensions|network)\/|utils\/(?:secrets|redaction|windowsSecurity|localFileLock|localIpc)\.ts$)/u;
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
  if (eventName === "pull_request") {
    if (git(root, "rev-parse", "HEAD^2") !== event.pull_request.head.sha) throw new Error("Checkout is not the requested PR merge result");
    ancestorHead = git(root, "rev-parse", "HEAD^1");
    branch = event.pull_request.base.ref;
  } else if (eventName !== "push" && !full) {
    return { head, reason: "unknown event" };
  }
  try {
    const runs = await fetchRuns(branch);
    const baseline = successfulAncestor(root, runs.filter(run => full || run.head_sha !== head), ancestorHead, branch, env.GITHUB_RUN_ID);
    return baseline ? { head, base: baseline.sha, runId: baseline.runId, full,
      reason: full ? "scheduled or manual full validation" : undefined }
      : { head, reason: "no successful ancestor available" };
  } catch (error) {
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
  const dependents = new Map();
  const opaque = new Set();
  const unresolved = [];
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, resolveJsonModule: true };
  const cache = ts.createModuleResolutionCache(root, file => file, options);
  for (const file of files) {
    const absolute = path.join(root, file);
    const source = ts.createSourceFile(absolute, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) throw new Error(`Cannot parse ${file}`);
    const addImport = specifier => {
      // Vite 的 SSR loader 在导入图之外读取源码；其消费者也必须保守保留。
      if (specifier === "vite" || /^(?:node:)?module$/u.test(specifier)
        || (file.startsWith("tests/") && /^(?:node:)?(?:fs(?:\/promises)?|child_process|vm)$/u.test(specifier))) opaque.add(file);
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
      if (!dependents.has(dependency)) dependents.set(dependency, new Set());
      dependents.get(dependency).add(file);
    };
    const visit = node => {
      if (file.startsWith("tests/") && ts.isStringLiteralLike(node)) {
        // 部分回归把另一个测试作为子进程夹具；数组中的 suite 名同样形成依赖。
        for (const candidate of [node.text, `tests/${node.text}`, `tests/${node.text}.test.ts`, path.posix.join(path.posix.dirname(file), node.text)]) {
          if (!testFiles.has(candidate) || candidate === file) continue;
          if (!dependents.has(candidate)) dependents.set(candidate, new Set());
          dependents.get(candidate).add(file);
        }
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        addImport(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) addImport(argument.text);
        else opaque.add(file);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        addImport(node.argument.literal.text);
      } else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression)
        && ["eval", "Function"].includes(node.expression.text)) {
        opaque.add(file);
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
    if (corePath.test(file)) return all(`shared authority changed: ${file}`);
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
    build: sources.length > 0, renderer: sources.length > 0, windows: true, windowsPackage: false
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
    if (!entry.isDirectory() || !/^test-timings-[1-4]$/u.test(entry.name)) continue;
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
    appendFileSync(process.env.GITHUB_OUTPUT, `windows_package=${plan.windowsPackage}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
