#if canImport(SwiftUI)
import SwiftUI
import MarkdownUI
import AppKit
import RemoteCCCore

struct ChatView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            if model.active == nil {
                MachineHomeView()
            } else if let session = model.active, !session.messages.isEmpty || session.remoteHistoryRef != nil {
                MessagesList(session: session).id(session.id)
                ComposerArea()
            } else {
                WelcomeView()
            }
        }
        .background(WorkbenchTheme.canvas)
    }
}

struct WelcomeView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 48)
            VStack(spacing: 28) {
                HStack(spacing: 12) {
                    Image(systemName: "terminal").font(.system(size: 28, weight: .medium)).foregroundStyle(WorkbenchTheme.accent)
                    Text("今天，想完成什么？")
                        .font(.system(size: 30, weight: .regular, design: .serif)).tracking(-0.6)
                }
                ComposerArea()
                HStack(spacing: 8) {
                    suggestion("了解项目", icon: "folder", prompt: "请梳理这个项目的目录结构、技术栈和主要入口。")
                    suggestion("检查代码", icon: "text.magnifyingglass", prompt: "请检查当前项目，找出影响使用的问题并给出改进建议。")
                    suggestion("实现功能", icon: "chevron.left.forwardslash.chevron.right", prompt: "我想实现一个新功能：")
                }
                .opacity((model.drafts[model.activeId ?? "welcome"] ?? "").isEmpty ? 1 : 0)
                .disabled(!(model.drafts[model.activeId ?? "welcome"] ?? "").isEmpty)
                .accessibilityHidden(!(model.drafts[model.activeId ?? "welcome"] ?? "").isEmpty)
            }
            .frame(maxWidth: 600).padding(.horizontal, 36)
            Spacer(minLength: 80)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func suggestion(_ title: String, icon: String, prompt: String) -> some View {
        Button { model.drafts[model.activeId ?? "welcome"] = prompt; model.composerFocus = UUID() } label: {
            Label(title, systemImage: icon).font(.system(size: 12))
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(WorkbenchTheme.surface.opacity(0.65), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(WorkbenchTheme.border))
        }.buttonStyle(.plain)
    }
}

struct MessagesList: View {
    @EnvironmentObject private var model: AppModel
    let session: ChatSession
    @State private var followsReply = true

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    if session.remoteHistoryRef != nil { HistoryNotice(session: session) }
                    ForEach(Array(session.messages.enumerated()), id: \.element.id) { index, message in
                        // Equatable lets unchanged messages skip rendering while the last one streams.
                        MessageRow(message: message, busy: index == session.messages.count - 1 && session.isBusy, sessionStatus: session.status, showHeader: index == 0 || session.messages[index - 1].role != "assistant", actions: FileActions(open: { model.open($0, line: $1) }))
                            .equatable()
                            .id(message.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 32).padding(.vertical, 32)
                .frame(maxWidth: 1080, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .background(ScrollReadingDetector { followsReply = false })
            .overlay(alignment: .bottomTrailing) {
                if !followsReply {
                    Button {
                        followsReply = true
                        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                    } label: { Label("回到最新", systemImage: "arrow.down") }
                        .buttonStyle(WorkbenchButtonStyle()).shadow(color: .black.opacity(0.08), radius: 8, y: 3).padding(16)
                }
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: followsReply) { if followsReply { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: session.messages.last) { if followsReply { proxy.scrollTo("bottom", anchor: .bottom) } }
        }
    }
}

struct HistoryNotice: View {
    @EnvironmentObject private var model: AppModel
    let session: ChatSession

