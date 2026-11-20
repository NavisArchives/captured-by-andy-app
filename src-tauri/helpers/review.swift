// review <video> <out.mp4> [--log] [--short 540] [--bitrate 1100000] [--keyframes N]
// A light copy of a clip for reviewing it: H.264 at most 540 px on the short
// side (960×540 for 16:9), about 1.1 Mbit/s, at most 50 frames a second, with
// its sound (AAC 64 kbit/s). With --log, S-Log3 / S-Gamut3.Cine footage is
// turned into normal colour, the same maths as the app's previews. The
// original is only read. With --keyframes N every Nth frame is a keyframe, so
// a player can jump anywhere at once (the editor's copies use 3). Prints
// "progress 0.42" lines, then "done" or "error <message>".
import AVFoundation
import CoreImage
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

var positional: [String] = []
var options: [String: String] = [:]
var log = false
do {
    var i = 1
    let args = CommandLine.arguments
    while i < args.count {
        let a = args[i]
        if a == "--log" {
            log = true
        } else if a.hasPrefix("--"), i + 1 < args.count {
            options[String(a.dropFirst(2))] = args[i + 1]
            i += 1
        } else {
            positional.append(a)
        }
        i += 1
    }
}
guard positional.count == 2 else {
    print("usage: review <video> <out.mp4> [--log] [--short 540] [--bitrate 1100000]")
    exit(2)
}
func fail(_ message: String) -> Never {
    print("error \(message)")
    exit(1)
}

let input = URL(fileURLWithPath: positional[0])
let output = URL(fileURLWithPath: positional[1])
let shortSide = Double(options["short"] ?? "") ?? 540
let bitrate = Int(options["bitrate"] ?? "") ?? 1_100_000
let keyframes = Int(options["keyframes"] ?? "")

// --- S-Log3 to normal colour (as in the clip helper and the app's previews)
let lutSize = 33
func sRGBEncode(_ x: Double) -> Double { x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055 }
func slog3(_ v: Double) -> Double {
    v >= 171.2102946929 / 1023.0 ? pow(10, (v * 1023 - 420) / 261.5) * 0.19 - 0.01 : (v * 1023 - 95) * 0.01125 / (171.2102946929 - 95)
}
func logTable() -> Data {
    var data = [Float](repeating: 0, count: lutSize * lutSize * lutSize * 4)
    for b in 0..<lutSize {
        for g in 0..<lutSize {
            for r in 0..<lutSize {
                let c = [r, g, b].map { slog3(Double($0) / Double(lutSize - 1)) }
                var lin = [
                    1.6269474 * c[0] - 0.5401385 * c[1] - 0.0868089 * c[2],
                    -0.1785155 * c[0] + 1.4179409 * c[1] - 0.2394254 * c[2],
                    -0.0444361 * c[0] - 0.1959199 * c[1] + 1.2403560 * c[2],
                ]
                lin = lin.map { max($0 * 0.8, 0) }
                let t = lin.map { min(max(($0 * (2.51 * $0 + 0.03)) / ($0 * (2.43 * $0 + 0.59) + 0.14), 0), 1) }
                let i = (r + g * lutSize + b * lutSize * lutSize) * 4
                data[i] = Float(sRGBEncode(t[0]))
                data[i + 1] = Float(sRGBEncode(t[1]))
                data[i + 2] = Float(sRGBEncode(t[2]))
                data[i + 3] = 1
            }
        }
    }
    return data.withUnsafeBufferPointer { Data(buffer: $0) }
}
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
let logData = log ? logTable() : nil

let asset = AVURLAsset(url: input)
let done = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0

