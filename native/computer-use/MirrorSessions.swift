import Foundation

/// 窗口号会被系统复用；异步帧必须同时匹配本次会话的 lease。
final class MirrorSessions {
    struct Session {
        let windowID: Int
        let pid: Int
        let lease: UUID
        var state: String
        var lastFrameAt: TimeInterval?
        var error: String?
    }
    private var sessions: [Int: Session] = [:]
    private let now: () -> TimeInterval
    private let limit: Int
    init(limit: Int = 8, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.limit = limit; self.now = now
    }
    var isEmpty: Bool { sessions.isEmpty }
    func begin(windowID: Int, pid: Int, armed: Bool) throws -> Session {
        guard windowID > 0, windowID <= Int(UInt32.max) else { throw failure("pip_invalid_window_id") }
        guard pid > 0 else { throw failure("pip_invalid_pid") }
        if let existing = sessions[windowID] {
            guard existing.pid == pid else { throw failure("pip_window_identity_changed") }
            return existing
        }
        guard sessions.count < limit else { throw failure("pip_session_limit") }
        let session = Session(windowID: windowID, pid: pid, lease: UUID(), state: armed ? "armed" : "opening")
        sessions[windowID] = session
        return session
    }
    func contains(_ session: Session) -> Bool { sessions[session.windowID]?.lease == session.lease }
    func present(_ session: Session) {
        guard contains(session) else { return }
        sessions[session.windowID]?.state = "open"
    }
    func frame(_ session: Session) {
        guard contains(session) else { return }
        sessions[session.windowID]?.lastFrameAt = now()
        sessions[session.windowID]?.error = nil
    }
    func fail(_ session: Session, error: String) {
        guard contains(session) else { return }
        sessions[session.windowID]?.error = error
    }
    @discardableResult func close(windowID: Int) -> Session? { sessions.removeValue(forKey: windowID) }
    func state(windowID: Int) -> [String: Any]? {
        guard let session = sessions[windowID] else { return nil }
        var result: [String: Any] = ["window_id": session.windowID, "pid": session.pid, "state": session.state,
            "last_frame_age_ms": session.lastFrameAt.map { max(0, Int((now() - $0) * 1000)) } as Any? ?? NSNull()]
        if let error = session.error { result["error"] = error }
        return result
    }
    func list() -> [String: Any] {
        let ordered = sessions.keys.sorted().compactMap { state(windowID: $0) }
        return ["sessions": ordered.filter { $0["state"] as? String != "armed" },
                "armed": ordered.filter { $0["state"] as? String == "armed" }]
    }
    private func failure(_ message: String) -> NSError {
        NSError(domain: "pip", code: 64, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
