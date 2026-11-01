import XCTest
import Darwin
@testable import RemoteCCCore

final class SoakTests: XCTestCase {
    func testSustainedReadsTransfersAndReconnects() async throws {
        guard let host = ProcessInfo.processInfo.environment["REMOTECC_SOAK_HOST"] else { throw XCTSkip("Opt-in sustained real SSH test") }
        let duration = Double(ProcessInfo.processInfo.environment["REMOTECC_SOAK_SECONDS"] ?? "900") ?? 900
        func metric(_ text: String) { FileHandle.standardError.write(Data((text + "\n").utf8)) }
        func descriptors() -> Int { (0..<min(getdtablesize(), 8192)).reduce(0) { $0 + (fcntl($1, F_GETFD) == -1 ? 0 : 1) } }
        func rss() throws -> Int {
            let text = String(decoding: try RemoteCCCoreTests.run("/bin/ps", ["-o", "rss=", "-p", String(getpid())]), as: UTF8.self)
            return Int(text.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        }
        let env = try AgentEnvironment(standIn: false); defer { env.cleanup() }
        let baselineFD = descriptors()
        let ssh = try SSHConnections()
        let config = ConnectionConfig(host: host, directory: "/tmp/remotecc-soak-" + UUID().uuidString)
        let agents = AgentClient(launcher: ssh, resources: try ServerResources(directory: env.resourcesDirectory))
        let files = RemoteFiles(agents: agents, cacheDirectory: env.home.appendingPathComponent("soak-cache"))
        func remote(_ command: String) async throws {
            let process = try ssh.spawn(config, command: command); process.closeInput()
            let code = await process.waitForExit(); guard code == 0 else { throw RemoteError(process.stderrText) }
        }
        var created = false
        do {
            try await ssh.connect(config)
            try await remote("mkdir " + shellQuote(config.directory)); created = true
            let local = env.home.appendingPathComponent("fixture.txt")
            let data = Data(("SOAK-CONTENT\n" + String(repeating: "stable\n", count: 8192)).utf8)
            try data.write(to: local)
            let attachment = try await files.upload(config, file: local, directory: config.directory)
            let started = Date(); var iterations = 0, reconnects = 0, downloads = 0, nextReconnect = 60.0
            var samples: [Double] = []; var firstRSS: Int?; var maxFD = baselineFD, maxRSS = 0
            while Date().timeIntervalSince(started) < duration {
                let t = Date()
                let preview = try await files.preview(config, attachment.path)
                XCTAssertEqual(preview.text, String(decoding: data, as: UTF8.self))
                samples.append(Date().timeIntervalSince(t) * 1000)
                iterations += 1
                if iterations % 10 == 0 {
                    let destination = env.home.appendingPathComponent("download.txt")
                    try await files.download(config, attachment.path, to: destination)
                    XCTAssertEqual(try Data(contentsOf: destination), data); downloads += 1
                }
                let elapsed = Date().timeIntervalSince(started)
                if elapsed >= nextReconnect {
                    agents.close(config); await ssh.disconnect(config)
                    try await ssh.connect(config)
                    let value = try await files.preview(config, attachment.path)
                    XCTAssertEqual(value.text, String(decoding: data, as: UTF8.self))
                    reconnects += 1; nextReconnect += 60
                    let fd = descriptors(), memory = try rss()
                    if firstRSS == nil { firstRSS = memory }
                    maxFD = max(maxFD, fd); maxRSS = max(maxRSS, memory)
                    metric("SOAK elapsed=\(Int(elapsed))s reads=\(iterations) downloads=\(downloads) reconnects=\(reconnects) fd=\(fd) rssKiB=\(memory)")
                }
                try await Task.sleep(nanoseconds: 2_000_000_000)
            }
            samples.sort()
            metric("SOAK FINAL seconds=\(Int(Date().timeIntervalSince(started))) reads=\(iterations) downloads=\(downloads) reconnects=\(reconnects) medianMs=\(Int(samples[samples.count/2])) p95Ms=\(Int(samples[min(samples.count-1, Int(Double(samples.count)*0.95))])) maxFD=\(maxFD) firstRSSKiB=\(firstRSS ?? 0) maxRSSKiB=\(maxRSS)")
            try await remote("rm " + shellQuote(attachment.path) + " && rmdir " + shellQuote(config.directory)); created = false
            agents.close(config); await ssh.closeAll()
            try await Task.sleep(nanoseconds: 1_000_000_000)
            let finalFD = descriptors()
            metric("SOAK CLEANUP baselineFD=\(baselineFD) finalFD=\(finalFD)")
            XCTAssertLessThanOrEqual(finalFD, baselineFD + 12, "Connection/file descriptors accumulated after cleanup")
        } catch {
            if created { try? await remote("rm -f " + shellQuote(config.directory + "/fixture.txt") + "; rmdir " + shellQuote(config.directory)) }
            agents.close(config); await ssh.closeAll(); throw error
        }
    }
}
