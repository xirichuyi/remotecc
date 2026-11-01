import XCTest
@testable import RemoteCCCore

final class TransferBenchmarkTests: XCTestCase {
    func testRealTransferBenchmark() async throws {
        guard let host = ProcessInfo.processInfo.environment["REMOTECC_TRANSFER_HOST"] else { throw XCTSkip("Opt-in real transfer benchmark") }
        let env = try AgentEnvironment(standIn: false); defer { env.cleanup() }
        let ssh = try SSHConnections()
        let config = ConnectionConfig(host: host, directory: "/tmp/remotecc-throughput-" + UUID().uuidString)
        let agents = AgentClient(launcher: ssh, resources: try ServerResources(directory: env.resourcesDirectory))
        let files = RemoteFiles(agents: agents, cacheDirectory: env.home.appendingPathComponent("cache"))
        func remote(_ command: String) async throws {
            let p = try ssh.spawn(config, command: command); p.closeInput()
            let code = await p.waitForExit(); guard code == 0 else { throw RemoteError(p.stderrText) }
        }
        func log(_ message: String) { FileHandle.standardError.write(Data((message + "\n").utf8)) }
        try await ssh.connect(config)
        try await remote("mkdir " + shellQuote(config.directory))
        var uploaded: [String] = []
        do {
            _ = try await agents.info(config)
            let random = try FileHandle(forReadingFrom: URL(fileURLWithPath: "/dev/urandom"))
            let payload = try XCTUnwrap(random.read(upToCount: 2 * 1024 * 1024)); try random.close()
            let large = env.home.appendingPathComponent("large.bin"); try payload.write(to: large)
            var start = Date()
            let attachment = try await files.upload(config, file: large, directory: config.directory); uploaded.append(attachment.path)
            let up = Date().timeIntervalSince(start)
            start = Date()
            let destination = env.home.appendingPathComponent("large-down.bin")
            try await files.download(config, attachment.path, to: destination)
            let down = Date().timeIntervalSince(start)
            XCTAssertEqual(try Data(contentsOf: destination), payload)
            log("TRANSFER random2MiB upload=\(String(format:"%.3f", up))s download=\(String(format:"%.3f", down))s")
            for round in 0..<3 {
                for width in (round % 2 == 0 ? [1, 2] : [2, 1]) {
                    var urls: [URL] = []
                    for index in 0..<8 {
                        let url = env.home.appendingPathComponent("small-\(round)-\(width)-\(index).bin")
                        try payload.prefix(32 * 1024).write(to: url); urls.append(url)
                    }
                    let begin = Date()
                    let results: [Attachment]
                    if width == 2 {
                        let batch = await files.uploadBatch(config, files: urls, directory: config.directory)
                        XCTAssertEqual(batch.map(\.file), urls)
                        XCTAssertTrue(batch.allSatisfy { $0.error == nil })
                        results = batch.compactMap(\.attachment)
                    } else {
                        var serial: [Attachment] = []
                        for url in urls { serial.append(try await files.upload(config, file: url, directory: config.directory)) }
                        results = serial
                    }
                    let elapsed = Date().timeIntervalSince(begin)
                    uploaded += results.map(\.path)
                    XCTAssertEqual(results.count, 8)
                    // Validate every transfer, outside the timed interval.
                    for item in results {
                        try await files.download(config, item.path, to: destination)
                        XCTAssertEqual(try Data(contentsOf: destination), payload.prefix(32 * 1024))
                    }
                    log("TRANSFER batch8x32KiB round=\(round) concurrency=\(width) seconds=\(String(format:"%.3f", elapsed))")
                }
            }
            try await remote("rm " + uploaded.map(shellQuote).joined(separator: " ") + " && rmdir " + shellQuote(config.directory))
            agents.close(config); await ssh.closeAll()
        } catch {
            // Only files with names created by this fixture are cleaned up.
            try? await remote("rm -f " + shellQuote(config.directory) + "/small-*.bin " + shellQuote(config.directory + "/large.bin") + "; rmdir " + shellQuote(config.directory))
            agents.close(config); await ssh.closeAll(); throw error
        }
    }
}
