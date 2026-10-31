#if canImport(SwiftUI)
import SwiftUI
import AppKit
import UniformTypeIdentifiers
import RemoteCCCore

struct ComposerArea: View {
    @EnvironmentObject private var model: AppModel
    @State private var caret = 0
    @State private var selection = 0
    @State private var dismissedText: String?
    @State private var mentions: [FileEntry] = []
    @State private var mentionTask: Task<Void, Never>?
    @State private var dropTarget = false

    private var id: String { model.activeId ?? "" }
    private var text: Binding<String> {
        Binding(get: { model.drafts[id] ?? "" }, set: { model.drafts[id] = $0 })
    }

    private var completions: [RemoteCommand] {
        let value = text.wrappedValue
        guard value != dismissedText, let token = CommandCompletion.token(value, caret: caret), let commands = model.active?.capabilities?.commands else { return [] }
        return CommandCompletion.match(CommandCompletion.candidates(commands), query: token.query)
    }

    /// `@query` immediately before the caret.
    private var mentionRange: NSRange? {
        let value = text.wrappedValue as NSString
        guard caret <= value.length else { return nil }
        let before = value.substring(to: caret)
        guard let range = before.range(of: "(^|\\s)@[^\\s@]*$", options: .regularExpression) else { return nil }
        let match = NSRange(range, in: before)
        let at = (before as NSString).range(of: "@", options: .backwards, range: match)
        return NSRange(location: at.location, length: caret - at.location)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let session = model.active {
                todoStrip(session)
                ForEach(session.permissions) { permission in
                    PermissionCard(permission: permission).id(permission.id)
                }
                queue(session)
            }
            if !completions.isEmpty { commandMenu }
            else if !mentions.isEmpty { mentionMenu }
            VStack(alignment: .leading, spacing: 6) {
                attachmentChips
                PromptEditor(text: text, caret: $caret, placeholder: "发送消息…", handler: handleKey, onPasteImage: { model.pasteImage($0) })
                    .frame(minHeight: 44, maxHeight: 160)
                toolbarRow
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 12).strokeBorder(dropTarget ? Color.accentColor : Color.secondary.opacity(0.3)))
            .onDrop(of: [.fileURL], isTargeted: $dropTarget) { providers in
                for provider in providers {
                    _ = provider.loadObject(ofClass: URL.self) { url, _ in
                        if let url { Task { @MainActor in model.upload([url]) } }
                    }
                }
                return true
            }
            HStack {
                Text(activity).lineLimit(1)
                Spacer()
                Text(model.transferStatus).lineLimit(1)
            }
            .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 22).padding(.bottom, 12).padding(.top, 8)
        .frame(maxWidth: 860)
        .frame(maxWidth: .infinity)
        .onChange(of: text.wrappedValue) { refreshMentions() }
        .onChange(of: caret) { selection = 0 }
    }

    private var activity: String {
        guard let session = model.active else { return "Enter 发送 · Shift + Enter 换行" }
        if session.status == "detached" { return "重新连接 SSH 后同步远端任务" }
        guard session.isBusy else { return "Enter 发送 · Shift + Enter 换行" }
        let message = session.messages.last
        if let activity = message?.activity { return activity + " · Enter 排队" }
        if let running = message?.blocks?.last(where: { $0.type == "tool" && $0.status == "running" }) {
            let view = ToolPresentation(name: running.name, input: running.input)
            let subject = view.file.map { ($0 as NSString).lastPathComponent } ?? view.subject ?? ""
            return "\(view.title) \(subject)" + (running.elapsed.map { " · \(Int($0))s" } ?? "") + " · Enter 排队"
        }
        return statusLabel(session.status) + " · Enter 排队"
    }

    @ViewBuilder private func todoStrip(_ session: ChatSession) -> some View {
        if ["working", "permission", "connecting", "detached"].contains(session.status),
           let block = session.messages.last?.blocks?.last(where: { $0.name == "TodoWrite" }),
           case .todos(let items)? = ToolPresentation(name: block.name, input: block.input).body, !items.isEmpty {
            ScrollView { TodoList(items: items).padding(8).frame(maxWidth: .infinity, alignment: .leading) }
                .frame(maxHeight: 130).fixedSize(horizontal: false, vertical: true)
                .background(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.secondary.opacity(0.2)))
        }
    }

    @ViewBuilder private func queue(_ session: ChatSession) -> some View {
        if let queue = session.queue, !queue.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(session.queuePaused == true ? "队列已暂停" : "回复完成后依次发送").foregroundStyle(.secondary)
                    if session.queuePaused == true {
                        Button("继续队列") { model.perform { try model.engine?.resumeQueue(session.id) } }.disabled(!model.isConnected)
                    }
                }
                ForEach(queue) { item in
                    HStack {
                        Text(item.text).lineLimit(1)
                        Spacer()
                        Button("取消") { model.perform { try model.engine?.cancelQueued(session.id, item: item.id) } }
                    }
                }
            }
            .font(.caption).controlSize(.small)
        }
    }

    private var commandMenu: some View {
        MenuList(count: completions.count, selection: selection) { index in
            let command = completions[index]
            return AnyView(Button { choose(command, execute: false) } label: {
                HStack(spacing: 10) {
                    Text("/" + command.name).font(.system(size: 12, design: .monospaced)).frame(minWidth: 90, alignment: .leading)
                    Text((command.description ?? "").components(separatedBy: "\n").first ?? "").foregroundStyle(.secondary).lineLimit(1)
                    Spacer()
                    Text(command.argumentHint ?? "").font(.caption2).foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }.buttonStyle(.plain))
        }
    }

    private var mentionMenu: some View {
        MenuList(count: mentions.count, selection: selection) { index in
            let file = mentions[index]
            return AnyView(Button { chooseMention(file) } label: {
                Text(file.relative ?? file.name).font(.system(size: 12, design: .monospaced)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).help(file.path))
        }
    }

    @ViewBuilder private var attachmentChips: some View {
        if let files = model.attachments[id], !files.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(files) { file in
                        HStack(spacing: 5) {
                            Button(file.name) { model.open(file.path) }.buttonStyle(.plain).help(file.path)
                            Button { model.attachments[id]?.removeAll { $0.path == file.path } } label: { Image(systemName: "xmark") }.buttonStyle(.plain).help("移除附件")
                        }
                        .font(.caption).padding(.horizontal, 7).padding(.vertical, 4)
                        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 5))
                    }
                }
            }
        }
    }

    private var toolbarRow: some View {
        let session = model.active
        let preferences = session?.preferences
        let modelName = preferences?.selectedModel.flatMap { $0.isEmpty ? nil : $0 }
        let displayed = session?.capabilities?.models.first { $0.value == (modelName ?? "default") }?.displayName ?? modelName ?? session?.model ?? "模型"
        let modes = ["default": "默认权限", "plan": "计划", "acceptEdits": "自动编辑", "dontAsk": "拒绝未授权", "auto": "自动权限"]
        let busy = session?.isBusy ?? false
        return HStack(spacing: 10) {
            Button { model.pickAndUpload() } label: { Image(systemName: "plus") }.buttonStyle(.plain).help("上传文件并附加").disabled(!model.isConnected)
            Text("\(session?.host ?? "未连接") / \(session?.directory ?? "~")").font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
            Spacer()
            Button(modes[preferences?.permissionMode ?? "default"] ?? "默认权限") { model.showPreferences = true }.buttonStyle(.plain).font(.caption2).foregroundStyle(.secondary)
            Button(displayed) { model.showPreferences = true }.buttonStyle(.plain).font(.caption2).foregroundStyle(.secondary).lineLimit(1).help(session?.model.map { "上一轮实际模型：" + $0 } ?? "选择模型")
            if busy {
                Button { model.stop() } label: { Image(systemName: "stop.circle.fill").font(.title2) }.buttonStyle(.plain).help("停止生成").disabled(session?.status == "stopping" || !model.isConnected)
            }
            Button { send() } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                .buttonStyle(.plain).help(busy ? "排队，当前回复完成后发送" : "发送消息")
                .disabled(session?.historyLoaded == false || !model.isConnected || (text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (model.attachments[id] ?? []).isEmpty))
        }
    }

    private func send() { model.submit(text: text.wrappedValue) }

    private func handleKey(_ key: PromptKey) -> Bool {
        if !completions.isEmpty {
            switch key {
            case .up: selection = (selection - 1 + completions.count) % completions.count; return true
            case .down: selection = (selection + 1) % completions.count; return true
            case .tab: choose(completions[min(selection, completions.count - 1)], execute: false); return true
            case .enter: choose(completions[min(selection, completions.count - 1)], execute: true); return true
            case .escape: dismissedText = text.wrappedValue; return true
            }
        }
        if !mentions.isEmpty {
            switch key {
            case .up: selection = (selection - 1 + mentions.count) % mentions.count; return true
            case .down: selection = (selection + 1) % mentions.count; return true
            case .tab, .enter: chooseMention(mentions[min(selection, mentions.count - 1)]); return true
            case .escape: mentions = []; return true
            }
        }
        switch key {
        case .enter: send(); return true
        case .escape:
            if model.active?.isBusy == true { model.stop(); return true }
            return false
        default: return false
        }
    }

    private func choose(_ command: RemoteCommand, execute: Bool) {
        guard let token = CommandCompletion.token(text.wrappedValue, caret: caret) else { return }
        let completed = CommandCompletion.complete(text.wrappedValue, stop: token.stop, command: command)
        text.wrappedValue = completed
        dismissedText = completed
        caret = (completed as NSString).length
        if execute { send() }
    }

    private func refreshMentions() {
        mentionTask?.cancel()
        guard let range = mentionRange, let workspace = model.activeWorkspace, model.isConnected else { mentions = []; return }
        let query = String((text.wrappedValue as NSString).substring(with: range).dropFirst())
        mentionTask = Task {
            try? await Task.sleep(nanoseconds: 120_000_000)
            guard !Task.isCancelled, let found = try? await workspace.suggest(query), !Task.isCancelled else { return }
            mentions = found
            selection = 0
        }
    }

    private func chooseMention(_ file: FileEntry) {
        if let range = mentionRange { text.wrappedValue = (text.wrappedValue as NSString).replacingCharacters(in: range, with: "") }
        mentions = []
        model.attach(file.path)
    }
}

