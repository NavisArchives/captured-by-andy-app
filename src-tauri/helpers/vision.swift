// vision [--labels] [--text] [--quality] <image>...
// Apple's on-device image analysis, one JSON line per image:
//   {"file": "...", "horizon": degrees or null, "subject": [x, y, w, h] or null, "labels": [["beach", 0.83], ...]}
// horizon: how far the horizon is tilted (positive: rising to the right), so
// straightening clockwise by it levels the photo. subject: where the eye goes
// (0..1, from the top left). labels (with --labels): what's in the photo.
// text (with --text): the words in the picture, line by line (screenshots).
// aesthetics, utility (with --quality): Apple's overall score (-1..1) and whether
// it's a "utility" image (a document, a receipt, a screen), not a memory.
// Images are only read.
import Foundation
import Vision

setvbuf(stdout, nil, _IOLBF, 0)

var args = Array(CommandLine.arguments.dropFirst())
var wantLabels = false
var wantText = false
var wantQuality = false
while let flag = args.first, flag.hasPrefix("--") {
    if flag == "--labels" { wantLabels = true }
    if flag == "--text" { wantText = true }
    if flag == "--quality" { wantQuality = true }
    args.removeFirst()
}
if args.isEmpty {
    print("usage: vision [--labels] [--text] [--quality] <image>...")
    exit(2)
}

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

for path in args {
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: path), options: [:])
    let horizon = VNDetectHorizonRequest()
    let saliency = VNGenerateAttentionBasedSaliencyImageRequest()
    let classify = VNClassifyImageRequest()
    let reader = VNRecognizeTextRequest()
    reader.recognitionLevel = .accurate
    reader.usesLanguageCorrection = true
    reader.recognitionLanguages = ["en-US", "nl-NL", "fr-FR"]
    var requests: [VNRequest] = [horizon, saliency]
    if wantLabels { requests.append(classify) }
    if wantText { requests.append(reader) }
    let quality = VNCalculateImageAestheticsScoresRequest()
    if wantQuality { requests.append(quality) }
    do {
        try handler.perform(requests)
    } catch {
        emit(["file": path, "error": error.localizedDescription])
        continue
    }
    var out: [String: Any] = ["file": path, "horizon": NSNull(), "subject": NSNull()]
    if let h = horizon.results?.first {
        // Vision measures the other way round: a horizon rising to the right comes back negative.
        out["horizon"] = -Double(h.angle) * 180 / .pi
    }
    if let objects = saliency.results?.first?.salientObjects, !objects.isEmpty {
        // Vision's boxes start bottom-left; the union of all salient objects, turned top-left.
        let box = objects.map(\.boundingBox).reduce(objects[0].boundingBox) { $0.union($1) }
        out["subject"] = [Double(box.minX), Double(1 - box.maxY), Double(box.width), Double(box.height)]
    }
    if wantLabels {
        let labels = (classify.results ?? [])
            .filter { $0.confidence >= 0.15 }
            .prefix(20)
            .map { [$0.identifier, Double(($0.confidence * 100).rounded() / 100)] as [Any] }
        out["labels"] = labels
    }
    if wantQuality, let q = quality.results?.first {
        out["aesthetics"] = Double(q.overallScore)
        out["utility"] = q.isUtility
    }
    if wantText {
        // Lines top to bottom, as they read on a screenshot.
        let lines = (reader.results ?? [])
            .sorted { $0.boundingBox.minY > $1.boundingBox.minY }
            .compactMap { $0.topCandidates(1).first?.string }
        out["text"] = lines.joined(separator: "\n")
    }
    emit(out)
}
