import AVFAudio
import Foundation
import ListenCore
import Speech

/// Progress and warnings go to stderr, so stdout carries only the transcript's lines.
func log(_ message: String) {
  FileHandle.standardError.write(Data("listen: \(message)\n".utf8))
}

let usage = """
  usage: listen [--apps chrome,slack | --all] [--raw-mic] [--locale en-IN] [--out DIR]
         listen --list | --languages

  Records a call until Ctrl-C: the apps' audio as "Them", the microphone as "You", both transcribed on this Mac.
  The transcript is written as it goes to DIR (default ~/.loki/calls, or $LOKI_CALLS_DIR). No audio is kept.
    --apps   what to tap, by name or bundle ID (default chrome,slack: Meet in Chrome, Slack huddles)
    --all    tap every app's audio instead (music playing will be transcribed too)
    --raw-mic  the microphone as it is, without Apple's echo cancelling (to compare)
    --locale the language spoken (default this Mac's)
    --list   the apps Core Audio knows, their bundle IDs, and which are playing now
    --languages  the languages transcription supports (✓ installed on this Mac)
    --file   transcribe an audio file as "Them" instead of listening (to check transcription without a call)
  On speakers the microphone hears them too: Apple's voice processing (echo cancelling) takes that out of your side,
  and at the end listen counts the lines of yours that still look like theirs.
  """

/// Names for the apps a call runs in, with the helper processes that actually play their audio.
let knownApps: [String: [String]] = [
  "chrome": ["com.google.Chrome", "com.google.Chrome.helper", "com.google.Chrome.helper.renderer"],
  "slack": ["com.tinyspeck.slackmacgap", "com.tinyspeck.slackmacgap.helper"],
  "zoom": ["us.zoom.xos"],
  "safari": ["com.apple.Safari", "com.apple.WebKit.GPU", "com.apple.WebKit.WebContent"],
  "teams": ["com.microsoft.teams2", "com.microsoft.teams2.helper"],
]

var apps = ["chrome", "slack"]
var tapAll = false
var echoCancel = true
var localeArg: String?
var filePath: String?
var outDir = ProcessInfo.processInfo.environment["LOKI_CALLS_DIR"].map { URL(fileURLWithPath: $0) }
  ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".loki/calls")
