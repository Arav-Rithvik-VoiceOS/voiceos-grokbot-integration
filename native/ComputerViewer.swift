import AppKit
import Foundation
import WebKit

private struct ViewerCommand: Decodable {
    let requestId: String
    let botId: String
    let botName: String
    let wsUrl: String
    let html: String
    let botColor: String?
    let botShape: String?
}

private struct ViewerAck: Encodable {
    let requestId: String
    let status: String
    let message: String?
}

private func sendAck(_ requestId: String, status: String, message: String? = nil) {
    guard let data = try? JSONEncoder().encode(ViewerAck(requestId: requestId, status: status, message: message)) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func isTrustedDesktopURL(_ raw: String) -> Bool {
    guard
        let parts = URLComponents(string: raw),
        parts.scheme?.lowercased() == "wss",
        let host = parts.host?.lowercased(),
        host == "cursorvm.com" || host.hasSuffix(".cursorvm.com"),
        parts.user == nil,
        parts.password == nil,
        parts.port == nil || parts.port == 443,
        parts.path == "/websockify",
        parts.fragment == nil
    else { return false }

    let query = parts.queryItems ?? []
    let tokens = query.filter { $0.name == "token" && !($0.value ?? "").isEmpty }
    let networkTokens = query.filter { $0.name == "network_token" && !($0.value ?? "").isEmpty }
    return tokens.count == 1 && networkTokens.count == 1
}

@MainActor
private final class ViewerController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private let window: NSWindow
    private let webView: WKWebView
    private var pendingRequestId: String?
    private var activeBotId: String?

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController = WKUserContentController()

        webView = WKWebView(frame: .zero, configuration: configuration)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        super.init()

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = false
        window.contentView = webView
        window.delegate = self
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.toolbar = nil
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(calibratedWhite: 0.02, alpha: 1)
        window.minSize = NSSize(width: 640, height: 400)
        window.center()
    }

    func show(_ command: ViewerCommand) {
        guard isTrustedDesktopURL(command.wsUrl) else {
            sendAck(command.requestId, status: "error", message: "The desktop connection was rejected for safety.")
            return
        }
        if let activeBotId, activeBotId != command.botId {
            sendAck(command.requestId, status: "error", message: "This viewer is already assigned to another bot.")
            return
        }
        activeBotId = command.botId
        pendingRequestId = command.requestId

        let config: [String: String] = [
            "wsUrl": command.wsUrl,
            "botName": command.botName,
            "botColor": command.botColor ?? "",
            "botShape": command.botShape ?? "",
        ]
        guard
            let configData = try? JSONSerialization.data(withJSONObject: config),
            !command.html.isEmpty
        else {
            sendAck(command.requestId, status: "error", message: "The desktop viewer could not be prepared.")
            return
        }
        let encoded = configData.base64EncodedString()
        let source = "window.__VOICEOS_CONFIG__=JSON.parse(atob('\(encoded)'));"

        clearRenderer { [weak self] in
            guard let self else { return }
            self.webView.configuration.userContentController.removeAllUserScripts()
            self.webView.configuration.userContentController.addUserScript(
                WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page)
            )
            self.webView.loadHTMLString(command.html, baseURL: nil)
            self.window.title = "\(command.botName)’s computer"
            self.window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            // Route physical keystrokes into the web content. Without this the
            // WKWebView never becomes first responder, so macOS sends key events
            // to the window (mouse still works — clicks don't need focus).
            self.window.makeFirstResponder(self.webView)
        }
    }

    private func clearRenderer(completion: @escaping () -> Void) {
        webView.stopLoading()
        webView.evaluateJavaScript("window.__voiceosClearCredential?.()") { _, _ in completion() }
    }

    private func finishPending(status: String, message: String? = nil) {
        guard let requestId = pendingRequestId else { return }
        pendingRequestId = nil
        webView.configuration.userContentController.removeAllUserScripts()
        sendAck(requestId, status: status, message: message)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finishPending(status: "ready")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finishPending(status: "error", message: "The desktop viewer could not open.")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finishPending(status: "error", message: "The desktop viewer could not open.")
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let url = navigationAction.request.url
        let isLocalDocument = url == nil || (url?.scheme == "about" && url?.absoluteString == "about:blank")
        decisionHandler(isLocalDocument && navigationAction.targetFrame?.isMainFrame != false ? .allow : .cancel)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? { nil }

    @available(macOS 12.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) { decisionHandler(.deny) }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(false)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        completionHandler(nil)
    }

    func windowWillClose(_ notification: Notification) {
        webView.stopLoading()
        webView.configuration.userContentController.removeAllUserScripts()
        webView.evaluateJavaScript("window.__voiceosClearCredential?.()", completionHandler: nil)
        webView.loadHTMLString("<html></html>", baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
    }
}

@MainActor
private final class ViewerAppDelegate: NSObject, NSApplicationDelegate {
    private var viewer: ViewerController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine(strippingNewline: true) {
                guard
                    let data = line.data(using: .utf8),
                    let command = try? JSONDecoder().decode(ViewerCommand.self, from: data)
                else { continue }
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    if self.viewer == nil { self.viewer = ViewerController() }
                    self.viewer?.show(command)
                }
            }
            DispatchQueue.main.async {
                NSApp.terminate(nil)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
private struct ViewerMain {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let appDelegate = ViewerAppDelegate()
        app.setActivationPolicy(.accessory)
        app.delegate = appDelegate
        app.run()
    }
}
