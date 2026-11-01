import Foundation

/// The CLI stores slash commands and their output inside XML-like tags.
func historyUserText(_ text: String) -> String {
    func capture(_ pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    if let command = capture("<command-name>([^<]*)</command-name>") {
        let arguments = capture("<command-args>(.*?)</command-args>") ?? ""
        return arguments.isEmpty ? command : command + " " + arguments
    }
    if let output = capture("<local-command-stdout>(.*?)</local-command-stdout>") { return output }
    return text.replacingOccurrences(of: "<system-reminder>[\\s\\S]*?</system-reminder>\\s*", with: "", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

private let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

/// Turns the agent's safe history records into displayable messages.
public func historyMessages(_ records: [JSON]) -> [ChatMessage] {
    var messages: [ChatMessage] = []
    for event in records {
        let identifier = event["uuid"]?.string ?? UUID().uuidString
        let timestamp = (event["timestamp"]?.string).flatMap { isoFormatter.date(from: $0) }.map { $0.timeIntervalSince1970 * 1000 } ?? 0
        let blocks = event["message"]?["content"]?.array ?? []
        if event["type"]?.string == "user" {
            for result in blocks where result["type"]?.string == "tool_result" {
                guard let target = messages.indices.reversed().first(where: { messages[$0].blocks?.contains(where: { $0.id == result["tool_use_id"]?.string }) == true }),
                      let index = messages[target].blocks?.firstIndex(where: { $0.id == result["tool_use_id"]?.string }) else { continue }
                let content = result["content"]
                messages[target].blocks?[index].output = content?.string ?? content?.array?.map { item in
                    if let text = item["text"]?.string { return text }
                    return "[" + (item["type"]?.string ?? "非文本结果") + "]"
                }.joined(separator: "\n")
                if result["is_error"]?.isTruthy == true { messages[target].blocks?[index].status = "error" }
            }
            let text = historyUserText(blocks.filter { $0["type"]?.string == "text" }.compactMap { $0["text"]?.string }.joined(separator: "\n"))
            if !text.isEmpty { messages.append(ChatMessage(id: identifier, role: "user", text: text, createdAt: timestamp)) }
        } else {
            var converted: [Block] = []
            for block in blocks {
                switch block["type"]?.string {
                case "text": converted.append(Block(type: "text", text: block["text"]?.string))
                case "thinking": converted.append(Block(type: "thinking", text: block["thinking"]?.string))
                case "tool_use": converted.append(Block(type: "tool", id: block["id"]?.string, name: block["name"]?.string, input: block["input"], status: "history"))
                default: break
                }
            }
            var message = ChatMessage(id: identifier, role: "assistant", blocks: converted, createdAt: timestamp)
            if event["isApiErrorMessage"]?.bool == true || event["error"]?.string != nil {
                let detail = converted.filter { $0.type == "text" }.compactMap(\.text).joined(separator: "\n")
                message.error = detail.isEmpty ? (event["error"]?.string ?? "远端请求失败") : detail
            }
            messages.append(message)
        }
    }
    return messages
}

/// Compact titles for imported CLI sessions; do not expose their XML envelopes in navigation.
public func historyDisplayTitle(_ text: String) -> String {
    let cleaned = historyUserText(text)
        .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return cleaned.isEmpty ? "未命名对话" : String(cleaned.prefix(80))
}
