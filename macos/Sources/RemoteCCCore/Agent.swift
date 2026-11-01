import Foundation

/// Files built from `src/` by scripts/prepare-server.cjs and shipped inside the app.
public struct ServerResources: Sendable {
    public let agentSource: Data
    public let agentDigest: String
    public let bundleDigest: String
    public let bundlePayload: String

    public init(directory: URL) throws {
        agentSource = try Data(contentsOf: directory.appendingPathComponent("remote-agent.cjs"))
        let manifest = try JSON.parse(try Data(contentsOf: directory.appendingPathComponent("manifest.json")))
        guard let agent = manifest["agentDigest"]?.string, let digest = manifest["bundleDigest"]?.string, let payload = manifest["bundlePayload"]?.string else {
            throw RemoteError("应用内的服务端程序不完整，请重新构建")
        }
        agentDigest = agent; bundleDigest = digest; bundlePayload = payload
    }
}

/// One persistent SSH channel to remote-agent.cjs, multiplexing every small request.
public final class AgentChannel: @unchecked Sendable {
    private struct Pending { let continuation: CheckedContinuation<JSON, Error> }
    public struct Subscription: Sendable {
        let cancel: @Sendable () -> Void
        public func kill() { cancel() }
    }
    private struct Watch { let packet: @Sendable (JSON) -> Void; let end: @Sendable (String) -> Void }

    private let lock = NSLock()
    private let launcher: RemoteLauncher
    private let config: ConnectionConfig
    private let resources: ServerResources
    private var child: RemoteProcess?
    private var pending: [Int: Pending] = [:]
    private var subscriptions: [String: Watch] = [:]
    private var sequence = 0
    private var closed = false
    public private(set) var info: ServerInfo?
    var onFileChange: (@Sendable ([String]) -> Void)?
    var onClosed: (@Sendable () -> Void)?

    init(launcher: RemoteLauncher, config: ConnectionConfig, resources: ServerResources) {
        self.launcher = launcher; self.config = config; self.resources = resources
    }

    private var agentFile: String { "$HOME/.local/share/remotecc/agent/\(resources.agentDigest)/remote-agent.cjs" }

    // Non-interactive login shells often miss nvm/fnm/volta, so look there before giving up on node.
    private var bootstrap: String {
        """
        A="\(agentFile)"
        if ! command -v node >/dev/null 2>&1; then
          for N in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node "$HOME"/.fnm/node-versions/*/installation/bin/node "$HOME"/.volta/bin/node "$HOME"/.asdf/shims/node /usr/local/bin/node /opt/homebrew/bin/node; do
            [ -x "$N" ] && PATH="$(dirname "$N"):$PATH"
          done
        fi
        PATH="$PATH:$HOME/.local/bin:$HOME/.claude/local:$HOME/.npm-global/bin"
        export PATH
        command -v node >/dev/null 2>&1 || { echo __RCC_NO_NODE__; exit 0; }
        [ -f "$A" ] || { echo __RCC_INSTALL__; exit 0; }
        exec node "$A"
        """
    }

    // The outer `sh -c` keeps this valid when the account's login shell is fish or csh.
    private var startCommand: String {
        "sh -c " + shellQuote("if command -v bash >/dev/null 2>&1; then exec bash -lc \(shellQuote(bootstrap)); else exec sh -lc \(shellQuote(bootstrap)); fi")
    }

    private var installCommand: String {
        "sh -c " + shellQuote("D=\"$(dirname \"\(agentFile)\")\"; T=\"$D/.install.$$\"; mkdir -p \"$D\" && chmod 700 \"$D\" && cat > \"$T\" && [ \"$(wc -c < \"$T\" | tr -d ' ')\" = \"\(resources.agentSource.count)\" ] && mv \"$T\" \"\(agentFile)\" || { rm -f \"$T\"; echo \"无法写入远端代理程序\" >&2; exit 1; }")
    }

    func start() async throws {
        var outcome = try await launch()
        if outcome == "install" {
            try await install()
            outcome = try await launch()
        }
        guard outcome == "ready" else { throw RemoteError("远端代理启动失败") }
        let hello = try await call("file", ["operation": "hello"])
        let server = try hello.decode(ServerInfo.self)
        guard server.nodeSupported else {
            close()
            throw RemoteError("服务器 Node.js 版本过低（\(server.node ?? "未知")），需要 18.14 或更高版本")
        }
        lock.withLock { info = server }
    }

