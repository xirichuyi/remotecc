import Foundation

public struct DiffRow: Hashable, Sendable {
    public enum Kind: Sendable { case context, added, removed, hunk }
    public var kind: Kind
    public var text: String
    public init(_ kind: Kind, _ text: String) { self.kind = kind; self.text = text }
}

/// Longest common subsequence over lines; very large edits fall back to remove-all/add-all.
public func lineDiff(before: String, after: String) -> [DiffRow] {
    let a = before.components(separatedBy: "\n"), b = after.components(separatedBy: "\n")
    var start = 0
    while start < a.count, start < b.count, a[start] == b[start] { start += 1 }
    var endA = a.count, endB = b.count
    while endA > start, endB > start, a[endA - 1] == b[endB - 1] { endA -= 1; endB -= 1 }
    let middleA = Array(a[start..<endA]), middleB = Array(b[start..<endB])
    var rows = a[max(0, start - 2)..<start].map { DiffRow(.context, $0) }
    if middleA.count * middleB.count > 250_000 {
        rows += middleA.map { DiffRow(.removed, $0) } + middleB.map { DiffRow(.added, $0) }
    } else {
        let width = middleB.count + 1
        var table = [Int32](repeating: 0, count: (middleA.count + 1) * width)
        if !middleA.isEmpty && !middleB.isEmpty {
            for i in stride(from: middleA.count - 1, through: 0, by: -1) {
                for j in stride(from: middleB.count - 1, through: 0, by: -1) {
                    table[i * width + j] = middleA[i] == middleB[j] ? table[(i + 1) * width + j + 1] + 1 : max(table[(i + 1) * width + j], table[i * width + j + 1])
                }
            }
        }
        var i = 0, j = 0
        while i < middleA.count || j < middleB.count {
            if i < middleA.count, j < middleB.count, middleA[i] == middleB[j] { rows.append(DiffRow(.context, middleA[i])); i += 1; j += 1 }
            else if j < middleB.count, i == middleA.count || table[i * width + j + 1] >= table[(i + 1) * width + j] { rows.append(DiffRow(.added, middleB[j])); j += 1 }
            else { rows.append(DiffRow(.removed, middleA[i])); i += 1 }
        }
    }
    rows += a[endA..<min(a.count, endA + 2)].map { DiffRow(.context, $0) }
    return rows
}

public func unifiedDiffRows(_ text: String) -> [DiffRow] {
    var rows: [DiffRow] = []
    for line in text.components(separatedBy: "\n") {
        if ["diff --git", "index ", "--- ", "+++ ", "new file", "deleted file", "similarity", "rename "].contains(where: line.hasPrefix) { continue }
        if line.hasPrefix("@@") { rows.append(DiffRow(.hunk, line)) }
        else if line.hasPrefix("+") { rows.append(DiffRow(.added, String(line.dropFirst()))) }
        else if line.hasPrefix("-") { rows.append(DiffRow(.removed, String(line.dropFirst()))) }
        else if !line.isEmpty { rows.append(DiffRow(.context, String(line.dropFirst()))) }
    }
    return rows
}

public struct TodoItem: Hashable, Sendable, Identifiable {
    public var text: String
    public var status: String
    public var id: String { text }
}

/// How one tool call reads best, independent of the UI toolkit.
public struct ToolPresentation: Hashable, Sendable {
    public enum Body: Hashable, Sendable {
        case command(String), code(String), diff([DiffRow]), todos([TodoItem]), markdown(String)
    }
    public var title: String
    public var subject: String?
    public var file: String?
    public var line: Int?
    public var body: Body?
    public var startsOpen = false
    public var hidesOutput = false