Task {
    do {
        let duration = try await asset.load(.duration).seconds
        guard let video = try await asset.loadTracks(withMediaType: .video).first else { fail("no picture in this file") }
        let audio = try await asset.loadTracks(withMediaType: .audio)
        let natural = try await video.load(.naturalSize)
        let transform = try await video.load(.preferredTransform)
        let fps = Double(try await video.load(.nominalFrameRate))
        let shown = natural.applying(transform)
        let (dw, dh) = (abs(shown.width), abs(shown.height))
        guard dw > 0, dh > 0 else { fail("couldn't read the video's size") }
        let scale = min(1, shortSide / Double(min(dw, dh)))
        let even = { (v: Double) -> Int in max(2, Int((v / 2).rounded()) * 2) }
        let render = CGSize(width: even(Double(dw) * scale), height: even(Double(dh) * scale))

        let composition = try await AVMutableVideoComposition.videoComposition(with: asset, applyingCIFiltersWithHandler: { request in
            var image = request.sourceImage
            if let d = logData {
                image = image.applyingFilter("CIColorCubeWithColorSpace", parameters: ["inputCubeDimension": lutSize, "inputCubeData": d, "inputColorSpace": srgb])
            }
            let e = image.extent
            let s = render.width / e.width
            image = image
                .transformed(by: CGAffineTransform(translationX: -e.minX, y: -e.minY))
                .transformed(by: CGAffineTransform(scaleX: s, y: s))
                .cropped(to: CGRect(origin: .zero, size: render))
            request.finish(with: image, context: nil)
        })
        composition.renderSize = render
        // At most 50 frames a second: slow-motion clips stay light.
        let rate = fps > 0 ? min(fps, 50) : 30
        composition.frameDuration = CMTime(value: 1000, timescale: CMTimeScale((rate * 1000).rounded()))

        let reader = try AVAssetReader(asset: asset)
        let videoOut = AVAssetReaderVideoCompositionOutput(videoTracks: [video], videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        videoOut.videoComposition = composition
        videoOut.alwaysCopiesSampleData = false
        guard reader.canAdd(videoOut) else { fail("this video can't be read") }
        reader.add(videoOut)
        var audioOut: AVAssetReaderAudioMixOutput?
        if !audio.isEmpty {
            let a = AVAssetReaderAudioMixOutput(audioTracks: audio, audioSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2,
                AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
            ])
            if reader.canAdd(a) {
                reader.add(a)
                audioOut = a
            }
        }

        let tmp = output.deletingLastPathComponent().appendingPathComponent(".\(output.lastPathComponent).part.mp4")
        try? FileManager.default.removeItem(at: tmp)
        try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
        let writer = try AVAssetWriter(outputURL: tmp, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        var compression: [String: Any] = [
            AVVideoAverageBitRateKey: bitrate,
            AVVideoMaxKeyFrameIntervalDurationKey: 1.0,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        ]
        if let k = keyframes {
            compression[AVVideoMaxKeyFrameIntervalKey] = max(1, k)
            compression[AVVideoAllowFrameReorderingKey] = false
        }
        let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(render.width),
            AVVideoHeightKey: Int(render.height),
            AVVideoCompressionPropertiesKey: compression,
        ])
        videoIn.expectsMediaDataInRealTime = false
        writer.add(videoIn)
        var audioIn: AVAssetWriterInput?
        if audioOut != nil {
            let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 64000,
            ])
            a.expectsMediaDataInRealTime = false
            writer.add(a)
            audioIn = a
        }

        guard reader.startReading() else { fail(reader.error?.localizedDescription ?? "couldn't start reading") }
        guard writer.startWriting() else { fail(writer.error?.localizedDescription ?? "couldn't start writing") }
        writer.startSession(atSourceTime: .zero)

        let group = DispatchGroup()
        var lastShown = -1
        func pump(_ input: AVAssetWriterInput, _ out: AVAssetReaderOutput, _ label: String, progress: Bool) {
            group.enter()
            var finished = false
            let queue = DispatchQueue(label: label)
            input.requestMediaDataWhenReady(on: queue) {
                while input.isReadyForMoreMediaData && !finished {
                    guard let sample = out.copyNextSampleBuffer() else {
                        finished = true
                        input.markAsFinished()
                        group.leave()
                        return
                    }
                    if progress, duration > 0 {
                        let pct = Int(CMSampleBufferGetPresentationTimeStamp(sample).seconds / duration * 100)
                        if pct >= lastShown + 2 {
                            lastShown = pct
                            print(String(format: "progress %.2f", min(1, Double(pct) / 100)))
                        }
                    }
                    if !input.append(sample) {
                        finished = true
                        reader.cancelReading()
                        input.markAsFinished()
                        group.leave()
                        return
                    }
                }
            }
        }
        pump(videoIn, videoOut, "review.video", progress: true)
        if let a = audioIn, let o = audioOut { pump(a, o, "review.audio", progress: false) }
        group.wait()

        if reader.status == .failed || writer.status == .failed {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: tmp)
            fail(reader.error?.localizedDescription ?? writer.error?.localizedDescription ?? "the copy stopped")
        }
        await writer.finishWriting()
        guard writer.status == .completed else {
            try? FileManager.default.removeItem(at: tmp)
            fail(writer.error?.localizedDescription ?? "the copy couldn't be finished")
        }
        try? FileManager.default.removeItem(at: output)
        try FileManager.default.moveItem(at: tmp, to: output)
        print("done")
    } catch {
        print("error \(error.localizedDescription)")
        exitCode = 1
    }
    done.signal()
}

while done.wait(timeout: .now() + 0.05) == .timedOut {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
}
exit(exitCode)