    private final class LaunchState: @unchecked Sendable {
        let lock = NSLock()
        var continuation: CheckedContinuation<String, Error>?
        var buffer = LineBuffer()
        var ready = false
        func settle(_ result: Result<String, Error>) {
            lock.lock(); let waiting = continuation; continuation = nil; lock.unlock()
            waiting?.resume(with: result)
        }
    }

    private func launch() async throws -> String {
        let process = try launcher.spawn(config, command: startCommand)
        let state = LaunchState()
        return try await withCheckedThrowingContinuation { continuation in
            state.continuation = continuation
            let timer = DispatchWorkItem { state.settle(.failure(RemoteError("远端代理启动超时"))); process.kill() }
            DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: timer)
            process.readOutput(chunk: { [weak self] data in
                var lines: [Data] = []
                state.buffer.append(data) { lines.append(Data($0)) }
                for line in lines {
                    if state.ready {
                        if line.first == UInt8(ascii: "{") { self?.receive(line) }
                        continue
                    }
                    // Profile scripts may print anything; ignore lines until the handshake.
                    let text = String(decoding: line, as: UTF8.self)
                    if text == "__RCC_INSTALL__" { timer.cancel(); state.settle(.success("install")) }
                    else if text == "__RCC_NO_NODE__" { timer.cancel(); state.settle(.failure(RemoteError("服务器未找到 Node.js。Claude 控制通道需要 Node.js 18.14 或更高版本，请先在服务器上安装。"))) }
                    else if text.hasPrefix("{\"rcc\":\"ready\"") {
                        state.ready = true
                        self?.setChild(process)
                        timer.cancel(); state.settle(.success("ready"))
                    }
                }
            }, done: { [weak self] in
                timer.cancel()
                Task {
                    _ = await process.waitForExit()
                    let reason = process.stderrText
                    state.settle(.failure(RemoteError(reason.isEmpty ? "远端代理已退出" : reason)))
                    // The install probe exits by design; only losing a running agent ends the channel.
                    if state.ready { self?.shutdown(reason.isEmpty ? "SSH 通道已断开" : reason) }
                }
            })
        }
    }

    private func setChild(_ process: RemoteProcess) { lock.lock(); child = process; lock.unlock() }

    private func install() async throws {
        let process = try launcher.spawn(config, command: installCommand)
        process.readOutput(chunk: { _ in }, done: {})
        process.write(resources.agentSource)
        process.closeInput()
        if await process.waitForExit() != 0 { throw RemoteError(process.stderrText.isEmpty ? "无法安装远端代理" : process.stderrText) }
    }

    private func receive(_ line: Data) {
        guard let message = try? JSON.parse(line) else { return }
        if message["event"]?.string == "fs" {
            onFileChange?((message["directories"]?.array ?? []).compactMap(\.string))
            return
        }
        if let subscription = message["sub"]?.string {
            lock.lock()
            let watch = subscriptions[subscription]
            let ended = message["end"]?.isTruthy == true
            if ended { subscriptions[subscription] = nil }
            lock.unlock()
            if ended { watch?.end(message["error"]?.string ?? "") }
            else if let packet = message["packet"] { watch?.packet(packet) }
            return
        }
        guard let id = message["id"]?.int else { return }
        lock.lock()
        let request = pending.removeValue(forKey: id)
        lock.unlock()
        if let error = message["error"]?.string { request?.continuation.resume(throwing: RemoteError(error)) }
        else { request?.continuation.resume(returning: message["result"] ?? .null) }
    }

    private func write(_ value: JSON) {
        lock.lock(); let process = child; lock.unlock()
        guard var data = try? value.data() else { return }
        data.append(10)
        process?.write(data)
    }

    public func call(_ op: String, _ params: JSON, timeout: TimeInterval = 60) async throws -> JSON {
        let id: Int = { lock.lock(); defer { lock.unlock() }; sequence += 1; return sequence }()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<JSON, Error>) in
                lock.lock()
                if closed || Task.isCancelled {
                    lock.unlock()
                    continuation.resume(throwing: RemoteError(closed ? "SSH 通道已断开" : "请求已取消"))
                    return
                }
                pending[id] = Pending(continuation: continuation)
                lock.unlock()
                write(["id": .number(Double(id)), "op": .string(op), "params": params])
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in self?.fail(id, "远端操作超时") }
            }
        } onCancel: { self.fail(id, "请求已取消") }
    }

    private func fail(_ id: Int, _ reason: String) {
        lock.lock()
        let request = pending.removeValue(forKey: id)
        lock.unlock()
        guard let request else { return }
        write(["cancel": .number(Double(id))])
        request.continuation.resume(throwing: RemoteError(reason))
    }

    public func watchTask(_ taskId: String, packet: @escaping @Sendable (JSON) -> Void, end: @escaping @Sendable (String) -> Void) -> Subscription {
        let subscription = UUID().uuidString.lowercased()
        let id: Int = {
            lock.lock(); defer { lock.unlock() }
            subscriptions[subscription] = Watch(packet: packet, end: end)
            sequence += 1
            return sequence
        }()
        write(["id": .number(Double(id)), "op": "taskWatch", "params": ["taskId": .string(taskId), "subscription": .string(subscription)]])
        return Subscription { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let existed = self.subscriptions.removeValue(forKey: subscription) != nil
            self.lock.unlock()
            if existed { self.write(["cancel": .string("sub:" + subscription)]) }
        }
    }

    private func shutdown(_ reason: String) {
        lock.lock()
        if closed { lock.unlock(); return }
        closed = true
        let requests = pending; pending = [:]
        let watches = subscriptions; subscriptions = [:]
        lock.unlock()
        for request in requests.values { request.continuation.resume(throwing: RemoteError(reason)) }
        for watch in watches.values { watch.end(reason) }
        onClosed?()
    }

    public func close() {
        lock.lock(); let process = child; lock.unlock()
        process?.kill()
        shutdown("SSH 通道已关闭")
    }
}