struct MenuList: View {
    let count: Int
    let selection: Int
    let row: (Int) -> AnyView

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(0..<count, id: \.self) { index in
                        row(index)
                            .padding(.horizontal, 8).padding(.vertical, 6)
                            .background(index == selection ? Color.secondary.opacity(0.15) : Color.clear, in: RoundedRectangle(cornerRadius: 5))
                            .id(index)
                    }
                }
                .padding(4)
            }
            .frame(maxHeight: 260)
            .fixedSize(horizontal: false, vertical: true)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.secondary.opacity(0.25)))
            .onChange(of: selection) { proxy.scrollTo(selection) }
        }
    }
}

enum PromptKey { case up, down, tab, enter, escape }

/// NSTextView rather than TextEditor: Enter handling must respect Chinese input-method composition,
/// which only the AppKit text system can report.
struct PromptEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var caret: Int
    let placeholder: String
    let handler: (PromptKey) -> Bool
    let onPasteImage: (Data) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        let original = scroll.documentView as! NSTextView
        let view = PasteAwareTextView(frame: original.frame, textContainer: original.textContainer)
        view.minSize = original.minSize; view.maxSize = original.maxSize
        view.isVerticallyResizable = true; view.isHorizontallyResizable = false
        view.autoresizingMask = original.autoresizingMask
        view.isRichText = false; view.allowsUndo = true; view.drawsBackground = false
        view.isAutomaticQuoteSubstitutionEnabled = false; view.isAutomaticDashSubstitutionEnabled = false
        view.font = .systemFont(ofSize: 13)
        view.delegate = context.coordinator
        view.onPasteImage = onPasteImage
        scroll.documentView = view
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? NSTextView else { return }
        // Never rewrite the text during input-method composition.
        if view.string != text, !view.hasMarkedText() {
            view.string = text
            view.setSelectedRange(NSRange(location: min(caret, (text as NSString).length), length: 0))
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: PromptEditor
        init(_ parent: PromptEditor) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            parent.caret = view.selectedRange().location
            parent.text = view.string
        }
        func textViewDidChangeSelection(_ notification: Notification) {
            guard let view = notification.object as? NSTextView, !view.hasMarkedText() else { return }
            let location = view.selectedRange().location
            if parent.caret != location { DispatchQueue.main.async { self.parent.caret = location } }
        }
        func textView(_ view: NSTextView, doCommandBy selector: Selector) -> Bool {
            // During composition these keys belong to the input method.
            if view.hasMarkedText() { return false }
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                if NSEvent.modifierFlags.contains(.shift) { view.insertNewlineIgnoringFieldEditor(nil); return true }
                return parent.handler(.enter)
            case #selector(NSResponder.moveUp(_:)): return parent.handler(.up)
            case #selector(NSResponder.moveDown(_:)): return parent.handler(.down)
            case #selector(NSResponder.insertTab(_:)): return parent.handler(.tab)
            case #selector(NSResponder.cancelOperation(_:)): return parent.handler(.escape)
            default: return false
            }
        }
    }
}

