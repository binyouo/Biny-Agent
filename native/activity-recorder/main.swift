// Activity Recorder 的 macOS 采集 sidecar。
//
// 记录器以整屏 JPEG 为主输入，同时保留 AX/输入事件作为时间线元数据。缩略图去重
// 在 sidecar 内完成；sidecar 不写配置、SQLite 或模型上下文。
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

private struct ActivitySettings: Decodable {
    let enabled: Bool
    let captureDebounceMs: Int
    let heartbeatMs: Int
    let idleTimeoutMs: Int
    let inputPauseMs: Int
    let visualPollMs: Int
    let browserPollIntervalMs: Int
    let jpegQuality: Int
    let histogramChangeThreshold: Double
    let pixelDiffThreshold: Double
    let pixelTolerance: Int
    let ocrEnabled: Bool
    let inputMonitoringEnabled: Bool
    let ocrLanguages: [String]
    let ocrEveryNFrames: Int
    let sensitiveApplications: Set<String>

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        let rawCaptureDebounceMs = try values.decodeIfPresent(Int.self, forKey: .captureDebounceMs) ?? 4_000
        let rawHeartbeatMs = try values.decodeIfPresent(Int.self, forKey: .heartbeatMs) ?? 120_000
        let rawIdleTimeoutMs = try values.decodeIfPresent(Int.self, forKey: .idleTimeoutMs) ?? 30_000
        let rawInputPauseMs = try values.decodeIfPresent(Int.self, forKey: .inputPauseMs) ?? 1_200
        let rawVisualPollMs = try values.decodeIfPresent(Int.self, forKey: .visualPollMs) ?? 12_000
        let rawBrowserPollIntervalMs = try values.decodeIfPresent(Int.self, forKey: .browserPollIntervalMs) ?? 12_000
        let rawJpegQuality = try values.decodeIfPresent(Int.self, forKey: .jpegQuality) ?? 55
        let rawOcrEveryNFrames = try values.decodeIfPresent(Int.self, forKey: .ocrEveryNFrames) ?? 3
        captureDebounceMs = max(3_000, rawCaptureDebounceMs == 0 ? 4_000 : rawCaptureDebounceMs)
        heartbeatMs = max(60_000, rawHeartbeatMs == 0 ? 120_000 : rawHeartbeatMs)
        idleTimeoutMs = max(10_000, rawIdleTimeoutMs == 0 ? 30_000 : rawIdleTimeoutMs)
        inputPauseMs = max(800, rawInputPauseMs == 0 ? 1_200 : rawInputPauseMs)
        visualPollMs = rawVisualPollMs > 0 ? max(10_000, rawVisualPollMs) : 0
        browserPollIntervalMs = rawBrowserPollIntervalMs > 0 ? max(10_000, rawBrowserPollIntervalMs) : 0
        jpegQuality = min(95, max(30, rawJpegQuality == 0 ? 55 : rawJpegQuality))
        histogramChangeThreshold = try values.decodeIfPresent(Double.self, forKey: .histogramChangeThreshold) ?? 0.05
        pixelDiffThreshold = try values.decodeIfPresent(Double.self, forKey: .pixelDiffThreshold) ?? 0.02
        pixelTolerance = try values.decodeIfPresent(Int.self, forKey: .pixelTolerance) ?? 30
        ocrEnabled = try values.decodeIfPresent(Bool.self, forKey: .ocrEnabled) ?? true
        inputMonitoringEnabled = try values.decodeIfPresent(Bool.self, forKey: .inputMonitoringEnabled) ?? true
        ocrLanguages = try values.decodeIfPresent([String].self, forKey: .ocrLanguages) ?? ["en-US", "zh-Hans", "zh-Hant", "ja"]
        ocrEveryNFrames = min(20, max(1, rawOcrEveryNFrames == 0 ? 3 : rawOcrEveryNFrames))
        sensitiveApplications = Set(try values.decodeIfPresent([String].self, forKey: .sensitiveApplications) ?? [
            "com.apple.keychainaccess",
            "com.1password.1password",
            "com.agilebits.onepassword7",
            "org.bitwarden.desktop",
            "com.lastpass.LastPass",
            "com.dashlane.dashlanephonefinal"
        ])
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, captureDebounceMs, heartbeatMs, idleTimeoutMs, inputPauseMs, visualPollMs
        case browserPollIntervalMs, jpegQuality, histogramChangeThreshold, pixelDiffThreshold, pixelTolerance
        case ocrEnabled, inputMonitoringEnabled
        case ocrLanguages, ocrEveryNFrames, sensitiveApplications
    }
}

private struct SidecarCommand: Decodable {
    let type: String
    let settings: ActivitySettings?
    let permission: String?
    let desktopCaptureAvailable: Bool?
    let requestId: String?
    let imageBase64: String?
    let error: String?
}

/// 备用截图只在本机父进程与 sidecar 间传输；去重、隐私检查和 OCR 仍由 sidecar 负责。
private struct DesktopCaptureRequest: Encodable {
    let type = "desktop_capture"
    let requestId: String
    let maxWidth: Int
}

private struct SidecarStatus: Encodable {
    let type = "status"
    let status: String
    let screenRecordingGranted: Bool
    let accessibilityGranted: Bool
    let axAvailable: Bool
    let fallbackAvailable: Bool
    let screenLocked: Bool
    let currentApplication: String?
    let inputEventCount: Int
    let error: String?
}

private struct SidecarEvent: Encodable {
    let type = "event"
    let occurredAt: String
    let eventType: String
    let application: String?
    let bundleId: String?
    let windowTitle: String?
    let axRole: String?
    let axTitle: String?
    /// 浏览器标签 URL：结构化字段，主进程直落 activity_events.url 列，不经过文本脱敏。
    let url: String?
    let text: String?
    let mouseEventType: String?
    let mouseButton: String?
    /// 输入监听只传 keyCode/modifier，不传字符；敏感应用会清空这两个字段。
    let keyCode: Int?
    let keyModifiers: UInt64?
    let mouseX: Double?
    let mouseY: Double?
    let inputEventCount: Int
    /// keypress 聚合同时保留首个 keyDown 时间；事件 occurredAt 仍是最后一个 keyDown。
    let inputEventFirstAt: String?
    let axAvailable: Bool
    let fallbackReason: String?
}

private struct SidecarCapture: Encodable {
    let type = "capture"
    let occurredAt: String
    let eventType = "fallback_capture"
    let application: String?
    let bundleId: String?
    let windowTitle: String?
    let axRole: String?
    let axTitle: String?
    let text: String?
    let jpegBase64: String
    let ocrText: String?
    let inputEventCount: Int
    let fallbackReason: String
    let captureTrigger: String
    let width: Int
    let height: Int
    /// 需要异步 OCR 的截图用这个 ID 与后续 OCR 投影关联。
    let captureId: String?
    let contentHash: String
    let histogramChange: Double?
    let pixelDiff: Double?
}

private struct SidecarOcr: Encodable {
    let type = "ocr"
    let captureId: String
    let ocrText: String?
}

private struct SidecarError: Encodable {
    let type = "error"
    let message: String
}

private struct AXContext {
    var windowTitle: String?
    var axRole: String?
    var axTitle: String?
    var text: String?
    var valid: Bool
    var secureTextField: Bool

    static let unavailable = AXContext(
        windowTitle: nil,
        axRole: nil,
        axTitle: nil,
        text: nil,
        valid: false,
        secureTextField: false
    )
}

private final class SidecarOutput {
    private let lock = NSLock()
    private let encoder = JSONEncoder()

    func write<T: Encodable>(_ value: T) {
        guard let data = try? encoder.encode(value) else { return }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}

@MainActor
private final class ActivityRecorder {
    private struct FrameSignature {
        let hash: UInt32
        let histogram: [Double]
        let pixels: [UInt8]
    }

    private struct FrameAcceptance {
        let accepted: Bool
        let histogramChange: Double?
        let pixelDiff: Double?
    }

