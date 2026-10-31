#if canImport(SwiftUI)
import SwiftUI
import AppKit
import PDFKit
import RemoteCCCore

func gitColor(_ code: String?) -> Color {
    switch code {
    case "M", "R": return .orange
    case "A", "?": return .green
    case "D", "U": return .red
    default: return .primary
    }
}

func byteText(_ bytes: Int) -> String {
    bytes < 1024 ? "\(bytes) B" : bytes < 1_048_576 ? String(format: "%.1f KB", Double(bytes) / 1024) : String(format: "%.1f MB", Double(bytes) / 1_048_576)
}

struct FilePanel: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $model.panel) {
                ForEach(SidePanel.allCases) { panel in
                    if panel == .changes, let count = model.activeWorkspace?.gitStatus?.files.count, count > 0 { Text("变更 \(count)").tag(panel) }
                    else { Text(panel.rawValue).tag(panel) }
                }
            }
            .pickerStyle(.segmented).labelsHidden().padding(8)
            Divider()
            if let workspace = model.activeWorkspace, model.isConnected {
                switch model.panel {
                case .files: FileTreeView(workspace: workspace)
                case .changes: ChangesView(workspace: workspace)
                case .search: SearchView(workspace: workspace)
                }
            } else {
                ContentUnavailableView("未连接 SSH", systemImage: "network.slash").frame(maxHeight: .infinity)
            }
        }
    }
}

struct NamePrompt: Identifiable {
    enum Action { case newFile(String), newFolder(String), rename(FileEntry) }
    let id = UUID()
    let title: String
    let initial: String
    let action: Action
}

struct FileTreeView: View {
    @EnvironmentObject private var model: AppModel
    let workspace: Workspace
    @State private var path = ""
    @State private var prompt: NamePrompt?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                Button { Task { await workspace.goToParent() } } label: { Image(systemName: "arrow.up") }.buttonStyle(.plain).help("上一级")
                TextField("远端目录", text: $path).textFieldStyle(.roundedBorder).font(.system(size: 11, design: .monospaced))
                    .onSubmit { Task { await workspace.browse(path) } }
                Button { Task { await workspace.reload(force: true) } } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.plain).help("刷新")
            }
            .padding(.horizontal, 8).padding(.top, 8)
            HStack(spacing: 6) {
                Button("设为工作目录") { useFolder() }.disabled(workspace.root == nil)
                Button("上传") { model.pickAndUpload(to: workspace.root) }
                Button { if let root = workspace.root { prompt = NamePrompt(title: "新文件名称", initial: "", action: .newFile(root)) } } label: { Image(systemName: "doc.badge.plus") }.help("新建文件")
                Button { if let root = workspace.root { prompt = NamePrompt(title: "新文件夹名称", initial: "", action: .newFolder(root)) } } label: { Image(systemName: "folder.badge.plus") }.help("新建文件夹")
                Spacer()
                Toggle("隐藏文件", isOn: Binding(get: { workspace.showHidden }, set: { workspace.showHidden = $0 })).toggleStyle(.checkbox).font(.caption2)
            }
            .controlSize(.small).padding(8)
            if let error = workspace.error { Text(error).font(.caption).foregroundStyle(.red).padding(.horizontal, 10).textSelection(.enabled) }
            Divider()
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(workspace.rows) { row in rowView(row) }
                }
                .padding(4)
            }
            .overlay { if workspace.rows.isEmpty && workspace.error == nil && workspace.root != nil { Text("空目录").font(.caption).foregroundStyle(.secondary) } }
            Divider()
            Text(workspace.footer).font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(8)
        }
        .onAppear { path = workspace.root ?? model.active?.directory ?? "~" }
        .onChange(of: workspace.root) { if let root = workspace.root { path = root } }
        .sheet(item: $prompt) { NameSheet(prompt: $0, workspace: workspace) }
    }

    private func rowView(_ row: TreeRow) -> some View {
        let entry = row.entry
        let color = row.entry.broken == true ? Color.secondary : gitColor(row.gitCode)
        return HStack(spacing: 5) {
            Image(systemName: entry.directory ? (row.expanded ? "chevron.down" : "chevron.right") : "doc")
                .font(.system(size: 9)).foregroundStyle(.secondary).frame(width: 12)
            Text(entry.name + (entry.symlink == true ? " ↗" : ""))
                .font(.system(size: 12, weight: row.touched ? .semibold : .regular))
                .foregroundStyle(color)
                .strikethrough(entry.broken == true)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(row.gitCode.map { $0 == "?" ? "U" : $0 } ?? (entry.directory ? "" : byteText(entry.size)))
                .font(.system(size: 10)).foregroundStyle(row.gitCode == nil ? Color.secondary : color)
        }
        .padding(.leading, CGFloat(row.depth) * 13 + 4).padding(.trailing, 6).padding(.vertical, 3)
        .contentShape(Rectangle())
        .help(entry.path)
        .onTapGesture(count: 2) { if entry.directory { Task { await workspace.browse(entry.path) } } }
        .simultaneousGesture(TapGesture().onEnded {
            if entry.directory { Task { await workspace.toggle(entry.path) } } else { model.open(entry.path) }
        })
        .contextMenu { menu(row) }
    }

    @ViewBuilder private func menu(_ row: TreeRow) -> some View {
        let entry = row.entry
        if entry.directory {
            Button("进入此目录") { Task { await workspace.browse(entry.path) } }
            Button("新建文件") { prompt = NamePrompt(title: "新文件名称", initial: "", action: .newFile(entry.path)) }
            Button("新建文件夹") { prompt = NamePrompt(title: "新文件夹名称", initial: "", action: .newFolder(entry.path)) }
        } else {
            Button("打开") { model.open(entry.path) }
            Button("附加到消息") { model.attach(entry.path) }
            Button("下载…") { model.download(entry.path) }
            Button("用本机软件打开") { model.openLocally(entry.path) }
            if row.gitCode != nil { Button("查看变更") { Task { await workspace.openDiff(entry.path) } } }
        }
        Button("复制路径") { copyToPasteboard(entry.path) }
        Divider()
        Button("重命名…") { prompt = NamePrompt(title: "重命名", initial: entry.name, action: .rename(entry)) }
        Button("删除…", role: .destructive) { remove(entry) }
    }

    private func remove(_ entry: FileEntry) {
        let alert = NSAlert()
        alert.messageText = entry.directory ? "删除文件夹 \(entry.path) 及其全部内容？" : "删除文件 \(entry.path)？"
        alert.informativeText = "此操作在服务器上执行，无法撤销。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "取消")
        alert.addButton(withTitle: "删除")
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        model.perform { try await workspace.remove(entry) }
    }

    /// A conversation with messages keeps its context, so a new folder starts a new conversation.
    private func useFolder() {
        guard let engine = model.engine, let root = workspace.root, let session = model.active else { return }
        var config = session.config
        config.directory = root
        model.perform { model.select(try engine.create(config, preferences: session.preferences).id) }
    }
}