final class PasteAwareTextView: NSTextView {
    var onPasteImage: ((Data) -> Void)?

    override func paste(_ sender: Any?) {
        let board = NSPasteboard.general
        // Text wins when both exist, so copied rich text is not uploaded as a picture.
        if board.string(forType: .string) == nil, let image = NSImage(pasteboard: board), let tiff = image.tiffRepresentation,
           let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            onPasteImage?(png)
            return
        }
        super.paste(sender)
    }
}

struct PermissionCard: View {
    @EnvironmentObject private var model: AppModel
    let permission: PermissionRequest
    @State private var answers: [String: String] = [:]
    @State private var reason = ""
    @State private var useRules = false
    @State private var sending = false
    @State private var error = ""
    @State private var form: [String: JSON] = [:]

    private var actions: FileActions { FileActions(open: { model.open($0, line: $1) }) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if permission.kind == "elicitation" { elicitation } else { approval }
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.yellow.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.orange.opacity(0.3)))
        .font(.callout)
    }

    private func submit(_ answer: JSON) {
        sending = true; error = ""
        Task {
            do { try await model.respond(permission, answer: answer) }
            catch { self.error = error.localizedDescription; sending = false }
        }
    }

    @ViewBuilder private var approval: some View {
        let question = permission.name == "AskUserQuestion"
        let view = ToolPresentation(name: permission.name, input: permission.input)
        Text(question ? "Claude 想确认一下" : permission.name == "ExitPlanMode" ? "Claude 的计划，确认后开始执行" : permission.title ?? "Claude 请求使用 \(permission.name ?? "工具")").fontWeight(.semibold)
        if let description = permission.description, !description.isEmpty { Text(description).font(.caption).foregroundStyle(.secondary) }
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                if question { questions }
                else {
                    if let file = view.file { Button(file) { model.open(file) }.buttonStyle(.link) }
                    if let subject = view.subject, permission.name != "Bash" { Text(subject).foregroundStyle(.secondary) }
                    if let body = view.body { ToolBodyView(body: body, actions: actions) }
                    else if view.file == nil && view.subject == nil { CodeBlock(text: permission.input?.text(pretty: true) ?? "") }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 300).fixedSize(horizontal: false, vertical: true)
        if let suggestions = permission.suggestions?.array, !suggestions.isEmpty {
            DisclosureGroup("远端建议的权限规则") { CodeBlock(text: permission.suggestions?.text(pretty: true) ?? "") }.font(.caption)
            Toggle("应用以上权限规则 · " + scope(suggestions), isOn: $useRules).font(.caption)
        }
        TextField("拒绝时给 Claude 的说明（可选）", text: $reason).textFieldStyle(.roundedBorder).font(.caption)
        HStack {
            Spacer()
            Button("拒绝") { submit(["allow": false, "reason": .string(reason)]) }
            Button(question ? "提交回答" : useRules ? "应用规则并允许" : "允许这一次") { allow() }.keyboardShortcut(.defaultAction)
        }
        .disabled(sending)
    }

    private func allow() {
        var answer: JSON = ["allow": true, "useSuggestedPermissions": .bool(useRules)]
        if permission.name == "AskUserQuestion" {
            let list = (permission.input?["questions"]?.array ?? []).compactMap { $0["question"]?.string }
            if list.contains(where: { (answers[$0] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }) { error = "请填写回答"; return }
            answer["answers"] = .object(answers.mapValues(JSON.string))
        }
        submit(answer)
    }

    private func scope(_ suggestions: [JSON]) -> String {
        let names = ["session": "本次运行", "localSettings": "此项目的本地设置", "projectSettings": "此项目的共享设置", "userSettings": "远端用户的所有项目", "cliArg": "本次启动参数"]
        var seen: [String] = []
        for destination in suggestions.compactMap({ $0["destination"]?.string }) {
            let name = names[destination] ?? destination
            if !seen.contains(name) { seen.append(name) }
        }
        return seen.joined(separator: "、")
    }

    @ViewBuilder private var questions: some View {
        ForEach(permission.input?["questions"]?.array ?? [], id: \.self) { item in
            if let question = item["question"]?.string {
                VStack(alignment: .leading, spacing: 5) {
                    Text(question)
                    TextField("输入你的回答，也可选择下方建议", text: Binding(get: { answers[question] ?? "" }, set: { answers[question] = $0 })).textFieldStyle(.roundedBorder)
                    FlowOptions(options: (item["options"]?.array ?? []).compactMap { option in option["label"]?.string.map { ($0, option["description"]?.string ?? "") } }, selected: selectedOptions(question), toggle: { toggle($0, question: question, multiple: item["multiSelect"]?.isTruthy == true) })
                }
            }
        }
    }

    private func selectedOptions(_ question: String) -> Set<String> {
        Set((answers[question] ?? "").components(separatedBy: ", "))
    }

    private func toggle(_ label: String, question: String, multiple: Bool) {
        guard multiple else { answers[question] = label; return }
        var chosen = (answers[question] ?? "").components(separatedBy: ", ").filter { !$0.isEmpty }
        if let index = chosen.firstIndex(of: label) { chosen.remove(at: index) } else { chosen.append(label) }
        answers[question] = chosen.joined(separator: ", ")
    }

    @ViewBuilder private var elicitation: some View {
        let request = permission.request
        Text(request?["title"]?.string ?? "需要你的输入").fontWeight(.semibold)
        if let server = request?["serverName"]?.string { Text(server).font(.caption2).foregroundStyle(.secondary) }
        if let message = request?["message"]?.string { Text(message).textSelection(.enabled) }
        if request?["mode"]?.string == "url", let link = request?["url"]?.string, let url = URL(string: link), ["http", "https"].contains(url.scheme ?? "") {
            Text(link).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            // Opening is the user's click; it is not treated as proof that authorization succeeded.
            Button("打开 " + (url.host ?? link)) { NSWorkspace.shared.open(url) }
            actionRow(acceptTitle: "已完成，继续", supported: true) { ["action": "accept"] }
        } else if let fields = try? SchemaField.fields(request?["requestedSchema"]) {
            ForEach(fields) { field in SchemaFieldView(field: field, values: $form) }
            actionRow(acceptTitle: "提交", supported: true) { ["action": "accept", "content": .object(form)] }
        } else {
            Text("此表单包含暂不支持的结构，可以拒绝或取消。").font(.caption).foregroundStyle(.secondary)
            actionRow(acceptTitle: "提交", supported: false) { ["action": "accept"] }
        }
    }

    private func actionRow(acceptTitle: String, supported: Bool, accept: @escaping () -> JSON) -> some View {
        HStack {
            Spacer()
            Button("取消") { submit(["interaction": ["action": "cancel"]]) }
            Button("拒绝") { submit(["interaction": ["action": "decline"]]) }
            Button(acceptTitle) { submit(["interaction": accept()]) }.keyboardShortcut(.defaultAction).disabled(!supported)
        }
        .disabled(sending)
    }
}

