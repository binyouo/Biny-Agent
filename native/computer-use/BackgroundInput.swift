import AppKit
import CoreGraphics

enum BackgroundInput {
    static func mouseEvent(pid: pid_t, windowID: Int, type: CGEventType, point: CGPoint, button: CGMouseButton, clickState: Int64) throws -> CGEvent {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
            throw NSError(domain: "input", code: 64, userInfo: [NSLocalizedDescriptionKey: "input_event_unavailable"])
        }
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
        event.flags = []
        return event
    }

    static func shouldDropActivation(type: UInt32, subtype: Int16, targetPID: pid_t, blocked: Set<pid_t>) -> Bool {
        (type == 13 || type == 14 && subtype == 8) && blocked.contains(targetPID)
    }
}

final class BackgroundFocusGuard {
    private let lock = NSLock()
    private var blocked: [pid_t: Int] = [:]
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var armed = false
    private var observedActivations = 0

    var status: [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["armed": armed, "observed_activations": observedActivations]
    }

    private func setArmed(_ value: Bool) {
        lock.lock(); defer { lock.unlock() }
        armed = value
    }

    @MainActor func arm() throws {
        if let tap, CFMachPortIsValid(tap), CGEvent.tapIsEnabled(tap: tap) { return }
        setArmed(false)
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap { CFMachPortInvalidate(tap) }
        source = nil; tap = nil
        let mask: CGEventMask = (1 << 13) | (1 << 14)
        let callback: CGEventTapCallBack = { _, type, event, context in
            guard let context else { return Unmanaged.passUnretained(event) }
            let guardState = Unmanaged<BackgroundFocusGuard>.fromOpaque(context).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                if let tap = guardState.tap {
                    CGEvent.tapEnable(tap: tap, enable: true)
                    guardState.setArmed(CGEvent.tapIsEnabled(tap: tap))
                }
                return Unmanaged.passUnretained(event)
            }
            guard let native = NSEvent(cgEvent: event), native.data1 > 0, native.data1 <= Int(Int32.max) else { return Unmanaged.passUnretained(event) }
            let drop = guardState.shouldDropActivation(type: UInt32(native.type.rawValue), subtype: native.subtype.rawValue, targetPID: pid_t(native.data1))
            return drop ? nil : Unmanaged.passUnretained(event)
        }
        guard let created = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
            eventsOfInterest: mask, callback: callback, userInfo: Unmanaged.passUnretained(self).toOpaque()),
            let runSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0) else {
            throw NSError(domain: "input", code: 64, userInfo: [NSLocalizedDescriptionKey: "focus_guard_unavailable: background input was not dispatched; enable Accessibility for the Computer Use helper"])
        }
        tap = created; source = runSource
        CFRunLoopAddSource(CFRunLoopGetMain(), runSource, .commonModes)
        CGEvent.tapEnable(tap: created, enable: true)
        guard CGEvent.tapIsEnabled(tap: created) else {
            throw NSError(domain: "input", code: 64, userInfo: [NSLocalizedDescriptionKey: "focus_guard_unavailable: background input was not dispatched"])
        }
        setArmed(true)
    }

    func block(_ pid: pid_t) {
        lock.lock(); defer { lock.unlock() }
        blocked[pid, default: 0] += 1
    }

    func shouldDropActivation(type: UInt32, subtype: Int16, targetPID: pid_t) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let drop = BackgroundInput.shouldDropActivation(type: type, subtype: subtype, targetPID: targetPID, blocked: Set(blocked.keys))
        if drop { observedActivations += 1 }
        return drop
    }

    func release(_ pid: pid_t) {
        lock.lock(); defer { lock.unlock() }
        let remaining = (blocked[pid] ?? 0) - 1
        if remaining > 0 { blocked[pid] = remaining } else { blocked.removeValue(forKey: pid) }
    }
}
