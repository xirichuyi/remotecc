#if canImport(SwiftUI)
import SwiftUI
import AppKit
import UniformTypeIdentifiers
import RemoteCCCore
import UserNotifications

enum SidePanel: String, CaseIterable, Identifiable {
    case files = "文件", changes = "变更", search = "搜索"
    var id: String { rawValue }
}

/// Bridges the core engine to SwiftUI. Core objects hold the state; this republishes their changes.
@MainActor
final class AppModel: ObservableObject {
    private(set) var engine: ChatEngine?
    private(set) var connections: SSHConnections?
    private var workspaces: [String: Workspace] = [:]

    @Published var selectedMachine: ConnectionConfig?
    @Published var savedMachines: [ConnectionConfig] = []
    @Published var syncingMachines = Set<String>()
    @Published var machineHistoryStatus: [String: String] = [:]
    @Published var activeId: String?
    @Published var showArchived = false
    @Published var searchText = ""
    @Published var toast: String?
    @Published var panel: SidePanel = .files
    @Published var showFiles = false
    @Published var showProjectPicker = false
    var proposedProject: String?
    @Published var composerFocus = UUID()
    @Published var showConnect = false
    @Published var showPreferences = false
    @Published var showQuickOpen = false
    @Published var showSessionTools = false
    @Published var historyStatus = ""
    @Published private var transferStatuses: [ConnectionConfig: String] = [:]
    @Published private var batchUploadProgress: [String: String] = [:]
    var transferStatus: String {
        guard let active else { return "" }
        return batchUploadProgress[active.id] ?? transferStatuses[active.config] ?? ""
    }
    @Published var drafts: [String: String] = [:]
    @Published var attachments: [String: [Attachment]] = [:]
    @Published var commandPicker: CommandInteraction?
    @Published var fatalError: String?
    #if DEBUG
    @Published var showChatGallery = false
    #endif

    @Published var showWorktree = false
    @Published var showUsage = false
    @Published var notificationsEnabled = UserDefaults.standard.bool(forKey: "task-notifications")
    var failedUploadDirectories: [String: [URL: String]] = [:]
    @Published var failedUploads: [String: [URL]] = [:]
    @Published var uploadingSessions = Set<String>()
    @Published var showActivity = false
    @Published var unreadSessions = Set<String>()
    @Published var historyRefreshErrors: [String: String] = [:]
    @Published var refreshingHistory = Set<String>()
    private var historyPoll: Task<Void, Never>?
    private var notificationTracker = TaskNotificationTracker()
    private var notificationRequestID = UUID()
    @Published var notificationsAuthorizing = false
    @Published var notificationTestStatus = ""
    @Published var notificationTestRunning = false
    private var toastTask: Task<Void, Never>?
    private var capabilityRetry: [String: Date] = [:]
    private var capabilityRequests = Set<String>()
    private let lastConnectionKey = "last-connection"

