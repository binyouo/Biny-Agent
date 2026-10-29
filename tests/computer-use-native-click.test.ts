import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("native click prefers physical bounds, honors explicit strategies and never repeats uncertain input", { skip: process.platform !== "darwin", timeout: 30_000 }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "biny-click-route-"));
  try {
    const source = path.join(directory, "test.swift");
    writeFileSync(source, `import Foundation
import ApplicationServices
@main struct Harness {
    static func run(_ strategy: String = "auto", special: Bool = false, bounds: Bool = true,
                    ax: AccessibilityActionResult = .success, physicalError: Bool = false) async -> [String: Any] {
        var calls: [String] = []
        var result: String
        do {
            result = try await performElementClick(strategy: strategy, requiresPhysical: special, physical: {
                calls.append("bounds")
                guard bounds else { return false }
                calls.append("physical")
                if physicalError { throw NSError(domain: "input", code: 1, userInfo: [NSLocalizedDescriptionKey: "physical_outcome_unknown"]) }
                return true
            }, accessibility: { calls.append("ax"); return ax })
        } catch { result = String(error.localizedDescription.split(separator: ":")[0]) }
        return ["result": result, "calls": calls]
    }
    static func main() async throws {
        let results: [String: Any] = [
            "auto": await run(),
            "noBounds": await run(bounds: false),
            "unavailable": await run(bounds: false, ax: .unsupported),
            "axUnknown": await run(bounds: false, ax: .unknown(-25204)),
            "physicalUnknown": await run(physicalError: true),
            "ax": await run("ax"),
            "axUnsupported": await run("ax", ax: .unsupported),
            "axExplicitUnknown": await run("ax", ax: .unknown(-25204)),
            "axSpecial": await run("ax", special: true),
            "physical": await run("physical"),
            "physicalNoBounds": await run("physical", bounds: false),
            "special": await run(special: true),
            "specialNoBounds": await run(special: true, bounds: false)
        ]
        print(String(data: try JSONSerialization.data(withJSONObject: results, options: [.sortedKeys]), encoding: .utf8)!)
    }
}
`);
    const executable = path.join(directory, "test");
    execFileSync("xcrun", ["swiftc", "-swift-version", "5", "native/computer-use/AccessibilityAction.swift", source, "-o", executable], { timeout: 20_000 });
    const results = JSON.parse(execFileSync(executable, { encoding: "utf8", timeout: 5_000 }));
    assert.deepEqual(results, {
      auto: { result: "physical", calls: ["bounds", "physical"] },
      noBounds: { result: "ax", calls: ["bounds", "ax"] },
      unavailable: { result: "click_action_unavailable", calls: ["bounds", "ax"] },
      axUnknown: { result: "click_action_outcome_unknown", calls: ["bounds", "ax"] },
      physicalUnknown: { result: "physical_outcome_unknown", calls: ["bounds", "physical"] },
      ax: { result: "ax", calls: ["ax"] },
      axUnsupported: { result: "click_action_unsupported", calls: ["ax"] },
      axExplicitUnknown: { result: "click_action_outcome_unknown", calls: ["ax"] },
      axSpecial: { result: "ax_cannot_express_this_click", calls: [] },
      physical: { result: "physical", calls: ["bounds", "physical"] },
      physicalNoBounds: { result: "element_has_no_frame", calls: ["bounds"] },
      special: { result: "physical", calls: ["bounds", "physical"] },
      specialNoBounds: { result: "element_has_no_frame", calls: ["bounds"] }
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
