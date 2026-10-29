import Foundation
import Carbon.HIToolbox
import CoreGraphics

struct PhysicalStroke {
    let keyCode: CGKeyCode
    let flags: CGEventFlags
}

func requireInputEvent<Event>(_ event: Event?, errorCode: String) throws -> Event {
    guard let event else { throw NSError(domain: "input", code: 64, userInfo: [NSLocalizedDescriptionKey: "\(errorCode): event was not sent"]) }
    return event
}

func keyboardEventPair<Event>(create: (Bool) -> Event?) throws -> (down: Event, up: Event) {
    let down = try requireInputEvent(create(true), errorCode: "keyboard_event_creation_failed")
    let up = try requireInputEvent(create(false), errorCode: "keyboard_event_creation_failed")
    return (down, up)
}

enum PhysicalInput {
    static func autoRoute(axWritable: Bool, physicalAvailable: Bool) -> String { axWritable ? "ax" : physicalAvailable ? "physical" : "unicode" }
    /// 先翻译完整文本再派发；不可表达的后缀不能留下已输入的前缀。
    static func plan(_ text: String, lookup: (String) -> PhysicalStroke?) throws -> [PhysicalStroke] {
        var result: [PhysicalStroke] = []
        for (index, character) in text.enumerated() {
            guard let stroke = lookup(String(character)) else {
                throw failure("input_method_unmappable_character: index \(index); use unicode or ax")
            }
            result.append(stroke)
        }
        return result
    }
    static func currentLayoutPlan(_ text: String) throws -> [PhysicalStroke] {
        let selected = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
        guard let rawType = TISGetInputSourceProperty(selected, kTISPropertyInputSourceType),
              CFEqual(Unmanaged<CFString>.fromOpaque(rawType).takeUnretainedValue(), kTISTypeKeyboardLayout) else {
            throw failure("input_method_layout_required: select a keyboard layout rather than an input method")
        }
        let source = TISCopyCurrentKeyboardLayoutInputSource().takeRetainedValue()
        guard let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { throw failure("input_method_layout_unavailable") }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
        guard let bytes = CFDataGetBytePtr(data) else { throw failure("input_method_layout_unavailable") }
        let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
        var mapping: [String: PhysicalStroke] = [
            "\n": PhysicalStroke(keyCode: 36, flags: []), "\r": PhysicalStroke(keyCode: 36, flags: []),
            "\r\n": PhysicalStroke(keyCode: 36, flags: []), "\t": PhysicalStroke(keyCode: 48, flags: [])
        ]
        let modifiers: [(UInt32, CGEventFlags)] = [(0, []), (UInt32(shiftKey), .maskShift),
            (UInt32(optionKey), .maskAlternate), (UInt32(shiftKey | optionKey), [.maskShift, .maskAlternate])]
        for (carbonFlags, flags) in modifiers {
            for code in UInt16(0)...UInt16(127) {
                var dead: UInt32 = 0
                var length = 0
                var characters = [UniChar](repeating: 0, count: 8)
                let status = UCKeyTranslate(layout, code, UInt16(kUCKeyActionDown), carbonFlags >> 8,
                    UInt32(LMGetKbdType()), OptionBits(1 << kUCKeyTranslateNoDeadKeysBit), &dead, 8, &length, &characters)
                guard status == noErr, length > 0, length <= 8 else { continue }
                let translated = String(utf16CodeUnits: characters, count: Int(length))
                guard translated.count == 1, !translated.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { continue }
                if mapping[translated] == nil { mapping[translated] = PhysicalStroke(keyCode: code, flags: flags) }
            }
        }
        return try plan(text) { mapping[$0] }
    }
    private static func failure(_ message: String) -> NSError { NSError(domain: "type_text", code: 69, userInfo: [NSLocalizedDescriptionKey: message]) }
}

let keyNameMap: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "forwarddelete": 117, "forward_delete": 117, "escape": 53, "esc": 53, "capslock": 57,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "page_up": 116, "prior": 116, "pagedown": 121, "page_down": 121, "next": 121,
    "help": 114, "clear": 71,
    "kp_0": 82, "kp_1": 83, "kp_2": 84, "kp_3": 85, "kp_4": 86, "kp_5": 87,
    "kp_6": 88, "kp_7": 89, "kp_8": 91, "kp_9": 92, "kp_enter": 76,
    "kp_plus": 69, "kp_minus": 78, "kp_multiply": 67, "kp_divide": 75, "kp_decimal": 65, "kp_equals": 81,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31,
    "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
]
let functionKeyCodes: [CGKeyCode] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90]
func parseKeyCombo(_ combo: String) -> (CGKeyCode, CGEventFlags)? {
    let parts = combo.lowercased().split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    guard let last = parts.last, !last.isEmpty else { return nil }
    let functionNumber = last.first == "f" ? Int(last.dropFirst()) : nil
    let functionKey = functionNumber.flatMap { number in
        (1...functionKeyCodes.count).contains(number) && last == "f\(number)" ? functionKeyCodes[number - 1] : nil
    }
    guard let keyCode = keyNameMap[last] ?? functionKey else { return nil }
    var flags = CGEventFlags()
    for modifier in parts.dropLast() {
        switch modifier {
        case "cmd", "command", "meta", "meta_l", "meta_r", "super", "super_l", "super_r": flags.insert(.maskCommand)
        case "ctrl", "control", "control_l", "control_r": flags.insert(.maskControl)
        case "alt", "alt_l", "alt_r", "opt", "option": flags.insert(.maskAlternate)
        case "shift", "shift_l", "shift_r": flags.insert(.maskShift)
        case "fn": flags.insert(.maskSecondaryFn)
        default: return nil
        }
    }
    return (keyCode, flags)
}
