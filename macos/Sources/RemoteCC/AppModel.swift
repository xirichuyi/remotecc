#if canImport(SwiftUI)
import SwiftUI
import AppKit
import UniformTypeIdentifiers
import RemoteCCCore

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

    @Published var activeId: String?
    @Published var showArchived = false
    @Published var searchText = ""
    @Published var toast: String?
    @Published var panel: SidePanel = .files
    @Published var showFiles = true
    @Published var showConnect = false
    @Published var showPreferences = false
    @Published var showQuickOpen = false
    @Published var showSessionTools = false
    @Published var historyStatus = ""
    @Published var transferStatus = ""
    @Published var drafts: [String: String] = [:]
    @Published var attachments: [String: [Attachment]] = [:]
    @Published var commandPicker: CommandInteraction?
    @Published var fatalError: String?

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
                    if let error = progress.error { self.transferStatus = "\(progress.name) · 失败：\(error)" }
                    else if progress.finished { self.transferStatus = "\(progress.name) · 完成" }
                    else { self.transferStatus = "\(progress.name) · \(progress.total > 0 ? min(99, progress.bytes * 100 / progress.total) : 0)%" }
                }
            }
            activeId = sortedSessions.first?.id
            if let activeId { select(activeId) }
            autoConnect()
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
    var currentConfig: ConnectionConfig? { active?.config ?? lastConnection }
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
        Task { try? await connect(config) }
    }

    func connect(_ input: ConnectionConfig) async throws {
        guard let engine, let connections else { return }
        let config = try input.validated()
        try await connections.connect(config)
        let info = try await engine.agents.info(config)
        var target = config
        if target.directory.isEmpty { target.directory = info.home }
        lastConnection = target
        if info.claude == nil { show("已连接，但服务器上未找到 claude 命令，聊天不可用。文件功能不受影响。") }
        if let current = active, current.config == target {} else {
            let session = try engine.create(target)
            select(session.id)
        }
        await activeWorkspace?.browse(active?.directory ?? target.directory)
        refreshCapabilities()
        Task { await engine.restore(target) }
        Task { await discoverHistory(target) }
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
        engine.files.invalidate()
        await engine.restore(config)
        if active?.config.key == config.key { await activeWorkspace?.reload(force: true) }
    }

    private func filesChanged(_ config: ConnectionConfig, _ directories: [String]) {
        guard let active, active.config.key == config.key else { return }
        Task { await workspace(for: active)?.filesChanged(directories) }
    }

    func discoverHistory(_ config: ConnectionConfig) async {
        guard let engine else { return }
        historyStatus = "读取远端会话…"
        do {
            let result = try await engine.discoverHistory(config)
            historyStatus = "\(config.host) · \(result.count) 条远端会话" + (result.unreadable > 0 ? " · \(result.unreadable) 条不可读" : "")
        } catch { historyStatus = "历史读取失败"; show(error.localizedDescription) }
    }

    // MARK: Conversations

    func select(_ id: String) {
        guard let engine else { return }
        activeId = id
        do { try engine.hydrate(id) } catch { show(error.localizedDescription) }
        guard let session = engine.session(id) else { return }
        if session.historyLoaded == false { perform { try await engine.loadHistory(id) } }
        if engine.connectionState(session.config).status == .connected {
            let workspace = workspace(for: session)
            if workspace?.root == nil { Task { await workspace?.browse(session.directory) } }
            refreshCapabilities()
        }
    }

    func newConversation() {
        guard let engine else { return }
        guard let config = currentConfig, isConnected else { showConnect = true; return }
        perform {
            let session = try engine.create(config, preferences: self.active?.preferences)
            self.select(session.id)
        }
    }

    func newConversation(in source: ChatSession) {
        guard let engine else { return }
        perform { self.select(try engine.create(source.config).id) }
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
        guard let engine, let id = activeId else { showConnect = !isConnected; return }
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
        guard let engine, let session = active, isConnected else { show("请先连接 SSH"); return }
        guard urls.count <= 20 else { show("一次最多上传 20 个文件"); return }
        let target = directory ?? session.directory
        perform {
            for url in urls {
                do { self.addAttachments([try await engine.files.upload(session.config, file: url, directory: target)], to: session.id) }
                catch { self.show(url.lastPathComponent + ": " + error.localizedDescription) }
            }
            await self.workspace(for: session)?.reload(force: true)
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
        engine?.shutdown()
        let connections = self.connections
        let semaphore = DispatchSemaphore(value: 0)
        Task.detached { await connections?.closeAll(); semaphore.signal() }
        _ = semaphore.wait(timeout: .now() + 3)
    }
}
#endif
