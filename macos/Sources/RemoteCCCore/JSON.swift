import Foundation

public struct RemoteError: LocalizedError, Sendable {
    public let message: String
    public var confirmed = true
    public init(_ message: String, confirmed: Bool = true) { self.message = message; self.confirmed = confirmed }
    public var errorDescription: String? { message }
}

/// Untyped JSON for protocol payloads whose shape belongs to the remote side.
public enum JSON: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSON].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSON].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    public subscript(key: String) -> JSON? {
        get { if case .object(let value) = self { return value[key] }; return nil }
        set { if case .object(var value) = self { value[key] = newValue; self = .object(value) } }
    }
    public var string: String? { if case .string(let value) = self { return value }; return nil }
    public var double: Double? { if case .number(let value) = self { return value }; return nil }
    public var int: Int? { double.map { Int($0) } }
    public var bool: Bool? { if case .bool(let value) = self { return value }; return nil }
    public var array: [JSON]? { if case .array(let value) = self { return value }; return nil }
    public var object: [String: JSON]? { if case .object(let value) = self { return value }; return nil }
    public var isTruthy: Bool {
        switch self {
        case .null: return false
        case .bool(let value): return value
        default: return true
        }
    }

    public static func parse(_ data: Data) throws -> JSON { try JSONDecoder().decode(JSON.self, from: data) }
    public func data() throws -> Data { try JSONEncoder().encode(self) }
    public func text(pretty: Bool = false) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = pretty ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes] : [.withoutEscapingSlashes]
        return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
    public func decode<T: Decodable>(_ type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(type, from: try data())
    }
    public static func from<T: Encodable>(_ value: T) throws -> JSON { try parse(try JSONEncoder().encode(value)) }
}

extension JSON: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral, ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(dictionaryLiteral elements: (String, JSON)...) { self = .object(Dictionary(uniqueKeysWithValues: elements)) }
    public init(arrayLiteral elements: JSON...) { self = .array(elements) }
}

/// Applies a packet from the agent's task watch. A subscriber starts with a full
/// snapshot; every patch requires the exact previous version.
public func applyStateDelta(_ previous: JSON?, _ packet: JSON) throws -> JSON {
    guard packet["delta"]?.isTruthy == true else { return packet }
    guard var state = previous, state["version"] == packet["base"] else { throw RemoteError("远端状态版本不连续，请重新连接") }
    for patch in packet["patches"]?.array ?? [] {
        guard let path = patch["path"]?.array, !path.isEmpty else { throw RemoteError("无效状态增量") }
        try applyPatch(&state, path[...], patch)
    }
    guard state["version"] == packet["version"] else { throw RemoteError("无效状态版本") }
    return state
}

private func applyPatch(_ node: inout JSON, _ path: ArraySlice<JSON>, _ patch: JSON) throws {
    guard let key = path.first else { throw RemoteError("无效状态增量") }
    let last = path.count == 1
    switch (node, key) {
    case (.object(var object), .string(let name)):
        node = .null // Releases the shared copy so the mutation stays in place.
        if last {
            if patch["remove"]?.isTruthy == true { object[name] = nil }
            else if let append = patch["append"] {
                guard case .string(let current)? = object[name], let text = append.string else { throw RemoteError("无效文本增量") }
                object[name] = .string(current + text)
            } else { object[name] = patch["value"] ?? .null }
        } else {
            guard var child = object[name] else { throw RemoteError("无效状态增量") }
            object[name] = nil
            try applyPatch(&child, path.dropFirst(), patch)
            object[name] = child
        }
        node = .object(object)
    case (.array(var array), .number(let number)):
        node = .null
        let index = Int(number)
        guard index >= 0, index <= array.count else { throw RemoteError("无效状态增量") }
        if last {
            let value: JSON
            if let append = patch["append"] {
                guard index < array.count, let current = array[index].string, let text = append.string else { throw RemoteError("无效文本增量") }
                value = .string(current + text)
            } else { value = patch["value"] ?? .null }
            if index == array.count { array.append(value) } else { array[index] = value }
        } else {
            guard index < array.count else { throw RemoteError("无效状态增量") }
            try applyPatch(&array[index], path.dropFirst(), patch)
        }
        node = .array(array)
    default:
        throw RemoteError("无效状态增量")
    }
}