    // 这类应用的主要内容是画布/视频，AX 可以返回控件但通常无法描述画面本身。
    private let visualApplicationBundleIds: Set<String> = [
        "com.apple.Preview",
        "com.apple.QuickTimePlayerX",
        "com.figma.Desktop",
        "com.bohemiancoding.sketch3",
        "com.adobe.Photoshop",
        "com.adobe.Photoshop2024",
        "com.pixelmatorteam.pixelmator.x"
    ]
    // P4：只有这些浏览器会被轮询当前标签。Chrome/Edge 家族共用 Chromium 的
    // 「active tab of front window」脚本，Safari 家族用「front document」。
    private let supportedBrowserBundleIds: Set<String> = [
        "com.google.Chrome",
        "com.google.Chrome.canary",
        "com.google.Chrome.beta",
        "com.microsoft.edgemac",
        "com.brave.Browser",
        "com.brave.Browser.beta",
        "company.thebrowser.Browser",
        "com.thebrowser.dia",
        "com.vivaldi.Vivaldi",
        "com.operasoftware.Opera",
        "com.apple.Safari",
        "com.apple.SafariTechnologyPreview"
    ]
    private struct BrowserTabState {
        let bundleId: String
        let url: String
        let title: String
    }
    private let output: SidecarOutput
    private var settings: ActivitySettings?
    private var fallbackTimer: DispatchSourceTimer?
    private var heartbeatTimer: DispatchSourceTimer?
    private var fallbackCheckWorkItem: DispatchWorkItem?
    private var browserPollTimer: DispatchSourceTimer?
    private var browserPollWorkItem: DispatchWorkItem?
    private var browserScripts: [String: (url: NSAppleScript, title: NSAppleScript)] = [:]
    private var lastBrowserTab: BrowserTabState?
    /// Apple Events 被拒绝（-1743）后短暂退避，避免每个轮询周期都重复失败开销；
    /// 用户后续在系统设置里授权后，退避结束会自动恢复采集。
    private var browserAutomationBlockedUntil: Date?
    /// 使用 NSEvent 全局 monitor；它与 Accessibility 授权绑定，不需要单独的 Input Monitoring TCC 条目。
    private var globalEventMonitors: [Any] = []
    private var workspaceObserver: NSObjectProtocol?
    private var distributedNotificationObservers: [NSObjectProtocol] = []
    private var powerNotificationObservers: [NSObjectProtocol] = []
    private var axObserver: AXObserver?
    private var axApplicationElement: AXUIElement?
    private var axRegistrations: [(element: AXUIElement, notification: CFString)] = []
    private var keyBurstWorkItem: DispatchWorkItem?
    private var typingPauseWorkItem: DispatchWorkItem?
    private var lastInputAt: Date?
    private var lastActivityAt: Date?
    private var lastSensitiveEventAt: Date?
    /// 在截图尝试开始前就更新时间戳；截图失败也必须参与 debounce。
    private var lastCaptureAttemptAt: Date?
    private var captureFailureCount = 0
    private var nextCaptureAllowedAt: Date?
    private var fallbackPendingReason: String?
    private var lastFrameSignature: FrameSignature?
    private var visualIdleTicks = 0
    private var snapshotsSinceLastOcr = 0
    private var inputEventCount = 0
    private var keyBurstCount = 0
    private var keyBurstCode: Int?
    private var keyBurstModifiers: UInt64?
    private var keyBurstApplication: NSRunningApplication?
    private var keyBurstFirstOccurredAt: Date?
    private var keyBurstLastOccurredAt: Date?
    private var captureContextEpoch: UInt64 = 0
    private var sessionActive = false {
        didSet { if oldValue != sessionActive { captureContextEpoch &+= 1 } }
    }
    private var captureInFlight = false
    private var currentContext = AXContext.unavailable {
        didSet { if oldValue.secureTextField != currentContext.secureTextField { captureContextEpoch &+= 1 } }
    }
    private var currentApplication: NSRunningApplication? {
        didSet { if oldValue?.processIdentifier != currentApplication?.processIdentifier { captureContextEpoch &+= 1 } }
    }
    private var lastAccessibilityGranted = false
    private var screenLocked = false {
        didSet { if oldValue != screenLocked { captureContextEpoch &+= 1 } }
    }
    /// 睡眠唤醒本身不产生 unlock 事件；若系统随后再发 screenIsUnlocked，吞掉这一次通知。
    private var powerWakePendingUnlock = false
    private var lastStatusError: String?
    private var desktopCaptureAvailable = false
    // 原生失败后保持降级直到进程退出，避免每个轮询都重复调用已失败的原生后端。
    private var nativeCaptureFailed = false
    private var pendingDesktopCapture: (id: String, continuation: CheckedContinuation<CGImage, Error>)?

    init(output: SidecarOutput) {
        self.output = output
    }

    func handle(_ command: SidecarCommand) {
        switch command.type {
        case "start":
            guard let settings = command.settings else {
                output.write(SidecarError(message: "start 缺少 Activity 设置。"))
                return
            }
            desktopCaptureAvailable = command.desktopCaptureAvailable == true
            start(settings)
        case "desktop_capture_result":
            guard let pending = pendingDesktopCapture, pending.id == command.requestId else { return }
            pendingDesktopCapture = nil
            if command.error == nil, let encoded = command.imageBase64,
               encoded.count <= 28_000_000,
               let data = Data(base64Encoded: encoded), let bitmap = NSBitmapImageRep(data: data), let image = bitmap.cgImage {
                pending.continuation.resume(returning: image)
            } else {
                pending.continuation.resume(throwing: NSError(domain: "BinyActivityRecorder", code: 3))
            }
        case "stop":
            stop()
        case "settings_updated":
            guard let updated = command.settings else {
                output.write(SidecarError(message: "settings_updated 缺少 Activity 设置。"))
                return
            }
            applySettingsUpdate(updated)
        case "status":
            emitStatus(status: sessionActive ? "running" : "stopped", error: lastStatusError)
        case "capture":
            // 仅供本地 smoke/诊断调用：沿用正常的整屏 JPEG、去重和 OCR 链路，不绕过隐私黑名单。
            requestCapture(reason: "manual")
        case "reset_browser_state":
            // 浏览器轮询不会创建 session；主进程创建新 session 后清空去重基线，
            // 让当前仍未变化的标签也能作为新 session 的第一条浏览器事件落库。
            lastBrowserTab = nil
        case "request_permission":
            requestPermission(command.permission)
        default:
            output.write(SidecarError(message: "未知 sidecar 命令：\(command.type)"))
        }
    }

    private func requestPermission(_ permission: String?) {
        guard let permission else {
            output.write(SidecarError(message: "request_permission 缺少权限类型。"))
            return
        }
        switch permission {
        case "screen-recording":
            _ = CGRequestScreenCaptureAccess()
        default:
            output.write(SidecarError(message: "未知权限类型：\(permission)"))
            return
        }
        emitStatus(status: sessionActive ? "running" : "stopped", error: statusError())
    }

    func stop() {
        if let pending = pendingDesktopCapture {
            pendingDesktopCapture = nil
            pending.continuation.resume(throwing: CancellationError())
        }
        if sessionActive {
            flushKeyBurst()
        }
        fallbackTimer?.cancel()
        fallbackTimer = nil
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        fallbackCheckWorkItem?.cancel()
        fallbackCheckWorkItem = nil
        browserPollTimer?.cancel()
        browserPollTimer = nil
        browserPollWorkItem?.cancel()
        browserPollWorkItem = nil
        browserScripts.removeAll()
        lastBrowserTab = nil
        browserAutomationBlockedUntil = nil
        keyBurstWorkItem?.cancel()
        keyBurstWorkItem = nil
        typingPauseWorkItem?.cancel()
        typingPauseWorkItem = nil
        keyBurstCode = nil
        keyBurstModifiers = nil
        keyBurstApplication = nil
        keyBurstFirstOccurredAt = nil
        keyBurstLastOccurredAt = nil
        lastSensitiveEventAt = nil
        removeGlobalEventMonitors()
        removeWorkspaceObserver()
        removeDistributedNotificationObservers()
        removePowerNotificationObservers()
        removeAXObserver()
        sessionActive = false
        screenLocked = false
        lastAccessibilityGranted = false
        powerWakePendingUnlock = false
        fallbackPendingReason = nil
        lastActivityAt = nil
        lastInputAt = nil
        lastCaptureAttemptAt = nil
        captureFailureCount = 0
        nextCaptureAllowedAt = nil
        visualIdleTicks = 0
        captureInFlight = false
        emitStatus(status: "stopped", error: nil)
    }

    private func start(_ nextSettings: ActivitySettings) {
        stop()
        settings = nextSettings
        guard nextSettings.enabled else {
            emitStatus(status: "paused", error: nil)
            return
        }

        snapshotsSinceLastOcr = 0
        inputEventCount = 0
        keyBurstCount = 0
        keyBurstCode = nil
        keyBurstModifiers = nil
        keyBurstApplication = nil
        keyBurstFirstOccurredAt = nil
        keyBurstLastOccurredAt = nil
        lastSensitiveEventAt = nil
        lastCaptureAttemptAt = nil
        captureFailureCount = 0
        nextCaptureAllowedAt = nil
        fallbackPendingReason = nil
        lastFrameSignature = nil
        visualIdleTicks = 0
        lastStatusError = nil
        screenLocked = false
        sessionActive = true
        if nextSettings.inputMonitoringEnabled {
            installWorkspaceObserver()
        }
        installDistributedNotificationObservers()
        installPowerNotificationObservers()
        installGlobalInputMonitorsIfNeeded(nextSettings)
        installFallbackTimer(nextSettings)
        installBrowserPollTimer(nextSettings)
        // input monitor 只在真正收到应用切换通知时写 app_focus；启动时只缓存前台应用。
        frontmostApplicationChanged(NSWorkspace.shared.frontmostApplication, emitEvent: false)
        lastAccessibilityGranted = AXIsProcessTrusted()
        emitStatus(status: "running", error: statusError())
    }

