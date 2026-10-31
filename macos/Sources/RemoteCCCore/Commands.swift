import Foundation

/// Presentation helpers for `/` completion. Every name and alias comes from the remote catalogue.
public enum CommandCompletion {
    public static func candidates(_ catalogue: [RemoteCommand]) -> [RemoteCommand] {
        var order: [String] = [], commands: [String: RemoteCommand] = [:]
        for command in catalogue where commands[command.name] == nil || command.builtin == true {
            if commands[command.name] == nil { order.append(command.name) }
            commands[command.name] = command
        }
        for command in catalogue {
            for alias in command.aliases ?? [] where commands[alias] == nil {
                var copy = command; copy.name = alias
                commands[alias] = copy; order.append(alias)
            }
        }
        return order.compactMap { commands[$0] }
    }

    public static func match(_ commands: [RemoteCommand], query: String) -> [RemoteCommand] {
        let query = query.lowercased()
        guard !query.isEmpty else { return commands }
        func rank(_ command: RemoteCommand) -> Int {
            let name = command.name.lowercased()
            if name == query { return 0 }
            if name.hasPrefix(query) { return 1 }
            if name.contains(query) { return 2 }
            return (command.description ?? "").lowercased().contains(query) ? 3 : 4
        }
        return commands.enumerated().map { (command: $0.element, index: $0.offset, rank: rank($0.element)) }
            .filter { $0.rank < 4 }
            .sorted { a, b in
                if a.rank != b.rank { return a.rank < b.rank }
                if a.rank == 1, a.command.name.count != b.command.name.count { return a.command.name.count < b.command.name.count }
                return a.index < b.index
            }
            .map(\.command)
    }

    /// The command being typed; nil once the caret has left the first word.
    public static func token(_ value: String, caret: Int) -> (query: String, stop: Int)? {
        guard value.hasPrefix("/") else { return nil }
        let characters = Array(value)
        let stop = characters.firstIndex(where: \.isWhitespace) ?? characters.count
        guard caret >= 1, caret <= stop else { return nil }
        return (String(characters[1..<stop]), stop)
    }

    /// Replaces only the command token, keeping any arguments already typed.
    public static func complete(_ value: String, stop: Int, command: RemoteCommand) -> String {
        let rest = String(Array(value)[stop...])
        return "/" + command.name + (rest.isEmpty ? " " : rest)
    }
}

public struct CommandOption: Hashable, Sendable, Identifiable {
    public var value: String
    public var label: String
    public var description: String?
    public var id: String { value }
}

/// A slash command the client can drive with a native picker.
public struct CommandInteraction: Hashable, Sendable {
    public enum Kind: Sendable { case newConversation, model, effort, argument }
    public var kind: Kind
    public var command: String
    public var argument = ""
    public var selected: String?
    public var options: [CommandOption] = []
    public var description: String?
}

public func resolveCommand(_ catalogue: [RemoteCommand], text: String) -> (command: RemoteCommand, argument: String, typed: String)? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix("/"), trimmed.count > 1 else { return nil }
    let body = trimmed.dropFirst()
    let end = body.firstIndex(where: \.isWhitespace) ?? body.endIndex
    let name = String(body[..<end])
    guard !name.isEmpty else { return nil }
    let argument = String(body[end...]).trimmingCharacters(in: .whitespacesAndNewlines)
    let named = catalogue.filter { $0.name == name }
    guard let command = named.first(where: { $0.builtin == true }) ?? named.first ?? catalogue.first(where: { $0.aliases?.contains(name) == true }) else { return nil }
    return (command, argument, name)
}

public func commandInteraction(_ capabilities: Capabilities, text: String, preferences: Preferences?) -> CommandInteraction? {
    guard let resolved = resolveCommand(capabilities.commands, text: text), resolved.command.builtin == true else { return nil }
    let (command, argument, typed) = resolved
    if command.name == "clear" && argument.isEmpty { return CommandInteraction(kind: .newConversation, command: typed) }
    let selectedModel = preferences?.selectedModel.flatMap { $0.isEmpty ? nil : $0 } ?? "default"
    if command.name == "model" {
        return CommandInteraction(kind: .model, command: typed, argument: argument, selected: selectedModel,
                                  options: capabilities.models.map { CommandOption(value: $0.value, label: $0.displayName ?? $0.value, description: $0.description) })
    }
    // A finite argument menu comes from the remote command's own grammar, never from guesses.
    var enumeration: [String]?
    if let hint = command.argumentHint, hint.range(of: "^<[a-zA-Z0-9_-]+(\\|[a-zA-Z0-9_-]+)+>$", options: .regularExpression) != nil {
        enumeration = hint.dropFirst().dropLast().split(separator: "|").map(String.init)
    }
    if command.name == "effort" {
        let model = capabilities.models.first { $0.value == selectedModel }
        let values = enumeration.map { list in list.filter { $0 == "auto" || model == nil || model?.supportedEffortLevels?.contains($0) == true } } ?? ((model?.supportedEffortLevels ?? []) + ["auto"])
        let effort = preferences?.effort.flatMap { $0.isEmpty ? nil : $0 } ?? "auto"
        return CommandInteraction(kind: .effort, command: typed, argument: argument, selected: effort, options: values.map { CommandOption(value: $0, label: $0) }, description: command.description)
    }
    if argument.isEmpty, let enumeration {
        return CommandInteraction(kind: .argument, command: typed, options: enumeration.map { CommandOption(value: $0, label: $0) }, description: command.description)
    }
    return nil
}

/// One field of a flat MCP form. The worker validates the answer again before it reaches Claude.
public struct SchemaField: Hashable, Sendable, Identifiable {
    public enum Kind: Sendable, Hashable { case text, number, integer, boolean, choice, multiChoice }
    public var name: String
    public var label: String
    public var required: Bool
    public var kind: Kind
    public var options: [CommandOption]
    public var description: String?
    public var defaultValue: JSON?
    public var id: String { name }

    public static func fields(_ schema: JSON?) throws -> [SchemaField] {
        guard let schema, schema["type"]?.string == "object", let properties = schema["properties"]?.object else { throw RemoteError("远端表单结构不受支持") }
        let required = (schema["required"]?.array ?? []).compactMap(\.string)
        func choices(_ value: JSON) -> [CommandOption]? {
            if let list = value["enum"]?.array {
                let names = value["enumNames"]?.array
                return list.enumerated().compactMap { index, item in
                    item.string.map { CommandOption(value: $0, label: names?[safe: index]?.string ?? $0) }
                }
            }
            if let list = value["oneOf"]?.array ?? value["anyOf"]?.array {
                return list.compactMap { item in item["const"]?.string.map { CommandOption(value: $0, label: item["title"]?.string ?? $0) } }
            }
            return nil
        }
        return try properties.keys.sorted().map { name in
            let value = properties[name]!
            let kind: Kind, options: [CommandOption]
            switch value["type"]?.string {
            case "string": options = choices(value) ?? []; kind = options.isEmpty ? .text : .choice
            case "boolean": options = []; kind = .boolean
            case "number": options = []; kind = .number
            case "integer": options = []; kind = .integer
            case "array":
                guard let items = value["items"], let list = choices(items), !list.isEmpty else { throw RemoteError("远端多选结构不受支持") }
                options = list; kind = .multiChoice
            default: throw RemoteError("远端字段类型不受支持：" + (value["type"]?.string ?? "未知"))
            }
            return SchemaField(name: name, label: value["title"]?.string ?? name, required: required.contains(name), kind: kind, options: options, description: value["description"]?.string, defaultValue: value["default"])
        }
    }
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
