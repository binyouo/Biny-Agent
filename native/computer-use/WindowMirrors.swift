import CryptoKit
import AppKit
import ScreenCaptureKit
import CoreImage
import ApplicationServices

private final class MirrorPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class MirrorStreamSink: NSObject, SCStreamOutput, SCStreamDelegate {
    var receive: ((CGImage?, String?) -> Void)?
    private let context = CIContext()
    private let lock = NSLock()
    private var painting = false
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              attachments.first?[.status] as? Int == SCFrameStatus.complete.rawValue,
              let buffer = sampleBuffer.imageBuffer else { return }
        lock.lock()
        if painting { lock.unlock(); return }
        painting = true; lock.unlock()
        let source = CIImage(cvPixelBuffer: buffer)
        let image = context.createCGImage(source, from: source.extent)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.receive?(image, image == nil ? "pip_frame_decode_failed" : nil)
            self.lock.lock(); self.painting = false; self.lock.unlock()
        }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { [weak self] in self?.receive?(nil, "pip_stream_stopped") }
    }
}

@MainActor private final class WindowMirror: NSObject, NSWindowDelegate {
    let session: MirrorSessions.Session
    let sink = MirrorStreamSink()
    var stream: SCStream?
    var startup: Task<Void, Error>?
    var panel: NSPanel?
    var observer: AXObserver?
    var observedWindow: AXUIElement?
    var lastImage: CGImage?
    var requestID: String?
    var external = false
    var layoutKey = ""
    var onClose: (() -> Void)?
    let imageView = NSImageView()
    let label = NSTextField(labelWithString: "正在等待画面")
    init(_ session: MirrorSessions.Session) { self.session = session }
    func windowWillClose(_ notification: Notification) { onClose?() }
}

@MainActor final class WindowMirrors {
    private let sessions = MirrorSessions()
    private var mirrors: [Int: WindowMirror] = [:]
    private var opening: [Int: (lease: UUID, requestID: String?)] = [:]
    private var freshnessTimer: Timer?
    var isEmpty: Bool { sessions.isEmpty }
    func list() -> [String: Any] { sessions.list() }

    func open(_ args: [String: Any]) async throws -> [String: Any] {
        guard let windowID = args["window_id"] as? Int, windowID > 0, windowID <= Int(UInt32.max) else { throw failure("pip_invalid_window_id") }
        let armed = args["on_minimize"] as? Bool ?? false
        let requestID = args["request_id"] as? String
        if let existing = mirrors[windowID] {
            if let requestID, existing.requestID != requestID { throw failure("pip_owner_conflict") }
            if let pid = args["pid"] as? Int, pid != existing.session.pid { throw failure("pip_window_identity_changed") }
            try await existing.startup?.value
            guard sessions.contains(existing.session) else { throw failure("pip_open_cancelled") }
            if !armed { try present(existing) }
            return sessions.state(windowID: windowID)!
        }
        guard screenTrusted() else { throw screenRecordingMissing() }
        guard opening[windowID] == nil else { throw failure("pip_open_in_progress") }
        guard Set(mirrors.keys).union(opening.keys).count < 8 else { throw failure("pip_session_limit") }
        let lease = UUID()
        opening[windowID] = (lease, requestID)
        defer { if opening[windowID]?.lease == lease { opening.removeValue(forKey: windowID) } }
        // 枚举可以跨 actor 让出执行权，回来后再检查一次，防止同时打开两份镜像。
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard opening[windowID]?.lease == lease else { throw failure("pip_open_cancelled") }
        guard let window = content.windows.first(where: { Int($0.windowID) == windowID }),
              let owner = window.owningApplication, owner.processID != getpid() else { throw failure("pip_window_not_found") }
        if let requested = args["pid"] as? Int, requested != Int(owner.processID) { throw failure("pip_window_identity_changed") }
        let session = try sessions.begin(windowID: windowID, pid: Int(owner.processID), armed: armed)
        let mirror = WindowMirror(session)
        mirror.requestID = requestID
        mirror.external = args["external"] as? Bool ?? false
        mirror.layoutKey = "biny-pip-" + SHA256.hash(data: Data((owner.bundleIdentifier + ":" + (window.title ?? "")).utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        mirrors[windowID] = mirror
        mirror.onClose = { [weak self] in _ = self?.close(["window_id": windowID]) }
        mirror.sink.receive = { [weak self, weak mirror] image, error in
            guard let self, let mirror, self.sessions.contains(session) else { return }
            if let error { self.sessions.fail(session, error: error) }
            if let image {
                mirror.lastImage = image; self.sessions.frame(session)
                mirror.imageView.image = NSImage(cgImage: image, size: .zero)
            }
            self.updateLabel(mirror)
        }
        mirror.startup = Task {
            do {
                if armed { try self.armMinimize(mirror) }
                let config = SCStreamConfiguration()
                let width = max(1, min(960, Int(window.frame.width)))
                config.width = width
                config.height = max(1, min(2160, Int(window.frame.height * CGFloat(width) / max(1, window.frame.width))))
                config.minimumFrameInterval = CMTime(value: 1, timescale: 3)
                config.queueDepth = 3; config.showsCursor = false; config.capturesAudio = false
                let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: config, delegate: mirror.sink)
                mirror.stream = stream
                try stream.addStreamOutput(mirror.sink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "biny.mirror.\(windowID)"))
                try await stream.startCapture()
                guard self.sessions.contains(session), !Task.isCancelled else {
                    try? await stream.stopCapture(); throw self.failure("pip_open_cancelled")
                }
                if !armed || (mirror.observedWindow.flatMap { axCopy($0, kAXMinimizedAttribute as String) as? Bool } ?? false) { try self.present(mirror) }
            } catch {
                if self.sessions.contains(session) { _ = self.close(["window_id": windowID]) }
                throw error
            }
        }
        try await mirror.startup!.value
        startFreshnessTimer()
        guard sessions.contains(session) else { throw failure("pip_open_cancelled") }
        return sessions.state(windowID: windowID)!
    }

