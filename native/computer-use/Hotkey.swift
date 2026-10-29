import CoreGraphics
import Foundation

let hotkeyKeyCodes: [String: CGKeyCode] = [
    "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9,
    "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
    "O": 31, "U": 32, "I": 34, "P": 35, "L": 37, "J": 38, "K": 40, "N": 45, "M": 46,
    "RETURN": 36, "SPACE": 49, "TAB": 48, "ESCAPE": 53,
    "LEFT": 123, "RIGHT": 124, "DOWN": 125, "UP": 126,
]

struct HotkeySpec {
    let flags: CGEventFlags
    let keyCode: CGKeyCode?              // nil = 单按修饰键两次
    let bareModifier: CGEventFlags?      // double-cmd 之类

    func bothHeld(in flags: CGEventFlags) -> Bool {
        guard let bareModifier else { return false }
        // IOLLEvent.h 的 NX_DEVICE 左右修饰键位；高位只表示某一侧被按下。
        let pair: UInt64
        switch bareModifier {
        case .maskCommand: pair = 0x18
        case .maskAlternate: pair = 0x60
        case .maskShift: pair = 0x06
        case .maskControl: pair = 0x2001
        default: return false
        }
        return flags.rawValue & pair == pair
    }
}

func parseHotkey(_ raw: String) -> HotkeySpec? {
    let text = raw.trimmingCharacters(in: .whitespaces)
    let lower = text.lowercased()
    if lower.hasPrefix("double-") || ["doublecommand", "doubleoption", "doubleshift"].contains(lower) {
        let name = String(lower.dropFirst(lower.hasPrefix("double-") ? 7 : 6))
        let map: [String: CGEventFlags] = ["cmd": .maskCommand, "command": .maskCommand,
                                           "alt": .maskAlternate, "option": .maskAlternate,
                                           "ctrl": .maskControl, "control": .maskControl,
                                           "shift": .maskShift]
        guard let flag = map[name] else { return nil }
        return HotkeySpec(flags: [], keyCode: nil, bareModifier: flag)
    }
    var flags: CGEventFlags = []
    var key: String?
    for raw in text.split(separator: "+") {
        let part = raw.trimmingCharacters(in: .whitespaces).uppercased()
        switch part {
        case "CMD", "COMMAND": flags.insert(.maskCommand)
        case "CTRL", "CONTROL": flags.insert(.maskControl)
        case "ALT", "OPTION": flags.insert(.maskAlternate)
        case "SHIFT": flags.insert(.maskShift)
        default: key = part
        }
    }
    guard let key, let code = hotkeyKeyCodes[key] else { return nil }
    return HotkeySpec(flags: flags, keyCode: code, bareModifier: nil)
}
