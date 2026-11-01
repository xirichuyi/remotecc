import XCTest
@testable import RemoteCCCore

final class LiveTaskRecoveryTests: XCTestCase {
    @MainActor
    func testTaskContinuesOfflineWithoutDuplicateTurn() async throws {
        guard let host = ProcessInfo.processInfo.environment["REMOTECC_RESUME_HOST"] else { throw XCTSkip("Opt-in real Claude in-flight recovery") }
        let env = try AgentEnvironment(standIn: false); defer { env.cleanup() }
        let ssh = try SSHConnections()
        let config = ConnectionConfig(host: host, directory: "/tmp/remotecc-resume-" + UUID().uuidString)
        let agents = AgentClient(launcher: ssh, resources: try ServerResources(directory: env.resourcesDirectory))
        let files = RemoteFiles(agents: agents, cacheDirectory: env.home.appendingPathComponent("cache"))
        let engine = try ChatEngine(store: ChatStore(directory: env.home.appendingPathComponent("store")), agents: agents, files: files)
        func remote(_ command: String) async throws {
            let p = try ssh.spawn(config, command: command); p.closeInput()
            let code = await p.waitForExit(); guard code == 0 else { throw RemoteError(p.stderrText) }
        }
        var sessionID: String?
        do {
            try await ssh.connect(config); engine.updateConnection(config, ssh.state(config))
            try await remote("mkdir " + shellQuote(config.directory))
            var preferences = Preferences(); preferences.selectedModel = "sonnet"; preferences.effort = "low"
            let id = try engine.create(config, preferences: preferences).id; sessionID = id
            let token = "RESUME-" + UUID().uuidString
            try engine.send(id, text: "Remember this exact token: " + token + ". Write about 250 words explaining what a text editor does. Do not use tools.")
            try await eventually(45) { engine.session(id)?.remoteTask?.submitted == true }
            XCTAssertTrue(engine.isRunning(id), "Test must disconnect an in-flight task")
            let originalIDs = engine.session(id)?.messages.map(\.id)
            engine.detach(config); agents.close(config); await ssh.disconnect(config)
            engine.updateConnection(config, ssh.state(config))
            FileHandle.standardError.write(Data("RESUME task submitted; disconnected for 120 seconds\n".utf8))
            try await Task.sleep(nanoseconds: 120_000_000_000)
            try await ssh.connect(config); engine.updateConnection(config, ssh.state(config))
            await engine.restore(config)
            try await eventually(45) { !engine.isRunning(id) }
            XCTAssertEqual(engine.session(id)?.status, "idle")
            XCTAssertEqual(engine.session(id)?.messages.map(\.id), originalIDs)
            XCTAssertEqual(engine.session(id)?.messages.count, 2)
            try engine.send(id, text: "Return only the exact RESUME token I asked you to remember. Do not use tools.")
            try await eventually(45) { !engine.isRunning(id) }
            let output = (engine.session(id)?.messages.last?.blocks ?? []).compactMap(\.text).joined()
            XCTAssertTrue(output.contains(token), "Conversation context was lost on reconnect")
            XCTAssertEqual(engine.session(id)?.messages.count, 4)
            FileHandle.standardError.write(Data("RESUME PASS: original message IDs preserved, no duplicate turn, remembered token correct\n".utf8))
            try await engine.remove(id); sessionID = nil
            try await remote("rmdir " + shellQuote(config.directory))
            engine.shutdown(); agents.close(config); await ssh.closeAll()
        } catch {
            try? await ssh.connect(config)
            if let id = sessionID { try? await engine.remove(id) }
            try? await remote("rmdir " + shellQuote(config.directory))
            engine.shutdown(); agents.close(config); await ssh.closeAll(); throw error
        }
    }
}