    func close(_ args: [String: Any]) -> [String: Any] {
        let ids = args["all"] as? Bool == true ? Array(Set(mirrors.keys).union(opening.keys)) : (args["window_id"] as? Int).map { [$0] } ?? []
        var count = 0
        for id in ids {
            if let requestID = args["request_id"] as? String,
               (mirrors[id]?.requestID ?? opening[id]?.requestID) != requestID { continue }
            let pending = opening.removeValue(forKey: id)
            if pending != nil && mirrors[id] == nil { count += 1 }
            guard let mirror = mirrors.removeValue(forKey: id) else { continue }
            sessions.close(windowID: id); count += 1
            mirror.startup?.cancel(); mirror.onClose = nil
            if let observer = mirror.observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }
            mirror.observer = nil; mirror.sink.receive = nil
            mirror.panel?.delegate = nil; mirror.panel?.close()
            if let stream = mirror.stream { Task { try? await stream.stopCapture() } }
        }
        if mirrors.isEmpty { freshnessTimer?.invalidate(); freshnessTimer = nil }
        if count > 0 { try? publishPrivacy(active: mirrors.values.contains { $0.panel?.isVisible == true }) }
        return ["closed": count]
    }

    func frame(_ args: [String: Any]) throws -> [String: Any] {
        guard let id = args["window_id"] as? Int, let mirror = mirrors[id], mirror.external,
              let owner = args["request_id"] as? String, mirror.requestID == owner else { throw failure("pip_owner_conflict") }
        var data = sessions.state(windowID: id) ?? [:]
        if data["state"] as? String == "open", let image = mirror.lastImage {
            let representation = NSBitmapImageRep(cgImage: image)
            if let bytes = representation.representation(using: .jpeg, properties: [.compressionFactor: 0.45]), bytes.count <= 1048576 {
                data["image"] = ["mimeType": "image/jpeg", "dataBase64": bytes.base64EncodedString()]
            } else { data["error"] = "pip_frame_budget_exceeded" }
        }
        return data
    }

    private func present(_ mirror: WindowMirror) throws {
        guard sessions.contains(mirror.session) else { return }
        if mirror.external { sessions.present(mirror.session); return }
        if mirror.panel == nil {
            let screen = NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1024, height: 768)
            let panel = MirrorPanel(contentRect: CGRect(x: screen.maxX - 440, y: screen.maxY - 340, width: 420, height: 290),
                                    styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.title = "窗口镜像 · \(mirror.session.windowID)"; panel.level = .floating
            panel.isReleasedWhenClosed = false; panel.hidesOnDeactivate = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.sharingType = .none; panel.delegate = mirror
            let content = NSVisualEffectView(); content.material = .hudWindow; content.state = .active
            panel.contentView = content
            mirror.imageView.imageScaling = .scaleProportionallyUpOrDown
            mirror.imageView.image = mirror.lastImage.map { NSImage(cgImage: $0, size: .zero) }
            mirror.label.textColor = .secondaryLabelColor; mirror.label.font = .systemFont(ofSize: 11)
            for view in [mirror.imageView, mirror.label] { view.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(view) }
            NSLayoutConstraint.activate([
                mirror.imageView.topAnchor.constraint(equalTo: content.topAnchor, constant: 6),
                mirror.imageView.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 6),
                mirror.imageView.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -6),
                mirror.imageView.bottomAnchor.constraint(equalTo: mirror.label.topAnchor, constant: -6),
                mirror.label.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 10),
                mirror.label.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -10),
                mirror.label.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -8)
            ])
            _ = panel.setFrameAutosaveName(mirror.layoutKey)
            mirror.panel = panel
        }
        if mirror.panel?.isVisible != true { try publishPrivacy(active: true) }
        sessions.present(mirror.session); updateLabel(mirror)
        mirror.panel?.orderFrontRegardless()
    }
    private func updateLabel(_ mirror: WindowMirror) {
        guard let state = sessions.state(windowID: mirror.session.windowID) else { return }
        if let error = state["error"] as? String { mirror.label.stringValue = "画面已中断 · \(error)" }
        else if let age = state["last_frame_age_ms"] as? Int { mirror.label.stringValue = age < 2000 ? "实时画面" : "画面已停留 \(age / 1000) 秒" }
        else { mirror.label.stringValue = "正在等待画面" }
    }
    private func startFreshnessTimer() {
        guard freshnessTimer == nil else { return }
        freshnessTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { guard let self else { return }; for mirror in self.mirrors.values { self.updateLabel(mirror) } }
        }
    }
    private func armMinimize(_ mirror: WindowMirror) throws {
        guard axTrusted(), let window = axWindow(pid: pid_t(mirror.session.pid), matching: mirror.session.windowID) else { throw failure("pip_minimize_observation_unavailable") }
        var observer: AXObserver?
        let created = AXObserverCreate(pid_t(mirror.session.pid), { _, _, notification, refcon in
            guard let refcon else { return }
            let mirror = Unmanaged<WindowMirror>.fromOpaque(refcon).takeUnretainedValue()
            MainActor.assumeIsolated {
                if notification as String == kAXUIElementDestroyedNotification { mirror.onClose?() }
                else { windowMirrors.handleMinimize(mirror.session.windowID) }
            }
        }, &observer)
        guard created == .success, let observer else { throw failure("pip_minimize_observation_unavailable") }
        let pointer = Unmanaged.passUnretained(mirror).toOpaque()
        guard AXObserverAddNotification(observer, window, kAXWindowMiniaturizedNotification as CFString, pointer) == .success else { throw failure("pip_minimize_observation_unavailable") }
        _ = AXObserverAddNotification(observer, window, kAXUIElementDestroyedNotification as CFString, pointer)
        mirror.observer = observer; mirror.observedWindow = window
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
    }
    fileprivate func handleMinimize(_ id: Int) {
        guard let mirror = mirrors[id] else { return }
        do { try present(mirror) }
        catch { sessions.fail(mirror.session, error: "pip_privacy_registry_unavailable") }
    }
    private func publishPrivacy(active: Bool) throws {
        let directory = NSTemporaryDirectory() + "biny-mirror-privacy-\(getuid())"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = URL(fileURLWithPath: directory + "/\(getpid()).json")
        let data = try JSONSerialization.data(withJSONObject: ["pid": Int(getpid()), "active": active, "epoch": UUID().uuidString])
        try data.write(to: url, options: .atomic); chmod(url.path, 0o600)
    }
    private func failure(_ message: String) -> NSError { NSError(domain: "pip", code: 64, userInfo: [NSLocalizedDescriptionKey: message]) }
}

@MainActor let windowMirrors = WindowMirrors()
