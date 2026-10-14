import { existsSync, globSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const root = process.cwd();
const local = process.argv.includes("--local");
const parser = unified().use(remarkParse).use(remarkGfm);
const documents = new Map();
const errors = [];

function walk(node, callback) {
  callback(node);
  for (const child of node.children ?? []) walk(child, callback);
}

function text(node) {
  return node.value ?? (node.children ?? []).map(text).join("");
}

function filesUnder(directory) {
  if (!existsSync(path.join(root, directory))) return [];
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const filename = `${directory}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(filename) : filename.endsWith(".md") ? [filename] : [];
  });
}

function load(filename) {
  if (documents.has(filename)) return documents.get(filename);
  const tree = parser.parse(readFileSync(path.join(root, filename), "utf8"));
  const anchors = new Set();
  const definitions = new Map();
  const counts = new Map();
  walk(tree, node => {
    if (node.type === "heading") {
      const slug = text(node).toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, "").replace(/ /g, "-");
      const count = counts.get(slug) ?? 0;
      counts.set(slug, count + 1);
      anchors.add(count ? `${slug}-${count}` : slug);
    }
    if (node.type === "html") {
      for (const match of node.value.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) anchors.add(match[1]);
    }
    if (node.type === "definition") definitions.set(node.identifier.toLowerCase(), node.url);
  });
  const document = { tree, anchors, definitions };
  documents.set(filename, document);
  return document;
}

function resolve(filename, url) {
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("//")) return undefined;
  const separator = url.indexOf("#");
  const pathname = decodeURIComponent((separator < 0 ? url : url.slice(0, separator)).split("?")[0]);
  const target = pathname ? path.resolve(root, path.dirname(filename), pathname) : path.join(root, filename);
  const relative = path.relative(root, target).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error(`reference outside repository: ${url}`);
  return { filename: relative, anchor: separator < 0 ? undefined : decodeURIComponent(url.slice(separator + 1)) };
}

function links(node, definitions = new Map()) {
  const result = [];
  walk(node, child => {
    if (child.type === "link" || child.type === "image") result.push({ node: child, url: child.url });
    if (child.type === "linkReference" || child.type === "imageReference") {
      result.push({ node: child, url: definitions.get(child.identifier.toLowerCase()) });
    }
  });
  return result;
}

function checkDocument(filename, queue) {
  const document = load(filename);
  for (const { node, url } of links(document.tree, document.definitions)) {
    try {
      if (!url) throw new Error("undefined reference link");
      const target = resolve(filename, url);
      if (!target) continue;
      if (!existsSync(path.join(root, target.filename))) throw new Error(`missing target: ${url}`);
      if (target.anchor && target.filename.endsWith(".md") && !load(target.filename).anchors.has(target.anchor)) {
        throw new Error(`missing anchor: ${url}`);
      }
      if (/^docs\/[^/]+\.md$/.test(target.filename)) queue.add(target.filename);
    } catch (error) {
      errors.push(`${filename}:${node.position.start.line}: ${error.message}`);
    }
  }
  walk(document.tree, node => {
    if (node.type !== "inlineCode" || !/^(?:src|tests|scripts|config|docs)\/[^\s]+$/.test(node.value)) return;
    const target = node.value.replace(/:\d+(?::\d+)?$/, "");
    if (!globSync(target, { cwd: root }).length) errors.push(`${filename}:${node.position.start.line}: missing path: ${target}`);
  });
}

function checkOwners() {
  const filename = "docs/specs/features/README.md";
  const document = load(filename);
  const tables = document.tree.children.filter(node => node.type === "table"
    && text(node.children[0].children[0]) === "子系统"
    && text(node.children[0].children[1]) === "唯一契约入口");
  if (tables.length !== 1) throw new Error(`${filename}: expected one subsystem ownership table`);
  const subsystems = new Set();
  const contracts = new Set();
  const implementations = new Set();
  for (const row of tables[0].children.slice(1)) {
    const subsystem = text(row.children[0]);
    if (!subsystem || subsystems.has(subsystem)) errors.push(`${filename}: duplicate subsystem: ${subsystem}`);
    subsystems.add(subsystem);
    const owners = links(row.children[1], document.definitions);
    if (owners.length !== 1) {
      errors.push(`${filename}: ${subsystem} must have exactly one contract owner`);
      continue;
    }
    const owner = resolve(filename, owners[0].url)?.filename;
    if (!owner || !/^docs\/(?:specs\/features\/(?!README\.md$).+|[^/]+)\.md$/.test(owner)) {
      errors.push(`${filename}: invalid contract owner: ${owners[0].url}`);
      continue;
    }
    if (contracts.has(owner)) errors.push(`${filename}: duplicate contract owner: ${owner}`);
    contracts.add(owner);
    for (const cell of row.children.slice(2)) {
      for (const link of links(cell, document.definitions)) {
        const target = resolve(filename, link.url)?.filename;
        if (target?.startsWith("docs/specs/implementation/")) implementations.add(target);
      }
    }
  }
  for (const [directory, registered] of [["features", contracts], ["implementation", implementations]]) {
    for (const filename of filesUnder(`docs/specs/${directory}`)) {
      if (!filename.endsWith("/README.md") && !registered.has(filename)) errors.push(`unregistered ${directory} page: ${filename}`);
    }
  }
  return subsystems.size;
}

try {
  if (process.argv.slice(2).some(argument => argument !== "--local")) throw new Error("Usage: node scripts/check-docs.mjs [--local]");
  const queue = new Set(["README.md", "CONTRIBUTING.md", "docs/README.md"]);
  let subsystemCount = 0;
  if (local) {
    subsystemCount = checkOwners();
    for (const filename of [
      ...filesUnder("docs/specs/features"), ...filesUnder("docs/specs/implementation"),
      ...readdirSync(path.join(root, "docs/specs")).filter(filename => filename.endsWith(".md")).map(filename => `docs/specs/${filename}`)
    ]) queue.add(filename);
  }
  const checked = new Set();
  for (const filename of queue) {
    if (checked.has(filename)) continue;
    checked.add(filename);
    try { checkDocument(filename, queue); } catch (error) { errors.push(`${filename}: ${error.message}`); }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`Documentation checks passed: ${checked.size} documents${local ? `, ${subsystemCount} subsystem owners` : "; local specs not checked (use --local)"}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
