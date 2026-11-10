import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("native cancellation stops AX invocation before it can reach a target", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-input-cancel-"));
  try {
    const source = path.join(root, "main.swift");
    await writeFile(source, `import Foundation
import ApplicationServices
actor Gate {
    var entered = false
    var waiter: CheckedContinuation<Void, Never>?
    func wait() async { entered = true; await withCheckedContinuation { waiter = $0 } }
    func release() { waiter?.resume(); waiter = nil }
}
@main struct Harness {
    static func main() async throws {
        let gate = Gate()
        let task = Task { () -> [String: Any] in
            await gate.wait()
            let request = NativeInputDispatch()
            return NativeInputDispatch.$current.withValue(request) {
                var calls = 0
                var cancelled = false
                do { _ = try NativeInputDispatch.action({ calls += 1; return .success }()) }
                catch { cancelled = true }
                return ["calls": calls, "cancelled": cancelled, "inputNotDispatched": request.inputNotDispatched]
            }
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !(await gate.entered) { precondition(ContinuousClock.now < deadline); await Task.yield() }
        task.cancel()
        await gate.release()
        print(String(data: try JSONSerialization.data(withJSONObject: await task.value), encoding: .utf8)!)
    }
}
`);
    const binary = path.join(root, "input-cancel");
    execFileSync("xcrun", ["swiftc", "-parse-as-library", "-swift-version", "5", "native/computer-use/AccessibilityAction.swift", "native/computer-use/InputDispatch.swift", source, "-o", binary], { timeout: 30_000 });
    const result = JSON.parse(execFileSync(binary, { encoding: "utf8", timeout: 10_000 }));
    assert.deepEqual(result, { calls: 0, cancelled: true, inputNotDispatched: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native dispatch evidence stays request-local and cannot undo an earlier input", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-input-evidence-"));
  try {
    const source = path.join(root, "main.swift");
    await writeFile(source, `import Foundation
import ApplicationServices
@main struct Harness {
    static func state(_ body: () throws -> Void) rethrows -> Bool {
        let state = NativeInputDispatch()
        return try NativeInputDispatch.$current.withValue(state) {
            try body()
            return state.inputNotDispatched
        }
    }
    static func main() async throws {
        let noInput = state {}
        let posted = state { NativeInputDispatch.markStarted() }
        let unsupported = try state { _ = try NativeInputDispatch.action(.actionUnsupported) }
        let unknown = try state { _ = try NativeInputDispatch.action(.cannotComplete) }
        let accepted = try state { _ = try NativeInputDispatch.attribute(.success) }
        let actionWrongUnsupported = try state { _ = try NativeInputDispatch.action(.attributeUnsupported) }
        let attributeWrongUnsupported = try state { _ = try NativeInputDispatch.attribute(.actionUnsupported) }
        let laterUnsupported = try state {
            NativeInputDispatch.markStarted()
            _ = try NativeInputDispatch.attribute(.attributeUnsupported)
        }
        let outer = NativeInputDispatch(), inner = NativeInputDispatch()
        let nested = NativeInputDispatch.$current.withValue(outer) {
            NativeInputDispatch.$current.withValue(inner) { NativeInputDispatch.markStarted() }
            return outer.inputNotDispatched && !inner.inputNotDispatched
        }
        let isolated = await withTaskGroup(of: Bool.self) { group in
            for index in 0..<32 {
                group.addTask {
                    let request = NativeInputDispatch()
                    return await NativeInputDispatch.$current.withValue(request) {
                        if index % 2 == 0 { NativeInputDispatch.markStarted() }
                        await Task.yield()
                        return request.inputNotDispatched == (index % 2 != 0)
                    }
                }
            }
            var result = true
            for await success in group { result = success && result }
            return result
        }
        print(String(data: try JSONSerialization.data(withJSONObject: [
            "noInput": noInput, "posted": posted, "unsupported": unsupported,
            "unknown": unknown, "accepted": accepted, "laterUnsupported": laterUnsupported,
            "nested": nested, "isolated": isolated,
            "actionWrongUnsupported": actionWrongUnsupported,
            "attributeWrongUnsupported": attributeWrongUnsupported
        ]), encoding: .utf8)!)
    }
}
`);
    const binary = path.join(root, "input-evidence");
    execFileSync("xcrun", ["swiftc", "-parse-as-library", "-swift-version", "5", "native/computer-use/AccessibilityAction.swift", "native/computer-use/InputDispatch.swift", source, "-o", binary], { timeout: 30_000 });
    const result = JSON.parse(execFileSync(binary, { encoding: "utf8", timeout: 10_000 }));
    assert.deepEqual(result, { noInput: true, posted: false, unsupported: true, unknown: false, accepted: false, laterUnsupported: false, nested: true, isolated: true, actionWrongUnsupported: false, attributeWrongUnsupported: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});