    var body: some View {
        HStack {
            if let error = model.historyRefreshErrors[session.id] { Text(error).foregroundStyle(.orange) }
            if model.refreshingHistory.contains(session.id) { ProgressView().controlSize(.mini) }
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
    var sessionStatus: String = "idle"
    var showHeader = true
    let actions: FileActions
    @EnvironmentObject private var model: AppModel
    @State private var copied = false
    @State private var showRewind = false

    static func == (a: MessageRow, b: MessageRow) -> Bool { a.busy == b.busy && a.sessionStatus == b.sessionStatus && a.showHeader == b.showHeader && a.message == b.message }

    var body: some View {
        Group { if message.role == "user" { userBody } else { assistantBody } }
            .sheet(isPresented: $showRewind) {
                if let checkpoint = message.checkpointId, let id = model.activeId { RewindSheet(sessionId: id, checkpoint: checkpoint) }
            }
    }

    private var userBody: some View {
        VStack(alignment: .trailing, spacing: 6) {
            Text(message.text ?? "")
                .textSelection(.enabled)
                .font(.system(size: 14)).lineSpacing(5)
                .padding(.horizontal, 20).padding(.vertical, 14)
                .background(WorkbenchTheme.userBubble, in: RoundedRectangle(cornerRadius: 20))
            if let files = message.attachments {
                ForEach(files) { file in
                    ChatAttachmentView(file: file)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var assistantBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showHeader && busy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.mini)
                    Text(activityLabel).font(.system(size: 12)).foregroundStyle(.secondary)
                }.padding(.bottom, 10)
                Divider().padding(.bottom, 8)
            }
            ForEach(Array((message.blocks ?? []).enumerated()), id: \.offset) { index, block in
                BlockView(block: block, actions: actions, thinkingActive: busy && sessionStatus == "working" && index == (message.blocks?.count ?? 0) - 1)
            }
            if let issue = message.serviceIssue {
                VStack(alignment: .leading, spacing: 6) {
                    Label(issue["title"]?.string ?? "服务暂不可用", systemImage: "exclamationmark.circle").font(.system(size: 13, weight: .medium))
                    Text(issue["detail"]?.string ?? "").font(.system(size: 12)).textSelection(.enabled)
                    if let reset = issue["resetsAt"]?.double {
                        Text("预计恢复：" + Date(timeIntervalSince1970: reset).formatted(date: .abbreviated, time: .shortened)).font(.caption)
                    }
                }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            }
            if let error = message.error {
                VStack(alignment: .leading, spacing: 10) {
                    Label("本次回复未完成", systemImage: "exclamationmark.circle").font(.system(size: 13, weight: .medium))
                    Text(error).font(.system(size: 12)).textSelection(.enabled)
                    Button("重新编辑上一条请求") { restoreRequest() }
                        .buttonStyle(WorkbenchButtonStyle()).disabled(model.active?.isBusy == true)
                }.foregroundStyle(.red).padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.05), in: RoundedRectangle(cornerRadius: 12))
            }
            if busy && message.error == nil {
                HStack(spacing: 8) {
                    if sessionStatus == "permission" { Image(systemName: "hand.raised").foregroundStyle(WorkbenchTheme.accent) }
                    else { ProgressView().controlSize(.mini) }
                    Text(message.activity ?? activityLabel).font(.system(size: 12)).foregroundStyle(.secondary)
                }.padding(.vertical, 8).accessibilityElement(children: .combine)
            }
            if message.interrupted == true { Text("已停止生成 · 可以发送下一条消息继续").font(.caption).foregroundStyle(.secondary) }
            if !busy { footer }
        }
    }

    private var activityLabel: String {
        if sessionStatus == "permission" { return "需要你的确认，请查看输入框上方的请求" }
        if sessionStatus == "stopping" { return "正在停止，已生成的内容会保留…" }
        if sessionStatus == "detached" { return "连接已中断，等待重新同步远端任务" }
        if message.blocks?.contains(where: { $0.type == "tool" && $0.status == "running" }) == true { return "正在执行工具…" }
        if message.blocks?.last?.type == "thinking" { return "正在思考…" }
        return (message.blocks ?? []).isEmpty ? "等待 Claude 响应…" : "正在生成回复…"
    }

    private func restoreRequest() {
        guard let session = model.active,
              let index = session.messages.firstIndex(where: { $0.id == message.id }),
              let request = session.messages[..<index].last(where: { $0.role == "user" }) else { return }
        guard (model.drafts[session.id] ?? "").isEmpty, (model.attachments[session.id] ?? []).isEmpty else {
            model.show("输入框已有草稿，请先保留或发送草稿后再重新编辑。"); return
        }
        model.drafts[session.id] = request.text ?? ""
        model.attachments[session.id] = request.attachments ?? []
        model.composerFocus = UUID()
    }

