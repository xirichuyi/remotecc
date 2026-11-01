// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "RemoteCC",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "RemoteCC", targets: ["RemoteCC"])],
    dependencies: [
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", exact: "2.4.1"),
    ],
    targets: [
        // Foundation only, so connection and protocol logic also build and test on Linux.
        .target(name: "RemoteCCCore"),
        .executableTarget(name: "RemoteCC", dependencies: ["RemoteCCCore", .product(name: "MarkdownUI", package: "swift-markdown-ui", condition: .when(platforms: [.macOS]))]),
        .testTarget(name: "RemoteCCCoreTests", dependencies: ["RemoteCCCore"]),
    ]
)
