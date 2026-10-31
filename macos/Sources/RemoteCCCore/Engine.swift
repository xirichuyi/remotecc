import Foundation

/// Conversations and their remote owners. All state changes happen on the main actor.
@MainActor
public final class ChatEngine {
    public private(set) var sessions: [ChatSession]
    public private(set) var connectionStates: [String: ConnectionState] = [:]
    public let agents: AgentClient
    public let files: RemoteFiles
    /// Fires at most once per frame; the UI reads current state afterwards.
    public var onChange: (() -> Void)?
    public var onError: ((String) -> Void)?

    private let store: ChatStore
    private var running = Set<String>()
    private var watchers: [String: Watcher] = [:]
    private var attaching: [String: Task<Void, Never>] = [:]
    private var installs: [String: Task<Void, Error>] = [:]
    private var capabilityCache: [String: Capabilities] = [:]
    private var capabilityRequests: [String: Task<Capabilities, Error>] = [:]
    private var changeQueued = false
    private var dirty = Set<String>()
    private var saveQueued = false

    private final class Watcher {
        let taskId: String
        var previous: JSON?
        var lastCapabilities: JSON?
        var subscription: AgentChannel.Subscription?
        var killed = false
        init(taskId: String) { self.taskId = taskId }
        func kill() { killed = true; subscription?.kill() }
    }

    public init(store: ChatStore, agents: AgentClient, files: RemoteFiles) throws {
        self.store = store; self.agents = agents; self.files = files
        sessions = try store.load()
        for session in sessions where session.remoteTask != nil { running.insert(session.id) }
    }

    // MARK: Lookup and change tracking

    private func index(_ id: String) throws -> Int {
        guard let index = sessions.firstIndex(where: { $0.id == id }) else { throw RemoteError("会话不存在") }
        return index
    }
    public func session(_ id: String) -> ChatSession? { sessions.first { $0.id == id } }
    public func isRunning(_ id: String) -> Bool { running.contains(id) }

