import AVFAudio
import Foundation
import ListenCore
import Speech

/// One side of the call, transcribed on this Mac: buffers in (any format), finished utterances out, each at its
/// offset from the start of this side's audio.
final class Side: @unchecked Sendable {
  let speaker: Speaker
  private let input: AsyncStream<AVAudioPCMBuffer>
  private let feed: AsyncStream<AVAudioPCMBuffer>.Continuation

  init(_ speaker: Speaker) {
    self.speaker = speaker
    (input, feed) = AsyncStream<AVAudioPCMBuffer>.makeStream(bufferingPolicy: .unbounded)
  }

  func push(_ buffer: AVAudioPCMBuffer) { feed.yield(buffer) }
  func end() { feed.finish() }

  /// Runs until end() and the analyzer has finished what it was given.
  func run(locale: Locale, onLine: @escaping @Sendable (Line) -> Void) async throws {
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    guard let target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw AudioError(call: "no audio format for \(locale.identifier)", status: -1)
    }
    let (analyzerInput, analyzerFeed) = AsyncStream<AnalyzerInput>.makeStream()
    let speaker = self.speaker
    let results = Task {
      for try await result in transcriber.results {
        onLine(Line(speaker: speaker, at: result.range.start.seconds, text: String(result.text.characters)))
      }
    }
    try await analyzer.start(inputSequence: analyzerInput)
    var converter: AVAudioConverter?
    for await incoming in input {
      guard let buffer = firstChannels(incoming) else { continue }
      if converter == nil || converter?.inputFormat != buffer.format {
        converter = AVAudioConverter(from: buffer.format, to: target)
      }
      guard let converter, let out = convert(buffer, with: converter, to: target) else { continue }
      analyzerFeed.yield(AnalyzerInput(buffer: out))
    }
    analyzerFeed.finish()
    try await analyzer.finalizeAndFinishThroughEndOfInput()
    try await results.value
  }
}

/// The microphone under voice processing can arrive with many channels (one per mic in the array); the converter
/// only mixes mono and stereo, so past two channels the first one is kept.
private func firstChannels(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
  guard buffer.format.channelCount > 2 else { return buffer }
  guard let data = buffer.floatChannelData,
        let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: buffer.format.sampleRate, channels: 1, interleaved: false),
        let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength) else { return nil }
  out.frameLength = buffer.frameLength
  memcpy(out.floatChannelData![0], data[0], Int(buffer.frameLength) * MemoryLayout<Float>.size)
  return out
}

private func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
  let ratio = format.sampleRate / buffer.format.sampleRate
  let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
  guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
  var given = false
  var error: NSError?
  let status = converter.convert(to: out, error: &error) { _, inputStatus in
    if given {
      inputStatus.pointee = .noDataNow
      return nil
    }
    given = true
    inputStatus.pointee = .haveData
    return buffer
  }
  return status == .error || out.frameLength == 0 ? nil : out
}

/// The locale to transcribe in: the one asked for, or this Mac's, as SpeechTranscriber supports it; its model is
/// downloaded the first time (a one-off, from Apple).
func transcriptionLocale(_ asked: String?) async throws -> Locale {
  let wanted = asked.map(Locale.init(identifier:)) ?? Locale.current
  guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else {
    let known = await SpeechTranscriber.supportedLocales.map(\.identifier).sorted().joined(separator: ", ")
    throw AudioError(call: "no transcription for \(wanted.identifier) (supported: \(known))", status: -1)
  }
  let installed = await SpeechTranscriber.installedLocales.map(\.identifier)
  if installed.contains(locale.identifier) { return locale }
  let probe = SpeechTranscriber(locale: locale, preset: .transcription)
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
    log("fetching the \(locale.identifier) speech model from Apple (first run only)…")
    try await request.downloadAndInstall()
  }
  return locale
}
