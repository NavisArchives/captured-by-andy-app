// videoframe <video> <out.jpg> <max px>
// Writes one frame of a video (at about 1 s) as a JPEG and prints
// "<seconds> <video width> <video height> <creation date or ->". Only the parts of the
// file AVFoundation needs are read, so a video that lives online (iCloud,
// Google Drive) is not downloaded whole.
import AVFoundation
import AppKit

let args = CommandLine.arguments
guard args.count >= 3 else { print("usage: videoframe <video> <out.jpg> [max px, 0 = full size] [at seconds] [jpeg quality]"); exit(2) }
let url = URL(fileURLWithPath: args[1])
let maxPx = args.count > 3 ? Double(args[3]) ?? 2048 : 2048
// A given moment is grabbed exactly (a still to keep); otherwise about 1 s in.
let atSeconds = args.count > 4 ? Double(args[4]) : nil
let quality = args.count > 5 ? Double(args[5]) ?? 0.85 : 0.85
let asset = AVURLAsset(url: url)
let sema = DispatchSemaphore(value: 0)
var code: Int32 = 0
Task {
    do {
        let duration = try await asset.load(.duration).seconds
        let created = try? await asset.load(.creationDate)?.load(.dateValue)
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        if maxPx > 0 {
            gen.maximumSize = CGSize(width: maxPx, height: maxPx)
        }
        if atSeconds != nil {
            gen.requestedTimeToleranceBefore = .zero
            gen.requestedTimeToleranceAfter = .zero
        }
        let at = CMTime(seconds: min(max(0, atSeconds ?? min(1, duration / 2)), max(0, duration - 0.01)), preferredTimescale: 600)
        let (image, _) = try await gen.image(at: at)
        let rep = NSBitmapImageRep(cgImage: image)
        guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: quality]) else { throw NSError(domain: "videoframe", code: 1) }
        try data.write(to: URL(fileURLWithPath: args[2]), options: .atomic)
        let iso = created.map { ISO8601DateFormatter().string(from: $0) } ?? "-"
        // The video's own size (upright), not the frame's.
        var size = CGSize(width: rep.pixelsWide, height: rep.pixelsHigh)
        if let track = try? await asset.loadTracks(withMediaType: .video).first,
           let natural = try? await track.load(.naturalSize),
           let transform = try? await track.load(.preferredTransform) {
            let upright = natural.applying(transform)
            size = CGSize(width: abs(upright.width), height: abs(upright.height))
        }
        print(String(format: "%.2f %d %d %@", duration, Int(size.width), Int(size.height), iso))
    } catch {
        print("error \(error.localizedDescription)")
        code = 1
    }
    sema.signal()
}
sema.wait()
exit(code)
