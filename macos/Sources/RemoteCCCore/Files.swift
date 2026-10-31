import Foundation

public struct TransferProgress: Sendable {
    public var name: String
    public var bytes: Int
    public var total: Int
    public var finished: Bool
    public var error: String?
}

/// Stable file name for a cache key; collisions only mean a re-download check by version.
private func cacheName(_ key: String) -> String {
    var first: UInt64 = 0xcbf29ce484222325, second: UInt64 = 0x84222325cbf29ce4
    for byte in key.utf8 {
        first = (first ^ UInt64(byte)) &* 0x100000001b3
        second = (second &+ UInt64(byte)) &* 0x100000001b3
    }
    return String(first, radix: 16) + String(second, radix: 16)
}

public final class RemoteFiles: @unchecked Sendable {
    private let agents: AgentClient
    private let cacheDirectory: URL
    private let cacheLimit: Int
    private let lock = NSLock()
    private var previews: [String: FilePreview] = [:]
    private var listings: [String: (time: Date, value: DirectoryListing)] = [:]
    public var onProgress: (@Sendable (TransferProgress) -> Void)?

    public init(agents: AgentClient, cacheDirectory: URL, cacheLimit: Int = 256 * 1024 * 1024) {
        self.agents = agents; self.cacheDirectory = cacheDirectory; self.cacheLimit = cacheLimit
    }

    public func run(_ config: ConnectionConfig, _ operation: String, _ params: [String: JSON] = [:], timeout: TimeInterval = 45) async throws -> JSON {
        var request = params
        request["operation"] = .string(operation)
        request["base"] = .string(config.directory)
        return try await agents.call(config, "file", .object(request), timeout: timeout)
    }

    public func invalidate() { lock.withLock { listings = [:] } }

    public func list(_ config: ConnectionConfig, _ folder: String, hidden: Bool, force: Bool = false) async throws -> DirectoryListing {
        let key = "\(config.key)|\(config.directory)|\(folder)|\(hidden)"
        if !force {
            let cached = lock.withLock { listings[key] }
            if let cached, Date().timeIntervalSince(cached.time) < 3 { return cached.value }
        }
        let value = try await run(config, "list", ["path": .string(folder), "hidden": .bool(hidden)]).decode(DirectoryListing.self)
        lock.withLock { listings[key] = (Date(), value) }
        return value
    }

    public func preview(_ config: ConnectionConfig, _ file: String) async throws -> FilePreview {
        let key = "\(config.key)|\(config.directory)|\(file)"
        let previous = lock.withLock { previews[key] }
        var params: [String: JSON] = ["path": .string(file)]
        if let version = previous?.version { params["knownVersion"] = .string(version) }
        var info = try await run(config, "preview", params).decode(FilePreview.self)
        if info.notModified == true, let previous { info = previous }
        let stored = info
        lock.withLock { previews[key] = stored }
        if info.kind == "image" || info.kind == "pdf" {
            info.data = try Data(contentsOf: try await cached(config, info), options: .mappedIfSafe)
        }
        return info
    }

    public func save(_ config: ConnectionConfig, _ file: String, text: String, revision: String) async throws -> FilePreview {
        defer { invalidate() }
        return try await run(config, "save", ["path": .string(file), "revision": .string(revision), "data": .string(text)]).decode(FilePreview.self)
    }

    public func stat(_ config: ConnectionConfig, _ file: String) async throws -> FileEntry {
        try await run(config, "stat", ["path": .string(file)]).decode(FileEntry.self)
    }

