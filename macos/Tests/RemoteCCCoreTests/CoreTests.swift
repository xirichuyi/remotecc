import XCTest
@testable import RemoteCCCore

/// `sh -c` stands in for the SSH channel; the agent underneath is the real one.
final class LocalLauncher: RemoteLauncher, @unchecked Sendable {
    let home: String
    init(home: String) { self.home = home }
    func spawn(_ config: ConnectionConfig, command: String) throws -> RemoteProcess {
        var environment = ProcessInfo.processInfo.environment
        environment["HOME"] = home
        return try RemoteProcess(executable: "/bin/sh", arguments: ["-c", command], environment: environment)
    }
}

/// Fault injection affects bulk transfer only; metadata still uses the real agent.
final class BrokenTransferLauncher: RemoteLauncher, @unchecked Sendable {
    let base: LocalLauncher
    let command: String
    init(home: String, command: String) { base = LocalLauncher(home: home); self.command = command }
    func spawn(_ config: ConnectionConfig, command: String) throws -> RemoteProcess {
        try base.spawn(config, command: command.contains(" transfer ") ? self.command : command)
    }
}

let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

func run(_ executable: String, _ arguments: [String], input: Data? = nil) throws -> Data {
    let process = Process(), output = Pipe(), stdin = Pipe()
    process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
    process.standardOutput = output; process.standardInput = stdin
    try process.run()
    if let input { stdin.fileHandleForWriting.write(input) }
    try stdin.fileHandleForWriting.close()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    return data
}

/// A stand-in task worker speaking the state.json protocol: the agent depends on that, not on the SDK.
let standInWorker = #"""
const fs=require('fs'),path=require('path');const folder=process.argv[2];
const request=JSON.parse(fs.readFileSync(path.join(folder,'request.json')));
let version=0,message=request.session.messages[0],permissions=[],status='working';
const write=(done=false)=>{fs.writeFileSync(path.join(folder,'state.json.tmp'),JSON.stringify({version:++version,done,resident:true,status,permissions,message,remoteSessionId:'remote-1',model:'stub-model',capabilities:{commands:[{name:'usage',builtin:true}],models:[]},preferences:request.session.preferences||{}}));fs.renameSync(path.join(folder,'state.json.tmp'),path.join(folder,'state.json'));};
const answer=(text)=>{message.blocks=[{type:'text',text:'he'}];write();setTimeout(()=>{message.blocks=[{type:'text',text},{type:'tool',id:'t',name:'Bash',input:{command:'ls'},status:'done',output:'a'}];status='permission';permissions=[{id:'p1',name:'Bash',title:'run',input:{command:'pwd'}}];write();},30);};
answer('reply:'+request.prompt);
setInterval(()=>{for(const name of fs.readdirSync(path.join(folder,'commands'))){if(!name.endsWith('.json'))continue;const file=path.join(folder,'commands',name);const c=JSON.parse(fs.readFileSync(file));let value={};
 if(c.kind==='respond'){permissions=[];status='idle';write();}
 if(c.kind==='send'){message=c.message;status='working';answer('reply:'+c.prompt);}
 if(c.kind==='stop'){permissions=[];status='stopped';message.interrupted=true;write();}
 if(c.kind==='control'&&c.action==='catalogue')value={commands:[{name:'live',builtin:true}],models:[]};
 fs.writeFileSync(file+'.result',JSON.stringify({ok:true,value}));fs.renameSync(file,file+'.done');
 if(c.kind==='close'){status='idle';write(true);process.exit(0);}}},15);
