import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("recent application metadata enriches running apps without replacing their identities", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-recent-apps-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `import Foundation
let running: [[String: Any]] = [
    ["pid": 41, "bundleId": "test.music", "name": "Music Running", "running": true],
    ["pid": 42, "bundleId": "test.music", "name": "Music Second", "running": true],
    ["pid": 43, "name": "No Bundle", "running": true]
]
let recent: [[String: Any]] = [
    ["bundleId": "test.music", "name": "Old Name", "running": false, "lastUsed": "2026-10-27T00:00:00Z", "useCount": 17],
    ["bundleId": "test.notes", "name": "Notes", "running": false, "lastUsed": "2026-10-26T00:00:00Z", "useCount": 3],
    ["bundleId": "test.notes", "name": "Old Notes", "running": false, "useCount": 1]
]
let merged = mergeRecentApplications(running: running, recent: recent)
precondition(recentApplicationUseCount(NSNumber(value: 17)) == 17)
precondition(recentApplicationUseCount(NSNumber(value: 0)) == 0)
precondition(recentApplicationUseCount(NSNumber(value: -1)) == nil)
precondition(recentApplicationUseCount(NSNumber(value: 1.5)) == nil)
precondition(recentApplicationUseCount(NSNumber(value: true)) == nil)
precondition(recentApplicationUseCount("17") == nil)
precondition(merged.count == 4)
precondition(merged[0]["pid"] as? Int == 41 && merged[0]["name"] as? String == "Music Running" && merged[0]["running"] as? Bool == true)
precondition(merged[0]["useCount"] as? Int == 17 && merged[0]["lastUsed"] as? String == "2026-10-27T00:00:00Z")
precondition(merged[1]["pid"] as? Int == 42 && merged[1]["useCount"] as? Int == 17)
precondition(merged[2]["pid"] as? Int == 43 && merged[2]["useCount"] == nil)
precondition(merged[3]["bundleId"] as? String == "test.notes" && merged[3]["useCount"] as? Int == 3 && merged[3]["pid"] == nil)
print("recent applications passed")
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/RecentApplications.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 10_000 }), /recent applications passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("accessibility enablement restores both settings after overlapping observations", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-ax-enablement-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `import Foundation
import Dispatch
final class Attributes {
    private let lock = NSLock()
    private var values: [Int32: [String: Bool]] = [1: ["AXEnhancedUserInterface": false, "AXManualAccessibility": true], 2: ["AXEnhancedUserInterface": true, "AXManualAccessibility": false]]
    func read(_ pid: Int32, _ key: String) -> Bool? { lock.lock(); defer { lock.unlock() }; return values[pid]?[key] }
    func write(_ pid: Int32, _ key: String, _ value: Bool) { lock.lock(); defer { lock.unlock() }; values[pid, default: [:]][key] = value }
}
let attributes = Attributes(), leases = AccessibilityEnablement()
func enabled<T>(_ pid: Int32, _ body: () throws -> T) rethrows -> T {
    try leases.withEnabled(pid: pid, read: { attributes.read(pid, $0) }, write: { attributes.write(pid, $0, $1) }, body: body)
}
let firstEntered = DispatchSemaphore(value: 0), finishFirst = DispatchSemaphore(value: 0), firstDone = DispatchSemaphore(value: 0)
DispatchQueue.global().async {
    enabled(1) { firstEntered.signal(); precondition(finishFirst.wait(timeout: .now() + 3) == .success) }
    firstDone.signal()
}
precondition(firstEntered.wait(timeout: .now() + 3) == .success)
enabled(1) {
    precondition(attributes.read(1, "AXEnhancedUserInterface") == true && attributes.read(1, "AXManualAccessibility") == true)
    finishFirst.signal()
    precondition(firstDone.wait(timeout: .now() + 3) == .success)
    precondition(attributes.read(1, "AXEnhancedUserInterface") == true && attributes.read(1, "AXManualAccessibility") == true)
    enabled(2) { precondition(attributes.read(2, "AXManualAccessibility") == true) }
    precondition(attributes.read(2, "AXEnhancedUserInterface") == true && attributes.read(2, "AXManualAccessibility") == false)
}
precondition(attributes.read(1, "AXEnhancedUserInterface") == false && attributes.read(1, "AXManualAccessibility") == true)
attributes.write(1, "AXEnhancedUserInterface", true); attributes.write(1, "AXManualAccessibility", false)
enabled(1) { precondition(attributes.read(1, "AXManualAccessibility") == true) }
precondition(attributes.read(1, "AXEnhancedUserInterface") == true && attributes.read(1, "AXManualAccessibility") == false)
enabled(3) { precondition(attributes.read(3, "AXEnhancedUserInterface") == true && attributes.read(3, "AXManualAccessibility") == true) }
precondition(attributes.read(3, "AXEnhancedUserInterface") == false && attributes.read(3, "AXManualAccessibility") == false)
enum Failure: Error { case failed }
do { try enabled(2) { throw Failure.failed }; fatalError("missing error") } catch {}
precondition(attributes.read(2, "AXEnhancedUserInterface") == true && attributes.read(2, "AXManualAccessibility") == false)
let blockedRead = DispatchSemaphore(value: 0), unblockRead = DispatchSemaphore(value: 0)
let firstFinished = DispatchSemaphore(value: 0), otherFinished = DispatchSemaphore(value: 0)
DispatchQueue.global().async {
    leases.withEnabled(pid: 7, read: { key in
        if key == "AXEnhancedUserInterface" { blockedRead.signal(); _ = unblockRead.wait(timeout: .now() + 3) }
        return false
    }, write: { _, _ in }, body: {})
    firstFinished.signal()
}
precondition(blockedRead.wait(timeout: .now() + 3) == .success)
DispatchQueue.global().async {
    leases.withEnabled(pid: 8, read: { _ in false }, write: { _, _ in }, body: {})
    otherFinished.signal()
}
let otherResult = otherFinished.wait(timeout: .now() + 2)
unblockRead.signal()
precondition(firstFinished.wait(timeout: .now() + 3) == .success && otherResult == .success)
print("accessibility enablement passed")
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/AccessibilityEnablement.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 10_000 }), /accessibility enablement passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("observation metadata retains container details, numeric values and unknown fields", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-ax-element-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `import Foundation
import ApplicationServices
import CoreGraphics
var point = CGPoint(x: 10, y: 20), size = CGSize(width: 40, height: 30)
let pointValue = AXValueCreate(.cgPoint, &point)!, sizeValue = AXValueCreate(.cgSize, &size)!
precondition(observationFrame(position: pointValue, size: sizeValue) == ["x": 10, "y": 20, "w": 40, "h": 30])
precondition(observationFrame(position: NSNumber(value: 42), size: sizeValue) == nil)
precondition(observationFrame(position: sizeValue, size: pointValue) == nil)
var validLinkedReads = 0
precondition(observationTitleElementValue(NSNumber(value: 42), read: { _ in validLinkedReads += 1; return "wrong" }) == nil)
let linkedElement = AXUIElementCreateApplication(getpid())
precondition(axElementValue(NSNumber(value: 42)) == nil, "wrong AX element type accepted")
precondition(axElementValue(linkedElement).map { CFEqual($0, linkedElement) } == true)
precondition(axElementArray([NSNumber(value: 42)] as CFArray) == nil, "wrong AX child type accepted")
precondition(axElementArray([linkedElement, NSNumber(value: 42)] as CFArray) == nil, "mixed AX child types accepted")
precondition(axElementArray(NSNumber(value: 42)) == nil, "non-array AX children accepted")
if case .failed = classifyAXChildren(status: .success, values: axElementArray([NSNumber(value: 42)] as CFArray)) {} else { fatalError("invalid AX children must mark the branch incomplete") }
let validChildren = axElementArray([linkedElement] as CFArray)
precondition(validChildren?.count == 1 && CFEqual(validChildren![0], linkedElement))
precondition(axElementArray([] as CFArray)?.isEmpty == true)
precondition(observationTitleElementValue(linkedElement, read: { _ in validLinkedReads += 1; return "linked" }) as? String == "linked")
precondition(validLinkedReads == 1)
let attributes: [String: Any] = ["AXTitle": "歌曲", "AXDescription": "列表", "AXRoleDescription": "滚动区", "AXSubrole": "AXContentList", "AXValue": NSNumber(value: 0.75), "AXFocused": false, "AXEnabled": true, "AXSelected": true]
let roles: Set<String> = ["AXButton", "AXSlider"]
if case .available(let children) = classifyAXChildren(status: .success, values: ["one"]) { precondition(children == ["one"]) } else { fatalError("valid children rejected") }
if case .available(let children) = classifyAXChildren(status: .noValue, values: Optional<[String]>.none) { precondition(children.isEmpty) } else { fatalError("empty children rejected") }
if case .unsupported = classifyAXChildren(status: .attributeUnsupported, values: Optional<[String]>.none) {} else { fatalError("unsupported children misclassified") }
if case .failed = classifyAXChildren(status: .cannotComplete, values: Optional<[String]>.none) {} else { fatalError("failed children hidden") }
if case .failed = classifyAXChildren(status: .success, values: Optional<[String]>.none) {} else { fatalError("invalid children hidden") }
let deadline = Date(timeIntervalSince1970: 10)
var budget = AXTraversalIssues()
precondition(budget.permitsVisit(count: 0, limit: 1, now: Date(timeIntervalSince1970: 9), deadline: deadline))
precondition(!budget.permitsVisit(count: 1, limit: 1, now: Date(timeIntervalSince1970: 9), deadline: deadline) && budget.limitReached)
var timeoutBudget = AXTraversalIssues()
precondition(!timeoutBudget.permitsVisit(count: 0, limit: 1, now: deadline, deadline: deadline) && timeoutBudget.deadlineReached)
var broken = AXTraversalIssues(); broken.failedChildren = 1
precondition(accessibilityObservationWarning(finished: true, maxDepth: 6, interactiveOnly: true, visibleCount: 1, rawCount: 1, wakeupAttempts: 2, issues: broken)?.hasPrefix("accessibility_tree_incomplete") == true)
var missingWindow = AXTraversalIssues(); missingWindow.windowUnavailable = true
precondition(accessibilityObservationWarning(finished: true, maxDepth: 6, interactiveOnly: true, visibleCount: 0, rawCount: 0, wakeupAttempts: 2, issues: missingWindow)?.hasPrefix("accessibility_window_unavailable") == true)
precondition(accessibilityObservationWarning(finished: true, maxDepth: 6, interactiveOnly: false, visibleCount: 5, rawCount: 5, wakeupAttempts: 0, issues: timeoutBudget)?.hasPrefix("accessibility_tree_incomplete") == true)
let collection = AXCollectBox(interactiveRoles: roles)
let pending = collection.take()
precondition(!pending.4 && pending.0.isEmpty)
precondition(accessibilityObservationWarning(finished: pending.4, maxDepth: 6, interactiveOnly: true, visibleCount: 0, rawCount: 0, wakeupAttempts: 0)?.hasPrefix("accessibility_timeout") == true)
collection.store([["ref": "e0", "role": "AXWindow"], ["ref": "e1", "role": "AXStaticText"]], ["e0": linkedElement, "e1": linkedElement], wakeupAttempts: 1)
let complete = collection.take()
precondition(complete.4 && complete.0.count == 1 && complete.1.count == 2 && complete.2 == 1)
let partialCollection = AXCollectBox(interactiveRoles: roles)
partialCollection.store([], [:], issues: broken)
precondition(partialCollection.take().5.failedChildren == 1)
precondition(accessibilityObservationWarning(finished: complete.4, maxDepth: 6, interactiveOnly: true, visibleCount: complete.0.count, rawCount: complete.1.count, wakeupAttempts: complete.2)?.hasPrefix("no_interactive_elements") == true)
precondition(accessibilityObservationWarning(finished: true, maxDepth: 6, interactiveOnly: true, visibleCount: 1, rawCount: 1, wakeupAttempts: 2)?.hasPrefix("empty_after_wakeup") == true)
precondition(accessibilityObservationWarning(finished: true, maxDepth: 0, interactiveOnly: true, visibleCount: 0, rawCount: 0, wakeupAttempts: 0) == nil)
precondition(observationElementVisible(role: "AXScrollArea", actions: ["AXScrollDownByPage"], interactiveOnly: true, interactiveRoles: roles))
precondition(!observationElementVisible(role: "AXScrollArea", actions: [], interactiveOnly: true, interactiveRoles: roles))
precondition(observationElementVisible(role: "AXScrollArea", actions: [], interactiveOnly: false, interactiveRoles: roles))
precondition(observationElementVisible(role: "AXButton", actions: nil, interactiveOnly: true, interactiveRoles: roles))
let element = observationElement(ref: "e1", role: "AXScrollArea", read: { attributes[$0] }, actions: { ["AXScrollDownByPage"] }, childrenCount: 2, frame: { ["x": 10, "y": 20, "w": 40, "h": 30] })
precondition(element["role"] as? String == "AXScrollArea")
precondition(element["title"] as? String == "歌曲" && element["description"] as? String == "列表")
precondition(element["role_description"] as? String == "滚动区" && element["subrole"] as? String == "AXContentList")
precondition(element["value"] as? String == "0.75" && element["focused"] as? Bool == false)
precondition(element["enabled"] as? Bool == true && element["selected"] as? Bool == true)
precondition(element["actions"] as? [String] == ["AXScrollDownByPage"] && element["children_count"] as? Int == 2)
precondition((element["frame"] as? [String: Double])?["x"] == 10)
var linkedReads = 0
func labelled(_ attrs: [String: Any], linkedValue: Any?) -> [String: Any] {
    observationElement(ref: "e3", role: "AXTextField", read: { attrs[$0] }, readTitleElementValue: { _ in linkedReads += 1; return linkedValue }, actions: { nil }, childrenCount: nil, frame: { nil })
}
precondition(labelled(["AXTitle": "直接标题", "AXTitleUIElement": "linked", "AXLabelValue": "标签"], linkedValue: "关联标题")["title"] as? String == "直接标题")
precondition(linkedReads == 0)
precondition(labelled(["AXTitle": "", "AXTitleUIElement": "linked", "AXLabelValue": "标签"], linkedValue: "关联标题")["title"] as? String == "关联标题")
precondition(labelled(["AXTitleUIElement": "linked", "AXLabelValue": "标签"], linkedValue: "")["title"] as? String == "标签")
precondition(labelled(["AXTitleUIElement": "linked", "AXLabelValue": "标签"], linkedValue: 42)["title"] as? String == "标签")
precondition(labelled(["AXLabelValue": "标签"], linkedValue: nil)["title"] as? String == "标签")
precondition(labelled(["AXTitleUIElement": "linked", "AXLabelValue": 42], linkedValue: nil)["title"] == nil)
let unknown = observationElement(ref: "e2", role: "AXGroup", read: { _ in nil }, actions: { nil }, childrenCount: nil, frame: { nil })
precondition(unknown["actions"] == nil && unknown["children_count"] == nil && unknown["selected"] == nil && unknown["frame"] == nil)
print("accessibility metadata passed")
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/AccessibilityElement.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /accessibility metadata passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("menu shortcuts match enabled keys and AX modifier semantics", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-menu-shortcuts-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `import CoreGraphics
import ApplicationServices
let entries: [MenuShortcut<String>] = [
    .init(element: "disabled", keyCode: 0, modifiers: 0, enabled: false),
    .init(element: "save", keyCode: 1, modifiers: 0, enabled: true),
    .init(element: "save-as", keyCode: 1, modifiers: 1, enabled: true),
    .init(element: "control", keyCode: 1, modifiers: 12, enabled: true),
    .init(element: "option", keyCode: 1, modifiers: 2, enabled: true)
]
precondition(matchingMenuShortcut(entries, keyCode: 1, flags: .maskCommand) == "save")
precondition(matchingMenuShortcut(entries, keyCode: 1, flags: [.maskCommand, .maskShift]) == "save-as")
precondition(matchingMenuShortcut(entries, keyCode: 1, flags: .maskControl) == "control")
precondition(matchingMenuShortcut(entries, keyCode: 1, flags: [.maskCommand, .maskAlternate]) == "option")
precondition(matchingMenuShortcut(entries, keyCode: 0, flags: .maskCommand) == nil)
precondition(matchingMenuShortcut(entries, keyCode: 1, flags: [.maskCommand, .maskSecondaryFn]) == nil)
precondition(matchingMenuShortcut(entries, keyCode: 1, flags: []) == nil)
var checks = 0, performed: [String] = []
let success = try performMenuShortcut(keyCode: 1, flags: .maskCommand, targetValid: { checks += 1; return true }, discover: { entries }, perform: { performed.append($0); return .success })
precondition(success && checks == 2 && performed == ["save"])
checks = 0; performed = []
let changed = try performMenuShortcut(keyCode: 1, flags: .maskCommand, targetValid: { checks += 1; return checks == 1 }, discover: { entries }, perform: { performed.append($0); return .success })
precondition(!changed && checks == 2 && performed.isEmpty)
var discoveries = 0
let wrongWindow = try performMenuShortcut(keyCode: 1, flags: .maskCommand, targetValid: { false }, discover: { discoveries += 1; return entries }, perform: { performed.append($0); return .success })
precondition(!wrongWindow && discoveries == 0 && performed.isEmpty)
let noMatch = try performMenuShortcut(keyCode: 0, flags: .maskCommand, targetValid: { true }, discover: { entries }, perform: { performed.append($0); return .success })
precondition(!noMatch && performed.isEmpty)
do { _ = try performMenuShortcut(keyCode: 1, flags: .maskCommand, targetValid: { true }, discover: { entries }, perform: { performed.append($0); return .cannotComplete }); fatalError("unknown menu result accepted") }
catch { precondition(error.localizedDescription.hasPrefix("menu_shortcut_outcome_unknown") && performed == ["save"]) }
performed = []
do { _ = try performMenuShortcut(keyCode: 1, flags: .maskCommand, targetValid: { true }, discover: { entries }, perform: { performed.append($0); return .actionUnsupported }); fatalError("unsupported menu action accepted") }
catch { precondition(error.localizedDescription.hasPrefix("menu_shortcut_unsupported") && performed == ["save"]) }
print("menu shortcuts passed")
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/AccessibilityAction.swift", "native/computer-use/MenuShortcuts.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /menu shortcuts passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("accessibility action fallback stops when the outcome may be unknown", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-ax-actions-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `import ApplicationServices
var calls: [String] = []
let actions = ["press", "pick", "confirm"]
let success = performAccessibilityActions(actions) { action in
  calls.append(action)
  return action == "press" ? .actionUnsupported : .success
}
precondition(success == .success && calls == ["press", "pick"])
calls = []
let unknown = performAccessibilityActions(actions) { action in
  calls.append(action)
  return action == "press" ? .notImplemented : .cannotComplete
}
precondition(unknown == .unknown(AXError.cannotComplete.rawValue) && calls == ["press", "pick"])
calls = []
let unavailable = performAccessibilityActions(actions) { action in
  calls.append(action); return .actionUnsupported
}
precondition(unavailable == .unsupported && calls == actions)
precondition(accessibilityActionResult(.failure) == .unknown(AXError.failure.rawValue))
precondition(accessibilityAttributeResult(.attributeUnsupported) == .unsupported)
precondition(accessibilityAttributeResult(.cannotComplete) == .unknown(AXError.cannotComplete.rawValue))
try requireAccessibilityAttributeWrite(.success, unsupported: "unsupported", unknown: "unknown")
do { try requireAccessibilityAttributeWrite(.attributeUnsupported, unsupported: "unsupported", unknown: "unknown"); fatalError("unsupported accepted") }
catch { precondition(error.localizedDescription.hasPrefix("unsupported:")) }
do { try requireAccessibilityAttributeWrite(.cannotComplete, unsupported: "unsupported", unknown: "unknown"); fatalError("unknown accepted") }
catch { precondition(error.localizedDescription.hasPrefix("unknown:") && error.localizedDescription.contains("不要重试")) }
var writes = 0
let inserted = try automaticAccessibilityTextInsert(target: "field", writable: { _ in true }, write: { _ in writes += 1; return .success })
precondition(inserted && writes == 1, "automatic AX insertion must not be repeated")
writes = 0
let unsupportedWrite = try automaticAccessibilityTextInsert(target: "field", writable: { _ in true }, write: { _ in writes += 1; return .attributeUnsupported })
precondition(!unsupportedWrite && writes == 1, "explicitly unsupported insertion can use another route")
writes = 0
let notWritable = try automaticAccessibilityTextInsert(target: "field", writable: { _ in false }, write: { _ in writes += 1; return .success })
precondition(!notWritable && writes == 0)
let noTarget = try automaticAccessibilityTextInsert(target: nil as String?, writable: { _ in fatalError("no target") }, write: { _ in fatalError("no target") })
precondition(!noTarget && writes == 0)
let notImplemented = try automaticAccessibilityTextInsert(target: "field", writable: { _ in true }, write: { _ in writes += 1; return .notImplemented })
precondition(!notImplemented && writes == 1)
writes = 0
do { _ = try automaticAccessibilityTextInsert(target: "field", writable: { _ in true }, write: { _ in writes += 1; return .cannotComplete }); fatalError("unknown AX write fell back") }
catch { precondition(error.localizedDescription.hasPrefix("text_input_outcome_unknown") && writes == 1) }
let parent: (String) -> String? = { ["inner": "field", "field": "window", "other": "window", "loop": "loop"][$0] }
precondition(focusedElementBelongsToTarget(focused: "field", target: "field", equals: ==, parent: parent))
precondition(focusedElementBelongsToTarget(focused: "inner", target: "field", equals: ==, parent: parent))
precondition(!focusedElementBelongsToTarget(focused: "other", target: "field", equals: ==, parent: parent))
precondition(!focusedElementBelongsToTarget(focused: nil as String?, target: "field", equals: ==, parent: parent))
precondition(!focusedElementBelongsToTarget(focused: "loop", target: "field", equals: ==, parent: parent))
let appended = try accessibilityTextValue("旧", text: "新", append: true)
let appendedEmpty = try accessibilityTextValue("", text: "新", append: true)
let replaced = try accessibilityTextValue(nil, text: "新", append: false)
precondition(appended == "旧新" && appendedEmpty == "新" && replaced == "新")
do { _ = try accessibilityTextValue(nil, text: "新", append: true); fatalError("append lost existing value") }
catch { precondition(error.localizedDescription.hasPrefix("type_append_read_unavailable:")) }
print("accessibility action contracts passed")
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/AccessibilityAction.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /accessibility action contracts passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("observation differences include removed controls and semantic state without crossing sessions", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-observation-diff-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `import Foundation
var time: TimeInterval = 0
let store = ObservationDiffStore(limit: 3, now: { time })
let a: [String: Any] = ["role": "AXButton", "description": "开始", "role_description": "按钮", "focused": false, "enabled": true]
let b: [String: Any] = ["role": "AXButton", "title": "返回"]
func compare(_ elements: [[String: Any]], owner: String = "a", window: Int = 9) -> (Bool, Int) {
  let result = store.compare(owner: owner, pid: 12, windowID: window, elements: elements)
  return (result.changed, result.unchanged)
}
let first = compare([a, b]); precondition(first.0 && first.1 == 0)
let same = compare([a, b]); precondition(!same.0 && same.1 == 2)
let removed = compare([a]); precondition(removed.0 && removed.1 == 1)
var changed = a; changed["description"] = "暂停"
let description = compare([changed]); precondition(description.0 && description.1 == 0)
changed["role_description"] = "切换按钮"
let roleDescription = compare([changed]); precondition(roleDescription.0 && roleDescription.1 == 0)
changed["focused"] = true
let focused = compare([changed]); precondition(focused.0 && focused.1 == 0)
changed["enabled"] = false
let enabled = compare([changed]); precondition(enabled.0 && enabled.1 == 0)
changed["selected"] = true
let selected = compare([changed]); precondition(selected.0 && selected.1 == 0)
changed["actions"] = ["AXPress"]
let actions = compare([changed]); precondition(actions.0 && actions.1 == 0)
changed["children_count"] = 2
let children = compare([changed]); precondition(children.0 && children.1 == 0)
let otherOwner = compare([changed], owner: "b"); precondition(otherOwner.0 && otherOwner.1 == 0)
let otherWindow = compare([changed], window: 10); precondition(otherWindow.0 && otherWindow.1 == 0)
time = 61
let expired = compare([changed]); precondition(expired.0 && expired.1 == 0)
print("observation differences passed")
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/ObservationDiff.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /observation differences passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("stable element references follow identity within one window and never revive removed references", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-stable-elements-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `import Foundation
import ApplicationServices
var time: TimeInterval = 0
let refs = StableElementRefs<String>(limit: 4, now: { time })
func assign(_ elements: [String: String], owner: String = "a", pid: Int32 = 12, window: Int = 9) -> [String: String] {
  return refs.assign(owner: owner, pid: pid, windowID: window, elements: elements, hash: { _ in 1 }, equals: ==)
}
let first = assign(["e1": "alpha", "e2": "beta"])
let reordered = assign(["e1": "beta", "e2": "alpha"])
precondition(first["e1"] == reordered["e2"] && first["e2"] == reordered["e1"])
let replaced = assign(["e1": "gamma", "e2": "alpha"])
precondition(replaced["e2"] == first["e1"] && replaced["e1"] != first["e2"])
let returned = assign(["e1": "beta", "e2": "alpha"])
precondition(returned["e1"] != first["e2"])
let otherOwner = assign(["e1": "alpha"], owner: "b")
let otherWindow = assign(["e1": "alpha"], window: 10)
precondition(otherOwner["e1"] != first["e1"] && otherWindow["e1"] != first["e1"])
let duplicate = assign(["e1": "alpha", "e2": "alpha"])
precondition(duplicate["e1"] != duplicate["e2"] && duplicate["e1"] != first["e1"] && duplicate["e2"] != first["e1"])
time = 61
precondition(assign(["e1": "alpha"])["e1"] != first["e1"])
let axRefs = StableElementRefs<AXUIElement>()
let firstApp = AXUIElementCreateApplication(getpid())
let sameApp = AXUIElementCreateApplication(getpid())
let firstAX = axRefs.assign(owner: "a", pid: getpid(), windowID: 9, elements: ["e1": firstApp], hash: { Int(bitPattern: CFHash($0)) }, equals: { CFEqual($0, $1) })
let sameAX = axRefs.assign(owner: "a", pid: getpid(), windowID: 9, elements: ["e9": sameApp], hash: { Int(bitPattern: CFHash($0)) }, equals: { CFEqual($0, $1) })
precondition(firstAX["e1"] == sameAX["e9"])
print("stable references passed")
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/StableElementRefs.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /stable references passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("page scrolling stops on a partial result without retrying another target", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-page-scroll-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `
precondition(scrollPageFraction(viewport: 100, content: 500) == 0.25)
precondition(scrollPageFraction(viewport: 200, content: 300) == 1)
precondition(scrollPageFraction(viewport: 100, content: 100) == nil)
precondition(scrollPageFraction(viewport: 0, content: 500) == nil)
precondition(scrollPageFraction(viewport: .infinity, content: 500) == nil)
var calls: [Int] = []
let full = performPageScroll(pages: 3, candidates: [1, 2]) { candidate in
  calls.append(candidate); return candidate == 2 ? .success : .unsupported
}
precondition(full == .complete(3) && calls == [1, 2, 2, 2])
calls = []
let partial = performPageScroll(pages: 3, candidates: [1, 2]) { candidate in
  calls.append(candidate); return calls.count == 1 ? .success : .unsupported
}
precondition(partial == .partial(1) && calls == [1, 1])
calls = []
let unavailable = performPageScroll(pages: 2, candidates: [1, 2]) { candidate in
  calls.append(candidate); return .unsupported
}
precondition(unavailable == .unavailable && calls == [1, 2])
calls = []
let unknown = performPageScroll(pages: 3, candidates: [1, 2]) { candidate in
  calls.append(candidate); return calls.count == 1 ? .success : .unknown(-25204)
}
precondition(unknown == .unknown(1, -25204) && calls == [1, 1])
calls = []
let unknownFirst = performPageScroll(pages: 2, candidates: [1, 2]) { candidate in
  calls.append(candidate); return .unknown(-25204)
}
precondition(unknownFirst == .unknown(0, -25204) && calls == [1])
print("page scroll contracts passed")
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/AccessibilityAction.swift", "native/computer-use/ScrollPages.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /page scroll contracts passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("scrolling targets the observed control without requiring a focused window", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-scroll-target-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `import Foundation
import CoreGraphics
var focusReads = 0
let direct = scrollAreaForTarget(reference: "control", focusedWindow: { focusReads += 1; return nil }, ancestor: { $0 == "control" ? "area" : nil }, findArea: { _ in "other" })
precondition(direct == "area" && focusReads == 0)
let noAncestor = scrollAreaForTarget(reference: "control", focusedWindow: { focusReads += 1; return nil }, ancestor: { _ in nil }, findArea: { _ in "other" })
precondition(noAncestor == "control" && focusReads == 0)
let automatic: String? = scrollAreaForTarget(reference: nil, focusedWindow: { focusReads += 1; return "window" }, ancestor: { _ in nil }, findArea: { $0 == "window" ? "area" : nil })
precondition(automatic == "area" && focusReads == 1)
let candidates = scrollPageCandidates(reference: "control", area: "area", children: ["horizontal-bar", "control", "vertical-bar"], includeChild: { $0 != "horizontal-bar" }, same: ==)
precondition(candidates == ["control", "area", "vertical-bar"])
precondition(scrollPageCandidates(reference: "area", area: "area", children: [], includeChild: { _ in true }, same: ==) == ["area"])
var dispatched: [String] = []
let noBar = scrollPageCandidates(reference: "control", area: "area", children: [], includeChild: { _ in true }, same: ==)
let pageResult = performPageScroll(pages: 2, candidates: noBar) { item in dispatched.append(item); return item == "control" ? .success : .unsupported }
precondition(pageResult == .complete(2) && dispatched == ["control", "control"])
let absent: String? = try scrollReference(nil, lookup: { _ in "unused" })
precondition(absent == nil)
let valid: String? = try scrollReference("e1", lookup: { $0 == "e1" ? "control" : nil })
precondition(valid == "control")
do { let _: String? = try scrollReference("stale", lookup: { _ in nil }); fatalError("stale ref accepted") }
catch { precondition(error.localizedDescription.hasPrefix("element_ref_not_observed")) }
let target = CGPoint(x: 120, y: 240)
let event = try scrollWheelEvent(pid: 42, windowID: 99, point: target, vertical: -3, horizontal: 0) { vertical, horizontal in
    let value = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0)!
    value.location = CGPoint(x: -100, y: -100)
    return value
}
precondition(event.location == target)
precondition(event.getIntegerValueField(.eventTargetUnixProcessID) == 42)
let horizontal = try scrollWheelEvent(pid: 42, windowID: 99, point: target, vertical: 0, horizontal: 4)
precondition(horizontal.getIntegerValueField(.scrollWheelEventDeltaAxis1) == 0 && horizontal.getIntegerValueField(.scrollWheelEventDeltaAxis2) == 4)
var created = false
do { _ = try scrollWheelEvent(pid: 42, windowID: 99, point: nil, vertical: 1, horizontal: 0) { _, _ in created = true; return nil }; fatalError("missing point accepted") }
catch { precondition(error.localizedDescription.hasPrefix("scroll_target_unavailable") && !created) }
do { _ = try scrollWheelEvent(pid: 42, windowID: 99, point: target, vertical: 1, horizontal: 0) { _, _ in nil }; fatalError("missing event accepted") }
catch { precondition(error.localizedDescription.hasPrefix("scroll_event_creation_failed")) }
print("scroll targets passed")
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/AccessibilityAction.swift", "native/computer-use/PhysicalInput.swift", "native/computer-use/ScrollPages.swift", "native/computer-use/ScrollRouting.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /scroll targets passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("key combinations preserve function keys, navigation, keypad and all declared modifiers", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-key-combo-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `import CoreGraphics
import Carbon.HIToolbox
func expect(_ combo: String, _ key: CGKeyCode, _ flags: CGEventFlags = []) {
  guard let (actual, modifiers) = parseKeyCombo(combo), actual == key, modifiers == flags else {
    fatalError("wrong key or modifiers for " + combo)
  }
}
let functionKeys = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10, kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20]
for (index, key) in functionKeys.enumerated() { expect("F" + String(index + 1), CGKeyCode(key)) }
expect("shift+F20", 90, .maskShift)
expect("cmd+opt+esc", 53, [.maskCommand, .maskAlternate])
expect("meta+ctrl+fn+page_up", 116, [.maskCommand, .maskControl, .maskSecondaryFn])
expect("Super_L+d", 2, .maskCommand); expect("Control_L+a", 0, .maskControl)
expect(" Super_L + d ", 2, .maskCommand)
expect("Shift_R+Prior", 116, .maskShift); expect("Alt_R+Next", 121, .maskAlternate)
expect("Meta_R+Escape", 53, .maskCommand)
expect("backspace", 51); expect("forward_delete", 117)
expect("Home", 115); expect("End", 119); expect("page_down", 121)
expect("kp_0", 82); expect("kp_9", 92); expect("kp_enter", 76)
expect("kp_plus", 69); expect("kp_minus", 78); expect("kp_multiply", 67); expect("kp_divide", 75)
expect("kp_decimal", 65); expect("kp_equals", 81)
expect("cmd+s", 1, .maskCommand); expect("ctrl+shift+t", 17, [.maskControl, .maskShift])
for invalid in ["cmd+unknown+s", "cmd++s", "cmd+ +s", "+s", "cmd+", "", "f21"] {
  precondition(parseKeyCombo(invalid) == nil, "accepted malformed combo: " + invalid)
}
print("key combinations passed")
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/PhysicalInput.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /key combinations passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("action cursor is normalized to the exact window and expires without borrowing another owner's point", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-action-cursor-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `import Foundation
import CoreGraphics
var time: TimeInterval = 10
let cursor = ActionCursor(now: { time })
let frame = CGRect(x: 300, y: 200, width: 800, height: 400)
precondition(cursor.mark(pid: 12, windowID: 42, owner: "a", point: CGPoint(x: 500, y: 400)) != nil)
let point = cursor.normalized(pid: 12, windowID: 42, frame: frame)!
precondition(point["x"] == 0.25 && point["y"] == 0.5 && point["remainingMs"] == 8000)
precondition(cursor.normalized(pid: 12, windowID: 43, frame: frame) == nil)
precondition(cursor.normalized(pid: 13, windowID: 42, frame: frame) == nil)
precondition(cursor.normalized(pid: 12, windowID: 42, frame: CGRect(x: 600, y: 200, width: 100, height: 100)) == nil)
precondition(cursor.normalized(pid: 12, windowID: 42, frame: .zero) == nil)
precondition(cursor.mark(pid: 12, windowID: 42, owner: "b", point: nil) == nil)
precondition(cursor.mark(pid: 12, windowID: 43, owner: "a", point: nil) == nil)
time = 17
precondition(cursor.mark(pid: 12, windowID: 42, owner: "a", point: nil) == CGPoint(x: 500, y: 400))
time = 25
precondition(cursor.normalized(pid: 12, windowID: 42, frame: frame)?["remainingMs"] == 0)
time = 25.01
precondition(cursor.normalized(pid: 12, windowID: 42, frame: frame) == nil)
precondition(cursor.mark(pid: 12, windowID: 42, owner: "a", point: nil) == nil)
_ = cursor.mark(pid: 12, windowID: 43, owner: "b", point: CGPoint(x: 700, y: 300))
precondition(cursor.normalized(pid: 12, windowID: 42, frame: frame) == nil)
precondition(cursor.normalized(pid: 12, windowID: 43, frame: frame)?["x"] == 0.5)
print("cursor contracts passed")
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/ActionCursor.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /cursor contracts passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("文字匹配选区按 UTF-16 返回唯一范围，拒绝缺失、重复及重叠匹配，协议替身无法验证原生范围计算", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-text-selection-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `import Foundation
func expect(_ text: String, _ match: String, _ location: Int, _ length: Int, prefix: String? = nil, suffix: String? = nil) throws {
    let range = try matchingTextRange(in: text, match: match, prefix: prefix, suffix: suffix)
    precondition(range.location == location && range.length == length)
}
try expect("A🤖目标结束", "目标", 3, 2)
try expect("前目标后，另一目标尾", "目标", 7, 2, prefix: "另一", suffix: "尾")
try expect("abc", "abc", 0, 3)
let before = try matchingTextRange(in: "A🤖目标结束", match: "目标", selectionType: "cursor_before")
precondition(before.location == 3 && before.length == 0)
let after = try matchingTextRange(in: "A🤖目标结束", match: "目标", selectionType: "cursor_after")
precondition(after.location == 5 && after.length == 0)
do { _ = try matchingTextRange(in: "abc", match: "b", selectionType: "other"); fatalError("invalid mode accepted") }
catch { precondition(error.localizedDescription == "text_selection_type_invalid") }
for (text, match, code) in [("abc", "", "invalid"), ("abc", "x", "not_found"), ("目标目标", "目标", "ambiguous"), ("aaa", "aa", "ambiguous")] {
    do { _ = try matchingTextRange(in: text, match: match); fatalError("unsafe range accepted") }
    catch { precondition(error.localizedDescription == "text_match_" + code) }
}
do { _ = try matchingTextRange(in: "abc", match: "b", prefix: "wrong"); fatalError("wrong context accepted") }
catch { precondition(error.localizedDescription == "text_match_not_found") }
print("text selection passed")
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/TextSelection.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /text selection passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("mirror sessions reject window ID reuse and late frames, report frame age, and bound resources", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-mirror-core-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `import Foundation
func expect(_ value: @autoclosure () -> Bool) { precondition(value()) }
var now: TimeInterval = 10
let sessions = MirrorSessions(limit: 2, now: { now })
let first = try sessions.begin(windowID: 42, pid: 12, armed: true)
expect(sessions.state(windowID: 42)!["last_frame_age_ms"] is NSNull)
expect((sessions.list()["armed"] as! [[String: Any]]).count == 1)
let duplicate = try sessions.begin(windowID: 42, pid: 12, armed: true)
expect(duplicate.lease == first.lease)
do { _ = try sessions.begin(windowID: 42, pid: 13, armed: false); fatalError("accepted a different owner") }
catch { expect(error.localizedDescription == "pip_window_identity_changed") }
sessions.frame(first); now = 12.5
expect(sessions.state(windowID: 42)!["last_frame_age_ms"] as! Int == 2500)
sessions.present(first)
expect((sessions.list()["sessions"] as! [[String: Any]]).count == 1)
sessions.fail(first, error: "stream_stopped")
expect(sessions.state(windowID: 42)!["error"] as! String == "stream_stopped")
sessions.frame(first)
expect(sessions.state(windowID: 42)!["error"] == nil)
_ = try sessions.begin(windowID: 43, pid: 12, armed: false)
do { _ = try sessions.begin(windowID: 44, pid: 12, armed: false); fatalError("unbounded sessions") }
catch { expect(error.localizedDescription == "pip_session_limit") }
sessions.close(windowID: 42)
let replacement = try sessions.begin(windowID: 42, pid: 13, armed: true)
expect(replacement.lease != first.lease)
sessions.frame(first); sessions.present(first); sessions.fail(first, error: "old error")
expect(sessions.state(windowID: 42)!["state"] as! String == "armed")
expect(sessions.state(windowID: 42)!["last_frame_age_ms"] is NSNull)
expect(sessions.state(windowID: 42)!["error"] == nil)
for id in [0, -1, Int(UInt32.max) + 1] {
  do { _ = try sessions.begin(windowID: id, pid: 12, armed: false); fatalError("invalid ID accepted") }
  catch { expect(error.localizedDescription == "pip_invalid_window_id") }
}
print("mirror contracts passed")
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/MirrorSessions.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /mirror contracts passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("physical input plans the complete text before dispatch and capture deadlines return explicit errors", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-native-contracts-"));
  try {
    const source = path.join(directory, "Contracts.swift");
    await writeFile(source, `import Foundation
import CoreGraphics
actor Gate {
  var released = false
  var pending: [CheckedContinuation<Void, Never>] = []
  func wait() async { if released { return }; await withCheckedContinuation { pending.append($0) } }
  func release() { released = true; for waiter in pending { waiter.resume() }; pending = [] }
}
@main struct Contracts {
  static func main() async throws {
    try validateCaptureTarget(pid: nil, windowID: nil, applications: [12], windows: [42: 12])
    try validateCaptureTarget(pid: 12, windowID: 42, applications: [12], windows: [42: 12])
    try validateForegroundTarget(pid: 12, windowID: 42, frontmostPID: 12, focusedWindowID: 42)
    try validateBackgroundKeyboardWindow(windowID: 42, focusedWindowID: 42)
    for (window, focused) in [(42, nil as Int?), (42, 43), (0, 0), (Int(UInt32.max) + 1, Int(UInt32.max) + 1)] {
      do { try validateBackgroundKeyboardWindow(windowID: window, focusedWindowID: focused); fatalError("background keyboard escaped its observed window") }
      catch { precondition(error.localizedDescription.hasPrefix("background_keyboard_target_not_focused")) }
    }
    let invalidFocus: [(Int, Int, Int?, Int?)] = [(12, 42, nil, 42), (12, 42, 13, 42), (12, 42, 12, nil), (12, 42, 12, 43), (0, 42, 0, 42), (12, 0, 12, 0), (12, Int(UInt32.max) + 1, 12, Int(UInt32.max) + 1)]
    for (pid, window, frontmost, focused) in invalidFocus {
      do { try validateForegroundTarget(pid: pid, windowID: window, frontmostPID: frontmost, focusedWindowID: focused); fatalError("keyboard input escaped its exact foreground window") }
      catch { precondition(error.localizedDescription.hasPrefix("foreground_target_not_focused")) }
    }
    for (pid, window, message) in [(13, 42, "capture_application_not_found"), (12, 43, "capture_window_not_found"), (12, 44, "capture_window_identity_changed")] {
      do { try validateCaptureTarget(pid: pid, windowID: window, applications: [12], windows: [42: 12, 44: 13]); fatalError("expanded a missing target") }
      catch { precondition(error.localizedDescription == message) }
    }
    let bounds: NSDictionary = ["X": NSNumber(value: 300), "Y": NSNumber(value: 200), "Width": NSNumber(value: 640), "Height": NSNumber(value: 480)]
    let window: [String: Any] = [kCGWindowOwnerPID as String: NSNumber(value: 12), kCGWindowNumber as String: NSNumber(value: 42), kCGWindowLayer as String: NSNumber(value: 0), kCGWindowBounds as String: bounds]
    precondition(windowNumberForApp(12, windows: [window]) == 42)
    precondition(windowScreenBounds(pid: 12, windowID: 42, windows: [window])?["x"] == 300)
    precondition(windowScreenBounds(pid: 12, windowID: 43, windows: [window]) == nil)
    let keys: [String: PhysicalStroke] = ["a": PhysicalStroke(keyCode: 0, flags: []), "A": PhysicalStroke(keyCode: 0, flags: .maskShift)]
    var created: [Bool] = []
    let pair = try keyboardEventPair { down -> String? in created.append(down); return down ? "down" : "up" }
    precondition(pair.down == "down" && pair.up == "up" && created == [true, false])
    for missing in [true, false] {
      created = []
      do { _ = try keyboardEventPair { down -> String? in created.append(down); return down == missing ? nil : "event" }; fatalError("missing keyboard event accepted") }
      catch { precondition(error.localizedDescription.hasPrefix("keyboard_event_creation_failed")) }
      precondition(created == (missing ? [true] : [true, false]))
    }
    do { _ = try requireInputEvent(nil as Int?, errorCode: "scroll_event_creation_failed"); fatalError("missing scroll event accepted") }
    catch { precondition(error.localizedDescription.hasPrefix("scroll_event_creation_failed")) }
    precondition(PhysicalInput.autoRoute(axWritable: true, physicalAvailable: true) == "ax")
    precondition(PhysicalInput.autoRoute(axWritable: false, physicalAvailable: true) == "physical")
    precondition(PhysicalInput.autoRoute(axWritable: false, physicalAvailable: false) == "unicode")
    let plan = try PhysicalInput.plan("aA") { keys[$0] }
    precondition(plan.count == 2 && plan[0].flags.isEmpty && plan[1].flags == .maskShift)
    do { _ = try PhysicalInput.plan("a🦊") { keys[$0] }; fatalError("accepted an unmappable suffix") }
    catch { precondition(error.localizedDescription.contains("input_method_unmappable_character: index 1")) }
    let timeout = Gate(), work = Gate(), timerStarted = Gate(), workStarted = Gate()
    let latePath = NSTemporaryDirectory() + "biny-late-capture-\\(UUID().uuidString).jpg"
    let operation = Task {
      await captureObservation(timeout: 3, wait: { _ in await timerStarted.release(); await timeout.wait() }, describeError: { $0.localizedDescription }) {
        try Data("late pixels".utf8).write(to: URL(fileURLWithPath: latePath))
        await workStarted.release(); await work.wait(); return ["path": latePath]
      }
    }
    await timerStarted.wait(); await workStarted.wait(); await timeout.release()
    let result = await operation.value
    precondition((result["screenshot_error"] as? String)?.hasPrefix("capture_timeout") == true && result["path"] == nil)
    await work.release()
    // 等待真实异步工作完成后的文件清理；条件轮询上限两秒，不用固定等待判成功。
    let cleanupDeadline = Date().addingTimeInterval(2)
    while FileManager.default.fileExists(atPath: latePath) && Date() < cleanupDeadline { try await Task.sleep(nanoseconds: 1_000_000) }
    let removed = !FileManager.default.fileExists(atPath: latePath)
    try? FileManager.default.removeItem(atPath: latePath)
    precondition(removed, "late capture file was retained after timeout")
    let never = Gate()
    let success = await captureObservation(timeout: 3, wait: { _ in await never.wait() }, describeError: { $0.localizedDescription }) { ["path": "fresh.jpg"] }
    precondition(success["path"] as? String == "fresh.jpg" && success["screenshot_error"] == nil)
    let empty = await captureObservation(timeout: 3, wait: { _ in await never.wait() }, describeError: { $0.localizedDescription }) { [:] }
    precondition((empty["screenshot_error"] as? String)?.hasPrefix("capture_empty") == true)
    let denied = await captureObservation(timeout: 3, wait: { _ in await never.wait() }, describeError: { $0.localizedDescription }) {
      throw NSError(domain: "capture", code: 1, userInfo: [NSLocalizedDescriptionKey: "screen_recording_not_granted"])
    }
    precondition(denied["screenshot_error"] as? String == "screen_recording_not_granted")
    await never.release()
    print("native contracts passed")
  }
}
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "-parse-as-library", "native/computer-use/PhysicalInput.swift", "native/computer-use/CaptureDeadline.swift", "native/computer-use/WindowGeometry.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /native contracts passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("background mouse packets name the exact window for clicks and drags without posting UI events", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-background-input-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `
import Foundation
import CoreGraphics
let left = BackgroundInput.dragTypes(button: .left)
precondition(left.0 == .leftMouseDown && left.1 == .leftMouseDragged && left.2 == .leftMouseUp)
let right = BackgroundInput.dragTypes(button: .right)
precondition(right.0 == .rightMouseDown && right.1 == .rightMouseDragged && right.2 == .rightMouseUp)
let middle = BackgroundInput.dragTypes(button: .center)
precondition(middle.0 == .otherMouseDown && middle.1 == .otherMouseDragged && middle.2 == .otherMouseUp)
for type: CGEventType in [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp] {
    let event = try BackgroundInput.mouseEvent(pid: 123, windowID: 456, type: type, point: CGPoint(x: 315, y: 245), button: .left, clickState: 2)
    precondition(event.getIntegerValueField(.mouseEventWindowUnderMousePointer) == 456, "packet omitted exact window ID")
    precondition(event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent) == 456)
    precondition(event.getIntegerValueField(.eventTargetUnixProcessID) == 123)
    precondition(event.getIntegerValueField(.mouseEventClickState) == 2)
    precondition(event.location == CGPoint(x: 315, y: 245))
}
print("background packets passed")
let focusGuard = BackgroundFocusGuard()
focusGuard.block(123); focusGuard.block(123)
precondition(focusGuard.shouldDropActivation(type: 13, subtype: 0, targetPID: 123))
precondition(focusGuard.shouldDropActivation(type: 14, subtype: 8, targetPID: 123))
precondition(!focusGuard.shouldDropActivation(type: 14, subtype: 7, targetPID: 123))
precondition(!focusGuard.shouldDropActivation(type: 1, subtype: 0, targetPID: 123))
precondition(!focusGuard.shouldDropActivation(type: 13, subtype: 0, targetPID: 124))
focusGuard.release(123)
precondition(focusGuard.shouldDropActivation(type: 13, subtype: 0, targetPID: 123))
focusGuard.release(123)
precondition(!focusGuard.shouldDropActivation(type: 13, subtype: 0, targetPID: 123))
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/BackgroundInput.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /background packets passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("double modifier requires separate bare presses and resets after a chord", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-modifier-"));
  try {
    const source = path.join(root, "main.swift"), binary = path.join(root, "gesture");
    await writeFile(source, `import Foundation
var taps = ModifierDoubleTap()
precondition(!taps.update(pressed: true, interrupted: false, now: 0))
precondition(!taps.update(pressed: true, interrupted: false, now: 0.1), "a repeated flags event is not a second press")
precondition(!taps.update(pressed: false, interrupted: false, now: 0.2))
precondition(taps.update(pressed: true, interrupted: false, now: 0.3))
precondition(!taps.update(pressed: false, interrupted: false, now: 0.4))
precondition(!taps.update(pressed: true, interrupted: false, now: 1))
precondition(!taps.update(pressed: true, interrupted: true, now: 1.1))
precondition(!taps.update(pressed: false, interrupted: false, now: 1.2))
precondition(!taps.update(pressed: true, interrupted: false, now: 1.3), "a chord cancels the first press")
precondition(!taps.update(pressed: false, interrupted: false, now: 1.4))
precondition(!taps.update(pressed: true, interrupted: false, now: 2), "expired taps must not capture")
print("gesture contracts passed")`);
    execFileSync("xcrun", ["swiftc", "native/computer-use/ModifierDoubleTap.swift", source, "-o", binary], { timeout: 30_000 });
    assert.match(execFileSync(binary, { encoding: "utf8", timeout: 5000 }), /gesture contracts passed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("原生观察按调用方和窗口隔离，拒绝过期、错配与重复输入且限制容量", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-observation-core-"));
  try {
    const source = path.join(directory, "main.swift");
    await writeFile(source, `import Foundation
var now: TimeInterval = 0
let store = ComputerObservations<String>(limit: 3, now: { now })
func save(_ id: String, _ owner: String, _ window: Int, _ element: String) {
  store.save(id: id, owner: owner, pid: 12, windowID: window, elements: ["e1": element], geometry: ["x": Double(window)])
}
func refuses(_ id: String, _ owner: String, _ window: Int) {
  do { _ = try store.take(id: id, owner: owner, pid: 12, windowID: window); fatalError("错误观察被用于输入") }
  catch { precondition(error.localizedDescription.hasPrefix("observation_invalid")) }
}
save("a", "client-a", 42, "窗口甲")
save("b", "client-b", 43, "窗口乙")
refuses("a", "client-b", 42)
refuses("a", "client-a", 43)
let first = try store.take(id: "a", owner: "client-a", pid: 12, windowID: 42)
precondition(first.elements["e1"] == "窗口甲" && first.geometry["x"] == 42)
refuses("a", "client-a", 42)
let second = try store.take(id: "b", owner: "client-b", pid: 12, windowID: 43)
precondition(second.elements["e1"] == "窗口乙")
save("old", "client-a", 42, "旧")
save("new", "client-a", 42, "新")
refuses("old", "client-a", 42)
now = 60
refuses("new", "client-a", 42)
for i in 0..<4 { now += 1; save("\\(i)", "client-\\(i)", i + 1, "元素") }
refuses("0", "client-0", 1)
precondition(first.elements["e1"] == "窗口甲", "新观察不能修改已取得的输入副本")
print("observation contracts passed")
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/Observations.swift", source, "-o", executable], { timeout: 30_000 });
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }), /observation contracts passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
