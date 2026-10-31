// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "RemoteCC",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "RemoteCC", targets: ["RemoteCC"])],
    targets: [
        // Foundation only, so connection and protocol logic also build and test on Linux.
        .target(name: "RemoteCCCore"),
        .executableTarget(name: "RemoteCC", dependencies: ["RemoteCCCore"]),
        .testTarget(name: "RemoteCCCoreTests", dependencies: ["RemoteCCCore"]),
    ]
)
