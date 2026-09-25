// 本机日历只读辅助进程；权限由 EventKit 和嵌入的 Info.plist 处理。
import Foundation
import EventKit

let environment = ProcessInfo.processInfo.environment
let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
let zone = TimeZone(identifier: environment["BINY_CALENDAR_ZONE"] ?? "")!
var calendar = Calendar(identifier: .gregorian)
calendar.timeZone = zone
func day(_ text: String) -> Date {
    let parts = text.split(separator: "-").compactMap { Int($0) }
    return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 0))!
}
func output(_ value: [String: Any]) {
    let bytes = try! JSONSerialization.data(withJSONObject: value)
    print(String(data: bytes, encoding: .utf8)!)
}
let from = day(environment["BINY_CALENDAR_FROM"]!)
let to = day(environment["BINY_CALENDAR_TO"]!)
let store = EKEventStore()
let status = EKEventStore.authorizationStatus(for: .event)
if status == .denied || status == .restricted {
    output(["status": "denied"])
} else {
    var allowed = false
    if #available(macOS 14.0, *) {
        allowed = status == .fullAccess
    } else {
        allowed = status == .authorized
    }
    var finished = status != .notDetermined
    if status == .notDetermined {
        if #available(macOS 14.0, *) {
            store.requestFullAccessToEvents { granted, _ in
                DispatchQueue.main.async { allowed = granted; finished = true }
            }
        } else {
            store.requestAccess(to: .event) { granted, _ in
                DispatchQueue.main.async { allowed = granted; finished = true }
            }
        }
        let deadline = Date(timeIntervalSinceNow: 18)
        while !finished && Date() < deadline {
            _ = RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
        }
    }
    if !finished {
        output(["status": "timeout"])
    } else if !allowed {
        output(["status": "denied"])
    } else {
        let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: nil))
            .filter { $0.endDate > from && $0.startDate < to }
            .sorted { $0.startDate < $1.startDate }
        let rows: [[String: Any]] = events.prefix(200).map { event in
            ["title": event.title ?? "", "startDate": formatter.string(from: event.startDate),
             "endDate": formatter.string(from: event.endDate), "calendar": event.calendar?.title ?? "",
             "isAllDay": event.isAllDay, "identifier": event.eventIdentifier ?? ""]
        }
        output(["status": "ok", "events": rows, "hasMore": events.count > 200])
    }
}
