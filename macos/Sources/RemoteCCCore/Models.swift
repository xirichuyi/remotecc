import Foundation

public struct ConnectionConfig: Codable, Hashable, Sendable {
    public var host: String
    public var port: Int?
    public var directory: String
    public init(host: String, port: Int? = nil, directory: String = "~") {
        self.host = host; self.port = port; self.directory = directory
    }
    /// Same server regardless of working directory.
    public var key: String { host + ":" + (port.map(String.init) ?? "") }

    public static func parsePort(_ text: String) throws -> Int? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        guard value.utf8.allSatisfy({ (48...57).contains($0) }),
              let port = Int(value), (1...65535).contains(port) else {
            throw RemoteError("SSH 端口需为 1–65535 的整数，留空使用 SSH 配置")
        }
        return port
    }

    /// `ssh axi`, `axi` and `user@host` are accepted; anything that could be an ssh option is not.
    public func validated() throws -> ConnectionConfig {
        var result = self
        var name = host.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.hasPrefix("ssh ") { name = String(name.dropFirst(4)).trimmingCharacters(in: .whitespaces) }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_.@:-"))
        guard let first = name.unicodeScalars.first, first != "-", first != ".", first != "@", first != ":",
              name.count <= 200, name.unicodeScalars.allSatisfy({ $0.isASCII && allowed.contains($0) }) else {
            throw RemoteError("请输入 SSH 别名或 user@host，端口和密钥请在 SSH config 中配置")
        }
        result.host = name
        let folder = directory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !folder.isEmpty, folder.count <= 2048, !folder.unicodeScalars.contains(where: { $0.value < 0x20 }) else {
            throw RemoteError("项目目录不能包含控制字符")
        }
        result.directory = folder
        if let port, !(1...65535).contains(port) { throw RemoteError("SSH 端口需为 1–65535") }
        return result
    }
}

public struct Attachment: Codable, Hashable, Sendable, Identifiable {
    public var name: String
    public var path: String
    public var size: Int
    public var id: String { path }
    public init(name: String, path: String, size: Int) { self.name = name; self.path = path; self.size = size }
}

public struct ChildTool: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String?
    public var input: JSON?
    public var status: String?
    public var output: String?
}

public struct Block: Codable, Hashable, Sendable {
    public var type: String
    public var text: String?
    public var id: String?
    public var name: String?
    public var input: JSON?
    public var status: String?
    public var output: String?
    public var summary: String?
    public var elapsed: Double?
    public var children: [ChildTool]?
    public var agentText: String?
    public var level: String?
    public init(type: String, text: String? = nil, id: String? = nil, name: String? = nil, input: JSON? = nil, status: String? = nil, output: String? = nil) {
        self.type = type; self.text = text; self.id = id; self.name = name; self.input = input; self.status = status; self.output = output
    }
}

public struct ChatMessage: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var role: String
    public var text: String?
    public var attachments: [Attachment]?
    public var blocks: [Block]?
    public var createdAt: Double?
    public var error: String?
    public var interrupted: Bool?
    public var activity: String?
    public var serviceIssue: JSON?
    public var checkpointId: String?
    public var model: String?
    public var durationMs: Double?
    public var costUSD: Double?
    public init(id: String = UUID().uuidString.lowercased(), role: String, text: String? = nil, attachments: [Attachment]? = nil, blocks: [Block]? = nil, createdAt: Double = Date().timeIntervalSince1970 * 1000) {
        self.id = id; self.role = role; self.text = text; self.attachments = attachments; self.blocks = blocks; self.createdAt = createdAt
    }
}

/// An approval or a structured question parked on the server.
public struct PermissionRequest: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var kind: String?
    public var name: String?
    public var input: JSON?
    public var title: String?
    public var description: String?
    public var suggestions: JSON?
    public var request: JSON?
}

public struct Preferences: Codable, Hashable, Sendable {
    public var agent: String?
    public var selectedModel: String?
    public var effort: String?
    public var permissionMode: String?
    public var fastMode: Bool?
    public var outputStyle: String?
    public var additionalDirectories: [String]?
    public init() {}
}

