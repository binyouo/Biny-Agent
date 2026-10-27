/**
 * QuickChat 的前台应用上下文服务。
 *
 * Activity 记录器负责长期记录，QuickChat 只在唤起时读取一次当前前台应用；两条链路不能
 * 互相借缓存，否则用户看到的窗口和模型实际拿到的上下文很容易错位。macOS 的 AX 查询放在
 * 一个按需编译并缓存的 Swift helper 中，Node 只负责生命周期、浏览器 URL 和结果整形。
 */
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import type {
  DesktopQuickChatFrontAppContext,
  DesktopQuickChatScreenContext,
  DesktopQuickChatTraversal
} from "../../protocol.js";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 1_500;
const COMPILE_TIMEOUT_MS = 30_000;
const MAX_TRAVERSAL_CHARS = 5_000;
const MAX_SELECTION_CHARS = 1_500;
const MAX_URL_CHARS = 4_000;

interface ProbeFrontResult {
  pid: number;
  appName: string;
  bundleId: string;
  appPath: string;
  windowTitle?: string;
  focusedValue?: string;
  textSelection?: string;
  permissionDenied: boolean;
}

export interface QuickChatContextServiceOptions {
  cacheDirectory: string;
  onContext?(context: DesktopQuickChatScreenContext): void;
}

export class QuickChatContextService {
  private readonly cacheDirectory: string;
  private readonly onContext: ((context: DesktopQuickChatScreenContext) => void) | undefined;
  private cached: DesktopQuickChatScreenContext = {};
  private probePromise: Promise<string | undefined> | undefined;
  private captureSequence = 0;

  constructor(options: QuickChatContextServiceOptions) {
    this.cacheDirectory = options.cacheDirectory;
    this.onContext = options.onContext;
  }

  cachedContext(): DesktopQuickChatScreenContext {
    return structuredClone(this.cached);
  }

  async recapture(): Promise<DesktopQuickChatScreenContext> {
    const sequence = ++this.captureSequence;
    const front = await this.readFrontApp();
    if (sequence !== this.captureSequence) return this.cachedContext();

    if (!front || this.isOwnApplication(front)) {
      this.cached = {};
      this.publish();
      return this.cachedContext();
    }

    const appIconDataUrl = await this.readAppIcon(front.appPath);
    if (sequence !== this.captureSequence) return this.cachedContext();
    const next = this.snapshot(front, undefined, appIconDataUrl);
    this.cached = next;
    this.publish();

    // 前台应用快照先返回让窗口立即出现，AX 树在后台补齐。
    void this.traverseAndPublish(front.pid, sequence);
    return this.cachedContext();
  }

  async traverseApp(pid: number): Promise<DesktopQuickChatScreenContext> {
    if (process.platform !== "darwin" || !Number.isSafeInteger(pid) || pid <= 0) return this.cachedContext();
    const front = this.cached.frontApp;
    if (!front || front.pid !== pid) return this.cachedContext();

    const startedAt = Date.now();
    const result = await this.runProbe("traverse", String(pid));
    const traversal = parseTraversal(result, pid, Date.now() - startedAt);
    if (!traversal || this.cached.frontApp?.pid !== pid) return this.cachedContext();
    this.cached = this.snapshot(this.cached.frontApp, traversal, this.cached.appIconDataUrl);
    this.publish();
    return this.cachedContext();
  }

  private async traverseAndPublish(pid: number, captureSequence: number): Promise<void> {
    const startedAt = Date.now();
    const result = await this.runProbe("traverse", String(pid));
    if (captureSequence !== this.captureSequence) return;
    const traversal = parseTraversal(result, pid, Date.now() - startedAt);
    if (!traversal || this.cached.frontApp?.pid !== pid) return;
    this.cached = this.snapshot(this.cached.frontApp, traversal, this.cached.appIconDataUrl);
    this.publish();
  }

