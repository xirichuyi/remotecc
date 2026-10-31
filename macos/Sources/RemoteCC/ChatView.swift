#if canImport(SwiftUI)
import SwiftUI
import AppKit
import RemoteCCCore

struct ChatView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            if let session = model.active {
                MessagesList(session: session)
            } else {
                ContentUnavailableView("新对话", systemImage: "bubble.left.and.bubble.right", description: Text(model.isConnected ? "" : "点击左下角「连接 SSH」连接你的服务器"))
                    .frame(maxHeight: .infinity)
            }
            ComposerArea()
        }
    }
}

struct MessagesList: View {
    @EnvironmentObject private var model: AppModel
    let session: ChatSession

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    if session.remoteHistoryRef != nil { HistoryNotice(session: session) }
                    ForEach(Array(session.messages.enumerated()), id: \.element.id) { index, message in
                        // Equatable lets unchanged messages skip rendering while the last one streams.
                        MessageRow(message: message, busy: index == session.messages.count - 1 && session.isBusy, actions: FileActions(open: { model.open($0, line: $1) }))
                            .equatable()
                            .id(message.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 26).padding(.vertical, 20)
                .frame(maxWidth: 860, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: session.messages.last) { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: session.id) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }
}

struct HistoryNotice: View {
    @EnvironmentObject private var model: AppModel
    let session: ChatSession

    var body: some View {
        HStack {
            Text(session.historyLoaded == false ? "正在加载远端消息…" : "远端历史 · 图片原始数据和超长内容未下载")
            if session.historyLoaded == false {
                Button("加载消息") { model.perform { try await model.engine?.loadHistory(session.id) } }
            } else if session.historyBefore != nil {
                Button("加载更早消息") { model.perform { try await model.engine?.loadHistory(session.id, older: true) } }.disabled(session.isBusy)
            }
        }
        .font(.caption).foregroundStyle(.secondary)
    }
}

/// Closures are not comparable, so they are left out of MessageRow's equality.
struct FileActions {
    let open: (String, Int?) -> Void
}

struct MessageRow: View, Equatable {
    let message: ChatMessage
    let busy: Bool
    let actions: FileActions

    static func == (a: MessageRow, b: MessageRow) -> Bool { a.busy == b.busy && a.message == b.message }

    var body: some View {
        if message.role == "user" { userBody } else { assistantBody }
    }

    private var userBody: some View {
        VStack(alignment: .trailing, spacing: 6) {
            Text(message.text ?? "")
                .textSelection(.enabled)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            if let files = message.attachments {
                ForEach(files) { file in
                    Button { actions.open(file.path, nil) } label: { Label(file.name, systemImage: "paperclip") }.buttonStyle(.link).font(.caption)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var assistantBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array((message.blocks ?? []).enumerated()), id: \.offset) { _, block in
                BlockView(block: block, actions: actions)
            }
            if let error = message.error {
                Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 7))
            }
            if busy && message.error == nil { ProgressView().controlSize(.small) }
            if message.interrupted == true { Text("已停止生成 · 可以发送下一条消息继续").font(.caption).foregroundStyle(.secondary) }
            if !busy { footer }
        }
    }

    @ViewBuilder private var footer: some View {
        let text = (message.blocks ?? []).filter { $0.type == "text" }.compactMap(\.text).joined(separator: "\n\n")
        let parts = [message.model, message.durationMs.map { String(format: "%.1fs", $0 / 1000) }, message.costUSD.map { String(format: "$%.4f", $0) }].compactMap { $0 }
        if !text.isEmpty || !parts.isEmpty {
            HStack(spacing: 10) {
                if !text.isEmpty {
                    Button("复制回复") { copyToPasteboard(text) }.buttonStyle(.plain)
                }
                Text(parts.joined(separator: " · "))
            }
            .font(.caption2).foregroundStyle(.secondary)
        }
    }
}

func copyToPasteboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}

struct BlockView: View {
    let block: Block
    let actions: FileActions

