import Foundation

public enum Speaker: String, Sendable {
  case you = "You"
  case them = "Them"
}

public struct Line: Sendable, Equatable {
  public let speaker: Speaker
  public let at: Double
  public let text: String
  public init(speaker: Speaker, at: Double, text: String) {
    self.speaker = speaker
    self.at = at
    self.text = text
  }
}

public struct Transcript: Sendable {
  public let started: Date
  public var ended: Date?
  public let apps: [String]
  public private(set) var lines: [Line] = []

  public init(started: Date, apps: [String]) {
    self.started = started
    self.apps = apps
  }

  public mutating func add(_ line: Line) {
    let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    let at = lines.firstIndex { $0.at > line.at } ?? lines.endIndex
    lines.insert(Line(speaker: line.speaker, at: line.at, text: text), at: at)
  }

  public func likelyEchoes(window: Double = 2.5, overlap: Double = 0.6) -> [Line] {
    let theirs = lines.filter { $0.speaker == .them }
    return lines.filter { line in
      guard line.speaker == .you else { return false }
      let mine = Transcript.words(line.text)
      guard !mine.isEmpty else { return false }
      let near = Set(theirs.filter { abs($0.at - line.at) <= window }.flatMap { Transcript.words($0.text) })
      let shared = Double(mine.filter(near.contains).count) / Double(mine.count)
      return mine.count <= 2 ? shared == 1 : shared >= overlap
    }
  }

  static func words(_ text: String) -> [String] {
    text.lowercased().split { !$0.isLetter && !$0.isNumber && $0 != "'" }.map(String.init)
  }

  public static func stamp(_ seconds: Double) -> String {
    let s = max(0, Int(seconds.rounded(.down)))
    let (h, m, sec) = (s / 3600, (s % 3600) / 60, s % 60)
    return h > 0 ? String(format: "[%d:%02d:%02d]", h, m, sec) : String(format: "[%02d:%02d]", m, sec)
  }

  public func fileName(timeZone: TimeZone = .current) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = timeZone
    f.dateFormat = "yyyy-MM-dd-HHmm"
    return "\(f.string(from: started)).md"
  }

  public func markdown(timeZone: TimeZone = .current) -> String {
    let iso = ISO8601DateFormatter()
    iso.timeZone = timeZone
    let title = DateFormatter()
    title.locale = Locale(identifier: "en_US_POSIX")
    title.timeZone = timeZone
    title.dateFormat = "d MMM yyyy, HH:mm"
    var out = ["---", "started: \(iso.string(from: started))"]
    if let ended {
      out.append("ended: \(iso.string(from: ended))")
      out.append("minutes: \(Int((ended.timeIntervalSince(started) / 60).rounded()))")
    }
    out.append("source: loki listen")
    out.append("apps: [\(apps.joined(separator: ", "))]")
    out.append("---")
    out.append("")
    out.append("# Call · \(title.string(from: started))")
    out.append("")
    if lines.isEmpty {
      out.append(ended == nil ? "_Listening…_" : "_Nothing was said._")
      out.append("")
    }
    for line in lines {
      out.append("\(Transcript.stamp(line.at)) **\(line.speaker.rawValue):** \(line.text)")
      out.append("")
    }
    return out.joined(separator: "\n")
  }
}
