import AVFAudio
import CoreAudio
import Foundation

/// A Core Audio failure, with the call that failed and its OSStatus.
struct AudioError: Error, CustomStringConvertible {
  let call: String
  let status: OSStatus
  var description: String { "\(call) failed (\(status))" }
}

private func check(_ status: OSStatus, _ call: String) throws {
  if status != noErr { throw AudioError(call: call, status: status) }
}

private func property<T: BitwiseCopyable>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) throws -> T {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  try check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value), "AudioObjectGetPropertyData(\(selector))")
  return value
}

private func stringProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let value else { return nil }
  return value.takeRetainedValue() as String
}

/// An app process Core Audio knows about: what `listen --list` prints, to find what to tap.
struct AudioProcess {
  let pid: pid_t
  let bundleID: String?
  let playing: Bool
}

func audioProcesses() throws -> [AudioProcess] {
  var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  try check(AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size), "process list size")
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids), "process list")
  return ids.map { id in
    AudioProcess(
      pid: (try? property(id, kAudioProcessPropertyPID, pid_t(0))) ?? 0,
      bundleID: stringProperty(id, kAudioProcessPropertyBundleID),
      playing: ((try? property(id, kAudioProcessPropertyIsRunningOutput, UInt32(0))) ?? 0) != 0
    )
  }
}

/// The other side of the call: the named apps' audio output, tapped (not muted) and delivered as PCM buffers.
/// With no bundle IDs it taps every app but this one. The tap follows the apps by bundle ID, so a helper
/// process that starts after the tap (Chrome's audio service does, with the first sound) is still heard.
final class AppTap: @unchecked Sendable {
  let format: AVAudioFormat
  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var deviceID = AudioObjectID(kAudioObjectUnknown)
  private var procID: AudioDeviceIOProcID?

  init(bundleIDs: [String], onBuffer: @escaping @Sendable (AVAudioPCMBuffer) -> Void) throws {
    let description: CATapDescription
    if bundleIDs.isEmpty {
      // Every app: listen itself plays nothing, so there is nothing to exclude.
      description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    } else {
      description = CATapDescription(stereoMixdownOfProcesses: [])
      description.bundleIDs = bundleIDs
      description.isProcessRestoreEnabled = true
    }
    description.name = "loki listen"
    description.isPrivate = true
    description.muteBehavior = .unmuted
    try check(AudioHardwareCreateProcessTap(description, &tapID), "AudioHardwareCreateProcessTap")

    var asbd = try property(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription())
    guard let format = AVAudioFormat(streamDescription: &asbd) else { throw AudioError(call: "tap format", status: -1) }
    self.format = format

    let output = try property(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioObjectID(0))
    guard let outputUID = stringProperty(output, kAudioDevicePropertyDeviceUID) else { throw AudioError(call: "output device UID", status: -1) }
    let aggregate: [String: Any] = [
      kAudioAggregateDeviceNameKey: "loki listen",
      kAudioAggregateDeviceUIDKey: UUID().uuidString,
      kAudioAggregateDeviceMainSubDeviceKey: outputUID,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
    ]
    try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &deviceID), "AudioHardwareCreateAggregateDevice")

    let queue = DispatchQueue(label: "loki.listen.tap")
    try check(AudioDeviceCreateIOProcIDWithBlock(&procID, deviceID, queue) { _, input, _, _, _ in
      // The buffer list is only valid inside this block: copy it out.
      guard let view = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil), view.frameLength > 0,
            let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: view.frameLength) else { return }
      copy.frameLength = view.frameLength
      let src = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: view.audioBufferList))
      let dst = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
      for (s, d) in zip(src, dst) where s.mData != nil && d.mData != nil {
        memcpy(d.mData, s.mData, Int(min(s.mDataByteSize, d.mDataByteSize)))
      }
      onBuffer(copy)
    }, "AudioDeviceCreateIOProcIDWithBlock")
  }

  func start() throws {
    try check(AudioDeviceStart(deviceID, procID), "AudioDeviceStart")
  }

  func stop() {
    if let procID {
      AudioDeviceStop(deviceID, procID)
      AudioDeviceDestroyIOProcID(deviceID, procID)
      self.procID = nil
    }
    if deviceID != kAudioObjectUnknown {
      AudioHardwareDestroyAggregateDevice(deviceID)
      deviceID = AudioObjectID(kAudioObjectUnknown)
    }
    if tapID != kAudioObjectUnknown {
      AudioHardwareDestroyProcessTap(tapID)
      tapID = AudioObjectID(kAudioObjectUnknown)
    }
  }
}