struct FlowOptions: View {
    let options: [(String, String)]
    let selected: Set<String>
    let toggle: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 5) {
                ForEach(options, id: \.0) { option in
                    Button(option.0) { toggle(option.0) }
                        .buttonStyle(.bordered).controlSize(.small)
                        .tint(selected.contains(option.0) ? Color.accentColor : Color.secondary)
                        .help(option.1)
                }
            }
        }
    }
}

struct SchemaFieldView: View {
    let field: SchemaField
    @Binding var values: [String: JSON]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            switch field.kind {
            case .boolean:
                Toggle(field.label, isOn: Binding(get: { values[field.name]?.bool ?? field.defaultValue?.bool ?? false }, set: { values[field.name] = .bool($0) }))
                    .onAppear { if values[field.name] == nil { values[field.name] = .bool(field.defaultValue?.bool ?? false) } }
            case .choice:
                Picker(field.label, selection: Binding(get: { values[field.name]?.string ?? "" }, set: { values[field.name] = .string($0) })) {
                    Text("请选择").tag("")
                    ForEach(field.options) { Text($0.label).tag($0.value) }
                }
                .onAppear { if let value = field.defaultValue, values[field.name] == nil { values[field.name] = value } }
            case .multiChoice:
                Text(field.label)
                ForEach(field.options) { option in
                    Toggle(option.label, isOn: Binding(get: { (values[field.name]?.array ?? []).contains(.string(option.value)) }, set: { on in
                        var list = values[field.name]?.array ?? []
                        list.removeAll { $0 == .string(option.value) }
                        if on { list.append(.string(option.value)) }
                        values[field.name] = .array(list)
                    }))
                }
            case .number, .integer:
                TextField(field.label, text: Binding(get: { values[field.name]?.double.map { field.kind == .integer ? String(Int($0)) : String($0) } ?? "" }, set: { text in
                    // An empty field means no answer, which the worker checks against `required`.
                    values[field.name] = Double(text).map(JSON.number)
                })).textFieldStyle(.roundedBorder)
            case .text:
                TextField(field.label, text: Binding(get: { values[field.name]?.string ?? field.defaultValue?.string ?? "" }, set: { values[field.name] = .string($0) })).textFieldStyle(.roundedBorder)
            }
            if let description = field.description { Text(description).font(.caption2).foregroundStyle(.secondary) }
        }
    }
}
#endif