    private func notify() {
        guard !changeQueued else { return }
        changeQueued = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 16_000_000)
            self?.changeQueued = false
            self?.onChange?()
        }
    }

    /// `immediate` is for approvals, turn ends and anything that must survive a crash.
    private func changed(_ id: String?, immediate: Bool = true) {
        if let id { dirty.insert(id) }
        notify()
        if immediate { flushSaves() }
        else if !saveQueued {
            saveQueued = true
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                self?.flushSaves()
            }
        }
    }

    private func flushSaves() {
        saveQueued = false
        store.save(sessions, changed: dirty)
        dirty = []
    }

    public func hydrate(_ id: String) throws {
        let position = try index(id)
        guard sessions[position].localMessagesLoaded == false else { return }
        sessions[position].messages = try store.messages(id)
        sessions[position].localMessagesLoaded = true
        if sessions[position].status == "stopped", let last = sessions[position].messages.indices.last, sessions[position].messages[last].role == "assistant" {
            sessions[position].messages[last].interrupted = true
        }
        notify()
    }

    // MARK: Connection

    public func updateConnection(_ config: ConnectionConfig, _ state: ConnectionState) {
        connectionStates[config.key] = state
        if state.status == .connected { capabilityCache = [:] }
        notify()
    }
    public func connectionState(_ config: ConnectionConfig) -> ConnectionState { connectionStates[config.key] ?? ConnectionState() }

    // MARK: Conversation management

    @discardableResult
    public func create(_ config: ConnectionConfig, name: String = "新对话", preferences: Preferences? = nil) throws -> ChatSession {
        var session = ChatSession(config: try config.validated(), name: name)
        session.preferences = preferences
        sessions.insert(session, at: 0)
        changed(session.id)
        return session
    }

    public func rename(_ id: String, _ name: String) throws {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 80 else { throw RemoteError("名称需为 1–80 个字符") }
        let position = try index(id)
        sessions[position].name = value; sessions[position].localName = true
        changed(id)
    }

    public func remove(_ id: String) async throws {
        guard !running.contains(id) else { throw RemoteError("请先停止当前回复，再删除对话") }
        if sessions[try index(id)].remoteOwner != nil { try await release(id) }
        sessions.removeAll { $0.id == id }
        changed(nil)
    }

    public func setPinned(_ id: String, _ value: Bool) throws {
        sessions[try index(id)].pinned = value
        changed(id)
    }

    public func setArchived(_ id: String, _ value: Bool) throws {
        let position = try index(id)
        if value, running.contains(id) || sessions[position].queue?.isEmpty == false { throw RemoteError("请先完成或取消此会话中的任务") }
        sessions[position].archived = value
        changed(id)
    }

    public func fork(_ id: String) throws -> ChatSession {
        let source = sessions[try index(id)]
        guard !running.contains(id), source.remoteSessionId != nil else { throw RemoteError("请在当前回复完成后分支对话") }
        var session = ChatSession(config: source.config, name: String(source.name.prefix(72)) + " · 分支")
        session.messages = source.messages; session.preferences = source.preferences
        session.remoteSessionId = source.remoteSessionId; session.forkPending = true; session.capabilities = source.capabilities
        sessions.insert(session, at: 0)
        changed(session.id)
        return session
    }

    public func exportMarkdown(_ id: String) throws -> String {
        let session = sessions[try index(id)]
        let body = session.messages.map { message -> String in
            let text = message.text ?? (message.blocks ?? []).filter { $0.type == "text" }.compactMap(\.text).joined(separator: "\n\n")
            return "## " + (message.role == "user" ? "User" : "Claude") + "\n\n" + text
        }
        return "# " + session.name + "\n\n" + body.joined(separator: "\n\n")
    }

    // MARK: Sending

    public func submit(_ id: String, text: String, attachments: [Attachment] = []) throws {
        if running.contains(id) { try enqueue(id, text: text, attachments: attachments) }
        else { try send(id, text: text, attachments: attachments) }
    }

    public func enqueue(_ id: String, text: String, attachments: [Attachment] = []) throws {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!value.isEmpty || !attachments.isEmpty), text.count <= 200_000 else { throw RemoteError("消息不能为空或超过 20 万字符") }
        let position = try index(id)
        guard (sessions[position].queue?.count ?? 0) < 20 else { throw RemoteError("最多排队 20 条消息") }
        sessions[position].queue = (sessions[position].queue ?? []) + [QueuedMessage(id: UUID().uuidString, text: value.isEmpty ? "请查看附件。" : value, attachments: attachments)]
        changed(id)
    }

    public func cancelQueued(_ id: String, item: String) throws {
        let position = try index(id)
        sessions[position].queue?.removeAll { $0.id == item }
        changed(id)
    }

    public func resumeQueue(_ id: String) throws {
        sessions[try index(id)].queuePaused = false
        drainQueue(id)
        changed(id)
    }

    private func drainQueue(_ id: String) {
        guard let position = try? index(id), !running.contains(id), sessions[position].queuePaused != true, let item = sessions[position].queue?.first else { return }
        sessions[position].queue?.removeFirst()
        do { try send(id, text: item.text, attachments: item.attachments) }
        catch {
            sessions[position].queue?.insert(item, at: 0)
            sessions[position].queuePaused = true
            changed(id)
            onError?(error.localizedDescription)
        }
    }

    public func send(_ id: String, text: String, attachments: [Attachment] = []) throws {
        let position = try index(id)
        try hydrate(id)
        guard sessions[position].historyLoaded != false else { throw RemoteError("请先加载此远端会话的历史") }
        guard !running.contains(id) else { throw RemoteError("Claude 正在回复，请先停止或等待完成") }
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!value.isEmpty || !attachments.isEmpty), text.count <= 200_000 else { throw RemoteError("消息不能为空或超过 20 万字符") }
        if value.isEmpty { value = "请查看附件。" }
        sessions[position].archived = false
        if sessions[position].messages.isEmpty, sessions[position].name == "新对话" { sessions[position].name = String(value.prefix(28)) }
        sessions[position].messages.append(ChatMessage(role: "user", text: value, attachments: attachments.isEmpty ? nil : attachments))
        let reply = ChatMessage(role: "assistant", blocks: [])
        sessions[position].messages.append(reply)
        sessions[position].status = "connecting"
        sessions[position].updatedAt = Date().timeIntervalSince1970 * 1000
        sessions[position].queuePaused = sessions[position].queuePaused == true ? false : nil
        running.insert(id)
        let prompt = attachments.isEmpty ? value : value + "\n\n用户附加的远端文件（已上传或在远端选定，可通过 Read 等工具访问，包括图片）：\n" + attachments.map { "- " + JSON.string($0.path).text() }.joined(separator: "\n")
        // Persist identity and request before dispatch: uncertain ACKs reuse this exact task ID.
        let owner = sessions[position].remoteOwner
        sessions[position].remoteTask = RemoteTask(id: owner?.id ?? UUID().uuidString.lowercased(), prompt: prompt, version: -1, submitted: false, messageId: reply.id, continuation: owner != nil)
        changed(id)
        Task { @MainActor [weak self] in
            guard let self else { return }
            if owner != nil { await self.continueTurn(id) } else { await self.attach(id) }
        }
    }

    private func continueTurn(_ id: String) async {
        do {
            await attach(id)
            let position = try index(id)
            guard let task = sessions[position].remoteTask, let messageId = task.messageId, let message = sessions[position].messages.first(where: { $0.id == messageId }) else { return }
            _ = try await command(id, kind: "send", fields: ["prompt": .string(task.prompt ?? ""), "message": try JSON.from(message)], commandId: messageId)
            if let current = try? index(id) { sessions[current].remoteTask?.submitted = true }
            changed(id)
        } catch { dispatchFailed(id, error) }
    }

    private func dispatchFailed(_ id: String, _ error: Error) {
        guard let position = try? index(id) else { return }
        if (error as? RemoteError)?.confirmed != true { detached(id, reason: error.localizedDescription); return }
        guard let task = sessions[position].remoteTask else { return }
        if let target = sessions[position].messages.firstIndex(where: { $0.id == task.messageId }) { sessions[position].messages[target].error = error.localizedDescription }
        sessions[position].remoteTask = nil
        running.remove(id)
        sessions[position].status = "error"; sessions[position].queuePaused = true
        changed(id)
    }

    // MARK: Remote task ownership

    private func ensureInstalled(_ config: ConnectionConfig) async throws {
        let key = config.key
        if installs[key] == nil {
            let agents = self.agents
            installs[key] = Task {
                let digest = agents.resources.bundleDigest
                let status = try await agents.call(config, "task", ["operation": "installed", "digest": .string(digest)])
                if status["installed"]?.isTruthy != true {
                    _ = try await agents.call(config, "task", ["operation": "install", "digest": .string(digest), "payload": .string(agents.resources.bundlePayload)], timeout: 180)
                }
            }
        }
        do { try await installs[key]!.value }
        catch { installs[key] = nil; throw error }
    }

    public func attach(_ id: String) async {
        if let existing = attaching[id] { await existing.value; return }
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            do { try await self.attachOnce(id) }
            catch { self.detached(id, reason: error.localizedDescription) }
        }
        attaching[id] = task
        await task.value
        attaching[id] = nil
    }

    private func attachOnce(_ id: String) async throws {
        try hydrate(id)
        let position = try index(id)
        let session = sessions[position]
        guard session.remoteTask != nil || session.remoteOwner != nil, watchers[id] == nil else { return }
        if session.remoteTask != nil { running.insert(id) }
        try await ensureInstalled(session.config)
        let taskId = session.remoteTask?.id ?? session.remoteOwner!.id
        let messageId = session.remoteTask?.messageId ?? session.remoteOwner?.messageId
        var payload = try JSON.from(session)
        for key in ["remoteTask", "remoteOwner", "capabilities", "localMessagesLoaded"] { payload[key] = nil }
        payload["queue"] = []; payload["permissions"] = []
        let message = session.messages.first { $0.id == messageId } ?? session.messages.last
        payload["messages"] = .array(try message.map { [try JSON.from($0)] } ?? [])
        // start is idempotent, and also resolves a worker crash without re-executing Claude.
        _ = try await agents.call(session.config, "task", ["operation": "start", "taskId": .string(taskId), "digest": .string(agents.resources.bundleDigest),
                                                          "request": ["session": payload, "prompt": .string(session.remoteTask?.prompt ?? "")]])
        let current = try index(id)
        if session.remoteTask?.continuation != true { sessions[current].remoteTask?.submitted = true }
        sessions[current].transportError = nil
        changed(id)
        try await watch(id, taskId: taskId, config: session.config)
    }

    private func watch(_ id: String, taskId: String, config: ConnectionConfig) async throws {
        let watcher = Watcher(taskId: taskId)
        watchers[id] = watcher
        let channel = try await agents.channel(config)
        watcher.subscription = channel.watchTask(taskId, packet: { [weak self] packet in
            Task { @MainActor [weak self] in self?.received(packet, id: id, watcher: watcher) }
        }, end: { [weak self] reason in
            Task { @MainActor [weak self] in self?.watchEnded(id, watcher: watcher, reason: reason) }
        })
        if watcher.killed { watcher.subscription?.kill() }
    }

    private func currentOwnerId(_ id: String) -> String? {
        guard let session = session(id) else { return nil }
        return session.remoteOwner?.id ?? session.remoteTask?.id
    }

    private func received(_ packet: JSON, id: String, watcher: Watcher) {
        guard watchers[id] === watcher, currentOwnerId(id) == watcher.taskId, packet["heartbeat"]?.isTruthy != true else { return }
        do {
            let state = try applyStateDelta(watcher.previous, packet)
            watcher.previous = state
            try apply(id, state: state, watcher: watcher)
        } catch {
            watcher.kill()
            watchers[id] = nil
            detached(id, reason: error.localizedDescription)
        }
    }

    private func watchEnded(_ id: String, watcher: Watcher, reason: String) {
        guard watchers[id] === watcher else { return }
        watchers[id] = nil
        if currentOwnerId(id) == watcher.taskId { detached(id, reason: reason) }
    }

    /// Exposed for tests; applies one complete remote snapshot.
    func apply(_ id: String, state: JSON, watcher: AnyObject? = nil) throws {
        let position = try index(id)
        let task = sessions[position].remoteTask
        guard let ownerVersion = sessions[position].remoteOwner?.version ?? task?.version else { return }
        let ownerId = sessions[position].remoteOwner?.id ?? task?.id ?? ""
        let version = state["version"]?.int ?? 0
        guard version >= ownerVersion else { return }
        let done = state["done"]?.isTruthy == true
        let status = state["status"]?.string ?? "working"
        let messageId = state["message"]?["id"]?.string
        // A queued new turn must not be overwritten by the previous turn's idle snapshot.
        if let task, messageId != task.messageId {
            if done {
                if let target = sessions[position].messages.firstIndex(where: { $0.id == task.messageId }) {
                    sessions[position].messages[target].error = "远端会话已退出，新消息未执行。请重新发送。"
                }
                sessions[position].status = "error"; sessions[position].queuePaused = true
                sessions[position].remoteTask = nil; sessions[position].remoteOwner = nil
                running.remove(id)
                watchers[id]?.kill(); watchers[id] = nil
                changed(id)
            }
            return
        }
        guard let target = sessions[position].messages.firstIndex(where: { $0.id == messageId }), let message = state["message"] else { throw RemoteError("远端任务与本地消息不匹配") }
        sessions[position].messages[target] = try message.decode(ChatMessage.self)
        sessions[position].status = status
        sessions[position].permissions = (try? state["permissions"]?.decode([PermissionRequest].self)) ?? []
        if let value = state["remoteSessionId"]?.string { sessions[position].remoteSessionId = value }
        if let value = state["model"]?.string { sessions[position].model = value }
        if let value = state["preferences"], let decoded = try? value.decode(Preferences.self) { sessions[position].preferences = decoded }
        // The catalogue rarely changes and is large, so it is only decoded when it differs.
        let local = watcher as? Watcher ?? watchers[id]
        if let value = state["capabilities"], local?.lastCapabilities != value {
            local?.lastCapabilities = value
            if let decoded = try? value.decode(Capabilities.self) { sessions[position].capabilities = decoded }
        }
        if let value = state["usage"] { sessions[position].usage = value }
        if let value = state["tasks"] { sessions[position].tasks = value }
        if let value = state["tools"] { sessions[position].tools = value }
        if let value = state["plugins"] { sessions[position].plugins = value }
        sessions[position].forkPending = state["forkPending"]?.bool
        if task != nil { sessions[position].remoteTask?.version = version }
        else { sessions[position].remoteOwner?.version = version }
        if state["resident"]?.isTruthy == true, !done {
            sessions[position].remoteOwner = RemoteOwner(id: ownerId, version: version, messageId: messageId)
        }
        let turnEnded = done || ["idle", "stopped", "error"].contains(status)
        if turnEnded {
            sessions[position].remoteTask = nil
            running.remove(id)
            if status != "idle" { sessions[position].queuePaused = true }
        }
        if done {
            watchers[id]?.kill(); watchers[id] = nil
            sessions[position].remoteOwner = nil
            let config = sessions[position].config, agents = self.agents
            Task { _ = try? await agents.call(config, "task", ["operation": "acknowledge", "taskId": .string(ownerId)]) }
        }
        sessions[position].transportError = nil
        changed(id, immediate: turnEnded || !sessions[position].permissions.isEmpty)
        if turnEnded, task != nil, sessions[position].queuePaused != true { drainQueue(id) }
    }

    private func detached(_ id: String, reason: String = "") {
        guard let position = try? index(id), sessions[position].remoteTask != nil || sessions[position].remoteOwner != nil else { return }
        if sessions[position].remoteTask != nil { sessions[position].status = "detached" }
        sessions[position].transportError = reason.isEmpty ? nil : reason
        sessions[position].queuePaused = true
        changed(id)
    }

    private func command(_ id: String, kind: String, fields: [String: JSON] = [:], commandId: String = UUID().uuidString.lowercased()) async throws -> JSON {
        let session = sessions[try index(id)]
        guard let owner = session.remoteOwner?.id ?? session.remoteTask?.id else { throw RemoteError("远端会话已经结束") }
        var command = fields
        command["kind"] = .string(kind)
        let wait = session.remoteOwner != nil || kind == "control" || kind == "send"
        let response = try await agents.call(session.config, "task", ["operation": "command", "taskId": .string(owner), "commandId": .string(commandId), "command": .object(command), "wait": .bool(wait)], timeout: 60)
        if response["ok"]?.bool == false {
            throw RemoteError(response["error"]?.string ?? "远端操作失败", confirmed: response["uncertain"]?.isTruthy != true)
        }
        return response["value"] ?? .null
    }

    private func control(_ id: String, action: String, value: JSON = .null) async throws -> JSON {
        await attach(id)
        return try await command(id, kind: "control", fields: ["action": .string(action), "value": value])
    }

    private func release(_ id: String) async throws {
        guard sessions[try index(id)].remoteOwner != nil else { return }
        guard sessions[try index(id)].remoteTask == nil else { throw RemoteError("请等待当前回复完成") }
        _ = try await command(id, kind: "close")
        watchers[id]?.kill(); watchers[id] = nil
        sessions[try index(id)].remoteOwner = nil
        changed(id)
    }

    /// Rejoins tasks after connecting. Nothing is re-executed: start is idempotent per task ID.
    public func restore(_ config: ConnectionConfig) async {
        let ids = sessions.filter { $0.config.key == config.key && ($0.remoteTask != nil || $0.remoteOwner != nil) }.map(\.id)
        await withTaskGroup(of: Void.self) { group in
            for id in ids {
                group.addTask { @MainActor [weak self] in
                    guard let self, let session = self.session(id) else { return }
                    if session.remoteTask?.continuation == true, session.remoteTask?.submitted != true { await self.continueTurn(id) }
                    else { await self.attach(id) }
                }
            }
        }
    }

    public func detach(_ config: ConnectionConfig? = nil) {
        for session in sessions where (session.remoteTask != nil || session.remoteOwner != nil) && (config == nil || session.config.key == config!.key) {
            watchers[session.id]?.kill(); watchers[session.id] = nil
            detached(session.id)
        }
    }

    public func stop(_ id: String) async throws {
        guard sessions[try index(id)].remoteTask != nil else { return }
        _ = try await command(id, kind: "stop")
    }

    /// Worker validates the answer; a rejected form comes back as an error here.
    public func respond(_ id: String, permission: String, answer: JSON) async throws {
        let session = sessions[try index(id)]
        guard session.permissions.contains(where: { $0.id == permission }) else { throw RemoteError("该请求已结束") }
        _ = try await command(id, kind: "respond", fields: ["permissionId": .string(permission), "answer": answer])
    }

    // MARK: Capabilities and settings

    private func inspect(_ session: ChatSession, action: String, value: JSON = .null) async throws -> JSON {
        try await ensureInstalled(session.config)
        return try await agents.call(session.config, "task", ["operation": "inspect", "digest": .string(agents.resources.bundleDigest), "action": .string(action), "value": value,
                                                              "directory": .string(session.directory), "preferences": try JSON.from(session.preferences ?? Preferences())], timeout: 60)
    }

    @discardableResult
    public func capabilities(_ id: String, refresh: Bool = false) async throws -> Capabilities {
        let session = sessions[try index(id)]
        if session.remoteOwner != nil {
            let result = try await control(id, action: "catalogue").decode(Capabilities.self)
            sessions[try index(id)].capabilities = result
            changed(id)
            return result
        }
        let key = [session.config.key, session.directory, (try? JSON.from(session.preferences ?? Preferences()).text()) ?? ""].joined(separator: "|")
        if !refresh, let cached = capabilityCache[key], Date().timeIntervalSince1970 * 1000 - (cached.fetchedAt ?? 0) < 300_000 {
            if session.capabilities != cached { sessions[try index(id)].capabilities = cached; changed(id) }
            return cached
        }
        let task = capabilityRequests[key] ?? Task { [weak self] in
            guard let self else { throw RemoteError("客户端已关闭") }
            return try await self.inspect(session, action: "catalogue").decode(Capabilities.self)
        }
        capabilityRequests[key] = task
        defer { capabilityRequests[key] = nil }
        let result = try await task.value
        capabilityCache[key] = result
        sessions[try index(id)].capabilities = result
        changed(id)
        return result
    }

    public func selectModel(_ id: String, _ value: String) async throws {
        let session = sessions[try index(id)]
        if running.contains(id), session.remoteOwner == nil { throw RemoteError("请等待远端会话连接完成") }
        let selected = value == "default" ? "" : value
        guard selected.isEmpty || selected.range(of: "^[a-zA-Z0-9][a-zA-Z0-9._:/\\[\\]-]{0,199}$", options: .regularExpression) != nil else { throw RemoteError("无效模型 ID") }
        if session.remoteOwner != nil {
            _ = try await control(id, action: "model", value: .string(selected))
            setPreference(id) { $0.selectedModel = selected }
            return
        }
        let caps = try await capabilities(id)
        _ = try await inspect(session, action: "model", value: .string(selected))
        let model = caps.models.first { $0.value == (selected.isEmpty ? "default" : selected) || $0.resolvedModel == selected }
        setPreference(id) { preferences in
            preferences.selectedModel = selected
            guard let model else { return }
            if let effort = preferences.effort, !effort.isEmpty, model.supportedEffortLevels?.contains(effort) != true { preferences.effort = "" }
            if preferences.fastMode == true, model.supportsFastMode != true { preferences.fastMode = false }
            if preferences.permissionMode == "auto", model.supportsAutoMode != true { preferences.permissionMode = "default" }
        }
    }

    public func selectEffort(_ id: String, _ value: String) async throws {
        let effort = value == "auto" ? "" : value
        guard ["", "low", "medium", "high", "xhigh", "max"].contains(effort) else { throw RemoteError("无效思考强度") }
        let session = sessions[try index(id)]
        if running.contains(id), session.remoteOwner == nil { throw RemoteError("请等待远端会话连接完成") }
        if session.remoteOwner != nil {
            _ = try await control(id, action: "effort", value: .string(effort))
        } else {
            let caps = try await capabilities(id)
            let model = caps.models.first { $0.value == (session.preferences?.selectedModel.flatMap { $0.isEmpty ? nil : $0 } ?? "default") }
            if !effort.isEmpty, let model, model.supportedEffortLevels?.contains(effort) != true { throw RemoteError("当前模型不支持此思考强度") }
            _ = try await inspect(session, action: "effort", value: .string(effort))
        }
        setPreference(id) { $0.effort = effort }
    }

    private func setPreference(_ id: String, _ update: (inout Preferences) -> Void) {
        guard let position = try? index(id) else { return }
        var preferences = sessions[position].preferences ?? Preferences()
        update(&preferences)
        sessions[position].preferences = preferences
        changed(id)
    }

    /// Live settings go to the running session and only stick once it confirms them.
    public func configure(_ id: String, _ next: Preferences) async throws {
        let position = try index(id)
        let session = sessions[position]
        let current = session.preferences ?? Preferences()
        for folder in next.additionalDirectories ?? [] where !folder.hasPrefix("/") { throw RemoteError("额外目录必须为远端绝对路径") }
        if (next.agent ?? "") != (current.agent ?? ""), !session.messages.isEmpty { throw RemoteError("请在新对话中选择 Agent，已有会话保留原生上下文") }
        let model = session.capabilities?.models.first { $0.value == (next.selectedModel.flatMap { $0.isEmpty ? nil : $0 } ?? "default") || $0.resolvedModel == next.selectedModel }
        if let model {
            if let effort = next.effort, !effort.isEmpty, model.supportedEffortLevels?.contains(effort) != true { throw RemoteError("此模型不支持选定的思考强度，请先设为自动") }
            if next.fastMode == true, model.supportsFastMode != true { throw RemoteError("此模型不支持快速模式，请先关闭快速模式") }
            if next.permissionMode == "auto", model.supportsAutoMode != true { throw RemoteError("此模型不支持自动权限模式") }
        }
        var patch: [String: JSON] = [:]
        if (next.selectedModel ?? "") != (current.selectedModel ?? "") { patch["selectedModel"] = .string(next.selectedModel ?? "") }
        if (next.effort ?? "") != (current.effort ?? "") { patch["effort"] = .string(next.effort ?? "") }
        if (next.permissionMode ?? "default") != (current.permissionMode ?? "default") { patch["permissionMode"] = .string(next.permissionMode ?? "default") }
        if (next.fastMode ?? false) != (current.fastMode ?? false) { patch["fastMode"] = .bool(next.fastMode ?? false) }
        if (next.outputStyle ?? "") != (current.outputStyle ?? "") { patch["outputStyle"] = .string(next.outputStyle ?? "") }
        let startup = (next.additionalDirectories ?? []) != (current.additionalDirectories ?? []) || (next.agent ?? "") != (current.agent ?? "")
        if running.contains(id), session.remoteOwner == nil || startup { throw RemoteError("请等待当前回复完成后切换设置") }
        if session.remoteOwner != nil {
            if startup { try await release(id) }
            else if !patch.isEmpty {
                let confirmed = try await control(id, action: "configure", value: .object(patch)).decode(Preferences.self)
                sessions[try index(id)].preferences = confirmed
                changed(id)
                return
            } else { return }
        }
        sessions[try index(id)].preferences = next
        changed(id)
    }

    public func details(_ id: String, section: String) async throws -> JSON {
        let session = sessions[try index(id)]
        switch section {
        case "status":
            return ["host": .string(session.host), "directory": .string(session.directory), "sessionId": session.remoteSessionId.map(JSON.string) ?? .null, "model": session.model.map(JSON.string) ?? .null,
                    "version": session.capabilities?.version.map(JSON.string) ?? .null, "tools": session.tools ?? [], "plugins": session.plugins ?? []]
        case "cost": return session.usage ?? ["message": "尚无用量数据"]
        case "tasks": return session.tasks ?? []
        case "skills": return try JSON.from(try await capabilities(id).commands.filter { $0.builtin != true })
        case "agents": return try JSON.from(try await capabilities(id).agents ?? [])
        default:
            return session.remoteOwner != nil ? try await control(id, action: section) : try await inspect(session, action: section)
        }
    }

    // MARK: Remote history

    public func discoverHistory(_ config: ConnectionConfig) async throws -> (count: Int, total: Int, unreadable: Int) {
        var offset: JSON = 0, count = 0, total = 0, unreadable = 0
        while true {
            let result = try await agents.call(config, "history", ["operation": "list", "offset": offset])
            for item in result["sessions"]?.array ?? [] {
                guard let sessionId = item["sessionId"]?.string else { continue }
                let name = item["name"]?.string ?? ""
                let shortName = name.isEmpty ? "远端会话" : String(name.prefix(80))
                if let position = sessions.firstIndex(where: { $0.remoteSessionId == sessionId && $0.config.key == config.key && $0.forkPending != true }) {
                    sessions[position].remoteHistoryRef = item["reference"]?.string
                    sessions[position].historySummary = name
                    if sessions[position].historyLoaded == false {
                        sessions[position].updatedAt = item["updatedAt"]?.double ?? sessions[position].updatedAt
                        if sessions[position].localName != true { sessions[position].name = shortName }
                        if let directory = item["directory"]?.string, !directory.isEmpty { sessions[position].directory = directory }
                    }
                } else {
                    let directory = item["directory"]?.string ?? ""
                    var session = ChatSession(config: ConnectionConfig(host: config.host, port: config.port, directory: directory.isEmpty ? "~" : directory), name: shortName)
                    session.remoteSessionId = sessionId; session.remoteHistoryRef = item["reference"]?.string
                    session.historyLoaded = false; session.historySummary = name
                    session.updatedAt = item["updatedAt"]?.double ?? session.updatedAt
                    sessions.append(session)
                }
                count += 1
            }
            total = result["total"]?.int ?? count
            unreadable += result["unreadable"]?.array?.count ?? 0
            notify()
            guard let next = result["nextOffset"]?.string else { break }
            offset = .string(next)
        }
        store.save(sessions, changed: [])
        return (count, total, unreadable)
    }

    public func loadHistory(_ id: String, older: Bool = false) async throws {
        try hydrate(id)
        let session = sessions[try index(id)]
        guard let reference = session.remoteHistoryRef, older || session.historyLoaded == false else { return }
        guard !running.contains(id) else { throw RemoteError("请等待当前回复完成后加载历史") }
        if older && session.historyBefore == nil { return }
        var request: JSON = ["operation": "messages", "reference": .string(reference)]
        if older, let before = session.historyBefore { request["before"] = .string(before) }
        let page = try await agents.call(session.config, "history", request)
        guard let directory = page["directory"]?.string, directory.hasPrefix("/") else { throw RemoteError("历史中缺少工作目录，无法安全续接此会话") }
        let position = try index(id)
        let existing = Set(sessions[position].messages.map(\.id))
        sessions[position].messages = historyMessages(page["records"]?.array ?? []).filter { !existing.contains($0.id) } + sessions[position].messages
        sessions[position].directory = directory
        sessions[position].historyLoaded = true
        sessions[position].historyBefore = page["before"]?.string
        changed(id)
    }

    public func shutdown() {
        detach()
        flushSaves()
        store.flush()
    }
}