    @ViewBuilder private var footer: some View {
        let text = (message.blocks ?? []).filter { $0.type == "text" }.compactMap(\.text).joined(separator: "\n\n")
        let parts = [message.model, message.durationMs.map { String(format: "%.1fs", $0 / 1000) }, message.costUSD.map { String(format: "$%.4f", $0) }].compactMap { $0 }
        if !text.isEmpty || !parts.isEmpty || message.checkpointId != nil {
            HStack(spacing: 10) {
                if !text.isEmpty {
                    Button { copyToPasteboard(text); copied = true } label: {
                        Label(copied ? "已复制" : "复制回复", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }.buttonStyle(QuietButtonStyle()).task(id: copied) {
                        if copied { try? await Task.sleep(nanoseconds: 2_000_000_000); copied = false }
                    }
                }
                if message.checkpointId != nil {
                    Button { showRewind = true } label: { Label("回退文件", systemImage: "arrow.uturn.backward") }.buttonStyle(QuietButtonStyle()).disabled(model.active?.isBusy == true || !model.isConnected)
                }
                Text(parts.joined(separator: " · ")).lineLimit(1).truncationMode(.middle)
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
    var thinkingActive = false

    var body: some View {
        switch block.type {
        case "text": MarkdownView(text: block.text ?? "", actions: actions)
        case "thinking": ThinkingCard(text: block.text ?? "", active: thinkingActive)
        case "tool": ToolCard(block: block, actions: actions)
        case "notice":
            Text(block.text ?? "").font(.caption)
                .foregroundStyle(block.level == "error" ? Color.red : Color.secondary)
                .frame(maxWidth: .infinity, alignment: block.level == "boundary" ? .center : .leading)
                .padding(.vertical, 6)
                .overlay(alignment: .top) { if block.level == "boundary" { Divider() } }
                .overlay(alignment: .bottom) { if block.level == "boundary" { Divider() } }
        default: Text(block.text ?? "暂不支持的消息类型：\(block.type)").font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct ToolCard: View {
    @EnvironmentObject private var model: AppModel
    let block: Block
    let actions: FileActions
    @State private var expanded: Bool?

    private var presentation: ToolPresentation { ToolPresentation(name: block.name, input: block.input) }
    private var isOpen: Binding<Bool> {
        Binding(get: { expanded ?? (block.status == "error") }, set: { expanded = $0 })
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
        return ["error": "失败", "stopped": "已停止", "history": "历史记录", "done": "已完成"][block.status ?? ""] ?? "待执行"
    }

    var body: some View {
        let view = presentation
        DisclosureGroup(isExpanded: isOpen) {
            VStack(alignment: .leading, spacing: 6) {
                if let file = view.file, ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"].contains(block.name ?? "") {
                    HStack {
                        Button("打开文件") { actions.open(file, view.line) }
                        Button("下载") { model.download(file) }
                        if block.name != "Read" { Button("查看变更") { model.panel = .changes; model.showFiles = true } }
                    }.font(.caption).disabled(!model.isConnected)
                }
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
                } else if block.name == "Read" {
                    Text(block.status == "running" ? "正在读取文件…" : block.status == "history" ? "这条历史记录没有保存读取结果，可打开文件查看当前内容。" : "未返回可显示的内容。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.top, 4)
        } label: {
            HStack(spacing: 7) {
                if block.status == "running" { ProgressView().controlSize(.mini) }
                else { Image(systemName: block.status == "error" ? "xmark.circle" : block.status == "done" ? "checkmark.circle" : "terminal").foregroundStyle(dotColor) }
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
        .padding(.vertical, 7).padding(.horizontal, 2)
        .foregroundStyle(.secondary)
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
        .defaultScrollAnchor(.topLeading)
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
        Markdown(text)
            .markdownTheme(.remoteCC)
            .textSelection(.enabled)
        .environment(\.openURL, OpenURLAction { url in
            // Links such as `src/app.js` refer to the server; only web links leave the app.
            if ["http", "https"].contains(url.scheme ?? "") { return .systemAction }
            let raw = url.absoluteString.replacingOccurrences(of: "rcc-file:", with: "").removingPercentEncoding ?? url.path
            if let reference = remotePathReference(raw) { actions.open(reference.path, reference.line) }
            return .handled
        })
    }

}
#endif
