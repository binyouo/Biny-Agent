import AppKit
import ApplicationServices
import CoreGraphics

struct MenuShortcut<Element> {
    let element: Element
    let keyCode: CGKeyCode
    let modifiers: UInt32
    let enabled: Bool
}

/// AX 的菜单修饰位默认包含 Command，NoCommand 位表示不含 Command。
func menuShortcutFlags(_ modifiers: UInt32) -> CGEventFlags {
    var flags = CGEventFlags()
    if modifiers & 1 != 0 { flags.insert(.maskShift) }
    if modifiers & 2 != 0 { flags.insert(.maskAlternate) }
    if modifiers & 4 != 0 { flags.insert(.maskControl) }
    if modifiers & 8 == 0 { flags.insert(.maskCommand) }
    return flags
}

func matchingMenuShortcut<Element>(_ shortcuts: [MenuShortcut<Element>], keyCode: CGKeyCode, flags: CGEventFlags) -> Element? {
    let mask: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift, .maskSecondaryFn]
    return shortcuts.first { shortcut in
        shortcut.enabled && shortcut.keyCode == keyCode && menuShortcutFlags(shortcut.modifiers) == flags.intersection(mask)
    }?.element
}

func performMenuShortcut<Element>(keyCode: CGKeyCode, flags: CGEventFlags, targetValid: () -> Bool,
    discover: () -> [MenuShortcut<Element>]?, perform: (Element) -> AXError) throws -> Bool {
    guard targetValid(), let shortcuts = discover(),
          let shortcut = matchingMenuShortcut(shortcuts, keyCode: keyCode, flags: flags), targetValid() else { return false }
    switch accessibilityActionResult(perform(shortcut)) {
    case .success: return true
    case .unsupported: throw NSError(domain: "key", code: 65, userInfo: [NSLocalizedDescriptionKey: "menu_shortcut_unsupported: menu action was not performed"])
    case .unknown(let code): throw NSError(domain: "key", code: 65, userInfo: [NSLocalizedDescriptionKey: "menu_shortcut_outcome_unknown: menu action outcome unknown (\(code)); do not retry"])
    }
}
