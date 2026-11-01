#if canImport(SwiftUI)
import SwiftUI
import AppKit

/// Bounded, local token colouring. Unknown languages remain readable plain code.
func highlightedCode(_ text: String, language: String) -> AttributedString {
    let supported = ["swift", "js", "javascript", "ts", "typescript", "jsx", "tsx", "json", "python", "py", "sh", "bash", "zsh", "c", "cpp", "go", "rust", "java"]
    guard supported.contains(language.lowercased()), text.utf16.count < 80_000 else { return AttributedString(text) }
    let result = NSMutableAttributedString(string: text)
    let pattern = #"(?<comment>//[^\n]*|#[^\n]*|/\*[\s\S]*?\*/)|(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?<number>\b\d+(?:\.\d+)?\b)|(?<keyword>\b(?:let|var|func|struct|class|enum|import|return|if|else|guard|for|while|await|async|try|throw|throws|const|function|export|from|def|in|with|as|true|false|null|nil|None|self|public|private|static|switch|case|break|continue|new)\b)"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return AttributedString(text) }
    for match in regex.matches(in: text, range: NSRange(location: 0, length: (text as NSString).length)) {
        let color: NSColor
        if match.range(withName: "comment").location != NSNotFound { color = .secondaryLabelColor }
        else if match.range(withName: "string").location != NSNotFound { color = .systemGreen }
        else if match.range(withName: "number").location != NSNotFound { color = .systemOrange }
        else { color = .systemPurple }
        result.addAttribute(.foregroundColor, value: color, range: match.range)
    }
    return AttributedString(result)
}
#endif
