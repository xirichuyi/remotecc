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
                    SidebarView().navigationSplitViewColumnWidth(min: 250, ideal: 290, max: 350)
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
        #if DEBUG
        .sheet(isPresented: $model.showChatGallery) { ChatGallery() }
        #endif
        .sheet(isPresented: $model.showWorktree) { WorktreeSheet() }
        .sheet(isPresented: $model.showUsage) { UsageSheet() }
        .sheet(isPresented: $model.showActivity) { ActivitySheet() }
        .sheet(isPresented: $model.showConnect) { ConnectSheet() }
        .sheet(isPresented: $model.showProjectPicker) { ProjectPickerSheet() }
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
            if model.showFiles, model.active != nil {
                FilePanel().frame(minWidth: 230, idealWidth: 280, maxWidth: 420)
            }
        }
        .navigationTitle(model.active?.name ?? "RemoteCC")
        .navigationSubtitle(model.active.map { ($0.directory as NSString).lastPathComponent + " · " + $0.host } ?? model.currentConfig?.host ?? "")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if let session = model.active {
                    if session.isBusy || !model.isConnected {
                        Text(model.isConnected ? statusLabel(session.status) : "未连接")
                            .font(.caption).foregroundStyle(.secondary).help(session.transportError ?? "")
                    }
                    Menu {
                        Button("同步消息", systemImage: "arrow.clockwise") { Task { await model.refreshVisibleHistory(session.id) } }
                            .disabled(!model.isConnected || session.isBusy || session.remoteOwner != nil || model.refreshingHistory.contains(session.id))
                        Button("上下文与用量", systemImage: "chart.bar") { model.showUsage = true }
                        Button("会话设置", systemImage: "slider.horizontal.3") { model.showSessionTools = true }
                    } label: { Label("对话操作", systemImage: "ellipsis") }
                    Button { model.showFiles.toggle() } label: { Label("文件", systemImage: "sidebar.right") }
                }
            }
        }
    }
}

func statusLabel(_ status: String) -> String {
    ["detached": "远端任务待同步", "idle": "就绪", "connecting": "连接中", "working": "正在回复", "permission": "等待你的确认", "stopping": "正在停止", "stopped": "已停止", "error": "调用未完成"][status] ?? status
}

