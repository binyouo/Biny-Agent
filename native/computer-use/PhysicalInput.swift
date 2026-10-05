import Foundation
import Carbon.HIToolbox
import CoreGraphics

struct PhysicalStroke {
    let keyCode: CGKeyCode
    let flags: CGEventFlags
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
