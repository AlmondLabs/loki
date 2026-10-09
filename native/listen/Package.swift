// swift-tools-version: 6.0
// loki listen: records a call's two sides (the apps' audio through a Core Audio process tap, you through the
// microphone), transcribes both on this Mac with Apple's SpeechAnalyzer, and writes the transcript as markdown.
import Foundation
import PackageDescription

/// The Info.plist rides inside the binary, so macOS has the usage strings it shows when it asks for the microphone,
/// other apps' audio and speech recognition.
let plist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Sources/listen/Info.plist").path

let package = Package(
  name: "listen",
  platforms: [.macOS("26.0")],
  targets: [
    .target(name: "ListenCore"),
    .executableTarget(
      name: "listen",
      dependencies: ["ListenCore"],
      exclude: ["Info.plist"],
      linkerSettings: [.unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist])]
    ),
    .testTarget(name: "ListenCoreTests", dependencies: ["ListenCore"]),
  ],
  // AVFAudio's buffers and converters are not Sendable yet: Swift 6's strict checking rejects handing them between the
  // audio thread and the transcriber, which is the whole program.
  swiftLanguageModes: [.v5]
)