var args = CommandLine.arguments.dropFirst().makeIterator()
while let arg = args.next() {
  switch arg {
  case "--apps": apps = (args.next() ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
  case "--all": tapAll = true
  case "--raw-mic": echoCancel = false
  case "--locale": localeArg = args.next()
  case "--file": filePath = args.next()
  case "--out": outDir = URL(fileURLWithPath: args.next() ?? ".")
  case "--list":
    for p in try audioProcesses().sorted(by: { ($0.bundleID ?? "") < ($1.bundleID ?? "") }) {
      print("\(p.playing ? "▶" : " ") \(p.bundleID ?? "?")  pid \(p.pid)")
    }
    exit(0)
  case "--languages":
    let installed = Set(await SpeechTranscriber.installedLocales.map(\.identifier))
    for id in await SpeechTranscriber.supportedLocales.map(\.identifier).sorted() {
      print("\(installed.contains(id) ? "✓" : " ") \(id)")
    }
    print("this Mac: \(Locale.current.identifier) → \(await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current)?.identifier ?? "not supported")")
    exit(0)
  case "-h", "--help":
    print(usage)
    exit(0)
  default:
    log("unknown option \(arg)\n\(usage)")
    exit(2)
  }
}
let bundleIDs = tapAll ? [] : apps.flatMap { knownApps[$0.lowercased()] ?? [$0] }

/// The transcript on disk, rewritten whole after each line so a crash loses at most the line being spoken.
actor Store {
  private var transcript: Transcript
  let file: URL
  init(_ transcript: Transcript, dir: URL) {
    self.transcript = transcript
    file = dir.appendingPathComponent(transcript.fileName())
  }
  func add(_ line: Line) {
    transcript.add(line)
    let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty { print("\(Transcript.stamp(line.at)) \(line.speaker.rawValue): \(text)") }
    write()
  }
  func finish(at ended: Date) {
    transcript.ended = ended
    write()
  }
  var lineCount: Int { transcript.lines.count }
  /// How many of your lines still look like their words heard back, of how many of yours.
  var echoes: (echoes: Int, yours: Int, sample: [Line]) {
    let echoes = transcript.likelyEchoes()
    return (echoes.count, transcript.lines.filter { $0.speaker == .you }.count, Array(echoes.prefix(3)))
  }
  func write() {
    do {
      try transcript.markdown().write(to: file, atomically: true, encoding: .utf8)
    } catch {
      log("could not write \(file.path): \(error)")
    }
  }
}

/// Whether a side has carried any sound, to tell a quiet call from a permission macOS withheld (a denied tap
/// delivers silence rather than failing).
final class Heard: @unchecked Sendable {
  private let lock = NSLock()
  private var loud = false
  func note(_ buffer: AVAudioPCMBuffer) {
    guard let data = buffer.floatChannelData else { return }
    var peak: Float = 0
    for c in 0..<Int(buffer.format.channelCount) {
      for i in 0..<Int(buffer.frameLength) { peak = max(peak, abs(data[c][i])) }
    }
    if peak > 0.001 { lock.withLock { loud = true } }
  }
  var any: Bool { lock.withLock { loud } }
}

do {
  try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
  let locale = try await transcriptionLocale(localeArg)
  if let filePath {
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: filePath))
    let store = Store(Transcript(started: Date(), apps: ["file"]), dir: outDir)
    let side = Side(.them)
    let chunk: AVAudioFrameCount = 4096
    while file.framePosition < file.length, let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunk) {
      try file.read(into: buffer, frameCount: chunk)
      side.push(buffer)
    }
    side.end()
    try await side.run(locale: locale) { line in Task { await store.add(line) } }
    try? await Task.sleep(for: .milliseconds(200))
    await store.finish(at: Date())
    log("\(await store.lineCount) lines → \(store.file.path)")
    exit(0)
  }
  let micAllowed = await AVAudioApplication.requestRecordPermission()
  if !micAllowed { log("the microphone was refused, so your side is not transcribed (System Settings › Privacy & Security › Microphone)") }

  let store = Store(Transcript(started: Date(), apps: tapAll ? ["all"] : bundleIDs), dir: outDir)
  await store.write()
  let them = Side(.them)
  let you = Side(.you)
  let themHeard = Heard()
  let youHeard = Heard()

  /// Ways of setting up echo cancelling, tried in turn: macOS refuses some depending on the Mac and its devices
  /// (-10875 when the output side will not initialise).
  enum EchoSetup: String, CaseIterable {
    case inputOnly = "input"
    case bothNodes = "input+output"
    case micInGraph = "mic in graph"
  }

  /// The microphone as "You": echo cancelled in the given setup, or as it is (nil).
  func startMic(_ setup: EchoSetup?) throws -> AVAudioEngine {
    let engine = AVAudioEngine()
    let mic = engine.inputNode
    let output = engine.outputNode
    if let setup {
      // Echo cancelling takes what the Mac plays out of what the microphone hears. It needs the engine's output side
      // running too, and it would duck other audio (the call itself) unless told to keep that to the minimum.
      try mic.setVoiceProcessingEnabled(true)
      if setup != .inputOnly && !output.isVoiceProcessingEnabled { try output.setVoiceProcessingEnabled(true) }
      mic.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
      engine.connect(engine.mainMixerNode, to: output, format: nil)
      if setup == .micInGraph { engine.connect(mic, to: engine.mainMixerNode, format: mic.outputFormat(forBus: 0)) }
      engine.mainMixerNode.outputVolume = 0
    }
    mic.installTap(onBus: 0, bufferSize: 4096, format: mic.outputFormat(forBus: 0)) { buffer, _ in
      youHeard.note(buffer)
      you.push(buffer)
    }
    do {
      engine.prepare()
      try engine.start()
    } catch {
      mic.removeTap(onBus: 0)
      engine.stop()
      throw error
    }
    return engine
  }
  // Ctrl-C (or a kill) ends the call; a second Ctrl-C gives up on finishing the last words.
  signal(SIGINT, SIG_IGN)
  signal(SIGTERM, SIG_IGN)
  let (stopped, stop) = AsyncStream<Void>.makeStream()
  var interrupts = 0
  let signalQueue = DispatchQueue(label: "loki.listen.signals")
  let sources = [SIGINT, SIGTERM].map { sig in
    // Not the main queue: the top-level awaits below never hand it a turn, so a handler there would never run.
    let source = DispatchSource.makeSignalSource(signal: sig, queue: signalQueue)
    source.setEventHandler {
      interrupts += 1
      if interrupts > 1 { exit(130) }
      stop.yield()
    }
    source.resume()
    return source
  }
  _ = sources

  // The microphone first: echo cancelling opens the speakers too, and may not start once the tap's device holds them.
  var engine: AVAudioEngine?
  if micAllowed {
    if echoCancel {
      var refused: [String] = []
      for setup in EchoSetup.allCases where engine == nil {
        do {
          engine = try startMic(setup)
          if !refused.isEmpty { log("echo cancelling started with the \(setup.rawValue) setup (refused: \(refused.joined(separator: ", ")))") }
        } catch {
          refused.append("\(setup.rawValue) \((error as NSError).code)")
        }
      }
      if engine == nil {
        log("echo cancelling would not start (\(refused.joined(separator: ", "))); using the microphone as it is")
        echoCancel = false
      }
    }
    if engine == nil { engine = try startMic(nil) }
  }
  let tap = try AppTap(bundleIDs: bundleIDs) { buffer in
    themHeard.note(buffer)
    them.push(buffer)
  }
  try tap.start()
  log("listening to \(tapAll ? "every app" : apps.joined(separator: ", ")) and \(micAllowed ? (echoCancel ? "your microphone, echo cancelled" : "your microphone, raw") : "no microphone") in \(locale.identifier) — Ctrl-C to finish")
  log("writing \(store.file.path)")

  try await withThrowingTaskGroup(of: Void.self) { group in
    group.addTask { try await them.run(locale: locale) { line in Task { await store.add(line) } } }
    if micAllowed { group.addTask { try await you.run(locale: locale) { line in Task { await store.add(line) } } } }
    group.addTask {
      for await _ in stopped { break }
      log("finishing the last words…")
      // If the transcriber never finishes, the call still ends: what was said is on disk, closed after 8 seconds.
      DispatchQueue.global().asyncAfter(deadline: .now() + 8) {
        Task {
          await store.finish(at: Date())
          log("the transcriber did not finish in time; \(await store.lineCount) lines → \(store.file.path)")
          exit(1)
        }
      }
      tap.stop()
      engine?.stop()
      engine?.inputNode.removeTap(onBus: 0)
      them.end()
      you.end()
    }
    try await group.waitForAll()
  }
  // The last lines' store.add tasks: let them land before the file is closed.
  try? await Task.sleep(for: .milliseconds(200))
  await store.finish(at: Date())
  if !themHeard.any { log("no sound came from \(tapAll ? "any app" : apps.joined(separator: ", ")). If a call was playing, allow audio recording for the app you ran this from (System Settings › Privacy & Security › Screen & System Audio Recording › System Audio Recording Only)") }
  if micAllowed && !youHeard.any { log("the microphone carried no sound") }
  let (echoes, yours, sample) = await store.echoes
  if yours > 0 {
    log("\(echoes) of your \(yours) lines look like their words heard back through the speakers (\(echoCancel ? "echo cancelled" : "raw microphone"))")
    for line in sample { log("  e.g. \(Transcript.stamp(line.at)) \(line.text)") }
  }
  log("\(await store.lineCount) lines → \(store.file.path)")
} catch {
  log("\(error)")
  exit(1)
}
