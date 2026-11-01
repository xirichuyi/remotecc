import XCTest
@testable import RemoteCCCore

final class LiveMultiServerTests: XCTestCase {
    func testConcurrentServersAndWakeRecovery() async throws {
        guard let firstHost = ProcessInfo.processInfo.environment["REMOTECC_LIVE_HOST"],
              let secondHost = ProcessInfo.processInfo.environment["REMOTECC_SECOND_HOST"] else {
            throw XCTSkip("Set two SSH hosts for live concurrency testing")
        }
        let environment = try AgentEnvironment(standIn: false)
        defer { environment.cleanup() }
        let log = environment.home.appendingPathComponent("sockets.txt")
        let wrapper = environment.home.appendingPathComponent("ssh-wrapper")
        let source = """
        #!/bin/sh
        previous=''
        socket=''
        master=''
        last=''
        for argument do
          if [ "$previous" = '-S' ]; then socket="$argument"; fi
          if [ "$argument" = '-M' ]; then master=yes; fi
          previous="$argument"
          last="$argument"
        done
        if [ "$master" = yes ]; then printf '%s|%s\\n' "$last" "$socket" >> \(shellQuote(log.path)); fi
        exec /usr/bin/ssh "$@"
        """
        try source.write(to: wrapper, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: wrapper.path)
        let ssh = try SSHConnections(executable: wrapper.path)
        let folder = "/tmp/remotecc-dual-" + UUID().uuidString
        let a = ConnectionConfig(host: firstHost, directory: folder), b = ConnectionConfig(host: secondHost, directory: folder)
        let localHome = environment.home
        let agents = AgentClient(launcher: ssh, resources: try ServerResources(directory: environment.resourcesDirectory))
        let files = RemoteFiles(agents: agents, cacheDirectory: environment.home.appendingPathComponent("dual-cache"))
        @Sendable func remote(_ config: ConnectionConfig, _ command: String) async throws {
            let child = try ssh.spawn(config, command: command); child.closeInput()
            let code = await child.waitForExit()
            guard code == 0 else { throw RemoteError(child.stderrText) }
        }
        @Sendable func exercise(_ config: ConnectionConfig) async throws -> Attachment {
            try await remote(config, "mkdir " + shellQuote(folder))
            let local = localHome.appendingPathComponent(config.host)
            try FileManager.default.createDirectory(at: local, withIntermediateDirectories: true)
            let file = local.appendingPathComponent("same-name.txt")
            try config.host.write(to: file, atomically: true, encoding: .utf8)
            return try await files.upload(config, file: file, directory: folder)
        }
        do {
            async let ca: Void = ssh.connect(a)
            async let cb: Void = ssh.connect(b)
            _ = try await (ca, cb)
            async let fa = exercise(a)
            async let fb = exercise(b)
            let (aa, bb) = try await (fa, fb)
            XCTAssertEqual(aa.path, bb.path)
            async let pa = files.preview(a, aa.path)
            async let pb = files.preview(b, bb.path)
            let (va, vb) = try await (pa, pb)
            XCTAssertEqual(va.text, firstHost); XCTAssertEqual(vb.text, secondHost)
            print("PASS two real servers concurrently upload/preview the same path with isolated contents")

            var previewLatencies: [Double] = []
            for _ in 0..<12 {
                let start = Date()
                _ = try await files.preview(b, bb.path)
                previewLatencies.append(Date().timeIntervalSince(start) * 1000)
            }
            previewLatencies.sort()
            print("MEASURE real SSH warm text preview: median=\(Int(previewLatencies[6]))ms max=\(Int(previewLatencies[11]))ms (12 requests; unchanged-version validation still crosses network)")

            // Kill only the test's own ControlMaster, then run the exact wake health-check path.
            let sockets = try String(contentsOf: log).split(separator: "\n").map { $0.split(separator: "|", maxSplits: 1).map(String.init) }
            let socket = try XCTUnwrap(sockets.first { $0.first == firstHost }?.last)
            let stop = try RemoteProcess(executable: "/usr/bin/ssh", arguments: ["-S", socket, "-O", "exit", firstHost])
            stop.closeInput(); let code = await stop.waitForExit(); XCTAssertEqual(code, 0)
            agents.close(a)
            async let check: Void = ssh.checkConnections()
            let unaffected = try await files.preview(b, bb.path)
            XCTAssertEqual(unaffected.text, secondHost)
            await check
            XCTAssertEqual(ssh.state(b).status, .connected)
            try await eventually(20) { ssh.state(a).status == .connected }
            let recovered = try await files.preview(a, aa.path)
            XCTAssertEqual(recovered.text, firstHost)
            print("PASS wake recovery after actual SSH master loss; second server remained usable")
            for config in [a, b] {
                try await remote(config, "rm " + shellQuote(folder + "/same-name.txt") + " && rmdir " + shellQuote(folder))
                agents.close(config)
            }
            await ssh.closeAll()
        } catch {
            agents.close(a); agents.close(b); await ssh.closeAll()
            throw error
        }
    }
}