"""#

final class AgentEnvironment {
    let home: URL, resourcesDirectory: URL
    let launcher: LocalLauncher
    let agents: AgentClient
    let files: RemoteFiles
    let config: ConnectionConfig

    init(standIn: Bool = true) throws {
        home = FileManager.default.temporaryDirectory.appendingPathComponent("rcc-swift-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        resourcesDirectory = home.appendingPathComponent("resources")
        let node = try XCTUnwrap(Self.which("node"))
        // Keep the fixture's login shell on the same Node as the test process.
        let nodeDirectory = URL(fileURLWithPath: node).deletingLastPathComponent().path.replacingOccurrences(of: "'", with: "'\"'\"'")
        try ("export PATH='" + nodeDirectory + "':$PATH\n").write(to: home.appendingPathComponent(".bash_profile"), atomically: true, encoding: .utf8)
        _ = try run(node, [repository.appendingPathComponent("macos/scripts/prepare-server.cjs").path, resourcesDirectory.path])
        if standIn {
            let script = "const{createHash:c}=require('crypto'),z=require('zlib'),fs=require('fs');const d=Buffer.from(JSON.stringify({'task-worker.cjs':fs.readFileSync(0,'utf8')}));const m=JSON.parse(fs.readFileSync(process.argv[1]));m.bundleDigest=c('sha256').update(d).digest('hex');m.bundlePayload=z.gzipSync(d).toString('base64');fs.writeFileSync(process.argv[1],JSON.stringify(m));"
            _ = try run(node, ["-e", script, resourcesDirectory.appendingPathComponent("manifest.json").path], input: Data(standInWorker.utf8))
        }
        launcher = LocalLauncher(home: home.path)
        agents = AgentClient(launcher: launcher, resources: try ServerResources(directory: resourcesDirectory))
        files = RemoteFiles(agents: agents, cacheDirectory: home.appendingPathComponent("cache"))
        config = ConnectionConfig(host: "test", directory: home.path)
    }
    static func which(_ name: String) -> String? {
        (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map { $0 + "/" + name }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }
    func cleanup() { agents.close(config); try? FileManager.default.removeItem(at: home) }
}

func eventually(_ timeout: TimeInterval = 8, _ condition: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > deadline { XCTFail("timed out"); return }
        try await Task.sleep(nanoseconds: 20_000_000)
    }
}

final class AgentTests: XCTestCase {
    func testInstallHandshakeAndConcurrentRequests() async throws {
        let environment = try AgentEnvironment(); defer { environment.cleanup() }
        try "echo welcome to the server\n".write(to: environment.home.appendingPathComponent(".profile"), atomically: true, encoding: .utf8)
        try "hi".write(to: environment.home.appendingPathComponent("note.txt"), atomically: true, encoding: .utf8)
        let info = try await environment.agents.info(environment.config)
        XCTAssertTrue(info.nodeSupported); XCTAssertEqual(info.home, environment.home.path)
        try await withThrowingTaskGroup(of: DirectoryListing.self) { group in
            for _ in 0..<30 { group.addTask { try await environment.files.list(environment.config, environment.home.path, hidden: true, force: true) } }
            for try await listing in group { XCTAssertTrue(listing.entries.contains { $0.name == "note.txt" }) }
        }
        do { _ = try await environment.files.list(environment.config, "/definitely/missing", hidden: false); XCTFail("expected failure") }
        catch { XCTAssertTrue(error.localizedDescription.contains("ENOENT")) }
    }

    func testLateDisconnectCallbackCannotEvictReplacementChannel() async throws {
        let environment = try AgentEnvironment(); defer { environment.cleanup() }
        let old = try await environment.agents.channel(environment.config)
        environment.agents.close(environment.config)
        let replacement = try await environment.agents.channel(environment.config)
        XCTAssertFalse(old === replacement)
        // Simulate EOF delivery racing behind a successful reconnect.
        old.onClosed?()
        let reused = try await environment.agents.channel(environment.config)
        XCTAssertTrue(reused === replacement)
        let hello = try await reused.call("file", ["operation": "hello"])
        XCTAssertNotNil(hello["home"]?.string)
    }

    func testDownloadNeverDeletesDestinationDirectory() async throws {
        let environment = try AgentEnvironment(); defer { environment.cleanup() }
        let source = environment.home.appendingPathComponent("source.txt")
        try "download".write(to: source, atomically: true, encoding: .utf8)
        let destination = environment.home.appendingPathComponent("existing-folder")
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let important = destination.appendingPathComponent("keep.txt")
        try "keep".write(to: important, atomically: true, encoding: .utf8)
        do {
            try await environment.files.download(environment.config, source.path, to: destination)
            XCTFail("Must not replace a directory with a downloaded file")
        } catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
        XCTAssertEqual(try String(contentsOf: important), "keep")
    }

    func testInterruptedOrTruncatedDownloadPreservesExistingFile() async throws {
        let environment = try AgentEnvironment(); defer { environment.cleanup() }
        let source = environment.home.appendingPathComponent("source.txt")
        try "complete remote contents".write(to: source, atomically: true, encoding: .utf8)
        let destination = environment.home.appendingPathComponent("existing.txt")
        try "original local contents".write(to: destination, atomically: true, encoding: .utf8)
        for command in ["printf partial; exit 1", "printf partial; exit 0"] {
            let launcher = BrokenTransferLauncher(home: environment.home.path, command: command)
            let agents = AgentClient(launcher: launcher, resources: try ServerResources(directory: environment.resourcesDirectory))
            let files = RemoteFiles(agents: agents, cacheDirectory: environment.home.appendingPathComponent("fault-cache"))
            do {
                try await files.download(environment.config, source.path, to: destination)
                XCTFail("An interrupted or short download must fail")
            } catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
            XCTAssertEqual(try String(contentsOf: destination), "original local contents")
            XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: environment.home.path).contains { $0.hasPrefix(".remotecc-") })
            agents.close(environment.config)
        }
    }

    func testCancelStalledDownloadReturnsPromptlyAndPreservesDestination() async throws {
        let environment = try AgentEnvironment(); defer { environment.cleanup() }
        let source = environment.home.appendingPathComponent("source.txt")
        let destination = environment.home.appendingPathComponent("destination.txt")
        try "remote".write(to: source, atomically: true, encoding: .utf8)
        try "keep".write(to: destination, atomically: true, encoding: .utf8)
        let launcher = BrokenTransferLauncher(home: environment.home.path, command: "exec sleep 4")
        let agents = AgentClient(launcher: launcher, resources: try ServerResources(directory: environment.resourcesDirectory))
        let files = RemoteFiles(agents: agents, cacheDirectory: environment.home.appendingPathComponent("cancel-cache"))
        _ = try await agents.info(environment.config)
        let task = Task { try await files.download(environment.config, source.path, to: destination) }
        try await Task.sleep(nanoseconds: 200_000_000)
        let start = Date(); task.cancel()
        do { try await task.value; XCTFail("Cancelled download succeeded") } catch { }
        print("CANCEL stalled download returned in \(Int(Date().timeIntervalSince(start) * 1000))ms")
        XCTAssertLessThan(Date().timeIntervalSince(start), 2)
        XCTAssertEqual(try String(contentsOf: destination), "keep")
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: environment.home.path).contains { $0.hasPrefix(".remotecc-") })
        agents.close(environment.config)
    }

    func testBatchUploadKeepsOrderAndSuccessfulFilesWhenOneFails() async throws {
        let env = try AgentEnvironment(); defer { env.cleanup() }
        let folder = env.home.appendingPathComponent("batch-target")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let first = env.home.appendingPathComponent("first.txt"), last = env.home.appendingPathComponent("last.txt")
        let missing = env.home.appendingPathComponent("missing.txt")
        try "first".write(to: first, atomically: true, encoding: .utf8)
        try "last".write(to: last, atomically: true, encoding: .utf8)
        let results = await env.files.uploadBatch(env.config, files: [first, missing, last], directory: folder.path)
        XCTAssertEqual(results.map(\.file), [first, missing, last])
        XCTAssertNotNil(results[0].attachment); XCTAssertNotNil(results[1].error); XCTAssertNotNil(results[2].attachment)
        XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("first.txt")), "first")
        XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("last.txt")), "last")
    }

    func testBatchUploadDuplicateBasenameKeepsFirstSelectionAndNeverOverwrites() async throws {
        let env = try AgentEnvironment(); defer { env.cleanup() }
        let a = env.home.appendingPathComponent("a"), b = env.home.appendingPathComponent("b"), target = env.home.appendingPathComponent("target")
        for folder in [a, b, target] { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
        let first = a.appendingPathComponent("same.txt"), second = b.appendingPathComponent("same.txt")
        try "chosen first".write(to: first, atomically: true, encoding: .utf8)
        try "chosen second".write(to: second, atomically: true, encoding: .utf8)
        let results = await env.files.uploadBatch(env.config, files: [first, second], directory: target.path)
        XCTAssertNotNil(results[0].attachment); XCTAssertNotNil(results[1].error)
        XCTAssertEqual(try String(contentsOf: target.appendingPathComponent("same.txt")), "chosen first")
    }

    func testUploadProgressCarriesItsMachineAndProject() async throws {
        let environment = try AgentEnvironment(); defer { environment.cleanup() }
        final class Events: @unchecked Sendable {
            let lock = NSLock()
            var values: [TransferProgress] = []
            func add(_ value: TransferProgress) { lock.lock(); defer { lock.unlock() }; values.append(value) }
            func snapshot() -> [TransferProgress] { lock.lock(); defer { lock.unlock() }; return values }
        }
        let events = Events()
        environment.files.onProgress = { events.add($0) }
        for host in ["machine-a", "machine-b"] {
            let folder = environment.home.appendingPathComponent(host)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let source = environment.home.appendingPathComponent(host + ".txt")
            try "data".write(to: source, atomically: true, encoding: .utf8)
            let config = ConnectionConfig(host: host, directory: folder.path)
            _ = try await environment.files.upload(config, file: source, directory: folder.path)
            environment.agents.close(config)
        }
        let finished = events.snapshot().filter { $0.finished }
        XCTAssertEqual(Set(finished.map { $0.config.host }), ["machine-a", "machine-b"])
        XCTAssertTrue(finished.allSatisfy { $0.config.directory.hasSuffix($0.config.host) })
    }

    func testTransferEditAndCache() async throws {
        let environment = try AgentEnvironment(); defer { environment.cleanup() }
        let files = environment.files, config = environment.config
        var progress = false
        _ = progress; progress = true
        let local = environment.home.appendingPathComponent("local"); try FileManager.default.createDirectory(at: local, withIntermediateDirectories: true)
        let remote = environment.home.appendingPathComponent("remote"); try FileManager.default.createDirectory(at: remote, withIntermediateDirectories: true)
        let payload = Data((0..<2_000_000).map { UInt8($0 % 251) })
        let source = local.appendingPathComponent("data.bin"); try payload.write(to: source)
        let attachment = try await files.upload(config, file: source, directory: remote.path)
        XCTAssertEqual(attachment.path, remote.appendingPathComponent("data.bin").path); XCTAssertEqual(attachment.size, payload.count)
        do { _ = try await files.upload(config, file: source, directory: remote.path); XCTFail("must not overwrite") }
        catch { XCTAssertTrue(error.localizedDescription.contains("同名")) }
        let copy = local.appendingPathComponent("copy.bin")
        try await files.download(config, attachment.path, to: copy)
        XCTAssertEqual(try Data(contentsOf: copy), payload)

        let text = remote.appendingPathComponent("edit.txt"); try "one\n".write(to: text, atomically: true, encoding: .utf8)
        let opened = try await files.preview(config, text.path)
        XCTAssertEqual(opened.kind, "text")
        let saved = try await files.save(config, text.path, text: "two\n", revision: try XCTUnwrap(opened.revision))
        XCTAssertEqual(saved.text, "two\n")
        try "elsewhere\n".write(to: text, atomically: true, encoding: .utf8)
        do { _ = try await files.save(config, text.path, text: "three\n", revision: try XCTUnwrap(saved.revision)); XCTFail("stale save") }
        catch { XCTAssertTrue(error.localizedDescription.contains("已变化")) }
        XCTAssertEqual(try String(contentsOf: text, encoding: .utf8), "elsewhere\n")
        let png = remote.appendingPathComponent("a.png")
        try (Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) + Data(repeating: 7, count: 64)).write(to: png)
        let image = try await files.preview(config, png.path)
        XCTAssertEqual(image.kind, "image"); XCTAssertEqual(image.data?.count, 72)
    }

    @MainActor
    func testWorkspaceFollowsServerAndProtectsDrafts() async throws {
        let environment = try AgentEnvironment(); defer { environment.cleanup() }
        let project = environment.home.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: project.appendingPathComponent("src"), withIntermediateDirectories: true)
        try "x".write(to: project.appendingPathComponent(".env"), atomically: true, encoding: .utf8)
        let source = project.appendingPathComponent("src/a.txt"); try "v1\n".write(to: source, atomically: true, encoding: .utf8)
        let config = ConnectionConfig(host: "test", directory: project.path)
        let workspace = Workspace(files: environment.files, agents: environment.agents, config: config)
        environment.agents.onFileChange = { _, directories in Task { @MainActor in await workspace.filesChanged(directories) } }
        await workspace.browse(project.path)
        XCTAssertEqual(workspace.rows.map(\.entry.name), ["src", ".env"])
        await workspace.toggle(project.appendingPathComponent("src").path)
        XCTAssertEqual(workspace.rows.map(\.entry.name), ["src", "a.txt", ".env"]); XCTAssertEqual(workspace.rows[1].depth, 1)
        XCTAssertFalse(workspace.watchFailed)

        try "made by claude".write(to: project.appendingPathComponent("src/new.txt"), atomically: true, encoding: .utf8)
        try await eventually { workspace.rows.contains { $0.entry.name == "new.txt" } }

        await workspace.open(source.path, line: 3)
        let tab = try XCTUnwrap(workspace.activeTab)
        XCTAssertEqual(tab.preview?.text, "v1\n")
        try "v2\n".write(to: source, atomically: true, encoding: .utf8)
        try await eventually { tab.preview?.text == "v2\n" }
        workspace.beginEditing(tab); tab.draft = "mine\n"
        XCTAssertTrue(workspace.hasUnsavedEdits)
        try "v3\n".write(to: source, atomically: true, encoding: .utf8)
        try await eventually { tab.conflict }
        XCTAssertEqual(tab.draft, "mine\n")
        await workspace.save(tab)
        XCTAssertTrue(tab.notice?.contains("已变化") == true)
        XCTAssertEqual(try String(contentsOf: source, encoding: .utf8), "v3\n")
        let found = try await workspace.search("v3")
        XCTAssertEqual(found.matches.map(\.relative), ["src/a.txt"])
        let suggested = try await workspace.suggest("a.t")
        XCTAssertEqual(suggested.first?.relative, "src/a.txt")
        await workspace.refreshGit()
        XCTAssertEqual(workspace.gitStatus?.repository, false)
        workspace.close(tab)
        XCTAssertNil(workspace.activeTab)
    }

    @MainActor
    func testConversationLifecycleThroughRealAgent() async throws {
        let environment = try AgentEnvironment(); defer { environment.cleanup() }
        let store = try ChatStore(directory: environment.home.appendingPathComponent("store"))
        let engine = try ChatEngine(store: store, agents: environment.agents, files: environment.files)
        let session = try engine.create(environment.config)
        let id = session.id
        try engine.send(id, text: "hello")
        XCTAssertThrowsError(try engine.send(id, text: "dup"))
        XCTAssertEqual(engine.session(id)?.name, "hello")
        try await eventually { engine.session(id)?.status == "permission" }
        var current = try XCTUnwrap(engine.session(id))
        XCTAssertEqual(current.messages.count, 2)
        XCTAssertEqual(current.messages[1].blocks?.first?.text, "reply:hello")
        XCTAssertEqual(current.messages[1].blocks?.last?.name, "Bash")
        XCTAssertEqual(current.remoteSessionId, "remote-1"); XCTAssertEqual(current.model, "stub-model")
        XCTAssertNotNil(current.remoteOwner); XCTAssertNotNil(current.remoteTask)
        XCTAssertEqual(current.capabilities?.commands.first?.name, "usage")

        // Queued while busy; delivered automatically once the turn ends.
        try engine.submit(id, text: "second")
        XCTAssertEqual(engine.session(id)?.queue?.count, 1)
        try await engine.respond(id, permission: "p1", answer: ["allow": true])
        try await eventually { engine.session(id)?.messages.last?.blocks?.first?.text == "reply:second" }
        try await eventually { engine.session(id)?.status == "permission" }
        current = try XCTUnwrap(engine.session(id))
        XCTAssertEqual(current.messages.count, 4); XCTAssertEqual(current.queue?.count ?? 0, 0)

        // Losing the channel only ends the subscription; the owner survives and is rejoined.
        engine.detach(environment.config)
        environment.agents.close(environment.config)
        XCTAssertEqual(engine.session(id)?.status, "detached")
        await engine.restore(environment.config)
        try await eventually { engine.session(id)?.status == "permission" }
        XCTAssertEqual(engine.session(id)?.messages.count, 4)
        let runs = try FileManager.default.contentsOfDirectory(atPath: environment.home.appendingPathComponent(".local/state/remotecc/tasks").path)
        XCTAssertEqual(runs.count, 1)

        try await engine.stop(id)
        try await eventually { engine.session(id)?.status == "stopped" }
        XCTAssertEqual(engine.session(id)?.messages.last?.interrupted, true)
        XCTAssertFalse(engine.isRunning(id))
        let live = try await engine.capabilities(id)
        XCTAssertEqual(live.commands.first?.name, "live")

        // Persisted and restored lazily.
        engine.shutdown()
        let reopened = try ChatEngine(store: store, agents: environment.agents, files: environment.files)
        XCTAssertEqual(reopened.session(id)?.messages.count, 0)
        try reopened.hydrate(id)
        XCTAssertEqual(reopened.session(id)?.messages.count, 4)
        try await reopened.remove(id)
        XCTAssertNil(reopened.session(id))
    }

    @MainActor
    func testRealSDKBundleReachesClaude() async throws {
        guard AgentEnvironment.which("claude") != nil else { throw XCTSkip("claude is not installed") }
        let environment = try AgentEnvironment(standIn: false); defer { environment.cleanup() }
        let store = try ChatStore(directory: environment.home.appendingPathComponent("store"))
        let engine = try ChatEngine(store: store, agents: environment.agents, files: environment.files)
        let id = try engine.create(environment.config).id
        // A temporary HOME has no credentials, so nothing is billed; Claude reports that itself.
        try engine.send(id, text: "hello")
        try await eventually(40) { !engine.isRunning(id) }
        XCTAssertEqual(engine.session(id)?.status, "error")
        XCTAssertNotNil(engine.session(id)?.messages.last?.error)
        let capabilities = try await engine.capabilities(try engine.create(environment.config).id)
        XCTAssertFalse(capabilities.commands.isEmpty)
    }

    @MainActor
    func testIsolatedWorktreeLeavesOriginalChangesUntouched() async throws {
        let environment = try AgentEnvironment(); defer { environment.cleanup() }
        let root = environment.home.appendingPathComponent("repo")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        _ = try RemoteCCCoreTests.run("/usr/bin/git", ["-C", root.path, "init"])
        let file = root.appendingPathComponent("note.txt")
        try "committed".write(to: file, atomically: true, encoding: .utf8)
        _ = try RemoteCCCoreTests.run("/usr/bin/git", ["-C", root.path, "add", "note.txt"])
        _ = try RemoteCCCoreTests.run("/usr/bin/git", ["-C", root.path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"])
        try "uncommitted".write(to: file, atomically: true, encoding: .utf8)
        var config = environment.config; config.directory = root.path
        let result = try await environment.files.run(config, "createWorktree", ["branch": "remotecc/test"])
        let directory = try XCTUnwrap(result["path"]?.string)
        XCTAssertEqual(try String(contentsOfFile: directory + "/note.txt"), "committed")
        XCTAssertEqual(try String(contentsOf: file), "uncommitted")
        do {
            _ = try await environment.files.run(config, "createWorktree", ["branch": "remotecc/test"])
            XCTFail("duplicate branch must fail without overwriting the worktree")
        } catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
        XCTAssertEqual(try String(contentsOfFile: directory + "/note.txt"), "committed")
        do {
            _ = try await environment.files.run(config, "createWorktree", ["branch": "--bad"])
            XCTFail("should reject an option as a branch")
        } catch { XCTAssertTrue(error.localizedDescription.contains("分支")) }
    }

    @MainActor
    func testFailedDirectoryRefreshPreservesLastLoadedRows() async throws {
        let environment = try AgentEnvironment(); defer { environment.cleanup() }
        let folder = environment.home.appendingPathComponent("last-known-folder")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("keep".utf8).write(to: folder.appendingPathComponent("note.txt"))
        let workspace = Workspace(files: environment.files, agents: environment.agents, config: environment.config)
        await workspace.browse(folder.path)
        XCTAssertEqual(workspace.rows.map(\.entry.name), ["note.txt"])
        // A failed refresh must preserve a clearly marked snapshot, not blank the panel.
        await workspace.browse(folder.path + "/unavailable", force: true)
        XCTAssertEqual(workspace.rows.map(\.entry.name), ["note.txt"])
        XCTAssertNotNil(workspace.error)
        XCTAssertTrue(workspace.footer.contains("上次加载"))
    }

    func testInvalidatingOneServerKeepsOtherServerDirectoryCache() async throws {
        let environment = try AgentEnvironment(); defer { environment.cleanup() }
        let folder = environment.home.appendingPathComponent("cache-isolation")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let a = environment.config
        var b = a; b.host = "other-machine"
        _ = try await environment.files.list(a, folder.path, hidden: false)
        _ = try await environment.files.list(b, folder.path, hidden: false)
        try Data("new".utf8).write(to: folder.appendingPathComponent("new.txt"))
        environment.files.invalidate(a)
        let cachedOther = try await environment.files.list(b, folder.path, hidden: false)
        XCTAssertTrue(cachedOther.entries.isEmpty)
        let refreshed = try await environment.files.list(a, folder.path, hidden: false)
        XCTAssertEqual(refreshed.entries.map(\.name), ["new.txt"])
    }

    @MainActor
    func testHistoryDiscoveryAndLoad() async throws {
        let environment = try AgentEnvironment(); defer { environment.cleanup() }
        // The agent reads CLAUDE_CONFIG_DIR, defaulting to ~/.claude under the fixture HOME.
        let project = environment.home.appendingPathComponent(".claude/projects/-tmp-p")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let sessionId = UUID().uuidString.lowercased()
        let lines: [JSON] = [
            ["type": "user", "uuid": "u1", "parentUuid": .null, "cwd": "/tmp/p", "timestamp": "2026-01-01T00:00:00.000Z", "message": ["content": "<command-name>/usage</command-name>"]],
            ["type": "assistant", "uuid": "a1", "parentUuid": "u1", "cwd": "/tmp/p", "message": ["id": "m", "content": [["type": "text", "text": "hi"], ["type": "tool_use", "id": "t", "name": "Read", "input": ["file_path": "/a"]]]]],
            ["type": "user", "uuid": "u2", "parentUuid": "a1", "cwd": "/tmp/p", "message": ["content": [["type": "tool_result", "tool_use_id": "t", "content": "data"]]]],
        ]
        try (lines.map { $0.text() }.joined(separator: "\n") + "\n").write(to: project.appendingPathComponent(sessionId + ".jsonl"), atomically: true, encoding: .utf8)
        let store = try ChatStore(directory: environment.home.appendingPathComponent("store"))
        let engine = try ChatEngine(store: store, agents: environment.agents, files: environment.files)
        let found = try await engine.discoverHistory(environment.config)
        XCTAssertEqual(found.total, 1)
        _ = try await engine.discoverHistory(environment.config)
        XCTAssertEqual(engine.sessions.count, 1)
        let session = try XCTUnwrap(engine.sessions.first)
        XCTAssertEqual(session.historyLoaded, false); XCTAssertEqual(session.directory, "/tmp/p"); XCTAssertEqual(session.remoteSessionId, sessionId)
        XCTAssertThrowsError(try engine.send(session.id, text: "x"))
        async let firstLoad: Void = engine.loadHistory(session.id)
        async let secondLoad: Void = engine.loadHistory(session.id)
        _ = try await (firstLoad, secondLoad)
        let messages = try XCTUnwrap(engine.session(session.id)?.messages)
        XCTAssertEqual(messages.map(\.role), ["user", "assistant"])
        XCTAssertEqual(messages[0].text, "/usage")
        XCTAssertEqual(messages[1].blocks?.last?.output, "data")
        // Another terminal appends more than one history page; refresh must bridge the gap.
        var appended = lines
        var parent = "u2"
        for index in 0..<61 {
            let id = "external-\(index)"
            appended.append(["type": "user", "uuid": .string(id), "parentUuid": .string(parent), "cwd": "/tmp/p", "message": ["content": .string("external message \(index)")]])
            parent = id
        }
        let transcript = project.appendingPathComponent(sessionId + ".jsonl")
        try (appended.map { $0.text() }.joined(separator: "\n") + "\n").write(to: transcript, atomically: true, encoding: .utf8)
        try await engine.refreshHistory(session.id)
        XCTAssertEqual(engine.session(session.id)?.messages.count, 63)
        XCTAssertEqual(engine.session(session.id)?.messages.last?.text, "external message 60")
        try await engine.refreshHistory(session.id)
        XCTAssertEqual(engine.session(session.id)?.messages.count, 63)
        // A concurrent remote branch rewrite must not silently discard our loaded tail.
        let saved = engine.session(session.id)?.messages
        let fork: JSON = ["type": "user", "uuid": "forked", "parentUuid": "u2", "cwd": "/tmp/p", "message": ["content": "other branch"]]
        try ((lines + [fork]).map { $0.text() }.joined(separator: "\n") + "\n").write(to: transcript, atomically: true, encoding: .utf8)
        do { try await engine.refreshHistory(session.id); XCTFail("branch rewrite must be explicit") }
        catch { XCTAssertTrue(error.localizedDescription.contains("分支")) }
        XCTAssertEqual(engine.session(session.id)?.messages, saved)
        // Same history ID on another machine must not merge with the original machine.
        var secondMachine = environment.config
        secondMachine.host = "second-machine"
        _ = try await engine.discoverHistory(secondMachine)
        XCTAssertEqual(engine.sessions.count, 2)
        XCTAssertEqual(Set(engine.sessions.map { $0.config.key }).count, 2)
        _ = try await engine.discoverHistory(secondMachine)
        XCTAssertEqual(engine.sessions.count, 2)
        environment.agents.close(secondMachine)
    }
}

final class LogicTests: XCTestCase {
    func testStateDelta() throws {
        var state = try applyStateDelta(nil, ["version": 1, "message": ["blocks": [["text": "he"]]], "gone": true])
        state = try applyStateDelta(state, ["delta": true, "base": 1, "version": 2, "patches": [
            ["path": ["version"], "value": 2], ["path": ["gone"], "remove": true],
            ["path": ["message", "blocks", 0, "text"], "append": "llo"], ["path": ["message", "blocks", 1], "value": ["text": "new"]],
        ]])
        XCTAssertEqual(state["message"]?["blocks"]?.array?[0]["text"]?.string, "hello")
        XCTAssertEqual(state["message"]?["blocks"]?.array?.count, 2); XCTAssertNil(state["gone"])
        XCTAssertThrowsError(try applyStateDelta(state, ["delta": true, "base": 1, "version": 3, "patches": []]))
    }

    func testConnectionValidation() throws {
        XCTAssertEqual(try ConnectionConfig(host: "ssh axi").validated().host, "axi")
        XCTAssertEqual(try ConnectionConfig(host: "me@1.2.3.4").validated().host, "me@1.2.3.4")
        for bad in ["-oProxyCommand=x", "a b", "", "a;b", "$(x)"] { XCTAssertThrowsError(try ConnectionConfig(host: bad).validated(), bad) }
    }

    func testPortInputDoesNotSilentlyFallBackToSSHConfig() throws {
        XCTAssertNil(try ConnectionConfig.parsePort("  "))
        XCTAssertEqual(try ConnectionConfig.parsePort(" 2222 "), 2222)
        XCTAssertEqual(try ConnectionConfig.parsePort("65535"), 65535)
        for value in ["abc", "22x", "0", "65536", "-1", "+22", "22.0", "999999999999999999999999"] {
            XCTAssertThrowsError(try ConnectionConfig.parsePort(value), value)
        }
    }

    func testCommands() {
        let catalogue = [RemoteCommand(name: "usage", description: "show", builtin: true), RemoteCommand(name: "model", argumentHint: "<x>", aliases: ["m"], builtin: true), RemoteCommand(name: "user-skill"), RemoteCommand(name: "clear", builtin: true), RemoteCommand(name: "mode", argumentHint: "<a|b>", builtin: true)]
        let all = CommandCompletion.candidates(catalogue)
        XCTAssertTrue(all.contains { $0.name == "m" })
        XCTAssertEqual(CommandCompletion.match(all, query: "us").map(\.name), ["usage", "user-skill"])
        XCTAssertEqual(CommandCompletion.token("/us", caret: 3)?.query, "us")
        XCTAssertNil(CommandCompletion.token("/us abc", caret: 6))
        XCTAssertNil(CommandCompletion.token("hi", caret: 1))
        XCTAssertEqual(CommandCompletion.complete("/us abc", stop: 3, command: catalogue[0]), "/usage abc")
        XCTAssertEqual(CommandCompletion.complete("/us", stop: 3, command: catalogue[0]), "/usage ")
        var capabilities = Capabilities(commands: catalogue, models: [])
        capabilities.models = []
        XCTAssertEqual(commandInteraction(capabilities, text: "/clear", preferences: nil)?.kind, .newConversation)
        XCTAssertNil(commandInteraction(capabilities, text: "/clear now", preferences: nil))
        XCTAssertEqual(commandInteraction(capabilities, text: "/m", preferences: nil)?.kind, .model)
        XCTAssertEqual(commandInteraction(capabilities, text: "/mode", preferences: nil)?.options.map(\.value), ["a", "b"])
        XCTAssertNil(commandInteraction(capabilities, text: "/user-skill", preferences: nil))
    }

    func testToolPresentationAndDiff() {
        let edit = ToolPresentation(name: "Edit", input: ["file_path": "/a.js", "old_string": "a\nb\nc", "new_string": "a\nB\nc"])
        XCTAssertEqual(edit.file, "/a.js"); XCTAssertTrue(edit.startsOpen)
        XCTAssertEqual(edit.body, .diff([DiffRow(.context, "a"), DiffRow(.added, "B"), DiffRow(.removed, "b"), DiffRow(.context, "c")]))
        XCTAssertEqual(ToolPresentation(name: "mcp__gh__list_prs", input: ["q": "v"]).title, "gh · list_prs")
        XCTAssertEqual(ToolPresentation(name: "Task", input: ["subagent_type": "Explore", "description": "d"]).title, "Agent · Explore")
        XCTAssertEqual(ToolPresentation(name: "constructor", input: nil).title, "constructor")
        if case .todos(let todos)? = ToolPresentation(name: "TodoWrite", input: ["todos": [["content": "x", "activeForm": "doing", "status": "in_progress"]]]).body { XCTAssertEqual(todos[0].text, "doing") } else { XCTFail("todos") }
        XCTAssertEqual(unifiedDiffRows("diff --git a b\n@@ -1 +1 @@\n-old\n+new\n ctx\n"), [DiffRow(.hunk, "@@ -1 +1 @@"), DiffRow(.removed, "old"), DiffRow(.added, "new"), DiffRow(.context, "ctx")])
    }

    func testMarkdownAndPaths() {
        let blocks = parseMarkdown("# T\n\npara\nline\n\n- a\n  - b\n1. c\n\n```js\nx=1\n```\n> q\n\n| h | i |\n|---|---|\n| 1 | 2 |\n\n---\nend")
        XCTAssertEqual(blocks[0], .heading(1, "T")); XCTAssertEqual(blocks[1], .paragraph("para\nline"))
        guard case .list(let items) = blocks[2] else { return XCTFail("list") }
        XCTAssertEqual(items.map(\.marker), ["•", "•", "1."]); XCTAssertEqual(items[1].indent, 1)
        XCTAssertEqual(blocks[3], .code(language: "js", text: "x=1")); XCTAssertEqual(blocks[4], .quote("q"))
        XCTAssertEqual(blocks[5], .table([["h", "i"], ["1", "2"]])); XCTAssertEqual(blocks[6], .rule); XCTAssertEqual(blocks[7], .paragraph("end"))
        XCTAssertEqual(remotePathReference("src/app.js:12")?.path, "src/app.js"); XCTAssertEqual(remotePathReference("src/app.js:12")?.line, 12)
        XCTAssertEqual(remotePathReference("/etc/hosts")?.path, "/etc/hosts"); XCTAssertEqual(remotePathReference("a.pdf")?.path, "a.pdf")
        for text in ["e.g.", "v1.2", "npm install", "https://x.y/z", "/"] { XCTAssertNil(remotePathReference(text), text) }
    }

    func testSchemaFields() throws {
        let fields = try SchemaField.fields(["type": "object", "required": ["a"], "properties": ["a": ["type": "string", "enum": ["x", "y"]], "b": ["type": "integer"], "c": ["type": "array", "items": ["enum": ["p"]]], "d": ["type": "boolean"]]])
        XCTAssertEqual(fields.map(\.kind), [.choice, .integer, .multiChoice, .boolean]); XCTAssertTrue(fields[0].required)
        XCTAssertThrowsError(try SchemaField.fields(["type": "object", "properties": ["a": ["type": "object"]]]))
    }

    func testReadHistoryResultSurvivesInterleavedAssistantAndArrayContent() throws {
        let records = try JSON.parse(Data(#"""
        [
          {"type":"assistant","message":{"content":[{"type":"tool_use","id":"read-1","name":"Read","input":{"file_path":"/tmp/example.txt"}}]}},
          {"type":"assistant","message":{"content":[{"type":"text","text":"Reading…"}]}},
          {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"read-1","content":[{"type":"text","text":"first line"},{"type":"text","text":"second line"}]}]}}
        ]
        """#.utf8)).array!
        let messages = historyMessages(records)
        XCTAssertEqual(messages[0].blocks?.first?.output, "first line\nsecond line")
        XCTAssertFalse(ToolPresentation(name: "Read", input: ["file_path": "/tmp/example.txt"]).hidesOutput)
    }

    func testHistoryText() {
        XCTAssertEqual(historyDisplayTitle("<command-name>/clear</command-name><command-message>clear</command-message>"), "/clear")

        XCTAssertEqual(historyUserText("<command-name>/x</command-name><command-args>1</command-args>"), "/x 1")
        XCTAssertEqual(historyUserText("<system-reminder>r</system-reminder>\nhello"), "hello")
    }
}
