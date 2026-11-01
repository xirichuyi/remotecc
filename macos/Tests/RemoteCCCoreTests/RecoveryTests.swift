import XCTest
@testable import RemoteCCCore

final class RecoveryTests: XCTestCase {
    private func fixture() throws -> (URL, SSHConnections) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("rcc-recovery-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let script = root.appendingPathComponent("ssh.py")
        let source = #"""
#!/usr/bin/python3
import sys,os,time
from pathlib import Path
root=Path(__file__).parent
args=sys.argv[1:]
socket=Path(args[args.index('-S')+1])
if '-M' in args:
    time.sleep(.2)
    socket.touch()
    sys.exit(0)
if '-O' in args:
    if args[args.index('-O')+1]=='exit': socket.unlink(missing_ok=True)
    sys.exit(0)
if args[-1]=='stream':
    for _ in range(100):
        if not socket.exists(): sys.exit(255)
        os.write(1,b'data')
        time.sleep(.1)
    sys.exit(0)
# The local master is alive, but the remote endpoint can be unreachable.
if args[-2]=='machine-a' and (root/'stall-probe').exists(): time.sleep(60)
if not socket.exists() or (args[-2]=='machine-a' and (root/'fail-probe').exists()): sys.exit(255)
sys.exit(0)
"""#
        try source.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        return (root, try SSHConnections(executable: script.path))
    }

    func testWakeProbeDetectsUnreachableEndpointWithoutDisconnectingOtherMachine() async throws {
        let (root, ssh) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let a = ConnectionConfig(host: "machine-a"), b = ConnectionConfig(host: "machine-b")
        async let first: Void = ssh.connect(a)
        async let second: Void = ssh.connect(b)
        _ = try await (first, second)
        try Data().write(to: root.appendingPathComponent("fail-probe"))
        await ssh.checkConnections()
        XCTAssertEqual(ssh.state(a).status, .error)
        XCTAssertEqual(ssh.state(b).status, .connected)
        try FileManager.default.removeItem(at: root.appendingPathComponent("fail-probe"))
        try await eventually { ssh.state(a).status == .connected }
        await ssh.closeAll()
    }

    func testSlowProbeTimesOutWithoutBlockingHealthyServer() async throws {
        let (root, ssh) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let a = ConnectionConfig(host: "machine-a"), b = ConnectionConfig(host: "machine-b")
        try await ssh.connect(a); try await ssh.connect(b)
        try Data().write(to: root.appendingPathComponent("stall-probe"))
        let started = Date()
        let check = Task { await ssh.checkConnections() }
        let healthy = try ssh.spawn(b, command: "true")
        healthy.closeInput()
        let result = await healthy.waitForExit()
        XCTAssertEqual(result, 0)
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
        await check.value
        XCTAssertLessThan(Date().timeIntervalSince(started), 12)
        XCTAssertEqual(ssh.state(a).status, .connected, "A single timed-out probe must not kill a live master")
        XCTAssertEqual(ssh.state(b).status, .connected)
        await ssh.closeAll()
    }

    func testSlowHealthProbeDoesNotAbortAnActiveTransfer() async throws {
        let (root, ssh) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let config = ConnectionConfig(host: "machine-a")
        try await ssh.connect(config)
        try Data().write(to: root.appendingPathComponent("stall-probe"))
        let stream = try ssh.spawn(config, command: "stream"); stream.closeInput()
        final class Received: @unchecked Sendable { var bytes = 0 }
        let received = Received()
        let drained = Task {
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                stream.readOutput(chunk: { received.bytes += $0.count }, done: { done.resume() })
            }
        }
        await ssh.checkConnections()
        let code = await stream.waitForExit(); await drained.value
        XCTAssertEqual(code, 0, "A slow probe killed the shared master and interrupted a healthy transfer")
        XCTAssertEqual(received.bytes, 400)
        XCTAssertTrue(ssh.state(config).error.contains("响应较慢"))
        try FileManager.default.removeItem(at: root.appendingPathComponent("stall-probe"))
        await ssh.checkConnections()
        XCTAssertTrue(ssh.state(config).error.isEmpty)
        await ssh.closeAll()
    }

    func testDisconnectDuringConnectDoesNotResurrectConnection() async throws {
        let (root, ssh) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let config = ConnectionConfig(host: "machine-a")
        let connection = Task { try await ssh.connect(config) }
        try await eventually { ssh.state(config).status == .connecting }
        await ssh.disconnect(config)
        do { try await connection.value; XCTFail("Cancelled connection must not succeed") }
        catch { XCTAssertEqual(ssh.state(config).status, .disconnected) }
        try await Task.sleep(nanoseconds: 1_500_000_000)
        XCTAssertEqual(ssh.state(config).status, .disconnected)
        await ssh.closeAll()
    }

    func testNetworkAvailabilityDoesNotReconnectManuallyDisconnectedServer() async throws {
        let (root, ssh) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let config = ConnectionConfig(host: "machine-a")
        try await ssh.connect(config)
        await ssh.disconnect(config)
        await ssh.networkBecameAvailable()
        XCTAssertEqual(ssh.state(config).status, .disconnected)
        await ssh.closeAll()
    }

    func testNotificationsCatchUpAfterDisconnectAndSeparateMachines() {
        var tracker = TaskNotificationTracker()
        XCTAssertNil(tracker.update(id: "a", status: "working", background: [], connected: true, isViewed: true))
        XCTAssertNil(tracker.update(id: "b", status: "working", background: [], connected: true, isViewed: false))
        XCTAssertNil(tracker.update(id: "a", status: "detached", background: [], connected: false, isViewed: false))
        XCTAssertNotNil(tracker.update(id: "a", status: "idle", background: [], connected: true, isViewed: false))
        XCTAssertNil(tracker.update(id: "a", status: "idle", background: [], connected: true, isViewed: false))
        XCTAssertNotNil(tracker.update(id: "b", status: "permission", background: [], connected: true, isViewed: false))
        XCTAssertNil(tracker.update(id: "b", status: "idle", background: [], connected: true, isViewed: true))
        XCTAssertNil(tracker.update(id: "a", status: "idle", background: ["task"], connected: true, isViewed: false))
        XCTAssertNotNil(tracker.update(id: "a", status: "idle", background: [], connected: true, isViewed: false))
    }
}