  private async readFrontApp(): Promise<DesktopQuickChatFrontAppContext | undefined> {
    if (process.platform !== "darwin") return undefined;
    const startedAt = Date.now();
    const result = await this.runProbe("front");
    const parsed = parseFront(result);
    if (!parsed) return undefined;
    const url = await readBrowserUrl(parsed.bundleId);
    return {
      pid: parsed.pid,
      appName: parsed.appName,
      bundleId: parsed.bundleId,
      appPath: parsed.appPath,
      windowTitle: parsed.windowTitle,
      url,
      focusedElement: parsed.focusedValue || parsed.textSelection
        ? { value: parsed.focusedValue, textSelection: parsed.textSelection }
        : undefined,
      permissionDenied: parsed.permissionDenied,
      durationMs: Math.max(0, Date.now() - startedAt)
    };
  }

  private async readAppIcon(appPath: string): Promise<string | undefined> {
    if (!appPath) return undefined;
    try {
      const icon = await app.getFileIcon(appPath, { size: "normal" });
      return icon.isEmpty() ? undefined : icon.toDataURL();
    } catch {
      return undefined;
    }
  }

  private snapshot(
    frontApp: DesktopQuickChatFrontAppContext,
    traversal: DesktopQuickChatTraversal | undefined,
    appIconDataUrl: string | undefined
  ): DesktopQuickChatScreenContext {
    const promptContext = formatPromptContext(frontApp, traversal);
    return {
      frontApp,
      traversal,
      appIconDataUrl,
      promptContext
    };
  }

  private isOwnApplication(front: DesktopQuickChatFrontAppContext): boolean {
    if (front.pid === process.pid) return true;
    const bundleId = front.bundleId.toLowerCase();
    const appName = front.appName.toLowerCase();
    return bundleId.includes("biny") || appName === app.getName().toLowerCase() || appName === "electron";
  }

  private async runProbe(mode: "front" | "traverse", argument?: string): Promise<unknown> {
    const binary = await this.probeBinary();
    if (!binary) return undefined;
    try {
      const result = await execFileAsync(binary, argument === undefined ? [mode] : [mode, argument], {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 512 * 1024
      });
      const output = String(result.stdout).trim();
      if (!output) return undefined;
      return JSON.parse(output.split("\n").at(-1) ?? output) as unknown;
    } catch {
      return undefined;
    }
  }

  private async probeBinary(): Promise<string | undefined> {
    if (process.platform !== "darwin") return undefined;
    this.probePromise ??= this.prepareProbe();
    return await this.probePromise;
  }

  private async prepareProbe(): Promise<string | undefined> {
    const binaryPath = path.join(this.cacheDirectory, "focused-window-probe");
    const sourcePath = `${binaryPath}.swift`;
    try {
      await mkdir(this.cacheDirectory, { recursive: true });
      let needsCompile = true;
      try {
        const source = await readFile(sourcePath, "utf8");
        await access(binaryPath);
        needsCompile = source !== FOCUSED_WINDOW_PROBE_SOURCE;
      } catch {
        needsCompile = true;
      }
      if (needsCompile) {
        await writeFile(sourcePath, FOCUSED_WINDOW_PROBE_SOURCE, "utf8");
        await execFileAsync("/usr/bin/swiftc", ["-O", "-o", binaryPath, sourcePath], {
          timeout: COMPILE_TIMEOUT_MS,
          maxBuffer: 256 * 1024
        });
      }
      return binaryPath;
    } catch {
      return undefined;
    }
  }

  private publish(): void {
    this.onContext?.(this.cachedContext());
  }
}

function parseFront(value: unknown): ProbeFrontResult | undefined {
  if (!isRecord(value) || value.ok !== true) return undefined;
  const pid = value.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (typeof value.appName !== "string" || typeof value.bundleId !== "string" || typeof value.appPath !== "string") return undefined;
  return {
    pid,
    appName: value.appName,
    bundleId: value.bundleId,
    appPath: value.appPath,
    windowTitle: stringValue(value.windowTitle),
    focusedValue: stringValue(value.focusedValue),
    textSelection: stringValue(value.textSelection),
    permissionDenied: value.permissionDenied === true
  };
}

