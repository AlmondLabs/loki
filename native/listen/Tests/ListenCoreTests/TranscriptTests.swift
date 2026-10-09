import Foundation
import ListenCore
import Testing

@Suite struct TranscriptTests {
  let utc = TimeZone(identifier: "UTC")!
  let start = Date(timeIntervalSince1970: 1_790_000_000) // 2026-09-21 14:13:20 UTC

  @Test func linesFallInTimeOrderWhicheverSideFinishesFirst() {
    var t = Transcript(started: start, apps: ["com.google.Chrome"])
    t.add(Line(speaker: .them, at: 12.4, text: "Can you hear me?"))
    t.add(Line(speaker: .you, at: 3.0, text: " Hi there. "))
    t.add(Line(speaker: .you, at: 14.0, text: "Yes."))
    t.add(Line(speaker: .them, at: 20.0, text: "   "))
    #expect(t.lines.map(\.text) == ["Hi there.", "Can you hear me?", "Yes."])
  }

  @Test func stampsReadMinutesThenHours() {
    #expect(Transcript.stamp(0) == "[00:00]")
    #expect(Transcript.stamp(75.9) == "[01:15]")
    #expect(Transcript.stamp(3725) == "[1:02:05]")
    #expect(Transcript.stamp(-2) == "[00:00]")
  }

  @Test func theFileIsFrontMatterATitleAndOneLinePerUtterance() {
    var t = Transcript(started: start, apps: ["com.google.Chrome", "com.tinyspeck.slackmacgap"])
    #expect(t.fileName(timeZone: utc) == "2026-09-21-1413.md")
    #expect(t.markdown(timeZone: utc).contains("_Listening…_"))
    t.add(Line(speaker: .you, at: 1, text: "Morning."))
    t.add(Line(speaker: .them, at: 4, text: "Morning, shall we start?"))
    t.ended = start.addingTimeInterval(31 * 60)
    #expect(t.markdown(timeZone: utc) == """
      ---
      started: 2026-09-21T14:13:20Z
      ended: 2026-09-21T14:44:20Z
      minutes: 31
      source: loki listen
      apps: [com.google.Chrome, com.tinyspeck.slackmacgap]
      ---

      # Call · 21 Sep 2026, 14:13

      [00:01] **You:** Morning.

      [00:04] **Them:** Morning, shall we start?

      """)
  }

  @Test func anEndedCallWithNothingSaidSaysSo() {
    var t = Transcript(started: start, apps: [])
    t.ended = start
    #expect(t.markdown(timeZone: utc).contains("_Nothing was said._"))
  }

  @Test func yourLinesThatRepeatTheirsNearbyCountAsEchoes() {
    var t = Transcript(started: start, apps: [])
    t.add(Line(speaker: .them, at: 10, text: "They want a twenty percent discount by Friday."))
    t.add(Line(speaker: .you, at: 10.6, text: "they want twenty percent discount friday")) // heard back through the speakers
    t.add(Line(speaker: .you, at: 30, text: "They want a twenty percent discount by Friday.")) // said again much later: yours
    t.add(Line(speaker: .you, at: 11, text: "Okay, let me check with finance.")) // yours
    t.add(Line(speaker: .them, at: 40, text: "Yes."))
    t.add(Line(speaker: .you, at: 40.2, text: "Yes."))
    t.add(Line(speaker: .you, at: 41, text: "Yes, sure."))
    #expect(t.likelyEchoes().map(\.at) == [10.6, 40.2])
  }
}