struct SidebarView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showAllProjects = false
    @State private var searchExpanded = false
    @FocusState private var searchFocused: Bool

    private var groups: [(key: String, sessions: [ChatSession])] {
        let filter = model.searchText.lowercased()
        let visible = model.machineSessions.filter { ($0.archived ?? false) == model.showArchived }.filter {
            filter.isEmpty || "\($0.name) \($0.host) \($0.directory) \($0.historySummary ?? "")".lowercased().contains(filter)
        }
        var order: [String] = [], grouped: [String: [ChatSession]] = [:]
        for session in visible {
            if grouped[session.projectKey] == nil { order.append(session.projectKey) }
            grouped[session.projectKey, default: []].append(session)
        }
        return order.map { ($0, grouped[$0]!) }
    }

    private var visibleGroups: [(key: String, sessions: [ChatSession])] {
        if showAllProjects || !model.searchText.isEmpty { return groups }
        var result = Array(groups.prefix(6))
        if let active = groups.first(where: { $0.sessions.contains(where: { $0.id == model.activeId }) }), !result.contains(where: { $0.key == active.key }) { result.append(active) }
        return result
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 18) {
                HStack(spacing: 9) {
                    MachineSwitcher()
                    Spacer()
                    Button { model.showActivity = true } label: {
                        Image(systemName: "bell")
                            .overlay(alignment: .topTrailing) {
                                if !model.attentionSessions.isEmpty { Circle().fill(WorkbenchTheme.accent).frame(width: 5, height: 5).offset(x: 3, y: -2) }
                            }
                    }.buttonStyle(QuietButtonStyle()).help("所有机器的任务").accessibilityLabel("所有机器的任务")
                    Button {
                        if searchExpanded { closeSearch() }
                        else { searchExpanded = true; searchFocused = true }
                    } label: { Image(systemName: "magnifyingglass") }
                        .buttonStyle(QuietButtonStyle()).help("搜索对话")
                        .accessibilityLabel("搜索对话")
                }
                Button { model.newConversation() } label: {
                    HStack {
                        Label("新建对话", systemImage: "square.and.pencil")
                        Spacer()
                        Text("⌘ N").font(.system(size: 11)).foregroundStyle(.tertiary)
                    }
                }
                .buttonStyle(QuietButtonStyle()).help("新对话（⌘N）").disabled(model.currentConfig == nil)
                if searchExpanded {
                    HStack(spacing: 7) {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                        TextField("搜索对话", text: $model.searchText)
                            .textFieldStyle(.plain).focused($searchFocused)
                            .onAppear { searchFocused = true }
                            .onExitCommand { closeSearch() }
                        Button { closeSearch() } label: { Image(systemName: "xmark") }
                            .buttonStyle(.plain).help("关闭搜索").accessibilityLabel("关闭搜索")
                    }
                    .font(.system(size: 12)).padding(9)
                    .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 24)
            List(selection: Binding(get: { model.activeId }, set: { if let id = $0 {
                let sessionID = id.hasPrefix("recent:") ? String(id.dropFirst(7)) : id
                if model.machineSessions.contains(where: { $0.id == sessionID }) { model.select(sessionID) }
            } })) {
                if !groups.isEmpty {
                    Section(model.showArchived ? "已归档 · 项目" : "项目") {
                        ForEach(Array(visibleGroups.enumerated()), id: \.element.key) { index, group in
                            ProjectGroup(sessions: group.sessions, searching: !model.searchText.isEmpty, initiallyExpanded: index < 2)
                        }
                        if model.searchText.isEmpty && (showAllProjects || groups.count > visibleGroups.count) {
                            Button(showAllProjects ? "收起项目" : "更多项目（\(groups.count - visibleGroups.count)）") { showAllProjects.toggle() }
                                .buttonStyle(.borderless).foregroundStyle(.secondary).font(.system(size: 12))
                                .padding(.vertical, 6).selectionDisabled()
                        }
                    }
                    if model.searchText.isEmpty && !model.showArchived {
                        Section("最近对话") {
                            ProjectGroup(sessions: Array(model.machineSessions.filter { $0.archived != true }.sorted { $0.updatedAt > $1.updatedAt }.prefix(8)), searching: false, flat: true)
                        }
                    }
                }
            }
            .id(model.currentConfig?.key ?? "no-machine")
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .overlay(alignment: .topLeading) {
                if groups.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(model.searchText.isEmpty ? (model.showArchived ? "还没有归档的对话" : "暂无历史对话") : "没有找到匹配的对话")
                        Text(model.searchText.isEmpty ? "连接后自动同步这台机器的对话" : "试试其他关键词")
                            .foregroundStyle(.tertiary)
                    }
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .padding(.horizontal, 20).padding(.top, 20).allowsHitTesting(false)
                }
            }
            ServerFooter()
        }
        .background(WorkbenchTheme.sidebar)
    }

    private func closeSearch() {
        model.searchText = ""
        searchExpanded = false
        searchFocused = false
    }


}

struct ProjectGroup: View {
    @EnvironmentObject private var model: AppModel
    let sessions: [ChatSession]
    let searching: Bool
    var flat = false
    var initiallyExpanded = false
    @State private var headerHovered = false
    @State private var showAll = false
    @State private var expanded: Bool?
    @State private var renaming: ChatSession?
    @State private var name = ""

    private var isExpanded: Binding<Bool> {
        Binding(get: { searching || (expanded ?? (initiallyExpanded || sessions.contains { $0.id == model.activeId })) }, set: { expanded = $0 })
    }

    private var visibleSessions: [ChatSession] {
        if flat || searching || showAll { return sessions }
        var result = Array(sessions.prefix(5))
        if let active = sessions.first(where: { $0.id == model.activeId }), !result.contains(where: { $0.id == active.id }) { result.append(active) }
        return result
    }