    var body: some View {
        switch block.type {
        case "text": MarkdownView(text: block.text ?? "", actions: actions)
        case "thinking":
            DisclosureGroup("思考过程") {
                Text(block.text ?? "").font(.callout).foregroundStyle(.secondary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(.callout).foregroundStyle(.secondary)
        case "tool": ToolCard(block: block, actions: actions)
        case "notice":
            Text(block.text ?? "").font(.caption)
                .foregroundStyle(block.level == "error" ? Color.red : Color.secondary)
                .frame(maxWidth: .infinity, alignment: block.level == "boundary" ? .center : .leading)
                .padding(.vertical, 6)
                .overlay(alignment: .top) { if block.level == "boundary" { Divider() } }
                .overlay(alignment: .bottom) { if block.level == "boundary" { Divider() } }
        default: EmptyView()
        }
    }
}

struct ToolCard: View {
    let block: Block
    let actions: FileActions
    @State private var expanded: Bool?

    private var presentation: ToolPresentation { ToolPresentation(name: block.name, input: block.input) }
    private var isOpen: Binding<Bool> {
        Binding(get: { expanded ?? (presentation.startsOpen || block.status == "error") }, set: { expanded = $0 })
    }
    private var dotColor: Color {
        switch block.status {
        case "running": return .orange
        case "error": return .red
        case "stopped", "history": return .gray
        default: return .green
        }
    }
    private var statusText: String {
        if block.status == "running" { return block.elapsed.map { "\(Int($0))s" } ?? "执行中" }
        return ["error": "失败", "stopped": "已停止"][block.status ?? ""] ?? ""
    }

    var body: some View {
        let view = presentation
        DisclosureGroup(isExpanded: isOpen) {
            VStack(alignment: .leading, spacing: 6) {
                if let summary = block.summary { Text(summary).font(.caption).foregroundStyle(.secondary) }
                if let body = view.body { ToolBodyView(body: body, actions: actions) }
                if let children = block.children, !children.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(children) { child in
                            let step = ToolPresentation(name: child.name, input: child.input)
                            HStack(spacing: 8) {
                                Text(step.title).fontWeight(.medium).foregroundStyle(child.status == "running" ? Color.orange : child.status == "error" ? Color.red : Color.primary)
                                Text(step.file ?? step.subject ?? "").foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                    .font(.caption)
                }
                if let text = block.agentText { Text(text).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                if let output = block.output, !output.isEmpty, !view.hidesOutput || block.status == "error" {
                    CodeBlock(text: output, color: block.status == "error" ? .red : .secondary)
                }
            }
            .padding(.top, 4)
        } label: {
            HStack(spacing: 7) {
                Circle().fill(dotColor).frame(width: 6, height: 6)
                Text(view.title).fontWeight(.medium)
                if let file = view.file {
                    Button(file) { actions.open(file, view.line) }.buttonStyle(.link).lineLimit(1).truncationMode(.head)
                }
                if let subject = view.subject { Text(subject).foregroundStyle(.secondary).lineLimit(1) }
                Spacer(minLength: 4)
                if !statusText.isEmpty { Text(statusText).foregroundStyle(block.status == "error" ? Color.red : Color.secondary) }
            }
            .font(.caption)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.secondary.opacity(0.18)))
    }
}

struct ToolBodyView: View {
    let body_: ToolPresentation.Body
    let actions: FileActions
    init(body: ToolPresentation.Body, actions: FileActions) { body_ = body; self.actions = actions }

    var body: some View {
        switch body_ {
        case .command(let text): CodeBlock(text: text, color: .primary)
        case .code(let text): CodeBlock(text: text, color: .secondary)
        case .diff(let rows): DiffView(rows: rows, maxHeight: 420)
        case .markdown(let text): MarkdownView(text: text, actions: actions)
        case .todos(let items): TodoList(items: items)
        }
    }
}

struct TodoList: View {
    let items: [TodoItem]
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(items) { item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: item.status == "completed" ? "checkmark.circle.fill" : item.status == "in_progress" ? "circle.lefthalf.filled" : "circle")
                        .foregroundStyle(item.status == "in_progress" ? Color.orange : Color.secondary)
                    Text(item.text)
                        .strikethrough(item.status == "completed")
                        .foregroundStyle(item.status == "completed" ? Color.secondary : Color.primary)
                        .fontWeight(item.status == "in_progress" ? .semibold : .regular)
                }
            }
        }
        .font(.callout)
    }
}