    init() {
        do {
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("RemoteCC Native")
            let caches = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("RemoteCC Native")
            guard let resourceDirectory = Bundle.main.resourceURL?.appendingPathComponent("server") else { throw RemoteError("找不到应用资源") }
            let resources = try ServerResources(directory: resourceDirectory)
            let connections = try SSHConnections()
            let agents = AgentClient(launcher: connections, resources: resources)
            let files = RemoteFiles(agents: agents, cacheDirectory: caches)
            let engine = try ChatEngine(store: try ChatStore(directory: support), agents: agents, files: files)
            self.connections = connections; self.engine = engine
            engine.onChange = { [weak self] in self?.engineChanged() }
            engine.onError = { [weak self] in self?.show($0) }
            connections.onState = { [weak self] config, state in
                Task { @MainActor in self?.connectionChanged(config, state) }
            }
            connections.onRecovered = { [weak self] config in
                Task { @MainActor in await self?.recovered(config) }
            }
            agents.onFileChange = { [weak self] config, directories in
                Task { @MainActor in self?.filesChanged(config, directories) }
            }
            files.onProgress = { [weak self] progress in
                Task { @MainActor in
                    guard let self else { return }
                    if let error = progress.error { self.transferStatuses[progress.config] = "\(progress.name) · 失败：\(error)" }
                    else if progress.finished { self.transferStatuses[progress.config] = "\(progress.name) · 完成" }
                    else { self.transferStatuses[progress.config] = "\(progress.name) · \(progress.total > 0 ? min(99, progress.bytes * 100 / progress.total) : 0)%" }
                }
            }
            savedMachines = UserDefaults.standard.data(forKey: "saved-machines").flatMap { try? JSONDecoder().decode([ConnectionConfig].self, from: $0) } ?? []
            for config in sessions.map(\.config) + [lastConnection].compactMap({ $0 }) {
                if !savedMachines.contains(where: { $0.key == config.key }) { savedMachines.append(config) }
            }
            selectedMachine = lastConnection ?? savedMachines.first
            autoConnect()
            historyPoll = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 30_000_000_000)
                    guard !Task.isCancelled, let self else { return }
                    if let id = self.activeId, self.isConnected { await self.refreshVisibleHistory(id, report: false) }
                }
            }
        } catch { fatalError = error.localizedDescription }
    }

    // MARK: State access

    var sessions: [ChatSession] { engine?.sessions ?? [] }
    var active: ChatSession? { activeId.flatMap { engine?.session($0) } }
    var sortedSessions: [ChatSession] {
        sessions.sorted { a, b in
            if (a.pinned ?? false) != (b.pinned ?? false) { return a.pinned ?? false }
            return a.updatedAt > b.updatedAt
        }
    }
    var lastConnection: ConnectionConfig? {
        get { UserDefaults.standard.data(forKey: lastConnectionKey).flatMap { try? JSONDecoder().decode(ConnectionConfig.self, from: $0) } }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: lastConnectionKey) }
    }
    var currentConfig: ConnectionConfig? { selectedMachine ?? active?.config ?? lastConnection }
    var machineSessions: [ChatSession] { sortedSessions.filter { $0.config.key == currentConfig?.key } }

    func selectMachine(_ config: ConnectionConfig) {
        selectedMachine = config
        lastConnection = config
        activeId = nil
        searchText = ""; showArchived = false
        historyStatus = machineHistoryStatus[config.key] ?? ""
        if engine?.connectionState(config).status != .connected {
            perform { try await self.connect(config) }
        }
    }

    private func rememberMachine(_ config: ConnectionConfig) {
        if let index = savedMachines.firstIndex(where: { $0.key == config.key }) { savedMachines[index] = config }
        else { savedMachines.append(config) }
        UserDefaults.standard.set(try? JSONEncoder().encode(savedMachines), forKey: "saved-machines")
    }
    var connectionState: ConnectionState { currentConfig.flatMap { engine?.connectionState($0) } ?? ConnectionState() }
    var isConnected: Bool { connectionState.status == .connected }
    var hasUnsavedEdits: Bool { workspaces.values.contains(where: \.hasUnsavedEdits) }

    func workspace(for session: ChatSession) -> Workspace? {
        guard let engine else { return nil }
        let key = session.id
        if let existing = workspaces[key] { return existing }
        let workspace = Workspace(files: engine.files, agents: engine.agents, config: session.config)
        workspace.onChange = { [weak self] in self?.objectWillChange.send() }
        workspace.touchedFiles = { [weak self] in self?.touchedFiles(session.id) ?? [] }
        workspaces[key] = workspace
        return workspace
    }
    var activeWorkspace: Workspace? { active.flatMap(workspace(for:)) }

    private func touchedFiles(_ id: String) -> Set<String> {
        var result = Set<String>()
        for block in engine?.session(id)?.messages.last?.blocks ?? [] where ["Write", "Edit", "MultiEdit", "NotebookEdit"].contains(block.name ?? "") {
            if let file = block.input?["file_path"]?.string ?? block.input?["notebook_path"]?.string { result.insert(file) }
        }
        return result
    }

    private var lastBusy: [String: Bool] = [:]
    private func engineChanged() {
        objectWillChange.send()
        for session in sessions {
            let background = Set((session.tasks?.array ?? []).filter { $0["status"]?.string == "running" && $0["ambient"]?.bool != true }.compactMap { $0["id"]?.string })
            let isViewed = session.id == activeId && NSApp.isActive && NSApp.windows.contains { $0.isVisible && !$0.isMiniaturized && $0.canBecomeMain }
            if let body = notificationTracker.update(id: session.id, status: session.status, background: background,
                connected: engine?.connectionState(session.config).status == .connected, isViewed: isViewed) {
                unreadSessions.insert(session.id)
                if notificationsEnabled {
                    Task {
                        do { try await postNotification(id: session.id, title: "RemoteCC · " + session.host, body: body, sessionId: session.id) }
                        catch { show("系统通知发送失败：" + error.localizedDescription) }
                    }
                }
            }
        }
        NSApp.dockTile.badgeLabel = unreadSessions.isEmpty ? nil : String(unreadSessions.count)
        for session in sessions where session.id == activeId {
            let busy = session.isBusy
            // Without working watches, follow the turn's end instead of live pushes.
            if lastBusy[session.id] == true, !busy, isConnected { Task { await workspace(for: session)?.reload(force: true) } }
            lastBusy[session.id] = busy
        }
    }

    func show(_ message: String) {
        toast = message
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 6_500_000_000)
            if !Task.isCancelled { self?.toast = nil }
        }
    }

    /// Runs async work and surfaces its failure; the UI's buttons all go through here.
    func perform(_ work: @escaping @MainActor () async throws -> Void) {
        Task { @MainActor [weak self] in
            do { try await work() } catch { self?.show(error.localizedDescription) }
        }
    }

    // MARK: Connection

    private func autoConnect() {
        guard let config = currentConfig, lastConnection != nil else { return }
        perform { try await self.connect(config) }
    }

    func connect(_ input: ConnectionConfig) async throws {
        guard let engine, let connections else { return }
        var config = try input.validated()
        // Connecting a machine never depends on a remembered project's existence.
        config.directory = "~"
        guard !syncingMachines.contains(config.key) else { return }
        syncingMachines.insert(config.key)
        defer { syncingMachines.remove(config.key) }
        selectedMachine = config
        activeId = nil
        searchText = ""; showArchived = false
        try await connections.connect(config)
        rememberMachine(config)
        if selectedMachine?.key == config.key { lastConnection = config }
        do {
            let info = try await engine.agents.info(config)
            config.directory = info.home
            rememberMachine(config)
            if selectedMachine?.key == config.key { selectedMachine = config; lastConnection = config }
            if info.claude == nil { show("SSH 已连接。远端未找到 Claude Code，仍可查看可用历史。") }
            await discoverHistory(config)
            await engine.restore(config)
        } catch {
            machineHistoryStatus[config.key] = "SSH 已连接，历史加载失败，可重试"
            if selectedMachine?.key == config.key { historyStatus = machineHistoryStatus[config.key]! }
            show(error.localizedDescription)
        }
    }

    func disconnect() {
        guard let engine, let connections, let config = currentConfig else { return }
        engine.detach(config)
        engine.agents.close(config)
        Task { await connections.disconnect(config) }
    }

    private func connectionChanged(_ config: ConnectionConfig, _ state: ConnectionState) {
        guard let engine else { return }
        let wasConnected = engine.connectionState(config).status == .connected
        engine.updateConnection(config, state)
        if wasConnected, state.status != .connected { engine.detach(config) }
    }

    /// After an automatic reconnect the tree reloads, watches return and tasks are rejoined.
    private func recovered(_ config: ConnectionConfig) async {
        guard let engine else { return }
        engine.files.invalidate(config)
        await engine.restore(config)
        if active?.config.key == config.key { await activeWorkspace?.reload(force: true) }
    }

    private func filesChanged(_ config: ConnectionConfig, _ directories: [String]) {
        guard let active, active.config.key == config.key else { return }
        Task { await workspace(for: active)?.filesChanged(directories) }
    }

    func discoverHistory(_ config: ConnectionConfig) async {
        guard let engine else { return }
        machineHistoryStatus[config.key] = "正在同步历史…"
        if currentConfig?.key == config.key { historyStatus = "正在同步历史…" }
        do {
            let result = try await engine.discoverHistory(config)
            machineHistoryStatus[config.key] = "已同步 \(result.count) 条对话" + (result.unreadable > 0 ? " · \(result.unreadable) 条不可读" : "")
        } catch { machineHistoryStatus[config.key] = "历史同步失败，点击刷新重试"; show(error.localizedDescription) }
        if currentConfig?.key == config.key { historyStatus = machineHistoryStatus[config.key] ?? "" }
    }

    // MARK: Conversations

    func select(_ id: String) {
        guard let engine else { return }
        activeId = id
        unreadSessions.remove(id)
        NSApp.dockTile.badgeLabel = unreadSessions.isEmpty ? nil : String(unreadSessions.count)
        do { try engine.hydrate(id) } catch { show(error.localizedDescription) }
        guard let session = engine.session(id) else { return }
        selectedMachine = savedMachines.first(where: { $0.key == session.config.key }) ?? session.config
        if session.historyLoaded == false, isConnected { perform { try await engine.loadHistory(id) } }
        if engine.connectionState(session.config).status == .connected {
            let workspace = workspace(for: session)
            if workspace?.root == nil { Task { await workspace?.browse(session.directory) } }
            refreshCapabilities()
            Task { await refreshVisibleHistory(id, report: false) }
        }
    }

    func refreshVisibleHistory(_ id: String, report: Bool = true) async {
        guard let engine, !refreshingHistory.contains(id), let session = engine.session(id),
              engine.connectionState(session.config).status == .connected else { return }
        refreshingHistory.insert(id)
        defer { refreshingHistory.remove(id) }
        do { try await engine.refreshHistory(id); historyRefreshErrors[id] = nil }
        catch {
            historyRefreshErrors[id] = error.localizedDescription
            if report { show(error.localizedDescription) }
        }
    }

    var attentionSessions: [ChatSession] {
        sortedSessions.filter { $0.isBusy || !$0.permissions.isEmpty || unreadSessions.contains($0.id) ||
            ($0.tasks?.array ?? []).contains { $0["status"]?.string == "running" && $0["ambient"]?.bool != true } }
    }

    func newConversation() {
        guard let engine else { return }
        searchText = ""; showArchived = false
        guard let config = currentConfig else {
            activeId = nil
            composerFocus = UUID()
            return
        }
        perform {
            let session = try engine.create(config, preferences: self.active?.preferences)
            if self.activeId == nil { self.drafts[session.id] = self.drafts.removeValue(forKey: "welcome-" + config.key) }
            self.select(session.id)
            self.composerFocus = UUID()
        }
    }

    func newConversation(in source: ChatSession) {
        guard let engine else { return }
        searchText = ""; showArchived = false
        perform {
            self.select(try engine.create(source.config, preferences: source.preferences).id)
            self.composerFocus = UUID()
        }
    }

    func chooseProject(_ directory: String) async throws {
        guard let engine, let source = active, isConnected else { throw RemoteError("请先连接服务器") }
        let listing = try await engine.files.list(source.config, directory, hidden: false, force: true)
        guard listing.path != source.directory else { return }
        var config = source.config
        config.directory = listing.path
        let session = try engine.create(config, preferences: source.preferences)
        // Move only the unsent draft; the old conversation and its running task remain bound to their project.
        drafts[session.id] = drafts.removeValue(forKey: source.id)
        attachments[session.id] = attachments.removeValue(forKey: source.id)
        searchText = ""; showArchived = false
        select(session.id)
        composerFocus = UUID()
    }

    func createWorktree(_ branch: String) async throws {
        guard let source = active, let engine, isConnected else { throw RemoteError("请先连接项目所在的机器") }
        let result = try await engine.files.run(source.config, "createWorktree", ["branch": .string(branch)], timeout: 90)
        guard let directory = result["path"]?.string else { throw RemoteError("工作区已创建，但远端没有返回路径") }
        var config = source.config; config.directory = directory
        do { select(try engine.create(config, preferences: source.preferences).id) }
        catch { throw RemoteError("工作区已创建在 \(directory)，新建对话失败：\(error.localizedDescription)") }
    }

    func openProjectPicker(_ directory: String? = nil) {
        proposedProject = directory ?? active?.directory
        showProjectPicker = true
    }

    func refreshCapabilities(force: Bool = false) {
        guard let engine, let session = active, session.historyLoaded != false, isConnected else { return }
        let id = session.id
        if !force, let fetched = session.capabilities?.fetchedAt, Date().timeIntervalSince1970 * 1000 - fetched < 300_000 { return }
        if capabilityRequests.contains(id) || (capabilityRetry[id] ?? .distantPast) > Date() { return }
        capabilityRequests.insert(id)
        Task {
            do { try await engine.capabilities(id, refresh: force); capabilityRetry[id] = nil }
            catch { capabilityRetry[id] = Date().addingTimeInterval(10) }
            capabilityRequests.remove(id)
        }
    }

    func submit(text: String) {
        guard let engine, let id = activeId else { return }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = attachments[id] ?? []
        guard !value.isEmpty || !files.isEmpty else { return }
        guard isConnected else { show("请先连接 SSH 服务器"); return }
        perform {
            if value.hasPrefix("/"), files.isEmpty, let capabilities = self.active?.capabilities, let interaction = commandInteraction(capabilities, text: value, preferences: self.active?.preferences) {
                try await self.run(interaction, id: id)
                return
            }
            try engine.submit(id, text: value, attachments: files)
            self.attachments[id] = nil
            self.drafts[id] = ""
        }
    }

    private func run(_ interaction: CommandInteraction, id: String) async throws {
        guard let engine else { return }
        switch interaction.kind {
        case .newConversation:
            drafts[id] = ""
            let session = try engine.create(active?.config ?? currentConfig!, preferences: active?.preferences)
            select(session.id)
        case .model where !interaction.argument.isEmpty:
            try await engine.selectModel(id, interaction.argument); drafts[id] = ""
        case .effort where !interaction.argument.isEmpty:
            try await engine.selectEffort(id, interaction.argument); drafts[id] = ""
        default:
            commandPicker = interaction
        }
    }

    func applyCommandPicker(_ interaction: CommandInteraction, value: String) {
        guard let engine, let id = activeId else { return }
        commandPicker = nil
        perform {
            switch interaction.kind {
            case .model: try await engine.selectModel(id, value)
            case .effort: try await engine.selectEffort(id, value)
            default: try engine.submit(id, text: "/" + interaction.command + " " + value)
            }
            self.drafts[id] = ""
        }
    }

    func stop() {
        guard let engine, let id = activeId else { return }
        perform { try await engine.stop(id) }
    }

    func respond(_ permission: PermissionRequest, answer: JSON) async throws {
        guard let engine, let id = activeId else { return }
        try await engine.respond(id, permission: permission.id, answer: answer)
    }

    func archiveProject(_ project: ChatSession, archived: Bool) {
        guard let engine else { return }
        let sessions = machineSessions.filter { $0.projectKey == project.projectKey }
        guard !sessions.contains(where: { $0.isBusy || $0.queue?.isEmpty == false }) else {
            show("请先完成或停止此项目中的任务"); return
        }
        if archived {
            let alert = NSAlert()
            alert.messageText = "从侧栏移除项目？"
            alert.informativeText = "\(project.directory)\n将归档该项目的 \(sessions.count) 条对话，可从已归档列表恢复。远端文件夹和聊天历史不会删除。"
            alert.addButton(withTitle: "取消")
            alert.addButton(withTitle: "移除项目")
            guard alert.runModal() == .alertSecondButtonReturn else { return }
        }
        perform {
            for session in sessions { try engine.setArchived(session.id, archived) }
            if sessions.contains(where: { $0.id == self.activeId }) { self.activeId = nil }
        }
    }

    func deleteConversation(_ session: ChatSession) {
        guard let engine else { return }
        let alert = NSAlert()
        alert.messageText = "删除这条本地聊天记录？"
        alert.informativeText = "远端 Claude 的历史不会被删除。"
        alert.addButton(withTitle: "删除")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        perform {
            try await engine.remove(session.id)
            self.workspaces[session.id] = nil
            if self.activeId == session.id {
                self.activeId = self.sortedSessions.first?.id
                if let next = self.activeId { self.select(next) }
            }
        }
    }

    func exportConversation(_ session: ChatSession) {
        guard let engine else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = session.name.replacingOccurrences(of: "/", with: "-") + ".md"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        perform { try engine.exportMarkdown(session.id).write(to: url, atomically: true, encoding: .utf8) }
    }

    // MARK: Files

    func open(_ file: String, line: Int? = nil) {
        guard isConnected else { show("请先连接 SSH 服务器"); return }
        Task { await activeWorkspace?.open(file, line: line) }
    }

    func closeActiveTab() {
        guard let workspace = activeWorkspace, let tab = workspace.activeTab else { return }
        close(tab, in: workspace)
    }

    func close(_ tab: EditorTab, in workspace: Workspace) {
        if tab.isDirty {
            let alert = NSAlert()
            alert.messageText = "文件有未保存的修改，放弃修改？"
            alert.addButton(withTitle: "继续编辑")
            alert.addButton(withTitle: "放弃修改")
            if alert.runModal() == .alertFirstButtonReturn { return }
        }
        workspace.close(tab)
    }

    func saveActiveTab() {
        guard let workspace = activeWorkspace, let tab = workspace.activeTab, tab.draft != nil else { return }
        Task { await workspace.save(tab) }
    }

    func attach(_ file: String) {
        guard let engine, let session = active else { return }
        perform {
            let entry = try await engine.files.stat(session.config, file)
            self.addAttachments([Attachment(name: entry.name, path: entry.path, size: entry.size)], to: session.id)
        }
    }

    func addAttachments(_ files: [Attachment], to id: String) {
        var current = attachments[id] ?? []
        for file in files where !current.contains(where: { $0.path == file.path }) { current.append(file) }
        attachments[id] = current
    }

    func upload(_ urls: [URL], to directory: String? = nil) {
        guard let engine, let config = currentConfig, isConnected else { show("请先连接 SSH"); return }
        guard !urls.isEmpty else { return }
        guard urls.count <= 20 else { show("一次最多上传 20 个文件"); return }
        if active == nil {
            do {
                let session = try engine.create(config)
                drafts[session.id] = drafts.removeValue(forKey: "welcome-" + config.key)
                select(session.id)
                composerFocus = UUID()
            } catch { show(error.localizedDescription); return }
        }
        guard let session = active else { return }
        let target = directory ?? session.directory
        guard !uploadingSessions.contains(session.id) else { show("请等待当前上传完成"); return }
        uploadingSessions.insert(session.id)
        perform {
            defer {
                self.uploadingSessions.remove(session.id)
                self.batchUploadProgress[session.id] = nil
            }
            if urls.count > 1 { self.batchUploadProgress[session.id] = "正在上传 · 0/\(urls.count) 个文件已处理" }
            let results = await engine.files.uploadBatch(session.config, files: urls, directory: target) { [weak self] completed, total in
                guard total > 1, let self else { return }
                await MainActor.run { self.batchUploadProgress[session.id] = "正在上传 · \(completed)/\(total) 个文件已处理" }
            }
            for result in results {
                let url = result.file
                if let attachment = result.attachment {
                    self.addAttachments([attachment], to: session.id)
                    self.failedUploads[session.id]?.removeAll { $0 == url }
                    self.failedUploadDirectories[session.id]?[url] = nil
                } else {
                    self.failedUploadDirectories[session.id, default: [:]][url] = target
                    if !(self.failedUploads[session.id] ?? []).contains(url) { self.failedUploads[session.id, default: []].append(url) }
                    self.show(url.lastPathComponent + ": " + (result.error ?? "上传失败"))
                }
            }
            let succeeded = results.filter { $0.attachment != nil }.count
            self.transferStatuses[session.config] = "上传完成 · \(succeeded)/\(urls.count) 个成功"
            await self.workspace(for: session)?.reload(force: true)
        }
    }

    func markActiveRead() {
        if let activeId { unreadSessions.remove(activeId) }
        NSApp.dockTile.badgeLabel = unreadSessions.isEmpty ? nil : String(unreadSessions.count)
    }

    private func postNotification(id: String, title: String, body: String, sessionId: String?) async throws {
        let content = UNMutableNotificationContent()
        content.title = title; content.body = body; content.sound = .default
        if let sessionId { content.userInfo = ["sessionId": sessionId] }
        try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    func testNotification() {
        guard !notificationTestRunning else { return }
        notificationTestRunning = true; notificationTestStatus = "正在发送…"
        Task {
            defer { notificationTestRunning = false }
            do {
                let center = UNUserNotificationCenter.current()
                let settings = await center.notificationSettings()
                guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
                    notificationTestStatus = "系统尚未允许通知，请先开启通知权限。"; return
                }
                let id = "remotecc-test-" + UUID().uuidString
                try await postNotification(id: id, title: "RemoteCC 通知测试", body: "任务通知已送达。", sessionId: activeId)
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let delivered = await center.deliveredNotifications()
                notificationTestStatus = delivered.contains { $0.request.identifier == id } ? "已在系统通知中心确认送达" : "已提交，但未确认送达；请检查专注模式与系统通知设置。"
            } catch { notificationTestStatus = "通知测试失败：" + error.localizedDescription }
        }
    }

    func setNotifications(_ enabled: Bool) {
        let request = UUID(); notificationRequestID = request
        if !enabled {
            notificationsAuthorizing = false; notificationsEnabled = false
            UserDefaults.standard.set(false, forKey: "task-notifications")
            return
        }
        notificationsAuthorizing = true; notificationTestStatus = "正在请求系统通知权限…"
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            guard let self, self.notificationRequestID == request, self.notificationsAuthorizing else { return }
            self.notificationRequestID = UUID()
            self.notificationsAuthorizing = false
            self.notificationTestStatus = "系统通知授权未响应，请检查系统权限提示后重试。"
        }
        Task {
            defer { if notificationRequestID == request { notificationsAuthorizing = false } }
            do {
                let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
                guard notificationRequestID == request else { return }
                notificationsEnabled = allowed
                UserDefaults.standard.set(allowed, forKey: "task-notifications")
                notificationTestStatus = allowed ? "系统通知已允许，可发送测试通知。" : "系统未允许通知，请在系统设置中允许 RemoteCC 通知。"
            } catch {
                if notificationRequestID == request { notificationTestStatus = "通知权限请求失败：" + error.localizedDescription }
            }
        }
    }

    func pickAndUpload(to directory: String? = nil) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK else { return }
        upload(panel.urls, to: directory)
    }

    func pasteImage(_ data: Data) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("screenshot-\(UUID().uuidString).png")
        guard (try? data.write(to: url)) != nil else { return }
        upload([url])
    }

    func download(_ file: String) {
        guard let engine, let session = active else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = (file as NSString).lastPathComponent
        guard panel.runModal() == .OK, let url = panel.url else { return }
        perform { try await engine.files.download(session.config, file, to: url) }
    }

    /// A private copy in the cache, so outside edits never change what the server holds.
    func openLocally(_ file: String) {
        guard let engine, let session = active else { return }
        perform {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent((file as NSString).lastPathComponent)
            try await engine.files.download(session.config, file, to: url)
            NSWorkspace.shared.open(url)
        }
    }

    func shutdown() {
        historyPoll?.cancel()
        engine?.shutdown()
        let connections = self.connections
        let semaphore = DispatchSemaphore(value: 0)
        Task.detached { await connections?.closeAll(); semaphore.signal() }
        _ = semaphore.wait(timeout: .now() + 3)
    }
}
#endif