function parseTraversal(value: unknown, expectedPid: number, durationMs: number): DesktopQuickChatTraversal | undefined {
  if (!isRecord(value) || value.ok !== true || value.pid !== expectedPid || typeof value.content !== "string") return undefined;
  const content = value.content.slice(0, MAX_TRAVERSAL_CHARS);
  return {
    pid: expectedPid,
    windowTitle: stringValue(value.windowTitle),
    content,
    truncated: value.truncated === true || content.length < value.content.length,
    source: value.source === "ax" && content ? "ax" : "empty",
    durationMs: Math.max(0, durationMs)
  };
}

async function readBrowserUrl(bundleId: string): Promise<string | undefined> {
  const script = BROWSER_URL_SCRIPTS[bundleId];
  if (!script) return undefined;
  try {
    const result = await execFileAsync("/usr/bin/osascript", ["-e", script], {
      timeout: 1_000,
      maxBuffer: 16 * 1024
    });
    const url = String(result.stdout).trim();
    return url ? url.slice(0, MAX_URL_CHARS) : undefined;
  } catch {
    return undefined;
  }
}

function formatPromptContext(
  front: DesktopQuickChatFrontAppContext,
  traversal: DesktopQuickChatTraversal | undefined
): string | undefined {
  const frontAttributes = [
    `name="${escapeAttribute(front.appName)}"`,
    `bundle-id="${escapeAttribute(front.bundleId)}"`,
    ...(front.windowTitle ? [`window="${escapeAttribute(front.windowTitle)}"`] : []),
    ...(front.url ? [`url="${escapeAttribute(front.url)}"`] : [])
  ];
  const selection = front.focusedElement?.textSelection?.trim().slice(0, MAX_SELECTION_CHARS);
  const lines = [`<front-app ${frontAttributes.join(" ")}/>`];
  if (selection) lines.push(`<text-selection>${escapeText(selection)}</text-selection>`);
  if (traversal?.content) lines.push(`<context>\n${escapeText(traversal.content)}\n</context>`);
  return lines.join("\n");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

const BROWSER_URL_SCRIPTS: Record<string, string> = {
  "com.apple.Safari": 'tell application "Safari" to return URL of current tab of front window',
  "com.google.Chrome": 'tell application "Google Chrome" to return URL of active tab of front window',
  "com.google.Chrome.canary": 'tell application "Google Chrome Canary" to return URL of active tab of front window',
  "com.microsoft.edgemac": 'tell application "Microsoft Edge" to return URL of active tab of front window',
  "com.brave.Browser": 'tell application "Brave Browser" to return URL of active tab of front window',
  "company.thebrowser.Browser": 'tell application "Browser" to return URL of active tab of front window',
  "org.mozilla.firefox": 'tell application "System Events" to return ""'
};

/**
 * 这个 helper 只做两种查询：front 返回前台应用/焦点控件，traverse 返回当前窗口的 AX 文本树。
 * 文本和节点数量都在 helper 内限流，避免权限异常或大型网页把 Electron 主进程拖住。
 */
const FOCUSED_WINDOW_PROBE_SOURCE = String.raw`
import AppKit
import ApplicationServices
import Foundation

let textBudget = 8000
let maxDepth = 30
let maxChildren = 80

struct FrontPayload: Encodable {
    let ok: Bool
    let pid: Int
    let appName: String
    let bundleId: String
    let appPath: String
    let windowTitle: String?
    let focusedValue: String?
    let textSelection: String?
    let permissionDenied: Bool
}

struct TraversalPayload: Encodable {
    let ok: Bool
    let pid: Int
    let windowTitle: String?
    let content: String
    let truncated: Bool
    let source: String
}

func emit<T: Encodable>(_ payload: T) {
    let data = try! JSONEncoder().encode(payload)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

func elementAttribute(_ element: AXUIElement, _ attribute: CFString) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success, let value else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}

func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success, let value else { return nil }
    if let string = value as? String { return string }
    if let attributed = value as? NSAttributedString { return attributed.string }
    return nil
}

func childrenAttribute(_ element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
          let value else { return [] }
    if let children = value as? [AXUIElement] { return children }
    return []
}

func modeFront() {
    guard let front = NSWorkspace.shared.frontmostApplication else {
        print("{\"ok\":false}")
        return
    }
    let pid = front.processIdentifier
    let trusted = AXIsProcessTrusted()
    let application = AXUIElementCreateApplication(pid)
    let window = trusted ? elementAttribute(application, kAXFocusedWindowAttribute as CFString) : nil
    let focused = trusted ? elementAttribute(application, kAXFocusedUIElementAttribute as CFString) : nil
    emit(FrontPayload(
        ok: true,
        pid: Int(pid),
        appName: front.localizedName ?? "",
        bundleId: front.bundleIdentifier ?? "",
        appPath: front.bundleURL?.path ?? "",
        windowTitle: window.flatMap { stringAttribute($0, kAXTitleAttribute as CFString) },
        focusedValue: focused.flatMap { stringAttribute($0, kAXValueAttribute as CFString) },
        textSelection: focused.flatMap { stringAttribute($0, kAXSelectedTextAttribute as CFString) },
        permissionDenied: !trusted
    ))
}

func modeTraverse() {
    guard CommandLine.arguments.count > 2, let pid = Int32(CommandLine.arguments[2]), pid > 0 else {
        print("{\"ok\":false}")
        return
    }
    guard AXIsProcessTrusted() else {
        emit(TraversalPayload(ok: true, pid: Int(pid), windowTitle: nil, content: "", truncated: false, source: "empty"))
        return
    }
    let application = AXUIElementCreateApplication(pid)
    let window = elementAttribute(application, kAXFocusedWindowAttribute as CFString)
    var chunks: [String] = []
    var characterCount = 0
    var truncated = false

    func append(_ value: String) {
        let normalized = value.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return }
        if characterCount + normalized.count > textBudget {
            let remaining = max(0, textBudget - characterCount)
            if remaining > 0 { chunks.append(String(normalized.prefix(remaining))) }
            characterCount = textBudget
            truncated = true
            return
        }
        chunks.append(normalized)
        characterCount += normalized.count
    }

    func walk(_ element: AXUIElement, _ depth: Int) {
        if depth > maxDepth || characterCount >= textBudget { truncated = true; return }
        let role = stringAttribute(element, kAXRoleAttribute as CFString)
        let title = stringAttribute(element, kAXTitleAttribute as CFString)
        let value = stringAttribute(element, kAXValueAttribute as CFString)
        let description = stringAttribute(element, kAXDescriptionAttribute as CFString)
        let line = [title, value, description].compactMap { $0 }.joined(separator: " ")
        if !line.isEmpty { append((role.map { "[\($0)] " } ?? "") + line) }
        for child in childrenAttribute(element).prefix(maxChildren) { walk(child, depth + 1) }
    }

    if let window {
        walk(window, 0)
        emit(TraversalPayload(
            ok: true,
            pid: Int(pid),
            windowTitle: stringAttribute(window, kAXTitleAttribute as CFString),
            content: chunks.joined(separator: "\n"),
            truncated: truncated,
            source: chunks.isEmpty ? "empty" : "ax"
        ))
    } else {
        emit(TraversalPayload(ok: true, pid: Int(pid), windowTitle: nil, content: "", truncated: false, source: "empty"))
    }
}

if CommandLine.arguments.dropFirst().first == "traverse" { modeTraverse() } else { modeFront() }
`;
