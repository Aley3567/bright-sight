// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "BrightSightVoice",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "BrightSightVoice", targets: ["BrightSightVoice"]),
  ],
  targets: [
    .executableTarget(
      name: "BrightSightVoice",
      path: "Sources/BrightSightVoice"
    ),
    .executableTarget(
      name: "AXPlayground",
      path: "Sources/AXPlayground"
    ),
    .testTarget(
      name: "BrightSightVoiceTests",
      dependencies: ["BrightSightVoice"],
      path: "Tests/BrightSightVoiceTests"
    ),
  ],
  swiftLanguageModes: [.v5]
)
