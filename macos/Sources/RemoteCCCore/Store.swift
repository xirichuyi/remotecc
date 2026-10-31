import Foundation

/// Index of metadata plus one file per conversation, so opening the app reads no transcripts.
public final class ChatStore: @unchecked Sendable {
    private let directory: URL
    private var indexFile: URL { directory.appendingPathComponent("index.json") }
    private var pendingTimer: DispatchWorkItem?
    private var saved: [String: Data] = [:]
    private let queue = DispatchQueue(label: "remotecc.store")

    public init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("sessions"), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }

    private func file(_ id: String) -> URL { directory.appendingPathComponent("sessions").appendingPathComponent(id + ".json") }

    private func atomic(_ url: URL, _ data: Data) throws {
        let temporary = url.appendingPathExtension("tmp")
        guard FileManager.default.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else { throw RemoteError("无法写入本地聊天记录") }
        guard rename(temporary.path, url.path) == 0 else { throw RemoteError("无法写入本地聊天记录") }
    }

    public func load() throws -> [ChatSession] {
        guard FileManager.default.fileExists(atPath: indexFile.path) else { return [] }
        var sessions = try JSONDecoder().decode([ChatSession].self, from: try Data(contentsOf: indexFile))
        for index in sessions.indices {
            if sessions[index].remoteTask != nil { sessions[index].status = "detached"; sessions[index].queuePaused = true }
            else if ["connecting", "working", "permission", "stopping"].contains(sessions[index].status) { sessions[index].status = "stopped" }
            sessions[index].permissions = []
            if sessions[index].queue?.isEmpty == false { sessions[index].queuePaused = true }
            sessions[index].localMessagesLoaded = false
        }
        return sessions
    }

    public func messages(_ id: String) throws -> [ChatMessage] {
        guard FileManager.default.fileExists(atPath: file(id).path) else { return [] }
        return try JSONDecoder().decode([ChatMessage].self, from: try Data(contentsOf: file(id)))
    }

    /// Unloaded conversations keep their message file untouched.
    public func save(_ sessions: [ChatSession], changed: Set<String>? = nil) {
        let index = sessions.map { session -> ChatSession in
            var meta = session; meta.messages = []; return meta
        }
        let updates = sessions.filter { (changed?.contains($0.id) ?? true) && $0.localMessagesLoaded != false }
        let ids = Set(sessions.map(\.id))
        queue.async { [self] in
            let encoder = JSONEncoder()
            for session in updates {
                guard let data = try? encoder.encode(session.messages), saved[session.id] != data else { continue }
                try? atomic(file(session.id), data)
                saved[session.id] = data
            }
            if let data = try? encoder.encode(index) { try? atomic(indexFile, data) }
            if let files = try? FileManager.default.contentsOfDirectory(at: directory.appendingPathComponent("sessions"), includingPropertiesForKeys: nil) {
                for url in files where url.pathExtension == "json" && !ids.contains(url.deletingPathExtension().lastPathComponent) {
                    try? FileManager.default.removeItem(at: url)
                    saved[url.deletingPathExtension().lastPathComponent] = nil
                }
            }
        }
    }

    public func flush() { queue.sync {} }
}
