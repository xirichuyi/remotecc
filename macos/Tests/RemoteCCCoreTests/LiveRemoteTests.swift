import XCTest
@testable import RemoteCCCore

/// Opt-in only: uses the native transport and engine against a real SSH host.
final class LiveRemoteTests: XCTestCase {
    @MainActor
    func testNativeFilesHistoryAndReconnect() async throws {
        guard let host = ProcessInfo.processInfo.environment["REMOTECC_LIVE_HOST"] else {
            throw XCTSkip("Set REMOTECC_LIVE_HOST to run real SSH integration")
        }
        let environment = try AgentEnvironment(standIn: false)
        defer { environment.cleanup() }
        let ssh = try SSHConnections()
        let config = ConnectionConfig(host: host, directory: "/tmp/remotecc-swift-live-" + UUID().uuidString)
        let agents = AgentClient(launcher: ssh, resources: try ServerResources(directory: environment.resourcesDirectory))
        let files = RemoteFiles(agents: agents, cacheDirectory: environment.home.appendingPathComponent("live-cache"))
        let engine = try ChatEngine(store: ChatStore(directory: environment.home.appendingPathComponent("live-store")), agents: agents, files: files)
        func remote(_ command: String) async throws {
            let child = try ssh.spawn(config, command: command)
            child.closeInput()
            let code = await child.waitForExit()
            guard code == 0 else { throw RemoteError(child.stderrText) }
        }
        do {
            try await ssh.connect(config)
            try await remote("mkdir " + shellQuote(config.directory))
            let local = environment.home.appendingPathComponent("中文 file.txt")
            let bytes = Data("native transfer\n中文\n".utf8)
            try bytes.write(to: local)
            let uploaded = try await files.upload(config, file: local, directory: config.directory)
            let preview = try await files.preview(config, uploaded.path)
            XCTAssertEqual(preview.text, String(decoding: bytes, as: UTF8.self))
            let destination = environment.home.appendingPathComponent("download.txt")
            try await files.download(config, uploaded.path, to: destination)
            XCTAssertEqual(try Data(contentsOf: destination), bytes)
            if ProcessInfo.processInfo.environment["REMOTECC_LIVE_LARGE"] == "1" {
                let large = environment.home.appendingPathComponent("large.bin")
                let payload = Data(repeating: 0xA5, count: 32 * 1024 * 1024)
                try payload.write(to: large)
                let uploadedLarge = try await files.upload(config, file: large, directory: config.directory)
                let downloadedLarge = environment.home.appendingPathComponent("large-downloaded.bin")
                try await files.download(config, uploadedLarge.path, to: downloadedLarge)
                XCTAssertEqual(try Data(contentsOf: downloadedLarge), payload)
                try await remote("rm " + shellQuote(uploadedLarge.path))
                print("PASS native real SSH 32 MiB upload/download with byte-for-byte equality")
            }
            if ProcessInfo.processInfo.environment["REMOTECC_LIVE_MODEL"] == "1" {
                var preferences = Preferences(); preferences.selectedModel = "sonnet"; preferences.effort = "low"
                let id = try engine.create(config, preferences: preferences).id
                try engine.send(id, text: "Use Read and Edit only on the attached file. Replace native transfer with native edited, preserve the Chinese line and trailing newline. Reply done.", attachments: [uploaded])
                let deadline = Date().addingTimeInterval(150)
                while engine.isRunning(id) {
                    if Date() > deadline { try? await engine.stop(id); throw RemoteError("Live native model test timed out") }
                    for permission in engine.session(id)?.permissions ?? [] {
                        let allow = ["Read", "Edit"].contains(permission.name ?? "") && permission.input?["file_path"]?.string == uploaded.path
                        try await engine.respond(id, permission: permission.id, answer: ["allow": .bool(allow)])
                    }
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
                XCTAssertEqual(engine.session(id)?.status, "idle", engine.session(id)?.messages.last?.error ?? "")
                files.invalidate()
                let edited = try await files.preview(config, uploaded.path)
                XCTAssertEqual(edited.text, "native edited\n中文\n")
                let checkpoint = try XCTUnwrap(engine.session(id)?.messages.last?.checkpointId)
                let before = try await engine.rewindFiles(id, checkpoint: checkpoint)
                XCTAssertEqual(before["canRewind"]?.bool, true, before.text())
                let token = try XCTUnwrap(before["token"]?.string)
                let result = try await engine.rewindFiles(id, checkpoint: checkpoint, token: token)
                XCTAssertEqual(result["canRewind"]?.bool, true, result.text())
                let restored = try await files.preview(config, uploaded.path)
                XCTAssertEqual(restored.text, String(decoding: bytes, as: UTF8.self))
                XCTAssertEqual(engine.session(id)?.messages.count, 2)
                try await engine.remove(id)
                print("PASS native Swift attachment → real model Edit → checkpoint preview/apply → exact original contents, chat preserved")
            }
            let discovered = try await engine.discoverHistory(config)
            XCTAssertGreaterThan(discovered.total, 0)
            let originalCount = engine.sessions.count
            _ = try await engine.discoverHistory(config)
            XCTAssertEqual(engine.sessions.count, originalCount)
            if let first = engine.sessions.first {
                try await engine.loadHistory(first.id)
                let ids = engine.session(first.id)?.messages.map(\.id)
                try await engine.refreshHistory(first.id)
                XCTAssertEqual(engine.session(first.id)?.messages.map(\.id), ids)
            }
            if let failed = engine.sessions.first(where: { $0.directory.hasPrefix("/tmp/remotecc-native-flows-") }) {
                try await engine.loadHistory(failed.id)
                let messages = engine.session(failed.id)?.messages ?? []
                if messages.contains(where: { ($0.blocks ?? []).contains(where: { $0.text?.contains("hit your 5-hour limit") == true }) }) {
                    XCTAssertTrue(messages.contains { $0.error?.contains("hit your 5-hour limit") == true }, "Real quota failure lost its error marker")
                }
            }
            agents.close(config)
            await ssh.disconnect(config)
            try await ssh.connect(config)
            let reconnected = try await files.run(config, "hello")
            XCTAssertNotNil(reconnected["home"]?.string)
            print("PASS native Swift SSH upload/download, history load/refresh/dedup, reconnect")
            try await remote("rm " + shellQuote(uploaded.path) + " && rmdir " + shellQuote(config.directory))
            engine.shutdown(); agents.close(config); await ssh.disconnect(config)
        } catch {
            engine.shutdown(); agents.close(config); await ssh.disconnect(config)
            throw error
        }
    }
}
