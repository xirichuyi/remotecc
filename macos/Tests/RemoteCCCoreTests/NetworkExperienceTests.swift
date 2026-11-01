import XCTest
@testable import RemoteCCCore

private func networkMetric(_ text: String) {
    FileHandle.standardError.write(Data((text + "\n").utf8))
}

final class NetworkExperienceTests: XCTestCase {
    func testRealPacketLossInIsolatedRemoteNamespace() async throws {
        guard let host = ProcessInfo.processInfo.environment["REMOTECC_NETEM_HOST"] else {
            throw XCTSkip("Set REMOTECC_NETEM_HOST; requires isolated netns permission")
        }
        let env = try AgentEnvironment(standIn: false); defer { env.cleanup() }
        let base = try SSHConnections(); let config = ConnectionConfig(host: host, directory: "/tmp")
        try await base.connect(config)
        let relayPath = "/tmp/remotecc-netem-" + UUID().uuidString + ".py"
        let installer = try base.spawn(config, command: "umask 077; cat > " + shellQuote(relayPath))
        try await installer.writeAndWait(Data(contentsOf: repository.appendingPathComponent("macos/Tests/NetworkFixtures/netem-relay.py")))
        installer.closeInput(); let installed = await installer.waitForExit(); XCTAssertEqual(installed, 0)
        let wrapper = env.home.appendingPathComponent("ssh-netem")
        let mtu = Int(ProcessInfo.processInfo.environment["REMOTECC_NETEM_MTU"] ?? "1500") ?? 1500
        let proxy = "/usr/bin/ssh -o BatchMode=yes " + shellQuote(host) + " /usr/bin/python3 " + shellQuote(relayPath) + " " + String(mtu)
        let delayedProbe = ProcessInfo.processInfo.environment["REMOTECC_SLOW_PROBE"] == "1" ? "for argument do last=\"$argument\"; done\nif [ \"$last\" = true ]; then sleep 10; fi\n" : ""
        try ("#!/bin/sh\n" + delayedProbe + "exec /usr/bin/ssh -o " + shellQuote("ProxyCommand=" + proxy) + " \"$@\"\n").write(to: wrapper, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: wrapper.path)
        let ssh = try SSHConnections(executable: wrapper.path)
        ssh.onState = { _, state in networkMetric("NETEM connection: " + state.status.rawValue + " " + state.error) }
        let agents = AgentClient(launcher: ssh, resources: try ServerResources(directory: env.resourcesDirectory))
        let files = RemoteFiles(agents: agents, cacheDirectory: env.home.appendingPathComponent("netem-cache"))
        files.onProgress = { progress in
            if progress.finished { networkMetric("NETEM transfer bytes=\(progress.bytes)/\(progress.total) error=\(progress.error ?? "none")") }
        }
        let name = "remotecc-loss-" + UUID().uuidString + ".bin"
        do {
            try await ssh.connect(config)
            let random = try FileHandle(forReadingFrom: URL(fileURLWithPath: "/dev/urandom"))
            let data = try XCTUnwrap(random.read(upToCount: Int(ProcessInfo.processInfo.environment["REMOTECC_NETEM_BYTES"] ?? "1048576") ?? 1048576)); try random.close()
            let local = env.home.appendingPathComponent(name); try data.write(to: local)
            let start = Date()
            async let probe: Void = ssh.checkConnections()
            let attachment = try await files.upload(config, file: local, directory: "/tmp")
            let destination = env.home.appendingPathComponent("download")
            try await files.download(config, attachment.path, to: destination)
            XCTAssertEqual(try Data(contentsOf: destination), data)
            await probe
            XCTAssertEqual(ssh.state(config).status, .connected)
            let telemetry = AgentClient(launcher: base, resources: try ServerResources(directory: env.resourcesDirectory))
            let snapshot = try await telemetry.call(config, "file", ["operation": "preview", "path": .string(relayPath + ".stats"), "base": "/tmp"])
            let stats = try JSON.parse(Data((snapshot["text"]?.string ?? "[]").utf8)).array ?? []
            let dropped = stats.reduce(0) { $0 + ($1["drops"]?.int ?? 0) }
            XCTAssertGreaterThan(dropped, 0, "Configured loss must actually drop packets in this run")
            networkMetric("NETEM observed dropped packets=\(dropped)")
            telemetry.close(config)
            networkMetric("NETEM real 2% packet loss + 50ms per loopback egress: \(data.count)-byte upload/download=\(String(format: "%.2f", Date().timeIntervalSince(start)))s byte-identical")
            agents.close(config); await ssh.closeAll()
        } catch {
            networkMetric("NETEM FAILURE mtu=\(mtu): \(error.localizedDescription)")
            let telemetry = AgentClient(launcher: base, resources: try ServerResources(directory: env.resourcesDirectory))
            if let snapshot = try? await telemetry.call(config, "file", ["operation": "preview", "path": .string(relayPath + ".stats"), "base": "/tmp"]) {
                networkMetric("NETEM failure qdisc: " + (snapshot["text"]?.string ?? "missing"))
            }
            telemetry.close(config)
            agents.close(config); await ssh.closeAll()
            let cleanup = try? base.spawn(config, command: "rm -f " + shellQuote(relayPath) + " " + shellQuote(relayPath + ".stats") + " " + shellQuote(relayPath + ".stats.tmp") + " " + shellQuote("/tmp/" + name))
            cleanup?.closeInput(); _ = await cleanup?.waitForExit(); await base.closeAll()
            throw error
        }
        let cleanup = try base.spawn(config, command: "rm -f " + shellQuote(relayPath) + " " + shellQuote(relayPath + ".stats") + " " + shellQuote(relayPath + ".stats.tmp") + " " + shellQuote("/tmp/" + name))
        cleanup.closeInput(); _ = await cleanup.waitForExit(); await base.closeAll()
    }

