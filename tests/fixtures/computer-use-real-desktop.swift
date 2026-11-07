import AppKit
import WebKit
import Network
import ApplicationServices

final class DragPad: NSView {
    var drags = 0
    override func mouseDown(with event: NSEvent) {}
    override func mouseDragged(with event: NSEvent) { drags += 1 }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemGray.setFill(); bounds.fill()
        ("Drag here" as NSString).draw(at: NSPoint(x: 15, y: 30), withAttributes: [.foregroundColor: NSColor.white])
    }
}

final class ScrollArea: NSScrollView {
    var wheelEvents = 0
    var wheelTrace: [[String: Any]] = []
    override func scrollWheel(with event: NSEvent) {
        wheelEvents += 1
        wheelTrace.append(["window": event.windowNumber, "x": event.locationInWindow.x, "y": event.locationInWindow.y,
            "deltaY": event.deltaY, "scrollingDeltaY": event.scrollingDeltaY, "precise": event.hasPreciseScrollingDeltas,
            "phase": event.phase.rawValue, "momentumPhase": event.momentumPhase.rawValue,
            "sourcePid": event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) ?? -1])
        super.scrollWheel(with: event)
    }
}
final class ScrollDocument: NSView { override var isFlipped: Bool { true } }

final class Fixture: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    let native = NSWindow(contentRect: NSRect(x: 60, y: 140, width: 620, height: 460), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let panel = NSPanel(contentRect: NSRect(x: 700, y: 170, width: 360, height: 230), styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
    let webWindow = NSWindow(contentRect: NSRect(x: 140, y: 240, width: 620, height: 420), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let field = NSTextField(frame: NSRect(x: 20, y: 350, width: 340, height: 30))
    let dragPad = DragPad(frame: NSRect(x: 20, y: 240, width: 300, height: 80))
    let scroll = ScrollArea(frame: NSRect(x: 370, y: 20, width: 220, height: 370))
    let panelScroll = ScrollArea(frame: NSRect(x: 200, y: 20, width: 140, height: 180))
    let web = WKWebView(frame: .zero)
    let selectAllItem = NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    var clicks = 0
    var panelClicks = 0
    var closedByInput = 0
    var keyEvents: [[String: Any]] = []
    var mouseEvents: [[String: Any]] = []
    var mouseMoves = 0
    var mouseMoveSources: [String: Int] = [:]
    var mouseMoveStates: [String: Int] = [:]
    var lastHardwareMouse: [String: Double]?
    var keyMonitor: Any?
    var mouseMonitor: Any?
    var listener: NWListener?

    func button(_ title: String, _ rect: NSRect, _ action: Selector, in window: NSWindow) {
        let button = NSButton(title: title, target: self, action: action)
        button.frame = rect; button.setAccessibilityLabel(title)
        window.contentView!.addSubview(button)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let application = NSMenuItem(title: "Fixture", action: nil, keyEquivalent: "")
        application.submenu = NSMenu(title: "Fixture")
        application.submenu!.addItem(NSMenuItem(title: "Quit Fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        menu.addItem(application)
        let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        edit.submenu = NSMenu(title: "Edit")
        edit.submenu!.addItem(selectAllItem)
        menu.addItem(edit); NSApplication.shared.mainMenu = menu
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp, .leftMouseDown, .leftMouseUp, .leftMouseDragged, .scrollWheel]) { [weak self] event in
            if event.type == .keyDown || event.type == .keyUp {
                self?.keyEvents.append(["type": event.type.rawValue, "code": event.keyCode, "flags": event.modifierFlags.rawValue, "window": event.windowNumber, "characters": event.characters ?? ""])
            } else {
                self?.mouseEvents.append(["type": event.type.rawValue, "window": event.windowNumber, "x": event.locationInWindow.x, "y": event.locationInWindow.y,
                    "sourcePid": event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) ?? -1])
            }
            return event
        }
        mouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged]) { [weak self] event in
            guard let self else { return }
            mouseMoves += 1
            let source = String(event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) ?? -1)
            mouseMoveSources[source, default: 0] += 1
            let sourceState = event.cgEvent?.getIntegerValueField(.eventSourceStateID) ?? -99
            mouseMoveStates["\(source):\(sourceState)", default: 0] += 1
            if source == "0", sourceState == CGEventSourceStateID.hidSystemState.rawValue, let point = event.cgEvent?.location { lastHardwareMouse = ["x": point.x, "y": point.y] }
        }
        native.title = "Biny Real Native Fixture"; panel.title = "Biny Real Floating Fixture"; webWindow.title = "Biny Real Web Fixture"
        for window in [native, panel, webWindow] { window.isReleasedWhenClosed = false; window.ignoresMouseEvents = true }
        panel.level = NSWindow.Level(rawValue: 27); panel.hidesOnDeactivate = false
        button("NativeCount", NSRect(x: 20, y: 400, width: 150, height: 32), #selector(count), in: native)
        button("CloseAfterInput", NSRect(x: 185, y: 400, width: 160, height: 32), #selector(closeAfterInput), in: native)
        button("PanelCount", NSRect(x: 20, y: 150, width: 160, height: 32), #selector(panelCount), in: panel)
        field.stringValue = "initial"; field.setAccessibilityLabel("FixtureText")
        native.contentView!.addSubview(field)
        dragPad.setAccessibilityElement(true); dragPad.setAccessibilityLabel("FixtureDrag")
        native.contentView!.addSubview(dragPad)
        let document = ScrollDocument(frame: NSRect(x: 0, y: 0, width: 210, height: 2000))
        for index in 0..<50 {
            let line = NSTextField(labelWithString: "Row \(index)"); line.frame = NSRect(x: 10, y: index * 38, width: 170, height: 24)
            document.addSubview(line)
        }
        scroll.documentView = document; scroll.hasVerticalScroller = true
        scroll.setAccessibilityLabel("FixtureScroll"); native.contentView!.addSubview(scroll)
        panelScroll.documentView = ScrollDocument(frame: NSRect(x: 0, y: 0, width: 130, height: 1600))
        panelScroll.hasVerticalScroller = true; panelScroll.setAccessibilityLabel("PanelScroll")
        panel.contentView!.addSubview(panelScroll)
        web.navigationDelegate = self; web.autoresizingMask = [.width, .height]
        web.frame = webWindow.contentView!.bounds; webWindow.contentView!.addSubview(web)
        for window in [native, webWindow, panel] { window.orderBack(nil) }
        web.loadHTMLString("""
        <!doctype html><meta charset="utf-8"><title>Owned Web Fixture</title>
        <style>body{padding:24px;font:18px system-ui}button,input{font:inherit;padding:12px;display:block;margin:12px}</style>
        <button id="count" aria-label="WebCount" onclick="window.clicks++;document.querySelector('output').textContent=window.clicks">WebCount</button>
        <input id="field" aria-label="WebText" value="web-initial"><output>0</output>
        <script>window.clicks=0;window.inputs=[];document.querySelector('input').addEventListener('input',e=>inputs.push(e.target.value));</script>
        """, baseURL: URL(string: "http://localhost/"))
    }

    @objc func count() { clicks += 1 }
    @objc func panelCount() { panelClicks += 1 }
    @objc func closeAfterInput() { closedByInput += 1; native.close() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        do {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
            let server = try NWListener(using: parameters)
            listener = server
            server.newConnectionHandler = { [weak self] connection in
                connection.start(queue: .global())
                connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, _, _ in
                    guard let data, let request = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { connection.cancel(); return }
                    DispatchQueue.main.async {
                        self?.handle(request) { value in
                            let body = (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8)
                            connection.send(content: body, completion: .contentProcessed { _ in connection.cancel() })
                        }
                    }
                }
            }
            server.stateUpdateHandler = { state in
                guard case .ready = state else { return }
                let value: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "port": Int(server.port!.rawValue),
                    "windows": ["native": self.native.windowNumber, "panel": self.panel.windowNumber, "web": self.webWindow.windowNumber]]
                print("FIXTURE_READY " + String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!)
                fflush(stdout)
            }
            server.start(queue: .main)
        } catch { fputs("\(error)\n", stderr); NSApplication.shared.terminate(nil) }
    }

    func screenPoint(_ view: NSView, _ point: NSPoint) -> [String: Double] {
        let point = view.window!.convertPoint(toScreen: view.convert(point, to: nil))
        return ["x": point.x, "y": NSScreen.screens.first!.frame.maxY - point.y]
    }

    func handle(_ request: [String: String], reply: @escaping ([String: Any]) -> Void) {
        let name = request["window"] ?? "native"
        let window = name == "panel" ? panel : name == "web" ? webWindow : native
        switch request["operation"] ?? "state" {
        case "hide": window.orderOut(nil); reply(["done": true])
        case "show": window.orderBack(nil); reply(["done": true])
        case "close": window.close(); reply(["done": true])
        case "move": window.setFrameOrigin(NSPoint(x: window.frame.minX + 23, y: window.frame.minY + 11)); reply(["done": true])
        case "resize": window.setContentSize(NSSize(width: window.contentView!.bounds.width + 40, height: window.contentView!.bounds.height + 20)); reply(["done": true])
        case "calibrateMenu":
            let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: native.windowNumber, context: nil, characters: "a", charactersIgnoringModifiers: "a", isARepeat: false, keyCode: 0)!
            let editor = field.currentEditor() as? NSTextView
            let original = editor?.selectedRange()
            let beforeTarget = NSApplication.shared.target(forAction: #selector(NSText.selectAll(_:)), to: nil, from: selectAllItem)
            if let editor { editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0)) }
            let accepted = NSApplication.shared.mainMenu?.performKeyEquivalent(with: event) ?? false
            let length = editor?.selectedRange().length ?? 0
            let actionTarget = NSApplication.shared.target(forAction: #selector(NSText.selectAll(_:)), to: nil, from: selectAllItem)
            let actionWindow = (actionTarget as? NSView)?.window?.windowNumber ?? 0
            if let editor, let original { editor.setSelectedRange(original) }
            reply(["accepted": accepted, "selectedLength": length, "editorPresent": editor != nil,
                "actionTarget": String(describing: actionTarget), "actionWindow": actionWindow,
                "beforeTarget": String(describing: beforeTarget), "beforeTargetWindow": (beforeTarget as? NSView)?.window?.windowNumber ?? 0,
                "mainWindow": NSApplication.shared.mainWindow?.windowNumber ?? 0, "keyWindow": NSApplication.shared.keyWindow?.windowNumber ?? 0,
                "nativeWindow": native.windowNumber, "nativeFirstResponder": String(describing: native.firstResponder)])
        case "shutdown": reply(["done": true]); DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        default:
            let mouse = CGEvent(source: nil)!.location
            let probeEvent = NSEvent.mouseEvent(with: .leftMouseDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: webWindow.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
            let nativeButton = native.contentView!.subviews.compactMap { $0 as? NSButton }.first { $0.title == "NativeCount" }!
            let panelButton = panel.contentView!.subviews.compactMap { $0 as? NSButton }.first { $0.title == "PanelCount" }!
            let editor = field.currentEditor() as? NSTextView
            var value: [String: Any] = ["clicks": clicks, "panelClicks": panelClicks, "closedByInput": closedByInput,
                "text": field.currentEditor()?.string ?? field.stringValue, "drags": dragPad.drags,
                "selectionLength": (field.currentEditor() as? NSTextView)?.selectedRange().length ?? 0,
                "keyEvents": Array(keyEvents.suffix(20)), "keyEventCount": keyEvents.count, "keyWindow": NSApplication.shared.keyWindow?.windowNumber ?? 0,
                "mainWindow": NSApplication.shared.mainWindow?.windowNumber ?? 0, "nativeWindow": native.windowNumber,
                "editorWindow": editor?.window?.windowNumber ?? 0, "editorPresent": editor != nil, "nativeResponderMatchesEditor": editor != nil && native.firstResponder === editor,
                "fieldAcceptsFirstMouse": field.acceptsFirstMouse(for: probeEvent), "applicationActive": NSApplication.shared.isActive,
                "mouseEvents": Array(mouseEvents.suffix(20)), "mouseMoves": mouseMoves, "mouseMoveSources": mouseMoveSources, "mouseMoveStates": mouseMoveStates,
                "webAcceptsFirstMouse": web.acceptsFirstMouse(for: probeEvent), "nativeAcceptsFirstMouse": nativeButton.acceptsFirstMouse(for: probeEvent),
                "lastHardwareMouse": lastHardwareMouse.map { $0 as Any } ?? NSNull(),
                "wheelEvents": scroll.wheelEvents, "wheelTrace": Array(scroll.wheelTrace.suffix(8)), "scrollOffset": scroll.contentView.bounds.origin.y,
                "panelWheelEvents": panelScroll.wheelEvents, "panelWheelTrace": Array(panelScroll.wheelTrace.suffix(8)), "panelScrollOffset": panelScroll.contentView.bounds.origin.y,
                "frontmost": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1), "mouse": ["x": mouse.x, "y": mouse.y],
                "dragStart": screenPoint(dragPad, NSPoint(x: 40, y: 40)), "dragEnd": screenPoint(dragPad, NSPoint(x: 220, y: 40)),
                "scrollPoint": screenPoint(scroll, NSPoint(x: 80, y: 180)),
                "panelScrollPoint": screenPoint(panelScroll, NSPoint(x: 70, y: 90)),
                "nativeCountPoint": screenPoint(nativeButton, NSPoint(x: nativeButton.bounds.midX, y: nativeButton.bounds.midY)),
                "panelCountPoint": screenPoint(panelButton, NSPoint(x: panelButton.bounds.midX, y: panelButton.bounds.midY)),
                "nativeVisible": native.isVisible, "panelLevel": panel.level.rawValue,
                "windowsIgnoreHardwareInput": [native.ignoresMouseEvents, panel.ignoresMouseEvents, webWindow.ignoresMouseEvents]]
            web.evaluateJavaScript("({clicks:window.clicks,text:document.querySelector('#field').value,inputs:window.inputs,activeElement:document.activeElement.id,selectionStart:document.querySelector('#field').selectionStart,selectionEnd:document.querySelector('#field').selectionEnd})") { result, error in
                if let result { value["web"] = result }
                if let error { value["webError"] = error.localizedDescription }
                reply(value)
            }
        }
    }
}