    private var rows: some View {
            ForEach(visibleSessions) { session in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        if session.pinned == true { Image(systemName: "pin.fill").font(.system(size: 9)).foregroundStyle(.secondary) }
                        Text(historyDisplayTitle(session.name)).font(.system(size: 14)).lineLimit(1)
                        Spacer(minLength: 0)
                        if model.unreadSessions.contains(session.id) { Circle().fill(WorkbenchTheme.accent).frame(width: 6, height: 6) }
                    }
                    if session.isBusy {
                        Text(statusLabel(session.status)).font(.system(size: 10)).foregroundStyle(WorkbenchTheme.accent)
                    }
                }
                .padding(.vertical, 7)
                .help(session.directory + " · " + session.name)
                .tag(flat ? "recent:" + session.id : session.id)
                .contextMenu {
                    Button("重命名…") { name = session.name; renaming = session }
                    Button(session.pinned == true ? "取消固定" : "固定") { model.perform { try model.engine?.setPinned(session.id, session.pinned != true) } }
                    Button(session.archived == true ? "恢复" : "归档") { model.perform { try model.engine?.setArchived(session.id, session.archived != true) } }
                    Button("导出…") { model.exportConversation(session) }
                    Divider()
                    Button("删除…", role: .destructive) { model.deleteConversation(session) }
                }
            }
    }

    @ViewBuilder private func projectActions(_ first: ChatSession) -> some View {
        Text(first.host + " · " + first.directory)
        Button("在项目中新建对话") { model.newConversation(in: first) }
        Button("浏览远端文件夹") {
            model.select(first.id); model.panel = .files; model.showFiles = true
            Task { await model.activeWorkspace?.browse(first.directory) }
        }
        Button("复制文件夹路径") { copyToPasteboard(first.directory) }
        Divider()
        Button(model.showArchived ? "恢复项目" : "从侧栏移除项目…") { model.archiveProject(first, archived: !model.showArchived) }
    }

    var body: some View {
        Group {
            if flat { rows }
            else if let first = sessions.first {
                DisclosureGroup(isExpanded: isExpanded) {
                    rows
                    if !searching && (showAll || sessions.count > visibleSessions.count) {
                        Button(showAll ? "收起" : "显示更多（\(sessions.count - visibleSessions.count)）") { showAll.toggle() }
                            .buttonStyle(.borderless).font(.system(size: 12)).foregroundStyle(.secondary)
                            .padding(.vertical, 6).selectionDisabled()
                    }
                } label: {
                    HStack {
                        Image(systemName: "folder").foregroundStyle(.secondary)
                        Text(first.directory == "/" ? "/" : (first.directory as NSString).lastPathComponent).font(.system(size: 13, weight: .medium)).lineLimit(1)
                        Spacer()
                        Button { model.newConversation(in: first) } label: { Image(systemName: "plus") }
                            .buttonStyle(.borderless).help("在项目中新建对话").accessibilityLabel("在项目中新建对话")
                            .opacity(headerHovered ? 1 : 0.25)
                        Menu { projectActions(first) } label: { Image(systemName: "ellipsis") }
                            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                            .help("项目操作").accessibilityLabel("项目操作")
                    }.contentShape(Rectangle()).onHover { headerHovered = $0 }.help(first.host + " · " + first.directory)
                        .contextMenu { projectActions(first) }
                }
            }
        }
        .onChange(of: model.activeId) {
            if sessions.contains(where: { $0.id == model.activeId }) { expanded = true }
        }
        .alert("重命名对话", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("对话名称", text: $name)
            Button("取消", role: .cancel) { renaming = nil }
            Button("保存") {
                if let session = renaming { model.perform { try model.engine?.rename(session.id, name) } }
                renaming = nil
            }
            .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.trimmingCharacters(in: .whitespacesAndNewlines).count > 80)
        } message: { Text("输入 1–80 个字符的名称。") }
    }
}

