// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Goodbase",
    platforms: [.iOS(.v15), .macOS(.v12), .tvOS(.v15), .watchOS(.v8)],
    products: [.library(name: "Goodbase", targets: ["Goodbase"])],
    targets: [
        .target(name: "Goodbase", path: "Sources/Goodbase"),
        .testTarget(name: "GoodbaseTests", dependencies: ["Goodbase"], path: "Tests/GoodbaseTests")
    ]
)