if let argument = CommandLine.arguments.firstIndex(of: "--probe-accessibility"), CommandLine.arguments.count > argument + 1,
   let pid = Int32(CommandLine.arguments[argument + 1]) {
    func read(_ element: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        return (error, value)
    }
    func string(_ element: AXUIElement, _ name: String) -> String? { read(element, name).1 as? String }
    func attribute(_ element: AXUIElement, _ name: String) -> [String: Any] {
        let (status, value) = read(element, name)
        var writable = DarwinBoolean(false)
        let writableStatus = AXUIElementIsAttributeSettable(element, name as CFString, &writable)
        var result: [String: Any] = ["status": status.rawValue, "writableStatus": writableStatus.rawValue, "writable": writable.boolValue]
        if let value {
            if CFGetTypeID(value) == AXValueGetTypeID() {
                let axValue = unsafeBitCast(value, to: AXValue.self)
                var range = CFRange()
                if AXValueGetType(axValue) == .cfRange, AXValueGetValue(axValue, .cfRange, &range) { result["value"] = ["location": range.location, "length": range.length] }
            } else if let text = value as? String { result["value"] = text }
            else if let number = value as? NSNumber { result["value"] = number }
        }
        return result
    }
    let application = AXUIElementCreateApplication(pid)
    let (windowStatus, windowValue) = read(application, "AXWindows")
    var fields: [[String: Any]] = []
    var visited = 0
    func walk(_ element: AXUIElement, _ windowTitle: String, _ depth: Int) {
        guard depth <= 20, visited < 600 else { return }
        visited += 1
        if string(element, "AXRole") == "AXTextField", [string(element, "AXTitle"), string(element, "AXDescription")].contains("WebText") {
            var field: [String: Any] = ["role": "AXTextField", "title": string(element, "AXTitle") ?? "", "description": string(element, "AXDescription") ?? "", "windowTitle": windowTitle]
            for name in ["AXValue", "AXFocused", "AXSelectedTextRange", "AXSelectedText"] { field[name] = attribute(element, name) }
            fields.append(field)
        }
        for child in read(element, "AXChildren").1 as? [AXUIElement] ?? [] { walk(child, windowTitle, depth + 1) }
    }
    for window in windowValue as? [AXUIElement] ?? [] { walk(window, string(window, "AXTitle") ?? "", 0) }
    var result: [String: Any] = ["pid": pid, "windowStatus": windowStatus.rawValue, "fields": fields]
    for name in ["AXFocusedWindow", "AXMainWindow", "AXFocusedUIElement"] {
        let (status, value) = read(application, name)
        var item: [String: Any] = ["status": status.rawValue]
        if let value, CFGetTypeID(value) == AXUIElementGetTypeID() {
            let element = unsafeBitCast(value, to: AXUIElement.self)
            item["role"] = string(element, "AXRole") ?? ""
            item["title"] = string(element, "AXTitle") ?? ""
        }
        result[name] = item
    }
    print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
    exit(0)
}

if CommandLine.arguments.contains("--environment") {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
    var displays: UInt32 = 0
    _ = CGGetActiveDisplayList(0, nil, &displays)
    let value: [String: Any] = ["locked": session["CGSSessionScreenIsLocked"] as? Bool ?? false,
        "onConsole": session[kCGSessionOnConsoleKey as String] as? Bool ?? false, "activeDisplays": Int(displays)]
    print(String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!)
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fixture = Fixture(); app.delegate = fixture
app.run()