public struct RemoteCommand: Codable, Hashable, Sendable, Identifiable {
    public var name: String
    public var description: String?
    public var argumentHint: String?
    public var aliases: [String]?
    public var builtin: Bool?
    public var id: String { name }
    public init(name: String, description: String? = nil, argumentHint: String? = nil, aliases: [String]? = nil, builtin: Bool? = nil) {
        self.name = name; self.description = description; self.argumentHint = argumentHint; self.aliases = aliases; self.builtin = builtin
    }
}

public struct RemoteModel: Codable, Hashable, Sendable, Identifiable {
    public var value: String
    public var displayName: String?
    public var description: String?
    public var resolvedModel: String?
    public var supportedEffortLevels: [String]?
    public var supportsFastMode: Bool?
    public var supportsAutoMode: Bool?
    public var id: String { value }
}

public struct RemoteAgent: Codable, Hashable, Sendable, Identifiable {
    public var name: String
    public var description: String?
    public var id: String { name }
}

public struct Capabilities: Codable, Hashable, Sendable {
    public var commands: [RemoteCommand]
    public var models: [RemoteModel]
    public var agents: [RemoteAgent]?
    public var version: String?
    public var outputStyles: [String]?
    public var fetchedAt: Double?
    public init(commands: [RemoteCommand] = [], models: [RemoteModel] = []) { self.commands = commands; self.models = models }
}

public struct QueuedMessage: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var text: String
    public var attachments: [Attachment]
}

public struct RemoteTask: Codable, Hashable, Sendable {
    public var id: String
    public var prompt: String?
    public var version: Int
    public var submitted: Bool?
    public var messageId: String?
    public var continuation: Bool?
}

public struct RemoteOwner: Codable, Hashable, Sendable {
    public var id: String
    public var version: Int
    public var messageId: String?
}

public struct ChatSession: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var host: String
    public var port: Int?
    public var directory: String
    public var createdAt: Double
    public var updatedAt: Double
    public var messages: [ChatMessage] = []
    public var status: String = "idle"
    public var permissions: [PermissionRequest] = []
    public var preferences: Preferences?
    public var capabilities: Capabilities?
    public var remoteSessionId: String?
    public var remoteTask: RemoteTask?
    public var remoteOwner: RemoteOwner?
    public var transportError: String?
    public var model: String?
    public var usage: JSON?
    public var tasks: JSON?
    public var tools: JSON?
    public var plugins: JSON?
    public var forkPending: Bool?
    public var queue: [QueuedMessage]?
    public var queuePaused: Bool?
    public var pinned: Bool?
    public var archived: Bool?
    public var localName: Bool?
    public var remoteHistoryRef: String?
    public var historyLoaded: Bool?
    public var historyBefore: String?
    public var historySummary: String?
    /// Hydrated lazily; persisted index entries carry no messages.
    public var localMessagesLoaded: Bool?

    public init(config: ConnectionConfig, name: String = "新对话") {
        let now = Date().timeIntervalSince1970 * 1000
        id = UUID().uuidString.lowercased(); self.name = name; host = config.host; port = config.port
        directory = config.directory; createdAt = now; updatedAt = now
    }
    public var config: ConnectionConfig { ConnectionConfig(host: host, port: port, directory: directory) }
    public var isBusy: Bool { ["connecting", "working", "permission", "stopping", "detached"].contains(status) }
    public var projectKey: String {
        let folder = directory == "/" ? "/" : directory.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        return host + ":" + (port.map(String.init) ?? "") + ":" + folder
    }
    private enum CodingKeys: String, CodingKey {
        case id, name, host, port, directory, createdAt, updatedAt, messages, status, permissions, preferences, capabilities, remoteSessionId, remoteTask, remoteOwner, transportError, model, usage, tasks, tools, plugins, forkPending, queue, queuePaused, pinned, archived, localName, remoteHistoryRef, historyLoaded, historyBefore, historySummary, localMessagesLoaded
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); name = try c.decode(String.self, forKey: .name)
        host = try c.decode(String.self, forKey: .host); port = try c.decodeIfPresent(Int.self, forKey: .port)
        directory = try c.decode(String.self, forKey: .directory)
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt) ?? 0
        updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt) ?? 0
        messages = try c.decodeIfPresent([ChatMessage].self, forKey: .messages) ?? []
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "idle"
        permissions = try c.decodeIfPresent([PermissionRequest].self, forKey: .permissions) ?? []
        preferences = try c.decodeIfPresent(Preferences.self, forKey: .preferences)
        capabilities = try? c.decodeIfPresent(Capabilities.self, forKey: .capabilities)
        remoteSessionId = try c.decodeIfPresent(String.self, forKey: .remoteSessionId)
        remoteTask = try c.decodeIfPresent(RemoteTask.self, forKey: .remoteTask)
        remoteOwner = try c.decodeIfPresent(RemoteOwner.self, forKey: .remoteOwner)
        transportError = try c.decodeIfPresent(String.self, forKey: .transportError)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        usage = try c.decodeIfPresent(JSON.self, forKey: .usage); tasks = try c.decodeIfPresent(JSON.self, forKey: .tasks)
        tools = try c.decodeIfPresent(JSON.self, forKey: .tools); plugins = try c.decodeIfPresent(JSON.self, forKey: .plugins)
        forkPending = try c.decodeIfPresent(Bool.self, forKey: .forkPending)
        queue = try c.decodeIfPresent([QueuedMessage].self, forKey: .queue); queuePaused = try c.decodeIfPresent(Bool.self, forKey: .queuePaused)
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned); archived = try c.decodeIfPresent(Bool.self, forKey: .archived)
        localName = try c.decodeIfPresent(Bool.self, forKey: .localName)
        remoteHistoryRef = try c.decodeIfPresent(String.self, forKey: .remoteHistoryRef)
        historyLoaded = try c.decodeIfPresent(Bool.self, forKey: .historyLoaded); historyBefore = try c.decodeIfPresent(String.self, forKey: .historyBefore)
        historySummary = try c.decodeIfPresent(String.self, forKey: .historySummary)
        localMessagesLoaded = try c.decodeIfPresent(Bool.self, forKey: .localMessagesLoaded)
    }
}

