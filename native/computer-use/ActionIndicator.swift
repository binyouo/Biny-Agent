import AppKit
import QuartzCore
import ImageIO

@MainActor final class ActionIndicatorView: NSView {
    let cursorLayer = CALayer()
    let pulseLayer = CAShapeLayer()
    private let badgeLayer = CALayer()
    private var eventID: Int?
    private var hideTimer: Timer?
    private var point: CGPoint?
    override var isFlipped: Bool { true }
    static let hotspot = CGPoint(x: 13, y: 22)
    static let color = NSColor(srgbRed: 217.0/255, green: 119.0/255, blue: 87.0/255, alpha: 1)
    static let cursorImage = makeImage()
    private static let blinkingImage = makeImage(blink: true)
    private static let airborneImage = makeImage(airborne: true)
    private static let stillPayload = pngPayload([cursorImage])
    private static let animatedPayload = pngPayload([cursorImage, blinkingImage])
    static var cursorPayload: [String: Any]? {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? stillPayload : animatedPayload
    }

    private static func makeImage(blink: Bool = false, airborne: Bool = false) -> NSImage {
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 52, pixelsHigh: 52,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 208, bitsPerPixel: 32)!
        bitmap.size = NSSize(width: 26, height: 26)
        let context = NSGraphicsContext(bitmapImageRep: bitmap)!.cgContext
        context.clear(CGRect(x: 0, y: 0, width: 52, height: 52))
        context.translateBy(x: 0, y: 26); context.scaleBy(x: 1, y: -1)
        context.setShouldAntialias(false)
        let foot: CGFloat = airborne ? 9 : 10
        let outline: [CGPoint] = [
            CGPoint(x: 2, y: 0), CGPoint(x: 14, y: 0), CGPoint(x: 14, y: 4), CGPoint(x: 16, y: 4),
            CGPoint(x: 16, y: 6), CGPoint(x: 14, y: 6), CGPoint(x: 14, y: 8), CGPoint(x: 13, y: 8),
            CGPoint(x: 13, y: foot), CGPoint(x: 12, y: foot), CGPoint(x: 12, y: 8), CGPoint(x: 11, y: 8),
            CGPoint(x: 11, y: foot), CGPoint(x: 10, y: foot), CGPoint(x: 10, y: 8), CGPoint(x: 6, y: 8),
            CGPoint(x: 6, y: foot), CGPoint(x: 5, y: foot), CGPoint(x: 5, y: 8), CGPoint(x: 4, y: 8),
            CGPoint(x: 4, y: foot), CGPoint(x: 3, y: foot), CGPoint(x: 3, y: 8), CGPoint(x: 2, y: 8),
            CGPoint(x: 2, y: 6), CGPoint(x: 0, y: 6), CGPoint(x: 0, y: 4), CGPoint(x: 2, y: 4)
        ]
        let shape = CGMutablePath()
        for (index, point) in outline.enumerated() {
            let pixel = CGPoint(x: 1 + point.x * 1.5, y: 7 + point.y * 1.5)
            if index == 0 { shape.move(to: pixel) } else { shape.addLine(to: pixel) }
        }
        shape.closeSubpath()
        context.setShadow(offset: CGSize(width: 0, height: 1), blur: 1.5, color: NSColor.black.withAlphaComponent(0.25).cgColor)
        context.addPath(shape); context.setFillColor(color.cgColor)
        context.setStrokeColor(NSColor.white.cgColor); context.setLineWidth(1.2); context.setLineJoin(.miter)
        context.drawPath(using: .fillStroke)
        context.setShadow(offset: .zero, blur: 0, color: nil)
        context.setFillColor(NSColor(srgbRed: 27.0/255, green: 27.0/255, blue: 31.0/255, alpha: 1).cgColor)
        for x: CGFloat in [4, 11] {
            context.fill(CGRect(x: 1 + x * 1.5, y: 7 + (blink ? 2.9 : 2) * 1.5, width: 1.5, height: blink ? 0.3 : 3))
        }
        let image = NSImage(size: NSSize(width: 26, height: 26)); image.addRepresentation(bitmap)
        return image
    }

    private static func pngPayload(_ frames: [NSImage]) -> [String: Any]? {
        let bytes = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(bytes, "public.png" as CFString, frames.count, nil) else { return nil }
        if frames.count > 1 { CGImageDestinationSetProperties(destination, [kCGImagePropertyPNGDictionary: [kCGImagePropertyAPNGLoopCount: 0]] as CFDictionary) }
        for (index, frame) in frames.enumerated() {
            guard let image = frame.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
            let properties = frames.count > 1 ? [kCGImagePropertyPNGDictionary: [kCGImagePropertyAPNGDelayTime: index == 0 ? 2.99 : 0.11]] as CFDictionary : nil
            CGImageDestinationAddImage(destination, image, properties)
        }
        guard CGImageDestinationFinalize(destination) else { return nil }
        return ["mimeType": "image/png", "dataBase64": (bytes as Data).base64EncodedString()]
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true; layer?.isGeometryFlipped = true
        cursorLayer.bounds = CGRect(x: 0, y: 0, width: 26, height: 26)
        cursorLayer.anchorPoint = CGPoint(x: Self.hotspot.x / 26, y: Self.hotspot.y / 26)
        cursorLayer.contents = Self.cursorImage.cgImage(forProposedRect: nil, context: nil, hints: nil)
        cursorLayer.contentsGravity = .resizeAspect
        pulseLayer.bounds = CGRect(x: -15, y: -15, width: 30, height: 30)
        pulseLayer.path = CGPath(ellipseIn: CGRect(x: -15, y: -15, width: 30, height: 30), transform: nil)
        pulseLayer.fillColor = Self.color.withAlphaComponent(0.12).cgColor
        pulseLayer.strokeColor = Self.color.cgColor; pulseLayer.lineWidth = 2
        badgeLayer.bounds = CGRect(x: 0, y: 0, width: 48, height: 18)
        badgeLayer.contentsGravity = .resizeAspect; badgeLayer.backgroundColor = Self.color.cgColor
        badgeLayer.cornerRadius = 5
        for item in [pulseLayer, cursorLayer, badgeLayer] { item.opacity = 0; layer?.addSublayer(item) }
    }
    required init?(coder: NSCoder) { nil }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private func idle() {
        if cursorLayer.animation(forKey: "breathe") == nil {
            let breathe = CAKeyframeAnimation(keyPath: "transform")
            breathe.values = [NSValue(caTransform3D: CATransform3DIdentity), NSValue(caTransform3D: CATransform3DMakeScale(0.965, 1.035, 1)), NSValue(caTransform3D: CATransform3DIdentity)]
            breathe.keyTimes = [0, 0.5, 1]; breathe.duration = 2.4; breathe.repeatCount = .infinity
            breathe.timingFunctions = [CAMediaTimingFunction(name: .easeInEaseOut), CAMediaTimingFunction(name: .easeInEaseOut)]
            cursorLayer.add(breathe, forKey: "breathe")
        }
        if cursorLayer.animation(forKey: "blink") == nil {
            let blink = CAKeyframeAnimation(keyPath: "contents")
            blink.values = [Self.cursorImage, Self.blinkingImage, Self.cursorImage].compactMap { $0.cgImage(forProposedRect: nil, context: nil, hints: nil) }
            blink.keyTimes = [0, 0.965, 1]; blink.calculationMode = .discrete; blink.duration = 3.1; blink.repeatCount = .infinity
            cursorLayer.add(blink, forKey: "blink")
        }
    }

    private func move(from: CGPoint, to: CGPoint) {
        let distance = hypot(to.x - from.x, to.y - from.y)
        let hops = max(1, min(4, Int(ceil(distance / 70))))
        var points: [NSValue] = [], transforms: [NSValue] = [], images: [CGImage] = []
        for index in 0...(hops * 16) {
            let hop = min(hops - 1, index / 16), phase = Double(index - hop * 16) / 16
            let progress = (Double(hop) + phase * phase * (3 - 2 * phase)) / Double(hops)
            let air = phase > 0.08 && phase < 0.92
            let lift = min(10, max(4, distance / CGFloat(hops) * 0.12)) * sin(.pi * max(0, min(1, (phase - 0.08) / 0.84)))
            points.append(NSValue(point: CGPoint(x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress - lift)))
            let squash = phase < 0.08 ? phase / 0.08 : max(0, (1 - phase) / 0.08)
            transforms.append(NSValue(caTransform3D: CATransform3DMakeScale(air ? 0.94 : 1 + 0.16 * squash, air ? 1.08 : 1 - 0.2 * squash, 1)))
            images.append((air ? Self.airborneImage : Self.cursorImage).cgImage(forProposedRect: nil, context: nil, hints: nil)!)
        }
        let position = CAKeyframeAnimation(keyPath: "position"); position.values = points
        let transform = CAKeyframeAnimation(keyPath: "transform"); transform.values = transforms
        let contents = CAKeyframeAnimation(keyPath: "contents"); contents.values = images; contents.calculationMode = .discrete
        let travel = CAAnimationGroup(); travel.animations = [position, transform, contents]
        travel.duration = max(0.18, min(0.65, distance / 650))
        cursorLayer.add(travel, forKey: "move")
    }

    func show(at target: CGPoint, action: ActionCursor.Action, symbol: String?, eventID: Int, duration: TimeInterval = ActionCursor.lifetime, reduceMotion: Bool = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion) {
        hideTimer?.invalidate()
        let previous = cursorLayer.presentation()?.position ?? point
        let newEvent = self.eventID != eventID
        CATransaction.begin(); CATransaction.setDisableActions(true)
        cursorLayer.position = target; cursorLayer.opacity = 1; pulseLayer.position = target
        badgeLayer.position = CGPoint(x: target.x + 38, y: target.y + 4)
        let icons = ["keyboard": "⌨", "arrow.up": "↑", "arrow.down": "↓", "arrow.left": "←", "arrow.right": "→"]
        let label = "Biny" + (symbol.flatMap { icons[$0] }.map { " " + $0 } ?? "")
        let badge = NSImage(size: badgeLayer.bounds.size)
        badge.lockFocus()
        (label as NSString).draw(in: NSRect(x: 5, y: 3, width: 43, height: 13), withAttributes: [.font: NSFont.systemFont(ofSize: 10, weight: .semibold), .foregroundColor: NSColor.white])
        badge.unlockFocus(); badgeLayer.contents = badge.cgImage(forProposedRect: nil, context: nil, hints: nil); badgeLayer.opacity = 1
        CATransaction.commit()
        if reduceMotion { cursorLayer.removeAllAnimations() }
        else {
            idle()
            if newEvent, let previous, previous != target { move(from: previous, to: target) }
        }
        if newEvent {
            pulseLayer.removeAllAnimations()
            if action == .click {
                CATransaction.begin(); CATransaction.setDisableActions(true); pulseLayer.opacity = reduceMotion ? 0.7 : 0; CATransaction.commit()
                if !reduceMotion {
                    let scale = CABasicAnimation(keyPath: "transform.scale"); scale.fromValue = 0.35; scale.toValue = 1.5
                    let opacity = CABasicAnimation(keyPath: "opacity"); opacity.fromValue = 0.9; opacity.toValue = 0
                    let pulse = CAAnimationGroup(); pulse.animations = [scale, opacity]; pulse.duration = 0.35
                    pulseLayer.add(pulse, forKey: "click")
                }
            } else { pulseLayer.opacity = 0 }
        }
        self.point = target; self.eventID = eventID
        hideTimer = Timer.scheduledTimer(withTimeInterval: max(0, duration), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.hide() }
        }
    }
    func hide() {
        hideTimer?.invalidate(); hideTimer = nil
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for item in [cursorLayer, pulseLayer, badgeLayer] { item.removeAllAnimations(); item.opacity = 0 }
        CATransaction.commit()
        point = nil; eventID = nil
    }
}