    public init(name: String?, input: JSON?) {
        let input = input ?? [:]
        let string = { (key: String) in input[key]?.string }
        func firstLine(_ text: String?, _ limit: Int = 90) -> String? {
            guard let line = text?.components(separatedBy: "\n").first, !line.isEmpty else { return nil }
            return line.count > limit ? String(line.prefix(limit)) + "…" : line
        }
        func editRows() -> [DiffRow] {
            if let edits = input["edits"]?.array {
                return edits.flatMap { lineDiff(before: $0["old_string"]?.string ?? "", after: $0["new_string"]?.string ?? "") }
            }
            return lineDiff(before: string("old_string") ?? "", after: string("new_string") ?? "")
        }
        func withPath(_ first: String?) -> String? {
            guard let first else { return nil }
            return string("path").map { first + " · " + $0 } ?? first
        }
        title = name ?? "工具"
        switch name {
        case "Bash":
            subject = string("description") ?? firstLine(string("command"))
            body = .command(string("command") ?? "")
        case "Read":
            file = string("file_path"); line = input["offset"]?.int
            subject = line.map { "第 \($0) 行起" }
            hidesOutput = true
        case "Write":
            file = string("file_path")
            let content = string("content") ?? ""
            subject = "\(content.isEmpty ? 0 : content.components(separatedBy: "\n").count) 行"
            body = .code(content); hidesOutput = true
        case "Edit", "MultiEdit":
            title = "Edit"; file = string("file_path")
            if let edits = input["edits"]?.array { subject = "\(edits.count) 处" }
            body = .diff(editRows()); startsOpen = true; hidesOutput = true
        case "NotebookEdit":
            file = string("notebook_path"); body = .code(string("new_source") ?? "")
        case "Grep", "Glob":
            subject = withPath(string("pattern"))
        case "LS":
            file = string("path")
        case "WebFetch":
            subject = string("url"); if let prompt = string("prompt") { body = .code(prompt) }
        case "WebSearch":
            subject = string("query")
        case "TodoWrite":
            title = "任务清单"
            let todos = (input["todos"]?.array ?? []).map { item -> TodoItem in
                let status = item["status"]?.string ?? "pending"
                let text = status == "in_progress" ? item["activeForm"]?.string ?? item["content"]?.string : item["content"]?.string
                return TodoItem(text: text ?? "", status: status)
            }
            subject = "\(todos.filter { $0.status == "completed" }.count)/\(todos.count)"
            body = .todos(todos); startsOpen = true; hidesOutput = true
        case "ExitPlanMode":
            title = "计划"
            if let plan = string("plan") { body = .markdown(plan) }
            startsOpen = true; hidesOutput = true
        case "AskUserQuestion":
            title = "提问"
            subject = input["questions"]?.array?.compactMap { $0["question"]?.string }.joined(separator: " · ")
        case "Skill":
            subject = string("skill") ?? string("command")
        case "Task", "Agent":
            title = string("subagent_type").map { "Agent · " + $0 } ?? "Agent"
            subject = string("description")
            if let prompt = string("prompt") { body = .code(prompt) }
        default:
            if let name, name.hasPrefix("mcp__") {
                let parts = name.dropFirst(5).components(separatedBy: "__")
                if parts.count >= 2 { title = parts[0] + " · " + parts[1...].joined(separator: "__") }
            }
            let object = input.object ?? [:]
            subject = firstLine(object.keys.sorted().compactMap { object[$0]?.string }.first)
            if !object.isEmpty { body = .code(input.text(pretty: true)) }
        }
    }
}

/// Markdown split into blocks; inline formatting is left to the UI's attributed strings.
public enum MarkdownBlock: Hashable, Sendable {
    case heading(Int, String)
    case paragraph(String)
    case code(language: String?, text: String)
    case list([ListItem])
    case quote(String)
    case table([[String]])
    case rule

    public struct ListItem: Hashable, Sendable {
        public var marker: String
        public var indent: Int
        public var text: String
    }
}