struct NameSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let prompt: NamePrompt
    let workspace: Workspace
    @State private var name = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(prompt.title).font(.headline)
            TextField("名称", text: $name).textFieldStyle(.roundedBorder).onSubmit(confirm)
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("确定", action: confirm).keyboardShortcut(.defaultAction).disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20).frame(width: 340)
        .onAppear { name = prompt.initial }
    }

    private func confirm() {
        let value = name.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { return }
        dismiss()
        model.perform {
            switch prompt.action {
            case .newFile(let directory): try await workspace.createEntry(in: directory, name: value, folder: false)
            case .newFolder(let directory): try await workspace.createEntry(in: directory, name: value, folder: true)
            case .rename(let entry): if value != entry.name { try await workspace.rename(entry, to: value) }
            }
        }
    }
}

struct ChangesView: View {
    let workspace: Workspace

    var body: some View {
        let status = workspace.gitStatus
        VStack(alignment: .leading, spacing: 0) {
            Text(summary(status))
                .font(.caption).foregroundStyle(.secondary).padding(10)
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(status?.files ?? []) { file in
                        Button { Task { await workspace.openDiff(file.path) } } label: {
                            HStack {
                                Text(file.relative).foregroundStyle(gitColor(file.code)).lineLimit(1).truncationMode(.head)
                                Spacer()
                                Text(file.status.trimmingCharacters(in: .whitespaces)).foregroundStyle(.secondary)
                            }
                            .font(.system(size: 12)).padding(.horizontal, 10).padding(.vertical, 4).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).help(file.path)
                    }
                }
            }
        }
        .task { await workspace.refreshGit() }
    }

    private func summary(_ status: GitStatus?) -> String {
        guard let status else { return "读取中…" }
        guard status.repository else { return "当前目录不是 Git 仓库" }
        return (status.branch ?? "") + (status.files.isEmpty ? " · 没有未提交的变更" : "")
    }
}

