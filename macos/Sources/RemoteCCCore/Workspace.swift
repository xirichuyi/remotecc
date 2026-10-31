import Foundation

public final class EditorTab: Identifiable {
    public let id: String
    public var path: String
    public let isDiff: Bool
    public var preview: FilePreview?
    public var diffText: String?
    public var error: String?
    /// Non-nil while editing; a difference from `preview.text` means unsaved work.
    public var draft: String?
    public var conflict = false
    public var line: Int?
    public var showSource = false
    public var notice: String?
    init(id: String, path: String, isDiff: Bool, line: Int? = nil) { self.id = id; self.path = path; self.isDiff = isDiff; self.line = line }
    public var isDirty: Bool { draft != nil && draft != preview?.text }
    public var title: String { (path as NSString).lastPathComponent + (isDiff ? " · 变更" : "") }
    var directory: String { (path as NSString).deletingLastPathComponent }
}

public struct TreeRow: Identifiable, Equatable {
    public var entry: FileEntry
    public var depth: Int
    public var expanded: Bool
    public var gitCode: String?
    public var touched: Bool
    public var id: String { entry.path }
}

/// The file panel and editor tabs for one conversation; views only render this.
@MainActor
public final class Workspace {
    public private(set) var root: String?
    public private(set) var rows: [TreeRow] = []
    public private(set) var error: String?
    public private(set) var footer = ""
    public private(set) var gitStatus: GitStatus?
    public private(set) var watchFailed = false
    public private(set) var tabs: [EditorTab] = []
    public var activeTabId: String?
    public var showHidden = true { didSet { if showHidden != oldValue { Task { await reload(force: true) } } } }
    public var touchedFiles: () -> Set<String> = { [] }
    public var onChange: (() -> Void)?

    private let files: RemoteFiles
    private let agents: AgentClient
    private let config: ConnectionConfig
    private var directories: [String: DirectoryListing] = [:]
    private var expanded = Set<String>()
    private var git: [String: String] = [:]
    private var generation = 0

    public init(files: RemoteFiles, agents: AgentClient, config: ConnectionConfig) {
        self.files = files; self.agents = agents; self.config = config
    }

    public var activeTab: EditorTab? { tabs.first { $0.id == activeTabId } }
    public var hasUnsavedEdits: Bool { tabs.contains(where: \.isDirty) }
    private func changed() { onChange?() }

    public func browse(_ folder: String, force: Bool = false) async {
        generation += 1
        let current = generation
        error = nil; footer = "读取中…"; changed()
        do {
            let listing = try await files.list(config, folder, hidden: showHidden, force: force)
            guard current == generation else { return }
            if root != listing.path { expanded = []; directories = [:]; root = listing.path }
            directories[listing.path] = listing
            for directory in expanded {
                do { directories[directory] = try await files.list(config, directory, hidden: showHidden, force: force) }
                catch { expanded.remove(directory) }
            }
            guard current == generation else { return }
            rebuild()
            await syncWatches()
            await refreshGit()
        } catch {
            guard current == generation else { return }
            self.error = error.localizedDescription; footer = "读取失败"; rows = []; changed()
        }
    }

    public func reload(force: Bool = false) async {
        if let root { await browse(root, force: force) } else { await browse(config.directory, force: force) }
    }
    public func goToParent() async { if let root, let parent = directories[root]?.parent { await browse(parent) } }

    public func rebuild() {
        guard let root else { return }
        let touched = touchedFiles()
        var result: [TreeRow] = []
        func walk(_ directory: String, _ depth: Int) {
            for entry in directories[directory]?.entries ?? [] {
                let open = expanded.contains(entry.path)
                result.append(TreeRow(entry: entry, depth: depth, expanded: open, gitCode: git[entry.path], touched: touched.contains(entry.path)))
                if entry.directory, open, directories[entry.path] != nil { walk(entry.path, depth + 1) }
            }
        }
        walk(root, 0)
        rows = result
        let listing = directories[root]
        footer = "\(listing?.entries.count ?? 0) 项" + (listing?.truncated == true ? " · 仅显示前 5000 项" : "") + (watchFailed ? " · 未能实时监听，回复结束后刷新" : "")
        changed()
    }

    public func toggle(_ directory: String) async {
        if expanded.remove(directory) != nil { rebuild(); await syncWatches(); return }
        expanded.insert(directory)
        do { directories[directory] = try await files.list(config, directory, hidden: showHidden) }
        catch { expanded.remove(directory); self.error = error.localizedDescription }
        rebuild()
        await syncWatches()
    }

    /// Only what is on screen is watched: the root, expanded folders and folders of open files.
    public func syncWatches() async {
        guard let root else { return }
        let open = tabs.filter { !$0.isDiff && $0.path.hasPrefix("/") }.map(\.directory)
        let wanted = Array(Set([root] + expanded + open))
        do {
            let result = try await agents.call(config, "watchDirectories", ["directories": .array(wanted.map(JSON.string))])
            let failed = !(result["failed"]?.array ?? []).isEmpty
            if failed != watchFailed { watchFailed = failed; rebuild() }
        } catch { watchFailed = true }
    }