    /// alma 语义的热更新：运行中不重置去重基线、输入聚合与当前会话，定时器用新参数重排。
    /// 会话/空闲计时相关参数由主进程持有，天然到下个会话才生效；OCR 开关在采集链路逐帧读取，无需额外处理。
    private func applySettingsUpdate(_ nextSettings: ActivitySettings) {
        guard sessionActive, settings != nil else {
            // 未在录制时不做任何重排；下次 start 会携带完整设置。
            settings = nextSettings
            return
        }
        settings = nextSettings
        if nextSettings.inputMonitoringEnabled {
            installWorkspaceObserver()
            installGlobalInputMonitorsIfNeeded(nextSettings)
        } else {
            removeGlobalEventMonitors()
            removeWorkspaceObserver()
        }
        installFallbackTimer(nextSettings)
        installBrowserPollTimer(nextSettings)
        emitStatus(status: sessionActive ? "running" : "stopped", error: statusError())
    }

    private func installWorkspaceObserver() {
        guard workspaceObserver == nil else { return }
        workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: OperationQueue.main
        ) { [weak self] notification in
            let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            Task { @MainActor [weak self] in
                self?.frontmostApplicationChanged(application ?? NSWorkspace.shared.frontmostApplication)
            }
        }
    }

    private func removeWorkspaceObserver() {
        if let workspaceObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(workspaceObserver)
            self.workspaceObserver = nil
        }
    }

    /// 用系统分布式通知记录锁屏边界；锁屏本身是事件时间线的一部分，但期间不截图。
    private func installDistributedNotificationObservers() {
        let center = DistributedNotificationCenter.default()
        let names = ["com.apple.screenIsLocked", "com.apple.screenIsUnlocked"]
        distributedNotificationObservers = names.map { name in
            center.addObserver(
                forName: Notification.Name(name),
                object: nil,
                queue: OperationQueue.main
            ) { [weak self] notification in
                let locked = notification.name.rawValue == "com.apple.screenIsLocked"
                Task { @MainActor [weak self] in
                    self?.screenLockChanged(locked)
                }
            }
        }
    }

    private func removeDistributedNotificationObservers() {
        let center = DistributedNotificationCenter.default()
        for observer in distributedNotificationObservers {
            center.removeObserver(observer)
        }
        distributedNotificationObservers.removeAll()
    }

    /// powerMonitor hook 与输入 helper 独立：睡眠时暂停采集并收口当前 session，
    /// 唤醒时只重置截图/浏览器状态，不额外制造 unlock 事件。
    private func installPowerNotificationObservers() {
        guard powerNotificationObservers.isEmpty else { return }
        let center = NSWorkspace.shared.notificationCenter
        powerNotificationObservers = [
            center.addObserver(
                forName: NSWorkspace.willSleepNotification,
                object: nil,
                queue: OperationQueue.main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.handlePowerSleep()
                }
            },
            center.addObserver(
                forName: NSWorkspace.didWakeNotification,
                object: nil,
                queue: OperationQueue.main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.handlePowerWake()
                }
            }
        ]
    }

    private func removePowerNotificationObservers() {
        let center = NSWorkspace.shared.notificationCenter
        for observer in powerNotificationObservers {
            center.removeObserver(observer)
        }
        powerNotificationObservers.removeAll()
    }

    private func handlePowerSleep() {
        guard sessionActive else { return }
        powerWakePendingUnlock = true
        if !screenLocked {
            screenLockChanged(true)
        }
    }

    private func handlePowerWake() {
        guard sessionActive else { return }
        screenLocked = false
        lastFrameSignature = nil
        lastBrowserTab = nil
        visualIdleTicks = 0
        fallbackPendingReason = nil
        fallbackCheckWorkItem?.cancel()
        fallbackCheckWorkItem = nil
        browserPollWorkItem?.cancel()
        browserPollWorkItem = nil
        // 分布式 screenIsUnlocked 通知通常会紧随唤醒到达；它只负责清掉这个标记，
        // 不再重复写一条 unlock，保持 suspend/resume 的事件语义。
        powerWakePendingUnlock = true
        emitStatus(status: "running", error: statusError())
    }

    private func screenLockChanged(_ locked: Bool) {
        guard sessionActive else { return }
        if !locked && powerWakePendingUnlock {
            powerWakePendingUnlock = false
            screenLocked = false
            emitStatus(status: "running", error: statusError())
            return
        }
        guard screenLocked != locked else { return }
        if locked {
            powerWakePendingUnlock = false
            // 先把锁屏前已经聚合的输入事件写出，再写 lock，保证时间线顺序稳定。
            flushKeyBurst()
            screenLocked = true
            fallbackPendingReason = nil
            fallbackCheckWorkItem?.cancel()
            fallbackCheckWorkItem = nil
            browserPollWorkItem?.cancel()
            browserPollWorkItem = nil
            lastBrowserTab = nil
            emitSemanticEvent(eventType: "lock")
        } else {
            screenLocked = false
            // 解锁后的第一帧不能拿锁屏前的指纹做去重比较。
            lastFrameSignature = nil
            lastBrowserTab = nil
            visualIdleTicks = 0
            emitSemanticEvent(eventType: "unlock")
        }
        emitStatus(status: "running", error: statusError())
    }

    private func installFallbackTimer(_ nextSettings: ActivitySettings) {
        fallbackTimer?.cancel()
        fallbackTimer = nil
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        if nextSettings.visualPollMs > 0 {
            let interval = max(250, nextSettings.visualPollMs)
            let source = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
            source.schedule(deadline: .now() + .milliseconds(interval), repeating: .milliseconds(interval), leeway: .milliseconds(100))
            source.setEventHandler { [weak self] in
                guard let self else { return }
                self.refreshPermissionState()
                let now = Date()
                if let lastCaptureAttemptAt = self.lastCaptureAttemptAt,
                   now.timeIntervalSince(lastCaptureAttemptAt) * 1_000 < Double(interval) {
                    self.visualIdleTicks = 0
                    return
                }
                // 无输入时逐步降低视觉轮询频率，避免静止桌面持续唤醒截图链路。
                // 轮询仍保留，动画/视频应用在下一次允许的 tick 会继续被发现。
                if nextSettings.inputMonitoringEnabled {
                    let lastInputAt = self.lastInputAt ?? Date(timeIntervalSince1970: 0)
                    let idleMs = now.timeIntervalSince(lastInputAt) * 1_000
                    if idleMs > Double(nextSettings.idleTimeoutMs) {
                        self.visualIdleTicks += 1
                        let divisor = min(5, 1 + Int(idleMs / (4 * Double(interval))))
                        if self.visualIdleTicks % max(1, divisor) != 0 { return }
                    } else {
                        self.visualIdleTicks = 0
                    }
                } else {
                    self.visualIdleTicks = 0
                }
                // 视觉轮询先取 160×90 指纹，只有画面真的变化才会再取整屏图。
                self.requestCapture(reason: "visual_change", dedupOnly: true)
            }
            source.resume()
            fallbackTimer = source
        }

        let heartbeatInterval = max(1_000, nextSettings.heartbeatMs)
        let heartbeatSource = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
        heartbeatSource.schedule(
            deadline: .now() + .milliseconds(heartbeatInterval),
            repeating: .milliseconds(heartbeatInterval),
            leeway: .milliseconds(250)
        )
        heartbeatSource.setEventHandler { [weak self] in
            guard let self else { return }
            self.refreshPermissionState()
            // heartbeat 直接调用 maybeCapture，不进入普通 pending trigger 队列，
            // 不能覆盖点击/焦点/输入暂停正在等待的原因。
            self.requestCapture(reason: "heartbeat")
        }
        heartbeatSource.resume()
        heartbeatTimer = heartbeatSource
    }

    // P4：浏览器标签轮询。只有前台应用是受支持浏览器时才真正执行 AppleScript，
    // 因此不额外占用事件流；Apple Events 无权限（-1743）时安静降级，不报错不上报。
    private func installBrowserPollTimer(_ nextSettings: ActivitySettings) {
        browserPollTimer?.cancel()
        browserPollTimer = nil
        guard nextSettings.browserPollIntervalMs > 0 else { return }
        let intervalMs = max(1_000, nextSettings.browserPollIntervalMs)
        let source = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
        source.schedule(
            deadline: .now() + .milliseconds(intervalMs),
            repeating: .milliseconds(intervalMs),
            leeway: .milliseconds(250)
        )
        source.setEventHandler { [weak self] in
            self?.pollFrontmostBrowser()
        }
        source.resume()
        browserPollTimer = source
    }

    private func scheduleImmediateBrowserPoll() {
        guard settings?.browserPollIntervalMs ?? 0 > 0, sessionActive, !screenLocked else { return }
        browserPollWorkItem?.cancel()
        // 应用刚切到前台时窗口/标签可能还没就绪，延迟 300ms 再查，失败由周期轮询兜底。
        let workItem = DispatchWorkItem { [weak self] in
            self?.pollFrontmostBrowser()
        }
        browserPollWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(300), execute: workItem)
    }

    private func pollFrontmostBrowser() {
        guard sessionActive, settings?.enabled == true, !screenLocked else { return }
        refreshFrontmostApplicationIfNeeded(emitEvent: settings?.inputMonitoringEnabled == true)
        // session 是否存在由主进程决定；这里只负责采集前台标签，Service 会丢弃没有 session
        // 的浏览器事件，避免 sidecar 用自己的时间戳限制 session 语义。
        guard let app = NSWorkspace.shared.frontmostApplication,
              let bundleId = app.bundleIdentifier,
              supportedBrowserBundleIds.contains(bundleId) else { return }
        // 敏感应用黑名单（含浏览器内的密码框焦点）一律不采集标签。
        guard !isSensitive(application: app, context: currentContext), let settings, settings.browserPollIntervalMs > 0 else { return }
        if let blockedUntil = browserAutomationBlockedUntil, Date() < blockedUntil { return }
        guard let tab = queryFrontTab(bundleId: bundleId) else { return }
        if let last = lastBrowserTab, last.bundleId == bundleId, last.url == tab.url, last.title == tab.title {
            return
        }
        lastBrowserTab = tab
        emitBrowserTabEvents(application: app, url: tab.url, title: tab.title)
    }

    private func queryFrontTab(bundleId: String) -> BrowserTabState? {
        let scripts: (url: NSAppleScript, title: NSAppleScript)
        if let cached = browserScripts[bundleId] {
            scripts = cached
        } else {
            guard let source = browserScriptSource(for: bundleId),
                  let urlScript = NSAppleScript(source: source.urlScript),
                  let titleScript = NSAppleScript(source: source.titleScript) else { return nil }
            scripts = (url: urlScript, title: titleScript)
            browserScripts[bundleId] = scripts
        }
        var urlError: NSDictionary?
        guard let rawUrl = scripts.url.executeAndReturnError(&urlError).stringValue,
              !rawUrl.isEmpty,
              let url = safeUrl(rawUrl) else {
            if let number = urlError?[NSAppleScript.errorNumber] as? Int, number == -1743 {
                browserAutomationBlockedUntil = Date().addingTimeInterval(60)
            }
            return nil
        }
        // 标题偶尔拿不到（如正在加载中）时仍上报 URL，标题可空。
        let title = scripts.title.executeAndReturnError(nil).stringValue ?? ""
        return BrowserTabState(bundleId: bundleId, url: url, title: shortText(title) ?? "")
    }

    /// 返回该浏览器的 AppleScript 源：Safari 家族走 document，Chromium 家族走窗口标签。
    private func browserScriptSource(for bundleId: String) -> (urlScript: String, titleScript: String)? {
        guard supportedBrowserBundleIds.contains(bundleId) else { return nil }
        if bundleId == "com.apple.Safari" || bundleId == "com.apple.SafariTechnologyPreview" {
            return (
                urlScript: "tell application id \"\(bundleId)\" to get URL of front document",
                titleScript: "tell application id \"\(bundleId)\" to get name of front document"
            )
        }
        return (
            urlScript: "tell application id \"\(bundleId)\" to get URL of active tab of front window",
            titleScript: "tell application id \"\(bundleId)\" to get title of active tab of front window"
        )
    }

    private func emitBrowserTabEvents(application: NSRunningApplication, url: String, title: String) {
        guard sessionActive, !screenLocked else { return }
        let now = Date()
        let occurredAt = ISO8601DateFormatter().string(from: now)
        let normalizedTitle = shortText(title)
        output.write(SidecarEvent(
            occurredAt: occurredAt,
            eventType: "browser_visit",
            application: application.localizedName,
            bundleId: application.bundleIdentifier,
            windowTitle: normalizedTitle,
            axRole: nil,
            axTitle: nil,
            url: safeUrl(url),
            text: nil,
            mouseEventType: nil,
            mouseButton: nil,
            keyCode: nil,
            keyModifiers: nil,
            mouseX: nil,
            mouseY: nil,
            inputEventCount: inputEventCount,
            inputEventFirstAt: nil,
            axAvailable: currentContext.valid && !isVisualApplication(application),
            fallbackReason: nil
        ))
        if let normalizedTitle {
            output.write(SidecarEvent(
                occurredAt: occurredAt,
                eventType: "window_title",
                application: application.localizedName,
                bundleId: application.bundleIdentifier,
                windowTitle: normalizedTitle,
                axRole: nil,
                axTitle: nil,
                url: nil,
                text: nil,
                mouseEventType: nil,
                mouseButton: nil,
                keyCode: nil,
                keyModifiers: nil,
                mouseX: nil,
                mouseY: nil,
                inputEventCount: inputEventCount,
                inputEventFirstAt: nil,
                axAvailable: currentContext.valid && !isVisualApplication(application),
                fallbackReason: nil
            ))
        }
    }

    /// URL 结构化字段的准入：只收 http/https，清理控制字符，限长；不在这里做内容脱敏。
    private func safeUrl(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 2_048,
              let schemeEnd = trimmed.range(of: "://")?.lowerBound else { return nil }
        let scheme = String(trimmed[..<schemeEnd]).lowercased()
        guard scheme == "http" || scheme == "https" else { return nil }
        return String(trimmed.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
    }

    private func refreshPermissionState() {
        guard sessionActive else { return }
        if let settings {
            // 关闭输入监听时没有 app focus observer；视觉/heartbeat 仍必须使用最新前台应用，
            // 否则 fallbackCaptureAllowed 会一直拿旧 PID 拒绝截图。
            refreshFrontmostApplicationIfNeeded(emitEvent: settings.inputMonitoringEnabled)
        }
        if let settings, settings.inputMonitoringEnabled, globalEventMonitors.isEmpty {
            installGlobalInputMonitorsIfNeeded(settings)
        }
        let accessibilityGranted = AXIsProcessTrusted()
        if accessibilityGranted && (!lastAccessibilityGranted || (axObserver == nil && !currentContext.valid)) {
            rebindAXObserver(for: currentApplication ?? NSWorkspace.shared.frontmostApplication)
        } else if !accessibilityGranted && lastAccessibilityGranted {
            // 撤销权限时清掉旧上下文，不能继续把旧 secure-field 结果当成当前状态。
            removeAXObserver()
        }
        lastAccessibilityGranted = accessibilityGranted
        emitStatus(status: "running", error: statusError())
    }

    private func installGlobalInputMonitorsIfNeeded(_ nextSettings: ActivitySettings) {
        guard nextSettings.inputMonitoringEnabled, globalEventMonitors.isEmpty else { return }
        let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown]) { [weak self] event in
            guard let self else { return }
            // 回调瞬间读取 Cocoa 坐标和前台应用；异步处理只负责回到主队列。
            let application = NSWorkspace.shared.frontmostApplication
            let occurredAt = Date()
            let location: CGPoint?
            let mouseButton: String?
            let type: CGEventType
            let keyCode: Int?
            let keyModifiers: UInt64?
            switch event.type {
            case .leftMouseDown:
                type = .leftMouseDown
                location = NSEvent.mouseLocation
                mouseButton = "left"
                keyCode = nil
                keyModifiers = nil
            case .rightMouseDown:
                type = .rightMouseDown
                location = NSEvent.mouseLocation
                mouseButton = "right"
                keyCode = nil
                keyModifiers = nil
            case .keyDown:
                type = .keyDown
                location = nil
                mouseButton = nil
                keyCode = Int(event.keyCode)
                keyModifiers = UInt64(event.modifierFlags.rawValue)
            default:
                return
            }
            DispatchQueue.main.async {
                self.handleGlobalEvent(
                    type,
                    mouseButton: mouseButton,
                    keyCode: keyCode,
                    keyModifiers: keyModifiers,
                    mouseLocation: location,
                    application: application,
                    occurredAt: occurredAt
                )
            }
        }
        if let monitor {
            globalEventMonitors.append(monitor)
        }
    }

    private func removeGlobalEventMonitors() {
        for monitor in globalEventMonitors {
            NSEvent.removeMonitor(monitor)
        }
        globalEventMonitors.removeAll()
    }

    fileprivate func handleGlobalEvent(
        _ type: CGEventType,
        mouseButton: String?,
        keyCode: Int?,
        keyModifiers: UInt64?,
        mouseLocation: CGPoint?,
        application: NSRunningApplication?,
        occurredAt: Date
    ) {
        guard sessionActive, !screenLocked else { return }
        let now = occurredAt
        // NSEvent monitor 在输入回调发生的瞬间读取前台应用，再把这个
        // 身份带入异步处理；不能等回到主队列后再读，否则快速切换应用时会错归属。
        let application = application ?? NSWorkspace.shared.frontmostApplication ?? currentApplication
        let context = contextForApplication(application)
        if isSensitive(application: application, context: context) {
            inputEventCount += 1
            if lastSensitiveEventAt.map({ now.timeIntervalSince($0) >= 5 }) ?? true {
                lastSensitiveEventAt = now
                emitSemanticEvent(
                    eventType: "system",
                    application: application,
                    fallbackReasonOverride: "sensitive_app",
                    updatesActivity: false
                )
            }
            return
        }
        lastActivityAt = now
        lastInputAt = now
        inputEventCount += 1
        switch type {
        case .keyDown:
            keyBurstCount += 1
            keyBurstCode = keyCode
            keyBurstModifiers = keyModifiers
            keyBurstApplication = application
            if keyBurstFirstOccurredAt == nil { keyBurstFirstOccurredAt = now }
            keyBurstLastOccurredAt = now
            scheduleKeyBurstFlush()
            scheduleTypingPauseCapture()
        case .leftMouseDown, .rightMouseDown:
            // input monitor 只记录鼠标按下；释放、拖拽和滚轮不进入 Activity 事件流。
            // 点击是输入时间线的边界，必须先把此前聚合的按键写出。
            flushKeyBurst()
            emitInputEvent(
                eventType: "click",
                application: application,
                occurredAt: now,
                mouseEventType: "click",
                mouseButton: mouseButton,
                mouseLocation: mouseLocation
            )
        default:
            break
        }
    }

    private func scheduleKeyBurstFlush() {
        keyBurstWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in self?.flushKeyBurst() }
        keyBurstWorkItem = workItem
        // input monitor 在 1 秒窗口内合并 keyDown，40 个按键立即冲刷。
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(1_000), execute: workItem)
    }

    private func scheduleTypingPauseCapture() {
        typingPauseWorkItem?.cancel()
        guard let settings else { return }
        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.typingPauseWorkItem = nil
            // typing pause 直接调用 maybeCapture；如果仍在 debounce/backoff
            // 窗口内，本次停顿不会再排一个 pending capture。
            self.requestCapture(reason: "typing_pause")
        }
        typingPauseWorkItem = workItem
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(max(0, settings.inputPauseMs)),
            execute: workItem
        )
    }

    private func flushKeyBurst() {
        guard keyBurstCount > 0 else { return }
        let burstCount = keyBurstCount
        let burstCode = keyBurstCode
        let burstModifiers = keyBurstModifiers
        let burstApplication = keyBurstApplication
        let burstFirstOccurredAt = keyBurstFirstOccurredAt
        let burstOccurredAt = keyBurstLastOccurredAt ?? Date()
        keyBurstCount = 0
        keyBurstCode = nil
        keyBurstModifiers = nil
        keyBurstApplication = nil
        keyBurstFirstOccurredAt = nil
        keyBurstLastOccurredAt = nil
        keyBurstWorkItem = nil
        emitSemanticEvent(
            eventType: "keypress",
            application: burstApplication,
            occurredAt: burstOccurredAt,
            keyCode: burstCode,
            keyModifiers: burstModifiers,
            inputFirstOccurredAt: burstFirstOccurredAt,
            inputCountOverride: burstCount
        )
    }

    private func emitInputEvent(
        eventType: String,
        application: NSRunningApplication?,
        occurredAt: Date,
        mouseEventType: String,
        mouseButton: String?,
        mouseLocation: CGPoint?
    ) {
        emitSemanticEvent(
            eventType: eventType,
            application: application,
            occurredAt: occurredAt,
            mouseEventType: mouseEventType,
            mouseButton: mouseButton,
            mouseLocation: mouseLocation
        )
    }

    private func frontmostApplicationChanged(_ application: NSRunningApplication?, emitEvent: Bool = true) {
        // 应用焦点是输入时间线的边界；先冲刷旧应用的按键聚合，避免事件被新应用错误归类。
        flushKeyBurst()
        currentApplication = application ?? NSWorkspace.shared.frontmostApplication
        // 在 app_focus 边界重置视觉去重；回到同一个应用时也必须重新接受第一帧。
        lastFrameSignature = nil
        rebindAXObserver(for: currentApplication)
        guard emitEvent, !screenLocked else { return }
        if isSensitive(application: currentApplication, context: currentContext) {
            let now = Date()
            if lastSensitiveEventAt.map({ now.timeIntervalSince($0) >= 5 }) ?? true {
                lastSensitiveEventAt = now
                emitSemanticEvent(
                    eventType: "system",
                    application: currentApplication,
                    fallbackReasonOverride: "sensitive_app",
                    updatesActivity: false
                )
            }
        } else {
            // input monitor 把 app_focus 视作用户活动；它会刷新 idle/session 活跃
            // 时间，但不依赖截图是否最终成功。
            lastInputAt = Date()
            emitSemanticEvent(eventType: "app_focus", application: currentApplication)
        }
        if supportedBrowserBundleIds.contains(currentApplication?.bundleIdentifier ?? "") {
            // 切到浏览器时立即读取一次当前标签；周期轮询作为页面加载/Apple Events 延迟时的兜底。
            scheduleImmediateBrowserPoll()
        }
    }

    private func refreshFrontmostApplicationIfNeeded(emitEvent: Bool) {
        guard let application = NSWorkspace.shared.frontmostApplication else { return }
        guard currentApplication?.processIdentifier != application.processIdentifier else { return }
        frontmostApplicationChanged(application, emitEvent: emitEvent)
    }

    private func rebindAXObserver(for application: NSRunningApplication?) {
        removeAXObserver()
        currentContext = AXContext.unavailable
        guard AXIsProcessTrusted() else {
            return
        }
        guard let application else {
            return
        }
        let applicationElement = AXUIElementCreateApplication(application.processIdentifier)
        var observer: AXObserver?
        guard AXObserverCreate(application.processIdentifier, axObserverCallback, &observer) == .success,
              let observer else {
            axApplicationElement = applicationElement
            currentContext = queryAXContext(for: applicationElement, application: application)
            return
        }
        axObserver = observer
        axApplicationElement = applicationElement
        let source = AXObserverGetRunLoopSource(observer)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode)
        refreshAXObservation()
    }

    private func refreshAXObservation() {
        guard let observer = axObserver, let applicationElement = axApplicationElement else {
            currentContext = AXContext.unavailable
            return
        }
        removeAXRegistrations(observer)
        currentContext = queryAXContext(for: applicationElement, application: currentApplication)
        registerAXNotification(observer, element: applicationElement, notification: kAXFocusedUIElementChangedNotification as CFString)
        registerAXNotification(observer, element: applicationElement, notification: kAXFocusedWindowChangedNotification as CFString)
        if let window = axElementAttribute(kAXFocusedWindowAttribute as CFString, from: applicationElement) {
            registerAXNotification(observer, element: window, notification: kAXTitleChangedNotification as CFString)
        }
        if let focused = axElementAttribute(kAXFocusedUIElementAttribute as CFString, from: applicationElement) {
            registerAXNotification(observer, element: focused, notification: kAXTitleChangedNotification as CFString)
            registerAXNotification(observer, element: focused, notification: kAXValueChangedNotification as CFString)
            registerAXNotification(observer, element: focused, notification: kAXSelectedTextChangedNotification as CFString)
        }
    }

    private func removeAXObserver() {
        if let observer = axObserver {
            removeAXRegistrations(observer)
            let source = AXObserverGetRunLoopSource(observer)
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .defaultMode)
        }
        axObserver = nil
        axApplicationElement = nil
        currentContext = AXContext.unavailable
    }

    private func removeAXRegistrations(_ observer: AXObserver) {
        for registration in axRegistrations {
            _ = AXObserverRemoveNotification(observer, registration.element, registration.notification)
        }
        axRegistrations.removeAll()
    }

    private func registerAXNotification(_ observer: AXObserver, element: AXUIElement, notification: CFString) {
        guard AXObserverAddNotification(
            observer,
            element,
            notification,
            Unmanaged.passUnretained(self).toOpaque()
        ) == .success else { return }
        axRegistrations.append((element: element, notification: notification))
    }

    fileprivate func handleAXNotification(_ notification: String) {
        guard sessionActive, !screenLocked else { return }
        _ = notification
        // Activity 时间线不记录 AX window/focus/title/value 事件；AX 只用于刷新
        // 当前控件上下文（例如 secure text field 判断），真正的时间线事件来自 input monitor。
        refreshAXObservation()
    }

    private func queryAXContext(for applicationElement: AXUIElement, application: NSRunningApplication?) -> AXContext {
        _ = application
        guard AXIsProcessTrusted() else { return .unavailable }
        let window = axElementAttribute(kAXFocusedWindowAttribute as CFString, from: applicationElement)
        let focused = axElementAttribute(kAXFocusedUIElementAttribute as CFString, from: applicationElement)
        let windowTitle = window.flatMap { axStringAttribute(kAXTitleAttribute as CFString, from: $0) }
        let role = focused.flatMap { axStringAttribute(kAXRoleAttribute as CFString, from: $0) }
        let subrole = focused.flatMap { axStringAttribute(kAXSubroleAttribute as CFString, from: $0) }
        let secure = isSecureRole(role) || isSecureRole(subrole)
        let title = focused.flatMap { axStringAttribute(kAXTitleAttribute as CFString, from: $0) }
        let value = secure ? nil : focused.flatMap { axStringAttribute(kAXValueAttribute as CFString, from: $0) }
        let selected = secure ? nil : focused.flatMap { axStringAttribute(kAXSelectedTextAttribute as CFString, from: $0) }
        let text = shortText([value, selected].compactMap { $0 }.joined(separator: " "))
        let hasSemantics = windowTitle != nil || role != nil || title != nil || text != nil
        return AXContext(
            windowTitle: shortText(windowTitle),
            axRole: shortText(role),
            axTitle: shortText(title),
            text: text,
            valid: window != nil && focused != nil && hasSemantics,
            secureTextField: secure
        )
    }

    private func axElementAttribute(_ attribute: CFString, from element: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
              let value else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }

    private func axStringAttribute(_ attribute: CFString, from element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
              let value else { return nil }
        return value as? String
    }

    private func emitSemanticEvent(
        eventType: String,
        application: NSRunningApplication? = nil,
        occurredAt: Date = Date(),
        mouseEventType: String? = nil,
        mouseButton: String? = nil,
        keyCode: Int? = nil,
        keyModifiers: UInt64? = nil,
        mouseLocation: CGPoint? = nil,
        inputFirstOccurredAt: Date? = nil,
        inputCountOverride: Int? = nil,
        fallbackReasonOverride: String? = nil,
        updatesActivity: Bool = true
    ) {
        guard sessionActive else { return }
        let app = application ?? currentApplication ?? NSWorkspace.shared.frontmostApplication
        let context = contextForApplication(app)
        let sensitive = isSensitive(application: app, context: context)
        let outputContext = sensitive
            ? AXContext(windowTitle: nil, axRole: context.axRole, axTitle: nil, text: nil, valid: context.valid, secureTextField: context.secureTextField)
            : context
        let visualApplication = isVisualApplication(app)
        let semanticAvailable = outputContext.valid && !visualApplication
        if updatesActivity { lastActivityAt = occurredAt }
        if !sensitive && !screenLocked {
            // 只有 click/app_focus/typing_pause 会触发截图；keypress 只是输入时间线
            // 聚合结果，lock/unlock/system 和 AX 刷新都不直接触发截图。
            if eventType == "click" || eventType == "app_focus" || eventType == "typing_pause" {
                scheduleFallback(reason: eventType)
            }
        } else {
            fallbackPendingReason = nil
        }
        output.write(SidecarEvent(
            occurredAt: ISO8601DateFormatter().string(from: occurredAt),
            eventType: eventType,
            application: app?.localizedName,
            bundleId: app?.bundleIdentifier,
            windowTitle: nil,
            axRole: nil,
            axTitle: nil,
            url: nil,
            text: nil,
            mouseEventType: mouseEventType,
            mouseButton: mouseButton,
            keyCode: sensitive ? nil : keyCode,
            keyModifiers: sensitive ? nil : keyModifiers,
            mouseX: sensitive ? nil : mouseLocation.map { Double($0.x) },
            mouseY: sensitive ? nil : mouseLocation.map { Double($0.y) },
            inputEventCount: inputCountOverride ?? inputEventCount,
            inputEventFirstAt: sensitive ? nil : inputFirstOccurredAt.map { ISO8601DateFormatter().string(from: $0) },
            axAvailable: semanticAvailable,
            fallbackReason: fallbackReasonOverride ?? (semanticAvailable ? nil : fallbackPendingReason)
        ))
        emitStatus(status: "running", error: statusError())
    }

    /// 普通事件触发器：debounce 窗口内只保留一个待处理原因，并按
    /// app_focus > click > typing_pause 合并；窗口外直接尝试一次，不把 heartbeat 混进来。
    private func scheduleFallback(reason: String) {
        guard let settings, sessionActive, !screenLocked else { return }
        let now = Date()
        if let lastCaptureAttemptAt = lastCaptureAttemptAt,
           now.timeIntervalSince(lastCaptureAttemptAt) * 1_000 < Double(max(0, settings.captureDebounceMs)) {
            fallbackPendingReason = mergeCaptureTrigger(fallbackPendingReason, reason)
            scheduleFallbackCheck()
            return
        }
        requestCapture(reason: reason)
    }

    /// 视觉轮询和 heartbeat 都绕过 pending trigger；它们只在当前时刻满足条件时尝试。
    private func requestCapture(reason: String, dedupOnly: Bool = false) {
        guard let settings, sessionActive, !screenLocked else { return }
        refreshFrontmostApplicationIfNeeded(emitEvent: settings.inputMonitoringEnabled)
        let app = currentApplication ?? NSWorkspace.shared.frontmostApplication
        if isSensitive(application: app, context: currentContext) {
            emitStatus(status: "running", error: nil)
            return
        }
        let now = Date()
        if let lastCaptureAttemptAt = lastCaptureAttemptAt,
           now.timeIntervalSince(lastCaptureAttemptAt) * 1_000 < Double(max(0, settings.captureDebounceMs)) {
            return
        }
        if let nextCaptureAllowedAt, now < nextCaptureAllowedAt { return }
        beginCapture(
            reason: reason,
            dedupOnly: dedupOnly,
            settings: settings,
            application: app,
            startedAt: now
        )
    }

    private func mergeCaptureTrigger(_ existing: String?, _ incoming: String) -> String {
        guard let existing else { return incoming }
        if existing == "app_focus" || incoming == "app_focus" { return "app_focus" }
        if existing == "click" || incoming == "click" { return "click" }
        if existing == "typing_pause" || incoming == "typing_pause" { return "typing_pause" }
        return incoming
    }

    private func scheduleFallbackCheck() {
        guard let settings, sessionActive, !screenLocked, fallbackPendingReason != nil else { return }
        fallbackCheckWorkItem?.cancel()
        let now = Date()
        // 首次触发无需先空等一个 debounce 周期；只在“上一次尝试”存在时延迟。
        let captureReadyAt = lastCaptureAttemptAt?.addingTimeInterval(Double(max(0, settings.captureDebounceMs)) / 1_000) ?? now
        let reason = fallbackPendingReason ?? "activity"
        let waitsForTypingPause = reason == "keypress" || reason == "typing_pause"
        let inputReadyAt = waitsForTypingPause
            ? (lastInputAt?.addingTimeInterval(Double(max(0, settings.inputPauseMs)) / 1_000) ?? now)
            : now
        let readyAt = max(captureReadyAt, inputReadyAt, nextCaptureAllowedAt ?? now)
        let delay = max(0, readyAt.timeIntervalSince(now))
        let workItem = DispatchWorkItem { [weak self] in
            self?.fallbackCheckWorkItem = nil
            self?.checkFallback()
        }
        fallbackCheckWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    private func checkFallback() {
        guard let settings, sessionActive, !screenLocked else { return }
        fallbackCheckWorkItem?.cancel()
        fallbackCheckWorkItem = nil
        let now = Date()
        guard let reason = fallbackPendingReason else { return }
        if let lastInputAt,
           (reason == "keypress" || reason == "typing_pause"),
           now.timeIntervalSince(lastInputAt) * 1_000 < Double(max(0, settings.inputPauseMs)) {
            scheduleFallbackCheck()
            return
        }
        if let lastCaptureAttemptAt,
           now.timeIntervalSince(lastCaptureAttemptAt) * 1_000 < Double(max(0, settings.captureDebounceMs)) {
            scheduleFallbackCheck()
            return
        }
        if let nextCaptureAllowedAt, now < nextCaptureAllowedAt {
            scheduleFallbackCheck()
            return
        }
        let app = currentApplication ?? NSWorkspace.shared.frontmostApplication
        guard !isSensitive(application: app, context: currentContext) else {
            fallbackPendingReason = nil
            return
        }
        // 到期后先消费 pending 状态，即使本轮
        // 因权限、在途截图或 backoff 被跳过，也不能把旧原因永久挂在队列里。
        fallbackPendingReason = nil
        requestCapture(reason: reason)
    }

    private func beginCapture(
        reason: String,
        dedupOnly: Bool,
        settings: ActivitySettings,
        application: NSRunningApplication?,
        startedAt: Date
    ) {
        guard CGPreflightScreenCaptureAccess() else {
            lastStatusError = "无屏幕录制权限，Activity 截图与 OCR 不可用。"
            emitStatus(status: "running", error: lastStatusError)
            return
        }
        lastStatusError = nil
        guard !captureInFlight else { return }
        captureInFlight = true
        // 必须在真正发起 ScreenCaptureKit 请求前记录尝试时间；失败也不能立刻重试。
        lastCaptureAttemptAt = startedAt
        let capturedAt = ISO8601DateFormatter().string(from: startedAt)
        let bundleId = application?.bundleIdentifier
        let appName = application?.localizedName
        let capturedInputEventCount = inputEventCount
        // 异步截图期间即使切到敏感应用后又切回，也不能接受中间时刻捕获的旧画面。
        let captureEpoch = captureContextEpoch
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.captureInFlight = false }
            do {
                // Task 从 @MainActor 的 beginCapture 继承主队列；这里直接访问状态，不能再
                // DispatchQueue.main.sync，否则第一次截图时会触发 libdispatch 自同步 SIGTRAP。
                guard self.captureContextEpoch == captureEpoch, self.fallbackCaptureAllowed() else { return }
                let image: CGImage
                let jpeg: Data
                let signature: FrameSignature
                let acceptance: FrameAcceptance
                if dedupOnly {
                    // compare-only 路径先以 JPEG quality 40 抓最多 160px 宽的图，
                    // 再从编码后的 JPEG 生成 160×90 指纹；不能直接对原始 CGImage 去重。
                    let thumbnailCapture = try await self.captureScreenJPEG(maxWidth: 160, quality: 40)
                    guard self.captureContextEpoch == captureEpoch, self.fallbackCaptureAllowed() else { return }
                    self.recordCaptureSuccess()
                    guard let thumbnailSignature = self.frameSignature(image: thumbnailCapture.image) else {
                        self.lastStatusError = "无法生成屏幕画面指纹。"
                        return
                    }
                    let thumbnailAcceptance = self.compareFrame(thumbnailSignature, trigger: reason, settings: settings)
                    guard thumbnailAcceptance.accepted else { return }
                    signature = thumbnailSignature
                    acceptance = thumbnailAcceptance
                    let fullCapture = try await self.captureScreenJPEG(maxWidth: 2_560, quality: settings.jpegQuality)
                    image = fullCapture.image
                    jpeg = fullCapture.jpeg
                    self.recordCaptureSuccess()
                } else {
                    // 事件触发和 heartbeat 直接取整屏 JPEG；指纹也基于同一份编码结果。
                    let fullCapture = try await self.captureScreenJPEG(maxWidth: 2_560, quality: settings.jpegQuality)
                    image = fullCapture.image
                    jpeg = fullCapture.jpeg
                    self.recordCaptureSuccess()
                    guard let fullSignature = self.frameSignature(image: image) else {
                        self.lastStatusError = "无法生成屏幕画面指纹。"
                        return
                    }
                    signature = fullSignature
                    acceptance = self.compareFrame(fullSignature, trigger: reason, settings: settings)
                    guard acceptance.accepted else { return }
                }
                guard self.captureContextEpoch == captureEpoch, self.fallbackCaptureAllowed() else { return }
                let shouldRunOcr: Bool
                if settings.ocrEnabled {
                    // OCR 关闭时仍保留已接受帧的计数；重新打开后，如果已经
                    // 跨过 N 帧，下一张新快照立即进入 OCR，而不是重新从 1 开始等。
                    self.snapshotsSinceLastOcr += 1
                    let every = max(1, settings.ocrEveryNFrames)
                    if self.snapshotsSinceLastOcr >= every {
                        self.snapshotsSinceLastOcr = 0
                        shouldRunOcr = true
                    } else {
                        shouldRunOcr = false
                    }
                } else {
                    self.snapshotsSinceLastOcr += 1
                    shouldRunOcr = false
                }
                guard self.captureContextEpoch == captureEpoch, self.fallbackCaptureAllowed() else { return }
                // 先提交并发送完整 JPEG；OCR 是后续投影，不能阻塞截图本身的持久化。
                // 缩略图变化但整屏捕获或编码失败时，下一次 visual poll 仍会重新尝试。
                self.commitFrame(signature)
                let captureId = settings.ocrEnabled && shouldRunOcr ? UUID().uuidString : nil
                self.output.write(SidecarCapture(
                    occurredAt: capturedAt,
                    application: appName,
                    bundleId: bundleId,
                    windowTitle: nil,
                    axRole: nil,
                    axTitle: nil,
                    text: nil,
                    jpegBase64: jpeg.base64EncodedString(),
                    ocrText: nil,
                    inputEventCount: capturedInputEventCount,
                    fallbackReason: reason,
                    captureTrigger: reason,
                    width: image.width,
                    height: image.height,
                    captureId: captureId,
                    contentHash: self.frameHashHex(signature.hash),
                    histogramChange: acceptance.histogramChange,
                    pixelDiff: acceptance.pixelDiff
                ))
                if let captureId {
                    // OCR 即使在应用切换或 sidecar stop 之后完成，也只更新刚刚捕获的这张
                    // snapshot；不能再用当前前台应用状态否掉已经安全落盘的截图。
                    let ocrText = self.recognizeText(jpeg: jpeg, languages: settings.ocrLanguages)
                    self.output.write(SidecarOcr(captureId: captureId, ocrText: ocrText))
                }
            } catch is CancellationError {
                // 停止或隐私状态变化不算截图后端故障，也不能覆盖停止后的状态。
                return
            } catch {
                guard self.captureContextEpoch == captureEpoch, self.fallbackCaptureAllowed() else { return }
                self.recordCaptureFailure()
                self.lastStatusError = "无法读取当前屏幕画面。"
            }
        }
    }

    private func captureScreenJPEG(maxWidth: Int, quality: Int) async throws -> (image: CGImage, jpeg: Data) {
        let captured = try await captureScreen(maxWidth: maxWidth)
        guard let jpeg = jpegData(image: captured, quality: quality),
              let bitmap = NSBitmapImageRep(data: jpeg),
              let image = bitmap.cgImage else {
            throw NSError(domain: "BinyActivityRecorder", code: 2)
        }
        return (image: image, jpeg: jpeg)
    }

    private func captureScreen(maxWidth: Int? = nil) async throws -> CGImage {
        if !nativeCaptureFailed || !desktopCaptureAvailable {
            do {
                return try await captureNativeScreen(maxWidth: maxWidth)
            } catch {
                guard desktopCaptureAvailable else { throw error }
                nativeCaptureFailed = true
            }
        }
        guard fallbackCaptureAllowed(), CGPreflightScreenCaptureAccess() else { throw CancellationError() }
        let requestId = UUID().uuidString
        return try await withCheckedThrowingContinuation { continuation in
            pendingDesktopCapture = (requestId, continuation)
            output.write(DesktopCaptureRequest(requestId: requestId, maxWidth: min(2_560, max(1, maxWidth ?? 2_560))))
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
                guard let self, let pending = self.pendingDesktopCapture, pending.id == requestId else { return }
                self.pendingDesktopCapture = nil
                pending.continuation.resume(throwing: NSError(domain: "BinyActivityRecorder", code: 4))
            }
        }
    }

    private func captureNativeScreen(maxWidth: Int?) async throws -> CGImage {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw NSError(domain: "BinyActivityRecorder", code: 1)
        }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let configuration = SCStreamConfiguration()
        let displayWidth = max(1, display.width)
        let displayHeight = max(1, display.height)
        let width = min(displayWidth, max(1, maxWidth ?? displayWidth))
        configuration.width = width
        // 缩略图和整屏图都保持显示器原始比例；指纹阶段再统一投影为 160×90。
        configuration.height = max(1, Int((Double(displayHeight) * Double(width) / Double(displayWidth)).rounded()))
        configuration.showsCursor = false
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    }

    private func jpegData(image: CGImage, quality: Int) -> Data? {
        let bitmap = NSBitmapImageRep(cgImage: image)
        return bitmap.representation(using: .jpeg, properties: [
            .compressionFactor: CGFloat(min(100, max(1, quality))) / 100
        ])
    }

    private func recognizeText(jpeg: Data, languages: [String]) -> String? {
        guard let bitmap = NSBitmapImageRep(data: jpeg), let image = bitmap.cgImage else { return nil }
        return recognizeText(image: image, languages: languages)
    }

    private func recognizeText(image: CGImage, languages: [String]) -> String? {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = languages
        do {
            try VNImageRequestHandler(cgImage: image).perform([request])
        } catch {
            return nil
        }
        let lines = (request.results ?? []).compactMap { observation in
            observation.topCandidates(1).first?.string
        }
        // OCR helper 保留 Vision observation 的逐行边界；空格拼接会破坏代码、表格和
        // 中英文混排的结构，也会让后续的 OCR 去重和 embedding 变得不稳定。
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    private func frameSignature(image: CGImage) -> FrameSignature? {
        let width = 160
        let height = 90
        let bytesPerRow = width * 4
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .low
        // Sharp 的 resize(width:height:) 默认是 cover（居中裁剪），不能像 CGContext
        // 直接拉伸那样改变 16:10 桌面的纵横比，否则去重结果会不一致。
        let sourceWidth = CGFloat(image.width)
        let sourceHeight = CGFloat(image.height)
        let sourceAspect = sourceWidth / max(1, sourceHeight)
        let targetAspect = CGFloat(width) / CGFloat(height)
        let cropRect: CGRect
        if sourceAspect > targetAspect {
            let cropWidth = sourceHeight * targetAspect
            cropRect = CGRect(x: (sourceWidth - cropWidth) / 2, y: 0, width: cropWidth, height: sourceHeight)
        } else {
            let cropHeight = sourceWidth / targetAspect
            cropRect = CGRect(x: 0, y: (sourceHeight - cropHeight) / 2, width: sourceWidth, height: cropHeight)
        }
        if let cropped = image.cropping(to: cropRect) {
            context.draw(cropped, in: CGRect(x: 0, y: 0, width: width, height: height))
        } else {
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        guard let data = context.data else { return nil }
        let pixels = Array(UnsafeBufferPointer(
            start: data.assumingMemoryBound(to: UInt8.self),
            count: height * bytesPerRow
        ))
        // thumbnailHash 按 RGB 加权亮度做 32 位 FNV-1a。
        var hash: UInt32 = 2_166_136_261
        for index in stride(from: 0, to: pixels.count, by: 4) {
            let luminance = UInt32((77 * Int(pixels[index]) + 150 * Int(pixels[index + 1]) + 29 * Int(pixels[index + 2])) >> 8)
            hash ^= luminance
            hash = hash &* 16_777_619
        }
        var histogram = [Double](repeating: 0, count: 32)
        let pixelCount = Double(width * height)
        for index in stride(from: 0, to: pixels.count, by: 4) {
            let luminance = (77 * Int(pixels[index]) + 150 * Int(pixels[index + 1]) + 29 * Int(pixels[index + 2])) >> 8
            let bin = min(31, max(0, luminance * 32 / 256))
            histogram[bin] += 1.0 / pixelCount
        }
        return FrameSignature(hash: hash, histogram: histogram, pixels: pixels)
    }

    private func compareFrame(_ signature: FrameSignature, trigger: String, settings: ActivitySettings) -> FrameAcceptance {
        if let previous = lastFrameSignature {
            if signature.hash == previous.hash {
                return FrameAcceptance(
                    accepted: trigger == "heartbeat",
                    histogramChange: 0,
                    pixelDiff: 0
                )
            }
            var histogramDistance = 0.0
            for (left, right) in zip(previous.histogram, signature.histogram) {
                let difference = sqrt(max(0, left)) - sqrt(max(0, right))
                histogramDistance += difference * difference
            }
            let histogramChange = sqrt(histogramDistance) / sqrt(2.0)
            guard histogramChange < settings.histogramChangeThreshold else {
                // 只在直方图足够接近时再计算像素差；直方图已经明显变化时，
                // diffPct 直接使用直方图距离，不额外产出像素差。
                return FrameAcceptance(
                    accepted: true,
                    histogramChange: histogramChange,
                    pixelDiff: nil
                )
            }
            let differingPixels = stride(from: 0, to: min(previous.pixels.count, signature.pixels.count), by: 4)
                .reduce(into: 0) { count, index in
                    let changed = abs(Int(previous.pixels[index]) - Int(signature.pixels[index])) > settings.pixelTolerance
                        || abs(Int(previous.pixels[index + 1]) - Int(signature.pixels[index + 1])) > settings.pixelTolerance
                        || abs(Int(previous.pixels[index + 2]) - Int(signature.pixels[index + 2])) > settings.pixelTolerance
                    if changed { count += 1 }
            }
            let totalPixels = max(1, min(previous.pixels.count, signature.pixels.count) / 4)
            let pixelDiff = Double(differingPixels) / Double(totalPixels)
            let duplicate = pixelDiff < settings.pixelDiffThreshold
            // heartbeat 会形成时间锚点，即使画面没有变化也保留；其它触发只保留变化帧。
            if duplicate && trigger != "heartbeat" {
                return FrameAcceptance(accepted: false, histogramChange: histogramChange, pixelDiff: pixelDiff)
            }
            return FrameAcceptance(accepted: true, histogramChange: histogramChange, pixelDiff: pixelDiff)
        }
        return FrameAcceptance(accepted: true, histogramChange: nil, pixelDiff: nil)
    }

    private func commitFrame(_ signature: FrameSignature) {
        lastFrameSignature = signature
    }

    private func frameHashHex(_ hash: UInt32) -> String {
        String(format: "%08x", hash)
    }

    private func recordCaptureSuccess() {
        captureFailureCount = 0
        nextCaptureAllowedAt = nil
    }

    private func recordCaptureFailure() {
        captureFailureCount = min(captureFailureCount + 1, 16)
        let delayMs = min(30_000, 500 * (1 << max(0, captureFailureCount - 1)))
        nextCaptureAllowedAt = Date().addingTimeInterval(Double(delayMs) / 1_000)
    }

    private func isSensitive(application: NSRunningApplication?, context: AXContext) -> Bool {
        guard let settings else { return context.secureTextField }
        let bundleId = application?.bundleIdentifier
        return context.secureTextField || (bundleId.map { settings.sensitiveApplications.contains($0) } ?? false)
    }

    private func isVisualApplication(_ application: NSRunningApplication?) -> Bool {
        guard let bundleId = application?.bundleIdentifier else { return false }
        return visualApplicationBundleIds.contains(bundleId)
    }

    private func fallbackCaptureAllowed() -> Bool {
        let application = NSWorkspace.shared.frontmostApplication ?? currentApplication
        guard let application, let currentApplication,
              application.processIdentifier == currentApplication.processIdentifier else {
            return false
        }
        let context = contextForApplication(application)
        return sessionActive && !screenLocked && CGPreflightScreenCaptureAccess() && !isSensitive(application: application, context: context)
    }

    private func contextForApplication(_ application: NSRunningApplication?) -> AXContext {
        guard let application, let currentApplication,
              application.processIdentifier == currentApplication.processIdentifier else {
            return .unavailable
        }
        return currentContext
    }

    private func isSecureRole(_ role: String?) -> Bool {
        guard let role else { return false }
        let normalized = role.lowercased()
        return normalized == "axsecuretextfield" || normalized == "axpasswordfield" || normalized.contains("securetext")
    }

    private func statusError() -> String? {
        if !CGPreflightScreenCaptureAccess() {
            return "无屏幕录制权限，输入事件仍可记录，但截图与 OCR 不可用。"
        }
        return lastStatusError
    }

    private func emitStatus(status: String, error: String?) {
        let screenRecordingGranted = CGPreflightScreenCaptureAccess()
        let app = NSWorkspace.shared.frontmostApplication ?? currentApplication
        let context = contextForApplication(app)
        let blocked = isSensitive(application: app, context: context)
        // 截图是 Activity 的主链路；缺少屏幕录制权限时明确报告等待权限，
        // 不能伪装成 running 让 UI 误以为已经完整采集。
        let reportedStatus = status == "running" && !screenRecordingGranted ? "permission_required" : status
        output.write(SidecarStatus(
            status: reportedStatus,
            screenRecordingGranted: screenRecordingGranted,
            accessibilityGranted: AXIsProcessTrusted(),
            axAvailable: context.valid && !isVisualApplication(app),
            fallbackAvailable: screenRecordingGranted && !blocked && !screenLocked,
            screenLocked: screenLocked,
            currentApplication: app?.localizedName,
            inputEventCount: inputEventCount,
            error: error ?? (reportedStatus == "running" || reportedStatus == "permission_required" ? statusError() : nil)
        ))
    }

}

private func axObserverCallback(
    _ observer: AXObserver,
    _ element: AXUIElement,
    _ notification: CFString,
    _ refcon: UnsafeMutableRawPointer?
) {
    _ = observer
    _ = element
    guard let refcon else { return }
    let recorder = Unmanaged<ActivityRecorder>.fromOpaque(refcon).takeUnretainedValue()
    DispatchQueue.main.async {
        recorder.handleAXNotification(notification as String)
    }
}

private func shortText(_ value: String?) -> String? {
    guard let value else { return nil }
    let normalized = value
        .replacingOccurrences(of: "\0", with: " ")
        .split(whereSeparator: { $0.isWhitespace })
        .joined(separator: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return normalized.isEmpty ? nil : String(normalized.prefix(256))
}

if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--request-permission" {
    guard CommandLine.arguments[2] == "screen-recording" else {
        exit(64)
    }
    // Activity 未启动时由主进程拉起一次性 sidecar，确保授权请求仍由具备屏幕采集能力的
    // native 进程发起；这里不建立采集器、不注册监听器，也不写入任何 Activity 数据。
    _ = CGRequestScreenCaptureAccess()
    exit(0)
}

private let output = SidecarOutput()
private let recorder: ActivityRecorder = MainActor.assumeIsolated {
    ActivityRecorder(output: output)
}
private let inputQueue = DispatchQueue(label: "com.biny.activity-recorder.stdin")

inputQueue.async {
    while let line = readLine(), !line.isEmpty {
        guard let data = line.data(using: .utf8), let command = try? JSONDecoder().decode(SidecarCommand.self, from: data) else {
            output.write(SidecarError(message: "sidecar 收到无效 JSON 命令。"))
            continue
        }
        DispatchQueue.main.async {
            recorder.handle(command)
        }
    }
    DispatchQueue.main.async {
        recorder.stop()
        exit(0)
    }
}
RunLoop.main.run()