struct SearchView: View {
    @EnvironmentObject private var model: AppModel
    let workspace: Workspace
    @State private var query = ""
    @State private var status = ""
    @State private var matches: [SearchMatch] = []
    @State private var task: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextField("在工作目录中搜索内容", text: $query).textFieldStyle(.roundedBorder).padding(8).onSubmit(run)
            if !status.isEmpty { Text(status).font(.caption2).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.bottom, 4) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(matches) { match in
                        Button { model.open(match.path, line: match.line) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(match.relative):\(match.line)").font(.caption2).foregroundStyle(.blue).lineLimit(1)
                                Text(match.text.trimmingCharacters(in: .whitespaces)).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
                            }
                            .padding(.horizontal, 10).padding(.vertical, 4).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).help(match.path)
                    }
                }
            }
        }
    }

    private func run() {
        task?.cancel()
        guard !query.isEmpty else { return }
        status = "搜索中…"; matches = []
        task = Task {
            do {
                let result = try await workspace.search(query)
                guard !Task.isCancelled else { return }
                matches = result.matches
                status = "\(result.matches.count) 处匹配" + (result.truncated == true ? "（已截断）" : "")
            } catch { if !Task.isCancelled { status = error.localizedDescription } }
        }
    }
}

struct QuickOpenSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [FileEntry] = []
    @State private var selection = 0
    @State private var task: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 6) {
            TextField("按名称查找服务器上的文件", text: $query)
                .textFieldStyle(.roundedBorder)
                .onSubmit { if let file = results[safeIndex: selection] { choose(file) } }
                .onKeyPress(.downArrow) { selection = min(selection + 1, max(results.count - 1, 0)); return .handled }
                .onKeyPress(.upArrow) { selection = max(selection - 1, 0); return .handled }
                .onKeyPress(.escape) { dismiss(); return .handled }
            MenuList(count: results.count, selection: selection) { index in
                let file = results[index]
                return AnyView(Button { choose(file) } label: {
                    Text(file.relative ?? file.name).font(.system(size: 12, design: .monospaced)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).help(file.path))
            }
        }
        .padding(10).frame(width: 560)
        .onChange(of: query) { search() }
        .onAppear { search() }
    }

    private func search() {
        task?.cancel()
        guard let workspace = model.activeWorkspace, model.isConnected else { return }
        let current = query
        task = Task {
            try? await Task.sleep(nanoseconds: 60_000_000)
            guard !Task.isCancelled, let found = try? await workspace.suggest(current), !Task.isCancelled else { return }
            results = found; selection = 0
        }
    }

    private func choose(_ file: FileEntry) { dismiss(); model.open(file.path) }
}

extension Array {
    subscript(safeIndex index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

struct EditorPane: View {
    @EnvironmentObject private var model: AppModel
    let workspace: Workspace

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(workspace.tabs) { tab in tabButton(tab) }
                }
            }
            .background(Color.secondary.opacity(0.08))
            Divider()
            if let tab = workspace.activeTab {
                header(tab)
                Divider()
                if tab.conflict {
                    Text("服务器上的文件已被修改。保存会被拒绝，请先复制你的修改再重新打开。")
                        .font(.caption).padding(8).frame(maxWidth: .infinity, alignment: .leading).background(Color.yellow.opacity(0.15))
                }
                EditorContent(tab: tab, workspace: workspace).id(tab.id)
            }
        }
    }

    private func tabButton(_ tab: EditorTab) -> some View {
        HStack(spacing: 4) {
            Button { workspace.activeTabId = tab.id; model.objectWillChange.send() } label: {
                Text((tab.isDirty ? "● " : "") + tab.title).font(.caption).lineLimit(1)
                    .foregroundStyle(tab.id == workspace.activeTabId ? Color.primary : Color.secondary)
            }.buttonStyle(.plain).help(tab.path)
            Button { model.close(tab, in: workspace) } label: { Image(systemName: "xmark").font(.system(size: 8)) }.buttonStyle(.plain).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(tab.id == workspace.activeTabId ? Color(nsColor: .textBackgroundColor) : Color.clear)
    }

    private func header(_ tab: EditorTab) -> some View {
        let preview = tab.preview
        return HStack(spacing: 8) {
            Text(preview?.path ?? tab.path).font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head).textSelection(.enabled)
            Spacer()
            Text(tab.notice ?? tab.error.map { _ in "无法预览" } ?? info(tab)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            if !tab.isDiff, let preview {
                if tab.draft != nil {
                    Button("保存到远端") { Task { await workspace.save(tab) } }
                } else if preview.kind == "text", preview.truncated != true, preview.revision != nil {
                    Button("编辑") { workspace.beginEditing(tab) }
                }
                if isMarkdown(preview), tab.draft == nil {
                    Button(tab.showSource ? "渲染" : "源码") { tab.showSource.toggle(); model.objectWillChange.send() }
                }
                Button("附加") { model.attach(preview.path) }
                Button("下载") { model.download(preview.path) }
                Button("本地打开") { model.openLocally(preview.path) }.help("下载副本后使用本机软件打开")
            }
        }
        .controlSize(.small).padding(.horizontal, 10).padding(.vertical, 6)
    }

    private func info(_ tab: EditorTab) -> String {
        if tab.isDiff { return "Git 变更" }
        guard let preview = tab.preview else { return "读取中…" }
        return byteText(preview.size) + (preview.truncated == true ? " · 仅预览前 1 MB" : "")
    }
}