/// Owns one channel per server and restarts it on the next request after it closes.
public final class AgentClient: @unchecked Sendable {
    private let lock = NSLock()
    private struct ChannelEntry {
        let identity: UUID
        let task: Task<AgentChannel, Error>
    }
    private var channels: [String: ChannelEntry] = [:]
    public let launcher: RemoteLauncher
    public let resources: ServerResources
    public var onFileChange: (@Sendable (ConnectionConfig, [String]) -> Void)?

    public init(launcher: RemoteLauncher, resources: ServerResources) { self.launcher = launcher; self.resources = resources }

    public func channel(_ config: ConnectionConfig) async throws -> AgentChannel {
        let key = config.key
        let task = lock.withLock { () -> Task<AgentChannel, Error> in
            if let existing = channels[key] { return existing.task }
            let identity = UUID()
            let task = Task<AgentChannel, Error> { [weak self] in
                guard let self else { throw RemoteError("客户端已关闭") }
                let channel = AgentChannel(launcher: self.launcher, config: config, resources: self.resources)
                channel.onFileChange = { [weak self] directories in self?.onFileChange?(config, directories) }
                channel.onClosed = { [weak self] in self?.forget(key, identity: identity) }
                do { try await channel.start(); return channel }
                catch { self.forget(key, identity: identity); throw error }
            }
            channels[key] = ChannelEntry(identity: identity, task: task)
            return task
        }
        return try await task.value
    }

    private func forget(_ key: String, identity: UUID) {
        lock.withLock {
            // An old channel's delayed EOF must not evict the already reconnected channel.
            if channels[key]?.identity == identity { channels[key] = nil }
        }
    }

    public func call(_ config: ConnectionConfig, _ op: String, _ params: JSON, timeout: TimeInterval = 60) async throws -> JSON {
        try await channel(config).call(op, params, timeout: timeout)
    }

    public func info(_ config: ConnectionConfig) async throws -> ServerInfo {
        guard let info = try await channel(config).info else { throw RemoteError("远端代理未就绪") }
        return info
    }

    /// Bulk data gets its own SSH channel, so the mux shares bandwidth fairly with the control channel.
    public func spawnTransfer(_ config: ConnectionConfig, request: JSON) async throws -> RemoteProcess {
        let info = try await info(config)
        return try launcher.spawn(config, command: "\(shellQuote(info.nodePath)) \(shellQuote(info.agentPath)) transfer \(shellQuote(request.text()))")
    }

    public func close(_ config: ConnectionConfig) {
        let task = lock.withLock { channels.removeValue(forKey: config.key)?.task }
        guard let task else { return }
        Task { (try? await task.value)?.close() }
    }
}
