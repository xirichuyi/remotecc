#if canImport(SwiftUI)
import SwiftUI
import AppKit
import RemoteCCCore

@main
struct RemoteCCApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup("RemoteCC") {
            RootView()
                .environmentObject(model)
                .frame(minWidth: 1000, minHeight: 620)
                .onAppear { delegate.model = model }
        }
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
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var model: AppModel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A bare SwiftPM executable starts as a background process unless told otherwise.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.model?.connections?.checkConnections() }
        }
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