struct CodeBlock: View {
    let text: String
    var color: Color = .primary

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            Text(text).font(.system(size: 11, design: .monospaced)).foregroundStyle(color).textSelection(.enabled)
                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 320)
        .fixedSize(horizontal: false, vertical: true)
        .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 5))
    }
}

struct DiffView: View {
    let rows: [DiffRow]
    var maxHeight: CGFloat? = nil

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    Text(prefix(row) + row.text)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(foreground(row))
                        .padding(.horizontal, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(rowBackground(row))
                }
            }
            .textSelection(.enabled)
        }
        .frame(maxHeight: maxHeight)
    }
    private func prefix(_ row: DiffRow) -> String {
        switch row.kind { case .added: return "+ "; case .removed: return "- "; case .context: return "  "; case .hunk: return "" }
    }
    private func foreground(_ row: DiffRow) -> Color {
        switch row.kind { case .added: return .green; case .removed: return .red; case .hunk: return .blue; case .context: return .primary }
    }
    private func rowBackground(_ row: DiffRow) -> Color {
        switch row.kind { case .added: return .green.opacity(0.1); case .removed: return .red.opacity(0.1); case .hunk: return .blue.opacity(0.06); case .context: return .clear }
    }
}

struct MarkdownView: View {
    let text: String
    let actions: FileActions

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(parseMarkdown(text).enumerated()), id: \.offset) { _, block in blockView(block) }
        }
        .environment(\.openURL, OpenURLAction { url in
            // Links such as `src/app.js` refer to the server; only web links leave the app.
            if ["http", "https"].contains(url.scheme ?? "") { return .systemAction }
            let raw = url.absoluteString.replacingOccurrences(of: "rcc-file:", with: "").removingPercentEncoding ?? url.path
            if let reference = remotePathReference(raw) { actions.open(reference.path, reference.line) }
            return .handled
        })
    }

    @ViewBuilder private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let value):
            inline(value).font(headingFont(level)).fontWeight(.semibold).padding(.top, 6)
        case .paragraph(let value): inline(value)
        case .code(_, let value):
            VStack(alignment: .trailing, spacing: 0) {
                Button("复制代码") { copyToPasteboard(value) }.buttonStyle(.plain).font(.caption2).foregroundStyle(.secondary).padding(4)
                ScrollView(.horizontal) {
                    Text(value).font(.system(size: 12, design: .monospaced)).textSelection(.enabled).padding(.horizontal, 10).padding(.bottom, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 7))
        case .list(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(item.marker).foregroundStyle(.secondary)
                        inline(item.text)
                    }
                    .padding(.leading, CGFloat(item.indent) * 14)
                }
            }
        case .quote(let value):
            inline(value).foregroundStyle(.secondary).padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(Color.secondary.opacity(0.4)).frame(width: 3) }
        case .table(let rows):
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 5) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                inline(cell).fontWeight(index == 0 ? .semibold : .regular)
                            }
                        }
                        if index == 0 { Divider() }
                    }
                }
                .padding(8)
            }
            .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
        case .rule: Divider()
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title2
        case 2: return .title3
        default: return .headline
        }
    }

    private func inline(_ value: String) -> Text {
        // Code spans that look like file paths become links back into the app.
        var attributed = (try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value)
        for run in attributed.runs where run.inlinePresentationIntent?.contains(.code) == true {
            let content = String(attributed[run.range].characters)
            if remotePathReference(content) != nil, let url = URL(string: "rcc-file:" + (content.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? content)) {
                attributed[run.range].link = url
            }
        }
        return Text(attributed)
    }
}
#endif