    public func refreshGit() async {
        guard let status = try? await files.run(config, "gitStatus", timeout: 25).decode(GitStatus.self) else { return }
        gitStatus = status
        git = [:]
        for file in status.files {
            git[file.path] = file.code
            // A folder shows that something inside it changed.
            var parent = (file.path as NSString).deletingLastPathComponent
            while parent.count > (status.root ?? "").count {
                if git[parent] == nil { git[parent] = "M" }
                parent = (parent as NSString).deletingLastPathComponent
            }
        }
        rebuild()
    }

    /// A push from the server. Clean tabs follow it; tabs with unsaved edits are flagged instead.
    public func filesChanged(_ changedDirectories: [String]) async {
        files.invalidate()
        for directory in changedDirectories where directories[directory] != nil {
            if let listing = try? await files.list(config, directory, hidden: showHidden, force: true) { directories[directory] = listing }
        }
        rebuild()
        await refreshGit()
        for tab in tabs where changedDirectories.contains(tab.directory) {
            if tab.isDiff { tab.diffText = (try? await files.run(config, "gitFileDiff", ["path": .string(tab.path)]))?["text"]?.string; continue }
            do {
                let latest = try await files.preview(config, tab.path)
                guard latest.version != tab.preview?.version else { continue }
                if tab.isDirty { tab.conflict = true }
                else { tab.preview = latest; tab.draft = nil; tab.conflict = false; tab.line = nil }
                tab.error = nil
            } catch { tab.error = error.localizedDescription }
        }
        changed()
    }

    // MARK: Tabs

    @discardableResult
    private func addTab(_ id: String, path: String, isDiff: Bool, line: Int?) -> EditorTab {
        if let tab = tabs.first(where: { $0.id == id }) {
            tab.line = line ?? tab.line
            activeTabId = id; changed()
            return tab
        }
        // Images and PDFs hold their bytes in memory, so old clean tabs are dropped.
        while tabs.count >= 12, let old = tabs.first(where: { !$0.isDirty && $0.id != activeTabId }) { tabs.removeAll { $0 === old } }
        let tab = EditorTab(id: id, path: path, isDiff: isDiff, line: line)
        tabs.append(tab); activeTabId = id; changed()
        return tab
    }

    public func open(_ file: String, line: Int? = nil) async {
        let existing = tabs.first { !$0.isDiff && ($0.path == file || $0.preview?.path == file) }
        let tab = addTab(existing?.id ?? "file:" + file, path: file, isDiff: false, line: line)
        do {
            let result = try await files.preview(config, file)
            tab.preview = result; tab.path = result.path; tab.error = nil
            await syncWatches()
        } catch { tab.error = error.localizedDescription }
        changed()
    }

    public func openDiff(_ file: String) async {
        let tab = addTab("diff:" + file, path: file, isDiff: true, line: nil)
        do { tab.diffText = try await files.run(config, "gitFileDiff", ["path": .string(file)])["text"]?.string ?? ""; tab.error = nil }
        catch { tab.error = error.localizedDescription }
        changed()
    }

    /// The caller confirms discarding unsaved edits first.
    public func close(_ tab: EditorTab) {
        guard let index = tabs.firstIndex(where: { $0 === tab }) else { return }
        tabs.remove(at: index)
        if activeTabId == tab.id { activeTabId = (tabs[safe: index] ?? tabs[safe: index - 1])?.id }
        changed()
        Task { await syncWatches() }
    }

    public func beginEditing(_ tab: EditorTab) { if tab.preview?.kind == "text", tab.preview?.truncated != true { tab.draft = tab.preview?.text; changed() } }

    public func save(_ tab: EditorTab) async {
        guard let draft = tab.draft, let preview = tab.preview, let revision = preview.revision else { return }
        do {
            let saved = try await files.save(config, preview.path, text: draft, revision: revision)
            tab.preview = saved; tab.draft = saved.text; tab.conflict = false; tab.notice = "已保存到远端"
        } catch { tab.notice = error.localizedDescription }
        changed()
    }

    // MARK: Entry operations

    public func createEntry(in directory: String, name: String, folder: Bool) async throws {
        let created = try await files.run(config, "create", ["directory": .string(directory), "name": .string(name), "folder": .bool(folder)]).decode(FileEntry.self)
        files.invalidate()
        if directory != root { expanded.insert(directory) }
        await reload(force: true)
        if !folder { await open(created.path) }
    }

    public func rename(_ entry: FileEntry, to name: String) async throws {
        _ = try await files.run(config, "rename", ["path": .string(entry.path), "name": .string(name)])
        files.invalidate()
        await reload(force: true)
    }

    public func remove(_ entry: FileEntry) async throws {
        _ = try await files.run(config, "remove", ["path": .string(entry.path), "recursive": .bool(entry.directory)])
        files.invalidate()
        await reload(force: true)
    }

    public func search(_ query: String) async throws -> SearchResult {
        try await files.run(config, "search", ["query": .string(query)], timeout: 25).decode(SearchResult.self)
    }

    public func suggest(_ query: String) async throws -> [FileEntry] {
        (try await files.run(config, "suggest", ["query": .string(query)])["files"] ?? []).array?.compactMap { try? $0.decode(FileEntry.self) } ?? []
    }
}