    @MainActor
    func testShapedSSHAndFirstText() async throws {
        guard let host = ProcessInfo.processInfo.environment["REMOTECC_NETWORK_HOST"] else {
            throw XCTSkip("Set REMOTECC_NETWORK_HOST for opt-in shaped SSH tests")
        }
        let env = try AgentEnvironment(standIn: false)
        defer { env.cleanup() }
        let profile = env.home.appendingPathComponent("network.json")
        func shape(_ value: JSON) throws { try value.data().write(to: profile, options: .atomic) }
        try shape([:])
        let proxy = repository.appendingPathComponent("macos/Tests/NetworkFixtures/ssh-shaper.py").path
        let wrapper = env.home.appendingPathComponent("ssh")
        let command = "/usr/bin/python3 " + shellQuote(proxy) + " " + shellQuote(profile.path) + " %h %p"
        try ("#!/bin/sh\nexec /usr/bin/ssh -o " + shellQuote("ProxyCommand=" + command) + " \"$@\"\n").write(to: wrapper, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: wrapper.path)
        let ssh = try SSHConnections(executable: wrapper.path)
        let config = ConnectionConfig(host: host, directory: "/tmp/remotecc-network-" + UUID().uuidString)
        let agents = AgentClient(launcher: ssh, resources: try ServerResources(directory: env.resourcesDirectory))
        let files = RemoteFiles(agents: agents, cacheDirectory: env.home.appendingPathComponent("cache"))
        let engine = try ChatEngine(store: ChatStore(directory: env.home.appendingPathComponent("store")), agents: agents, files: files)
        func remote(_ command: String) async throws {
            let process = try ssh.spawn(config, command: command); process.closeInput()
            let result = await process.waitForExit()
            guard result == 0 else { throw RemoteError(process.stderrText) }
        }
        var created = false
        do {
            try await ssh.connect(config)
            try await remote("mkdir " + shellQuote(config.directory)); created = true
            let local = env.home.appendingPathComponent("random.bin")
            let random = try FileHandle(forReadingFrom: URL(fileURLWithPath: "/dev/urandom"))
            let payload = try XCTUnwrap(random.read(upToCount: 256 * 1024)); try random.close()
            try payload.write(to: local)
            let uploaded = try await files.upload(config, file: local, directory: config.directory)
            let scenarios: [(String, JSON)] = [
                ("baseline", [:]),
                ("added-300ms-RTT", ["delay_ms": 150]),
                ("added-500ms-RTT", ["delay_ms": 250]),
                ("128KiB-per-second", ["bytes_per_second": 131072]),
                ("32KiB-per-second", ["bytes_per_second": 32768]),
                ("retransmission-stalls-NOT-packet-loss", ["delay_ms": 50, "stall_every": 5, "stall_ms": 200])
            ]
            for (name, settings) in scenarios {
                try shape(settings)
                var samples: [Double] = []
                for _ in 0..<5 {
                    let start = Date()
                    _ = try await files.stat(config, uploaded.path)
                    samples.append(Date().timeIntervalSince(start) * 1000)
                }
                let start = Date()
                let destination = env.home.appendingPathComponent(name)
                async let download: Void = files.download(config, uploaded.path, to: destination)
                try await Task.sleep(nanoseconds: 200_000_000)
                let controlStart = Date()
                _ = try await files.stat(config, uploaded.path)
                let concurrentControl = Date().timeIntervalSince(controlStart) * 1000
                try await download
                let seconds = Date().timeIntervalSince(start)
                XCTAssertEqual(try Data(contentsOf: destination), payload)
                samples.sort()
                networkMetric("NETWORK \(name) stat-median=\(Int(samples[2]))ms stat-max=\(Int(samples[4]))ms concurrent-stat=\(Int(concurrentControl))ms 256KiB-download=\(String(format: "%.2f", seconds))s")
            }
            try shape([:])
            if ProcessInfo.processInfo.environment["REMOTECC_NETWORK_MODEL"] == "1" {
                var preferences = Preferences(); preferences.selectedModel = "sonnet"; preferences.effort = "low"
                let id = try engine.create(config, preferences: preferences).id
                for (name, settings) in [("cold", JSON.object([:])), ("resident+300ms-RTT", JSON.object(["delay_ms": 150]))] {
                    try shape(settings)
                    let start = Date(); var first: Double?
                    try engine.send(id, text: "Reply exactly SPEED-OK. Do not use tools.")
                    let deadline = Date().addingTimeInterval(120)
                    while engine.isRunning(id) {
                        if first == nil, let last = engine.session(id)?.messages.last, last.role == "assistant",
                           (last.blocks ?? []).contains(where: { $0.type == "text" && !($0.text ?? "").isEmpty }) {
                            first = Date().timeIntervalSince(start)
                        }
                        if Date() > deadline { try? await engine.stop(id); throw RemoteError("first-text test timed out") }
                        try await Task.sleep(nanoseconds: 10_000_000)
                    }
                    if first == nil, (engine.session(id)?.messages.last?.blocks ?? []).contains(where: { $0.type == "text" && !($0.text ?? "").isEmpty }) { first = Date().timeIntervalSince(start) }
                    XCTAssertEqual(engine.session(id)?.status, "idle")
                    XCTAssertNotNil(first)
                    networkMetric("FIRST_TEXT \(name) engine-observed=\(String(format: "%.3f", first ?? -1))s total=\(String(format: "%.3f", Date().timeIntervalSince(start)))s (not screen-paint latency)")
                }
            }
            let blackhole = ProcessInfo.processInfo.environment["REMOTECC_BLACKHOLE"] == "1"
            let lossStarted = Date()
            try shape(blackhole ? ["blackhole": true] : ["offline": true]); agents.close(config)
            await ssh.checkConnections()
            if blackhole { try await eventually(75) { ssh.state(config).status != .connected } }
            XCTAssertNotEqual(ssh.state(config).status, .connected)
            networkMetric("DISCONNECT mode=\(blackhole ? "silent-blackhole" : "closed-link") detectedSeconds=\(String(format: "%.2f", Date().timeIntervalSince(lossStarted)))")
            let offline = Double(ProcessInfo.processInfo.environment["REMOTECC_OFFLINE_SECONDS"] ?? "120") ?? 120
            let start = Date()
            var minute = -1
            while Date().timeIntervalSince(start) < offline {
                let currentMinute = Int(Date().timeIntervalSince(start)) / 60
                if currentMinute != minute { minute = currentMinute; networkMetric("OFFLINE elapsed=\(minute)m state=\(ssh.state(config).status.rawValue)") }
                XCTAssertNotEqual(ssh.state(config).status, .connected)
                try await Task.sleep(nanoseconds: 1_000_000_000)
            }
            try shape([:])
            // Exercise the same path called by NWPathMonitor and macOS wake.
            await ssh.networkBecameAvailable()
            try await eventually(45) { ssh.state(config).status == .connected }
            let recovered = try await files.stat(config, uploaded.path)
            XCTAssertEqual(recovered.size, payload.count)
            networkMetric("OFFLINE \(Int(offline))s recovered=\(String(format: "%.2f", Date().timeIntervalSince(start) - offline))s contents retained")
            try await remote("rm " + shellQuote(uploaded.path) + " && rmdir " + shellQuote(config.directory)); created = false
            engine.shutdown(); agents.close(config); await ssh.closeAll()
        } catch {
            try? shape([:])
            if created {
                try? await ssh.connect(config)
                try? await remote("rm -f " + shellQuote(config.directory + "/random.bin") + "; rmdir " + shellQuote(config.directory))
            }
            engine.shutdown(); agents.close(config); await ssh.closeAll()
            throw error
        }
    }
}
