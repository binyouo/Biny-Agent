import Foundation

struct ModifierDoubleTap {
    private var lastPress: TimeInterval?
    private var down = false
    mutating func update(pressed: Bool, interrupted: Bool, now: TimeInterval) -> Bool {
        let wasDown = down; down = pressed
        if interrupted { lastPress = nil; return false }
        guard pressed, !wasDown else { return false }
        if let previous = lastPress, now - previous <= 0.45 { lastPress = nil; return true }
        lastPress = now; return false
    }
}