func isMarkdown(_ preview: FilePreview) -> Bool {
    let name = preview.name.lowercased()
    return (name.hasSuffix(".md") || name.hasSuffix(".markdown")) && preview.truncated != true
}

struct EditorContent: View {
    @EnvironmentObject private var model: AppModel
    let tab: EditorTab
    let workspace: Workspace

    var body: some View {
        Group {
            if let error = tab.error {
                Text(error).foregroundStyle(.secondary).padding().textSelection(.enabled).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else if tab.isDiff {
                if let text = tab.diffText {
                    let rows = unifiedDiffRows(text)
                    if rows.isEmpty { Text("没有差异").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity) }
                    else { DiffView(rows: rows) }
                } else { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
            } else if let preview = tab.preview {
                content(preview)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    @ViewBuilder private func content(_ preview: FilePreview) -> some View {
        switch preview.kind {
        case "text":
            if tab.draft != nil {
                TextEditor(text: Binding(get: { tab.draft ?? "" }, set: { tab.draft = $0; model.objectWillChange.send() }))
                    .font(.system(size: 12, design: .monospaced))
            } else if isMarkdown(preview), !tab.showSource {
                ScrollView {
                    MarkdownView(text: preview.text ?? "", actions: FileActions(open: { model.open($0, line: $1) }))
                        .textSelection(.enabled).padding(20).frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                CodeTextView(text: preview.text ?? "", line: tab.line)
            }
        case "image":
            if let data = preview.data, let image = NSImage(data: data) {
                ScrollView([.horizontal, .vertical]) { Image(nsImage: image).padding() }
            } else { Text("无法显示图片").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity) }
        case "pdf":
            if let data = preview.data { PDFContent(data: data) }
        default:
            Text(preview.reason ?? "此格式请下载或在本地打开").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

struct PDFContent: NSViewRepresentable {
    let data: Data
    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        return view
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func updateNSView(_ view: PDFView, context: Context) {
        // Comparing against the document's own bytes would re-serialize it on every update.
        if context.coordinator.shown != data { context.coordinator.shown = data; view.document = PDFDocument(data: data) }
    }
    final class Coordinator { var shown: Data? }
}

/// AppKit's text system handles megabyte files that a SwiftUI Text cannot.
struct CodeTextView: NSViewRepresentable {
    let text: String
    let line: Int?

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var text: String?; var line: Int? }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        let view = scroll.documentView as! NSTextView
        view.isEditable = false; view.isSelectable = true; view.isRichText = false
        view.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        view.textContainerInset = NSSize(width: 8, height: 10)
        // Long lines scroll rather than wrap, so line numbers from Claude stay meaningful.
        view.isHorizontallyResizable = true
        view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        view.textContainer?.widthTracksTextView = false
        view.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        scroll.hasHorizontalScroller = true
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? NSTextView else { return }
        // Updates arrive constantly while Claude works; only real changes may move the view.
        guard context.coordinator.text != text || context.coordinator.line != line else { return }
        let lineChanged = context.coordinator.line != line
        context.coordinator.text = text; context.coordinator.line = line
        let numbered = numberedText()
        let visible = scroll.contentView.bounds.origin
        view.string = numbered
        guard lineChanged, let line, line > 0 else { scroll.contentView.scroll(to: visible); return }
        var index = numbered.startIndex
        for _ in 1..<line {
            guard let newline = numbered[index...].firstIndex(of: "\n") else { break }
            index = numbered.index(after: newline)
        }
        let location = NSRange(index..<index, in: numbered).location
        let lineRange = (numbered as NSString).lineRange(for: NSRange(location: location, length: 0))
        DispatchQueue.main.async {
            view.scrollRangeToVisible(lineRange)
            view.setSelectedRange(lineRange)
        }
    }

    private func numberedText() -> String {
        let lines = text.components(separatedBy: "\n")
        let width = String(lines.count).count
        // Beyond this size the gutter costs more than it helps.
        guard lines.count < 50_000 else { return text }
        return lines.enumerated().map { index, line in
            let number = String(index + 1)
            return String(repeating: " ", count: width - number.count) + number + "  " + line
        }.joined(separator: "\n")
    }
}
#endif
