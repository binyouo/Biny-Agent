import Foundation

struct ModifierDoubleTap {
    private var lastPress: TimeInterval?
    private var down = false
    private var bothDown = false
    private var suppressed = false
    mutating func update(pressed: Bool, both: Bool = false, interrupted: Bool, now: TimeInterval) -> Bool {
        let wasDown = down; let hadBoth = bothDown
        down = pressed; bothDown = both
        if interrupted { lastPress = nil; suppressed = pressed; return false }
        if !pressed { suppressed = false; return false }
        if suppressed { return false }
        if both && !hadBoth { lastPress = nil; suppressed = true; return true }
        guard pressed, !wasDown else { return false }
        if let previous = lastPress, now >= previous, now - previous <= 0.45 { lastPress = nil; return true }
        lastPress = now; return false
    }
}
