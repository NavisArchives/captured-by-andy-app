// listen: voice commands for culling. Hears the microphone with Apple's
// on-device speech recognition (offline; nothing is recorded or sent) and
// prints what it hears, one line at a time:
//   ready                  listening
//   task <n>               a fresh utterance starts (after "reset")
//   partial <n> <text>     what utterance n sounds like so far
//   final <n> <text>       utterance n ended
//   denied mic|speech      permission refused
//   error <message>
// It reads commands on stdin: "reset" (start a fresh utterance), "pause",
// "resume". When stdin closes (the app quit or stopped it) it exits.
import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

/// The words the app acts on; recognition leans towards them.
let hints = ["yes", "no", "maybe", "keep", "nope", "back", "undo", "skip", "next", "zoom", "play"]
/// `listen --dictate`: whole sentences with punctuation (voice ideas), not command words.
let dictation = CommandLine.arguments.contains("--dictate")
let language: String = {
    guard let i = CommandLine.arguments.firstIndex(of: "--language"), i + 1 < CommandLine.arguments.count else { return "en-US" }
    return CommandLine.arguments[i + 1]
}()

func say(_ line: String) {
    print(line.replacingOccurrences(of: "\n", with: " "))
}

final class Listener {
    let recognizer: SFSpeechRecognizer
    let engine = AVAudioEngine()
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var seq = 0
    var paused = false

    init?(recognizer: SFSpeechRecognizer?) {
        guard let recognizer, recognizer.isAvailable else { return nil }
        self.recognizer = recognizer
    }

    func start() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        engine.prepare()
        try engine.start()
        newTask()
        say("ready")
    }

    /// Ends the current utterance and starts listening for the next one.
    func newTask() {
        task?.cancel()
        request?.endAudio()
        seq += 1
        let n = seq
        let r = SFSpeechAudioBufferRecognitionRequest()
        r.requiresOnDeviceRecognition = true
        r.shouldReportPartialResults = true
        r.contextualStrings = dictation ? [] : hints
        r.taskHint = dictation ? .dictation : .confirmation
        if #available(macOS 13, *) { r.addsPunctuation = dictation }
        request = r
        say("task \(n)")
        task = recognizer.recognitionTask(with: r) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, n == self.seq else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    say("\(result.isFinal ? "final" : "partial") \(n) \(text)")
                    if result.isFinal { self.newTask() }
                } else if error != nil, !self.paused {
                    // Silence timeouts end a task: just listen again.
                    self.newTask()
                }
            }
        }
    }

    func pause() {
        guard !paused else { return }
        paused = true
        task?.cancel()
        request?.endAudio()
        engine.pause()
    }

    func resume() {
        guard paused else { return }
        paused = false
        do {
            try engine.start()
            newTask()
        } catch {
            say("error \(error.localizedDescription)")
        }
    }
}

func authorised() async -> Bool {
    let speech = await withCheckedContinuation { c in
        SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
    }
    guard speech == .authorized else { say("denied speech"); return false }
    let mic = await AVCaptureDevice.requestAccess(for: .audio)
    guard mic else { say("denied mic"); return false }
    return true
}

var listener: Listener?

// `listen --status`: what's allowed and available, without asking anything.
if CommandLine.arguments.dropFirst().first == "--status" {
    func name(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch s {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        default: return "undecided"
        }
    }
    func name(_ s: AVAuthorizationStatus) -> String {
        switch s {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        default: return "undecided"
        }
    }
    let r = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    let mics = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone], mediaType: .audio, position: .unspecified).devices
    say("status speech=\(name(SFSpeechRecognizer.authorizationStatus())) mic=\(name(AVCaptureDevice.authorizationStatus(for: .audio))) recognizer=\(r == nil ? "none" : "yes") available=\(r?.isAvailable == true ? "yes" : "no") ondevice=\(r?.supportsOnDeviceRecognition == true ? "yes" : "no") microphones=\(mics.count)")
    exit(0)
}

// `listen --file <recording>`: the spoken words of a screen recording or audio
// file, on this Mac, printed once as "final 0 <text>". Video sound is taken
// out first; nothing is kept.
if CommandLine.arguments.dropFirst().first == "--file", CommandLine.arguments.count >= 3 {
    let source = URL(fileURLWithPath: CommandLine.arguments[2])
    Task { @MainActor in
        let speech = await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
        }
        guard speech == .authorized else { say("denied speech"); exit(3) }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            say("error On-device speech recognition for this language is not available on this Mac")
            exit(4)
        }
        var url = source
        var temp: URL?
        if ["mov", "mp4", "m4v"].contains(source.pathExtension.lowercased()) {
            let asset = AVURLAsset(url: source)
            let out = FileManager.default.temporaryDirectory.appendingPathComponent("cba-listen-\(UUID().uuidString).m4a")
            guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
                say("error no sound in this file")
                exit(5)
            }
            export.outputURL = out
            export.outputFileType = .m4a
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                export.exportAsynchronously { c.resume() }
            }
            guard export.status == .completed else {
                say("error no sound in this file")
                exit(5)
            }
            url = out
            temp = out
        }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.taskHint = .dictation
        if #available(macOS 13, *) { request.addsPunctuation = true }
        recognizer.recognitionTask(with: request) { result, error in
            if let result, result.isFinal {
                let segments = result.bestTranscription.segments.map { segment -> [String: Any] in
                    ["start": segment.timestamp, "end": segment.timestamp + segment.duration, "text": segment.substring]
                }
                if let json = try? JSONSerialization.data(withJSONObject: segments), let text = String(data: json, encoding: .utf8) {
                    say("segments 0 \(text)")
                }
                say("final 0 \(result.bestTranscription.formattedString)")
                if let temp { try? FileManager.default.removeItem(at: temp) }
                exit(0)
            }
            if let error {
                if let temp { try? FileManager.default.removeItem(at: temp) }
                // No speech at all is an empty transcript, not a failure.
                say((error as NSError).code == 1110 ? "final 0 " : "error \(error.localizedDescription)")
                exit((error as NSError).code == 1110 ? 0 : 6)
            }
        }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 600) {
        say("error took too long")
        exit(7)
    }
    RunLoop.main.run()
}

Task { @MainActor in
    guard await authorised() else { exit(3) }
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    guard let recognizer, recognizer.supportsOnDeviceRecognition else {
        say("error English speech recognition isn't available on this Mac (System Settings › Keyboard › Dictation)")
        exit(4)
    }
    guard let l = Listener(recognizer: recognizer) else {
        say("error speech recognition is busy or unavailable")
        exit(4)
    }
    do {
        try l.start()
    } catch {
        say("error \(error.localizedDescription)")
        exit(5)
    }
    listener = l
}

// Commands from the app. Closing stdin ends the helper.
Thread {
    while let line = readLine() {
        let command = line.trimmingCharacters(in: .whitespaces)
        DispatchQueue.main.async {
            switch command {
            case "reset": if listener?.paused == false { listener?.newTask() }
            case "pause": listener?.pause()
            case "resume": listener?.resume()
            default: break
            }
        }
    }
    exit(0)
}.start()

RunLoop.main.run()
