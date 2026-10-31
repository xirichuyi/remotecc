#if canImport(SwiftUI)
import SwiftUI
import AppKit
import RemoteCCCore

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            if let failure = model.fatalError {
                ContentUnavailableView("无法启动", systemImage: "exclamationmark.triangle", description: Text(failure))
            } else {
                NavigationSplitView {
                    SidebarView().navigationSplitViewColumnWidth(min: 190, ideal: 230, max: 340)
                } detail: {
                    WorkArea()
                }
            }
        }
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                Text(toast)
                    .font(.callout).padding(.horizontal, 14).padding(.vertical, 9)
                    .foregroundStyle(.white).background(.black.opacity(0.82), in: RoundedRectangle(cornerRadius: 8))
                    .padding(.bottom, 24).frame(maxWidth: 650).textSelection(.enabled)
            }
        }
        .sheet(isPresented: $model.showConnect) { ConnectSheet() }
        .sheet(isPresented: $model.showPreferences) { PreferencesSheet() }
        .sheet(isPresented: $model.showQuickOpen) { QuickOpenSheet() }
        .sheet(isPresented: $model.showSessionTools) { SessionToolsSheet() }
        .sheet(item: Binding(get: { model.commandPicker.map(IdentifiedInteraction.init) }, set: { if $0 == nil { model.commandPicker = nil } })) { CommandPickerSheet(interaction: $0.value) }
    }
}

struct IdentifiedInteraction: Identifiable {
    let value: CommandInteraction
    var id: String { value.command }
}

struct WorkArea: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HSplitView {
            ChatView().frame(minWidth: 380, maxWidth: .infinity)
            if let workspace = model.activeWorkspace, workspace.activeTab != nil {
                EditorPane(workspace: workspace).frame(minWidth: 400, maxWidth: .infinity)
            }
            if model.showFiles {
                FilePanel().frame(minWidth: 230, idealWidth: 280, maxWidth: 420)
            }
        }
        .navigationTitle(model.active?.name ?? "RemoteCC")
        .navigationSubtitle(model.active?.host ?? "")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Text(statusLabel(model.active?.status ?? "idle")).font(.caption).foregroundStyle(.secondary).help(model.active?.transportError ?? "")
                Button { model.showSessionTools = true } label: { Label("会话", systemImage: "ellipsis.circle") }
                Button { model.showFiles.toggle() } label: { Label("文件", systemImage: "sidebar.right") }
            }
        }
    }
}

func statusLabel(_ status: String) -> String {
    ["detached": "远端任务待同步", "idle": "就绪", "connecting": "连接中", "working": "正在回复", "permission": "等待你的确认", "stopping": "正在停止", "stopped": "已停止", "error": "调用未完成"][status] ?? status
}

struct SidebarView: View {
    @EnvironmentObject private var model: AppModel

    private var groups: [(key: String, sessions: [ChatSession])] {
        let filter = model.searchText.lowercased()
        let visible = model.sortedSessions.filter { ($0.archived ?? false) == model.showArchived }.filter {
            filter.isEmpty || "\($0.name) \($0.host) \($0.directory) \($0.historySummary ?? "")".lowercased().contains(filter)
        }
        var order: [String] = [], grouped: [String: [ChatSession]] = [:]
        for session in visible {
            if grouped[session.projectKey] == nil { order.append(session.projectKey) }
            grouped[session.projectKey, default: []].append(session)
        }
        return order.map { ($0, grouped[$0]!) }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $model.showArchived) {
                Text("对话").tag(false)
                Text("已归档").tag(true)
            }
            .pickerStyle(.segmented).labelsHidden().padding(.horizontal, 10).padding(.top, 6)
            List(selection: Binding(get: { model.activeId }, set: { if let id = $0 { model.select(id) } })) {
                ForEach(groups, id: \.key) { group in
                    ProjectGroup(sessions: group.sessions, searching: !model.searchText.isEmpty)
                }
            }
            .listStyle(.sidebar)
            .searchable(text: $model.searchText, placement: .sidebar, prompt: "搜索")
            Divider()
            ServerFooter()
        }
    }
}