struct MachineSwitcher: View {
    @EnvironmentObject private var model: AppModel
    @State private var choosing = false
    var body: some View {
        Button { choosing.toggle() } label: {
            HStack(spacing: 6) {
                Text("RemoteCC").font(.system(size: 19, weight: .semibold))
                Image(systemName: "chevron.down").font(.system(size: 9)).foregroundStyle(.secondary)
            }
        }.buttonStyle(.plain).help("当前机器：" + (model.currentConfig?.host ?? "未连接") + " · 切换或添加机器")
        .popover(isPresented: $choosing, arrowEdge: .trailing) {
            VStack(alignment: .leading, spacing: 6) {
                Button { choosing = false; model.activeId = nil } label: { Label("返回首页", systemImage: "house") }.buttonStyle(QuietButtonStyle())
                Divider()
                Text("我的机器").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary).padding(8)
                ForEach(model.savedMachines, id: \.key) { machine in
                    Button {
                        choosing = false
                        model.selectMachine(machine)
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "desktopcomputer")
                            Text(machine.host + (machine.port.map { ":\($0)" } ?? ""))
                            Spacer()
                            if model.currentConfig?.key == machine.key { Image(systemName: "checkmark") }
                            Circle().fill(model.engine?.connectionState(machine).status == .connected ? Color.green : Color.secondary).frame(width: 6, height: 6)
                        }.font(.system(size: 13)).padding(4).contentShape(Rectangle())
                    }.buttonStyle(QuietButtonStyle())
                }
                Divider()
                Button { choosing = false; model.showConnect = true } label: {
                    Label("添加机器…", systemImage: "plus").font(.system(size: 13)).padding(10)
                }.buttonStyle(.plain)
            }.padding(8).frame(width: 260)
        }
    }
}

struct ServerFooter: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        HStack(spacing: 8) {
            if let config = model.currentConfig, model.syncingMachines.contains(config.key) {
                ProgressView().controlSize(.mini)
            } else { Image(systemName: "clock.arrow.circlepath").foregroundStyle(.secondary) }
            Text(model.connectionState.error.isEmpty ? (model.historyStatus.isEmpty ? "历史对话自动同步" : model.historyStatus) : model.connectionState.error)
                .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                .help(model.connectionState.error.isEmpty ? model.historyStatus : model.connectionState.error)
            Spacer(minLength: 0)
            Menu {
                Button(model.showArchived ? "返回全部对话" : "查看已归档对话") { model.showArchived.toggle() }
                Divider()
                Button("添加机器…") { model.showConnect = true }
                if let config = model.currentConfig {
                    Button("刷新历史") { Task { await model.discoverHistory(config) } }.disabled(!model.isConnected)
                    if model.isConnected { Button("断开这台机器") { model.disconnect() } }
                    else { Button("重新连接") { model.perform { try await model.connect(config) } } }
                }
            } label: { Image(systemName: "ellipsis") }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        }.padding(16)
    }
}

struct ConnectSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var host = ""
    @State private var port = ""
    @State private var error = ""
    @State private var connecting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text("添加机器").font(.system(size: 22, weight: .semibold))
                Text("连接 SSH，即可找回这台机器上的 Claude Code 对话。")
                    .font(.system(size: 13)).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 16) {
                connectionField("SSH 主机", text: $host, prompt: "服务器别名或 user@host")
                DisclosureGroup("高级选项") {
                    connectionField("SSH 端口", text: $port, prompt: "使用 SSH 配置中的端口").padding(.top, 10)
                }.font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Text("使用系统 SSH 配置与密钥。首次连接请先在终端确认主机指纹。")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if !error.isEmpty {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.system(size: 12)).foregroundStyle(.red).textSelection(.enabled)
            }
            HStack {
                if connecting { ProgressView().controlSize(.small) }
                Spacer()
                Button("取消") { dismiss() }.buttonStyle(WorkbenchButtonStyle())
                    .keyboardShortcut(.cancelAction).disabled(connecting)
                Button(connecting ? "连接并同步中…" : "连接机器") { connect() }
                    .buttonStyle(WorkbenchButtonStyle(prominent: true)).keyboardShortcut(.defaultAction)
                    .disabled(connecting || host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(28).frame(width: 460).background(WorkbenchTheme.canvas)
        .interactiveDismissDisabled(connecting)
    }

    private func connectionField(_ label: String, text: Binding<String>, prompt: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.system(size: 12, weight: .medium))
            TextField(label, text: text, prompt: Text(prompt)).labelsHidden().textFieldStyle(.plain)
                .font(.system(size: 13)).padding(12)
                .background(WorkbenchTheme.surface, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(WorkbenchTheme.border))
        }
    }

    private func connect() {
        connecting = true; error = ""
        Task {
            do {
                try await model.connect(ConnectionConfig(host: host, port: ConnectionConfig.parsePort(port), directory: "~"))
                dismiss()
            } catch { self.error = error.localizedDescription }
            connecting = false
        }
    }
}
#endif