public struct FileEntry: Codable, Hashable, Sendable, Identifiable {
    public var path: String
    public var name: String
    public var size: Int
    public var directory: Bool
    public var symlink: Bool?
    public var broken: Bool?
    public var version: String?
    public var relative: String?
    public var id: String { path }
}

public struct DirectoryListing: Codable, Hashable, Sendable {
    public var path: String
    public var parent: String
    public var entries: [FileEntry]
    public var truncated: Bool?
}

public struct FilePreview: Codable, Hashable, Sendable {
    public var path: String
    public var name: String
    public var size: Int
    public var version: String?
    public var kind: String?
    public var text: String?
    public var revision: String?
    public var truncated: Bool?
    public var mime: String?
    public var reason: String?
    public var notModified: Bool?
    /// Image and PDF bytes, read from the local content cache; never persisted.
    public var data: Data?
    private enum CodingKeys: String, CodingKey { case path, name, size, version, kind, text, revision, truncated, mime, reason, notModified }
}

public struct GitFile: Codable, Hashable, Sendable, Identifiable {
    public var status: String
    public var path: String
    public var relative: String
    public var id: String { path }
    /// One letter for display: conflict, untracked, or the most relevant side.
    public var code: String {
        if status.contains("U") { return "U" }
        if status == "??" { return "?" }
        let characters = Array(status)
        return characters.count > 1 && characters[1] != " " ? String(characters[1]) : String(characters.first ?? "M")
    }
}

public struct GitStatus: Codable, Hashable, Sendable {
    public var repository: Bool
    public var root: String?
    public var branch: String?
    public var files: [GitFile]
}

public struct SearchMatch: Codable, Hashable, Sendable, Identifiable {
    public var path: String
    public var relative: String
    public var line: Int
    public var text: String
    public var id: String { path + ":" + String(line) }
}

public struct SearchResult: Codable, Hashable, Sendable {
    public var matches: [SearchMatch]
    public var truncated: Bool?
}

public struct ServerInfo: Codable, Hashable, Sendable {
    public var home: String
    public var hostname: String?
    public var node: String?
    public var nodeSupported: Bool
    public var nodePath: String
    public var agentPath: String
    public var claude: String?
}
