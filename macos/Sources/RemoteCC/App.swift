#if canImport(SwiftUI)
import SwiftUI
import Network
import AppKit
import UserNotifications
import RemoteCCCore

@main
struct RemoteCCApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup("RemoteCC") {
            RootView()
                .environmentObject(model)
                .tint(WorkbenchTheme.accent)
                .frame(minWidth: 1000, minHeight: 620)
                .onAppear { delegate.model = model }
        }
        .defaultSize(width: 1160, height: 760)
        .windowToolbarStyle(.unifiedCompact)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("新对话") { model.newConversation() }.keyboardShortcut("n")
                Button("快速打开文件…") { model.showQuickOpen = true }.keyboardShortcut("p")
                Button("关闭文件标签") { model.closeActiveTab() }.keyboardShortcut("w")
            }
            CommandGroup(after: .saveItem) {
                Button("保存到远端") { model.saveActiveTab() }.keyboardShortcut("s")
            }
            CommandMenu("工作区") {
                Button("在文件中搜索") { model.panel = .search; model.showFiles = true }.keyboardShortcut("f", modifiers: [.command, .shift])
                Button("显示 / 隐藏文件面板") { model.showFiles.toggle() }.keyboardShortcut("b")
                Divider()
                Button("模型与会话设置…") { model.showPreferences = true }
                Button("连接 SSH…") { model.showConnect = true }
                #if DEBUG
                Divider()
                Button("聊天交互预览…") { model.showChatGallery = true }
                #endif
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    weak var model: AppModel?
    private let networkMonitor = NWPathMonitor()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A bare SwiftPM executable starts as a background process unless told otherwise.
        UNUserNotificationCenter.current().delegate = self
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        networkMonitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in await self?.model?.connections?.networkBecameAvailable() }
        }
        networkMonitor.start(queue: DispatchQueue(label: "remotecc.network-path"))
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.model?.connections?.networkBecameAvailable() }
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        Task { @MainActor in model?.markActiveRead() }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let id = response.notification.request.content.userInfo["sessionId"] as? String {
            Task { @MainActor in self.model?.select(id); NSApp.activate(ignoringOtherApps: true) }
        }
        completionHandler()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    @MainActor
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model else { return .terminateNow }
        if model.hasUnsavedEdits {
            let alert = NSAlert()
            alert.messageText = "远端文件有未保存的修改"
            alert.informativeText = "退出后这些编辑将丢失。"
            alert.addButton(withTitle: "继续编辑")
            alert.addButton(withTitle: "放弃修改")
            if alert.runModal() == .alertFirstButtonReturn { return .terminateCancel }
        }
        model.shutdown()
        return .terminateNow
    }
}
#else
// The core library builds and tests on Linux; the interface needs macOS.
@main
struct RemoteCCStub {
    static func main() { print("RemoteCC 的界面只能在 macOS 上运行") }
}
#endif