struct ProjectGroup: View {
    @EnvironmentObject private var model: AppModel
    let sessions: [ChatSession]
    let searching: Bool
    @State private var expanded: Bool?

    private var isExpanded: Binding<Bool> {
        Binding(get: { searching || (expanded ?? sessions.contains { $0.id == model.activeId }) }, set: { expanded = $0 })
    }

    var body: some View {
        let first = sessions[0]
        DisclosureGroup(isExpanded: isExpanded) {
            ForEach(sessions) { session in
                VStack(alignment: .leading, spacing: 2) {
                    Text((session.pinned == true ? "• " : "") + session.name).lineLimit(1)
                    Text(session.isBusy ? statusLabel(session.status) : Date(timeIntervalSince1970: session.updatedAt / 1000).formatted(date: .numeric, time: .shortened))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                .tag(session.id)
                .contextMenu {
                    Button(session.pinned == true ? "取消固定" : "固定") { model.perform { try model.engine?.setPinned(session.id, session.pinned != true) } }
                    Button(session.archived == true ? "恢复" : "归档") { model.perform { try model.engine?.setArchived(session.id, session.archived != true) } }
                    Button("导出…") { model.exportConversation(session) }
                    Divider()
                    Button("删除…", role: .destructive) { model.deleteConversation(session) }
                }
            }
        } label: {
            HStack {
                Text((first.directory as NSString).lastPathComponent).fontWeight(.medium).lineLimit(1)
                Spacer()
                Text("\(sessions.count)").font(.caption2).foregroundStyle(.secondary)
                Button { model.newConversation(in: first) } label: { Image(systemName: "plus") }.buttonStyle(.plain).help("在 \(first.directory) 新建对话")
            }
            .help("\(first.host) · \(first.directory)")
        }
    }
}

struct ServerFooter: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !model.historyStatus.isEmpty {
                Text(model.historyStatus).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            HStack {
                Text(model.currentConfig?.host ?? "未配置服务器").font(.caption).fontWeight(.medium).lineLimit(1)
                Spacer()
                Text(label).font(.caption2).foregroundStyle(model.isConnected ? Color.green : Color.secondary).help(model.connectionState.error)
            }
            HStack(spacing: 6) {
                if model.isConnected {
                    Button("断开") { model.disconnect() }
                    Button("刷新历史") { if let config = model.currentConfig { Task { await model.discoverHistory(config) } } }
                } else {
                    Button("连接 SSH") {
                        if let config = model.currentConfig { model.perform { try await model.connect(config) } } else { model.showConnect = true }
                    }
                    .disabled(model.connectionState.status == .connecting)
                }
                Button("设置") { model.showConnect = true }
            }
            .controlSize(.small)
        }
        .padding(10)
    }

    private var label: String {
        switch model.connectionState.status {
        case .connected: return "已连接"
        case .connecting: return "连接中"
        case .reconnecting: return "重连中"
        case .disconnected: return "未连接"
        case .error: return "已断开"
        }
    }
}

struct ConnectSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var host = ""
    @State private var port = ""
    @State private var directory = "~"
    @State private var error = ""
    @State private var connecting = false

    var body: some View {
        Form {
            TextField("主机 / SSH 别名", text: $host, prompt: Text("ssh axi 或 user@host"))
            TextField("端口", text: $port, prompt: Text("使用 SSH 配置"))
            TextField("初始目录", text: $directory)
            Text("使用本机 ~/.ssh/config、密钥和 SSH agent。").font(.caption).foregroundStyle(.secondary)
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
        }
        .formStyle(.grouped)
        .frame(width: 420)
        .safeAreaInset(edge: .bottom) {
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(connecting ? "连接中…" : "连接") { connect() }.keyboardShortcut(.defaultAction).disabled(connecting || host.isEmpty)
            }.padding()
        }
        .onAppear {
            if let config = model.currentConfig { host = config.host; port = config.port.map(String.init) ?? ""; directory = config.directory }
        }
    }

    private func connect() {
        connecting = true; error = ""
        Task {
            do {
                try await model.connect(ConnectionConfig(host: host, port: Int(port), directory: directory))
                dismiss()
            } catch { self.error = error.localizedDescription }
            connecting = false
        }
    }
}
#endif