private final class LensWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor final class LensOverlay {
    private var windows: [ObjectIdentifier: (window: NSWindow, indicator: ActionIndicatorView)] = [:]
    private var active: ObjectIdentifier?
    private var hideTimer: Timer?
    private var eventID = 0
    private var screenObserver: NSObjectProtocol?
    private var visibilityTimer: Timer?

    init() {
        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.resetScreens() }
        }
    }
    private func resetScreens() {
        hide()
        for item in windows.values { item.window.close() }
        windows.removeAll()
    }
    private func targetVisible(_ point: CGPoint, pid: Int, windowID: Int) -> Bool {
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let desktopTop = NSScreen.screens.first?.frame.maxY ?? 0
        let displays = NSScreen.screens.map { screen in
            CGRect(x: screen.frame.minX, y: desktopTop - screen.frame.maxY, width: screen.frame.width, height: screen.frame.height)
        }
        let dockPID = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first.map { Int($0.processIdentifier) }
        return ActionCursorGeometry.windowVisible(at: point, pid: pid, windowID: windowID, windows: windows, ignoringPID: Int(getpid()), dockPID: dockPID, displays: displays)
    }
    func show(at point: CGPoint, action: ActionCursor.Action, symbol: String?, pid: Int?, windowID: Int?) {
        if let pid, let windowID, !targetVisible(point, pid: pid, windowID: windowID) { hide(); return }
        let desktopTop = NSScreen.screens.first?.frame.maxY ?? 0
        guard let screen = NSScreen.screens.first(where: { ActionCursorGeometry.screenPoint(point, screen: $0.frame, desktopTop: desktopTop) != nil }),
              let local = ActionCursorGeometry.screenPoint(point, screen: screen.frame, desktopTop: desktopTop) else { hide(); return }
        let id = ObjectIdentifier(screen)
        if active != id { hide() }
        if windows[id] == nil {
            let window = LensWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false; window.isOpaque = false; window.backgroundColor = .clear; window.hasShadow = false
            window.ignoresMouseEvents = true; window.level = .screenSaver; window.sharingType = .none
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            let indicator = ActionIndicatorView(frame: CGRect(origin: .zero, size: screen.frame.size))
            indicator.autoresizingMask = [.width, .height]; window.contentView = indicator
            windows[id] = (window, indicator)
        }
        active = id; eventID += 1
        windows[id]?.indicator.show(at: local, action: action, symbol: symbol, eventID: eventID)
        windows[id]?.window.orderFrontRegardless()
        visibilityTimer?.invalidate()
        if let pid, let windowID {
            visibilityTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if !self.targetVisible(point, pid: pid, windowID: windowID) { self.hide() }
                }
            }
        }
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: ActionCursor.lifetime, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.hide() }
        }
    }
    func hide() {
        hideTimer?.invalidate(); hideTimer = nil
        visibilityTimer?.invalidate(); visibilityTimer = nil
        if let active { windows[active]?.indicator.hide(); windows[active]?.window.orderOut(nil) }
        active = nil
    }
    deinit { if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) } }
}