    private func cached(_ config: ConnectionConfig, _ info: FilePreview) async throws -> URL {
        try FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let target = cacheDirectory.appendingPathComponent(cacheName("\(config.key)|\(info.path)|\(info.version ?? "")"))
        if FileManager.default.fileExists(atPath: target.path) { return target }
        let temporary = cacheDirectory.appendingPathComponent(UUID().uuidString + ".tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try await transferDown(config, path: info.path, version: info.version, name: info.name, size: info.size, to: temporary)
        try FileManager.default.moveItem(at: temporary, to: target)
        pruneCache(keeping: target)
        return target
    }

    private func pruneCache(keeping: URL) {
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: cacheDirectory, includingPropertiesForKeys: keys) else { return }
        let items = files.compactMap { url -> (URL, Date, Int)? in
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url, values.contentModificationDate ?? .distantPast, values.fileSize ?? 0)
        }.sorted { $0.1 < $1.1 }
        var total = items.reduce(0) { $0 + $1.2 }
        for item in items where total > cacheLimit && item.0 != keeping {
            try? FileManager.default.removeItem(at: item.0)
            total -= item.2
        }
    }

    private func transferDown(_ config: ConnectionConfig, path: String, version: String?, name: String, size: Int, to destination: URL) async throws {
        var request: JSON = ["operation": "download", "path": .string(path), "base": .string(config.directory)]
        if let version { request["version"] = .string(version) }
        let process = try await agents.spawnTransfer(config, request: request)
        process.closeInput()
        guard FileManager.default.createFile(atPath: destination.path, contents: nil, attributes: [.posixPermissions: 0o600]),
              let output = try? FileHandle(forWritingTo: destination) else { process.kill(); throw RemoteError("无法写入本地文件") }
        final class Counter: @unchecked Sendable { var bytes = 0; var last = Date.distantPast; var failed = false }
        let counter = Counter()
        let progress = onProgress
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            process.readOutput(chunk: { data in
                do { try output.write(contentsOf: data) } catch { counter.failed = true; process.kill() }
                counter.bytes += data.count
                if Date().timeIntervalSince(counter.last) > 0.15 {
                    counter.last = Date()
                    progress?(TransferProgress(name: name, bytes: counter.bytes, total: size, finished: false))
                }
            }, done: { done.resume() })
        }
        try? output.close()
        let code = await process.waitForExit()
        if code != 0 || counter.failed {
            let message = process.stderrText.isEmpty ? "下载失败" : process.stderrText
            progress?(TransferProgress(name: name, bytes: counter.bytes, total: size, finished: true, error: message))
            throw RemoteError(message)
        }
        progress?(TransferProgress(name: name, bytes: counter.bytes, total: size, finished: true))
    }

    public func download(_ config: ConnectionConfig, _ file: String, to destination: URL) async throws {
        let info = try await stat(config, file)
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(".remotecc-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try await transferDown(config, path: info.path, version: info.version, name: info.name, size: info.size, to: temporary)
        _ = try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: temporary, to: destination)
    }

    public func upload(_ config: ConnectionConfig, file: URL, directory: String) async throws -> Attachment {
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
        guard attributes[.type] as? FileAttributeType == .typeRegular, size <= 1024 * 1024 * 1024 else { throw RemoteError("请选择不超过 1 GB 的普通文件") }
        let name = file.lastPathComponent
        let process = try await agents.spawnTransfer(config, request: ["operation": "upload", "directory": .string(directory), "name": .string(name), "size": .number(Double(size)), "base": .string(config.directory)])
        final class Output: @unchecked Sendable { var data = Data() }
        let output = Output()
        process.readOutput(chunk: { output.data.append($0) }, done: {})
        let input = try FileHandle(forReadingFrom: file)
        defer { try? input.close() }
        var sent = 0, last = Date.distantPast
        while let chunk = try input.read(upToCount: 256 * 1024), !chunk.isEmpty {
            process.write(chunk)
            sent += chunk.count
            if Date().timeIntervalSince(last) > 0.15 {
                last = Date()
                onProgress?(TransferProgress(name: name, bytes: sent, total: size, finished: false))
            }
        }
        process.closeInput()
        let code = await process.waitForExit()
        invalidate()
        if code != 0 {
            let message = process.stderrText.isEmpty ? "上传失败" : process.stderrText
            onProgress?(TransferProgress(name: name, bytes: sent, total: size, finished: true, error: message))
            throw RemoteError(message)
        }
        onProgress?(TransferProgress(name: name, bytes: sent, total: size, finished: true))
        // readOutput may still be delivering the final chunk just after exit.
        for _ in 0..<100 where output.data.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
        let entry = try JSONDecoder().decode(FileEntry.self, from: output.data)
        return Attachment(name: entry.name, path: entry.path, size: entry.size)
    }
}