public func parseMarkdown(_ source: String) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    var paragraph: [String] = []
    let lines = source.components(separatedBy: "\n")
    var index = 0
    func flush() { if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] } }
    func listItem(_ line: String) -> MarkdownBlock.ListItem? {
        let indent = line.prefix { $0 == " " }.count
        let body = line.dropFirst(indent)
        if let first = body.first, "-*+".contains(first), body.dropFirst().first == " " {
            return .init(marker: "•", indent: indent / 2, text: String(body.dropFirst(2)))
        }
        let digits = body.prefix { $0.isNumber }
        if !digits.isEmpty, body.dropFirst(digits.count).hasPrefix(". ") {
            return .init(marker: digits + ".", indent: indent / 2, text: String(body.dropFirst(digits.count + 2)))
        }
        return nil
    }
    func tableCells(_ line: String) -> [String] {
        var text = line.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("|") { text.removeFirst() }
        if text.hasSuffix("|") { text.removeLast() }
        return text.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }
    func isTableRule(_ line: String) -> Bool {
        line.contains("-") && line.contains("|") && line.allSatisfy { "|-: ".contains($0) }
    }
    while index < lines.count {
        let line = lines[index]
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
            flush()
            let fence = String(trimmed.prefix(3))
            let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            var code: [String] = []
            index += 1
            while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) { code.append(lines[index]); index += 1 }
            index += 1
            blocks.append(.code(language: language.isEmpty ? nil : language, text: code.joined(separator: "\n")))
            continue
        }
        if trimmed.isEmpty { flush(); index += 1; continue }
        let hashes = trimmed.prefix { $0 == "#" }.count
        if (1...6).contains(hashes), trimmed.dropFirst(hashes).first == " " {
            flush(); blocks.append(.heading(hashes, String(trimmed.dropFirst(hashes + 1)))); index += 1; continue
        }
        if trimmed.count >= 3, ["-", "*", "_"].contains(where: { mark in trimmed.allSatisfy { String($0) == mark } }) {
            flush(); blocks.append(.rule); index += 1; continue
        }
        if trimmed.hasPrefix(">") {
            flush()
            var quote: [String] = []
            while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                quote.append(String(lines[index].trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces)); index += 1
            }
            blocks.append(.quote(quote.joined(separator: "\n")))
            continue
        }
        if line.contains("|"), index + 1 < lines.count, isTableRule(lines[index + 1]) {
            flush()
            var rows = [tableCells(line)]
            index += 2
            while index < lines.count, lines[index].contains("|"), !lines[index].trimmingCharacters(in: .whitespaces).isEmpty { rows.append(tableCells(lines[index])); index += 1 }
            blocks.append(.table(rows))
            continue
        }
        if listItem(line) != nil {
            flush()
            var items: [MarkdownBlock.ListItem] = []
            while index < lines.count, let item = listItem(lines[index]) { items.append(item); index += 1 }
            blocks.append(.list(items))
            continue
        }
        paragraph.append(line)
        index += 1
    }
    flush()
    return blocks
}

/// Recognises `src/app.js:12`, `/etc/hosts` and `report.pdf`, but not `e.g.` or `v1.2`.
public func remotePathReference(_ text: String) -> (path: String, line: Int?)? {
    guard !text.contains(" "), !text.contains("\n"), text.count < 1024 else { return nil }
    var path = text, line: Int?
    if let range = text.range(of: ":[0-9]+(:[0-9]+)?$", options: .regularExpression) {
        path = String(text[..<range.lowerBound])
        line = Int(text[range].dropFirst().prefix { $0.isNumber })
    }
    if path.hasPrefix("http:") || path.hasPrefix("https:") { return nil }
    if path.hasPrefix("/") || path.hasPrefix("~/") || path.hasPrefix("./") || path.hasPrefix("../") { return path.count > 1 ? (path, line) : nil }
    if path.range(of: "^[\\w.@-]+(/[\\w.@-]+)+$", options: .regularExpression) != nil { return (path, line) }
    if path.range(of: "^[\\w.@-]+\\.(js|cjs|mjs|ts|tsx|jsx|py|go|rs|java|c|h|cpp|cs|rb|php|swift|sh|md|txt|json|yaml|yml|toml|html|css|sql|csv|png|jpg|jpeg|gif|webp|pdf|log)$", options: [.regularExpression, .caseInsensitive]) != nil { return (path, line) }
    return nil
}
