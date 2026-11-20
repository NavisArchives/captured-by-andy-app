// clip <video> <out> [options]
// Makes a finished clip for Instagram: part of a video, converted from S-Log3
// when filmed in it, with a look (a 33³ RGBA8 table) at a strength, every
// slider of the photo editor (same maths, see `gradeSource`), straightened and
// cropped, at an output size. The video is only read.
//   --size 1080x1920        output size; auto:1920 keeps the video's shape, 1920 on its long side
//   --bitrate 9000000       H.264 at this average bitrate (bits/s), so the file size is predictable
//   --start S --end E       the part to keep, in seconds (default: all)
//   --log                   the clip is S-Log3 / S-Gamut3.Cine: convert it first
//   --lut FILE --strength F the look and how much of it (0..1)
//   --exposure EV --contrast C --highlights H --shadows S --whites W --blacks B
//   --temperature T --tint T --vibrance V --saturation S --grain G --vignette V   (-100..100; grain 0..100)
//   --fade --soften --halation --fringe --scanlines --weave --leak   the effects (0..100)
//   --straighten DEG --cropx X --cropy Y --zoom Z   the crop, as in the photo editor
//   --still S               one JPEG of the frame at S seconds instead of a video
// Prints "progress 0.42" lines, then "done" or "error <message>".
import AVFoundation
import CoreImage
import Foundation
import Metal

setvbuf(stdout, nil, _IOLBF, 0)

var positional: [String] = []
var options: [String: String] = [:]
var flags: Set<String> = []
do {
    var i = 1
    let args = CommandLine.arguments
    while i < args.count {
        let a = args[i]
        if a == "--log" {
            flags.insert("log")
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
    print("usage: clip <video> <out> [--size WxH] [--start S --end E] [--log] [--lut FILE --strength F] ...")
    exit(2)
}
func num(_ key: String, _ fallback: Double = 0) -> Double { options[key].flatMap(Double.init) ?? fallback }
func fail(_ message: String) -> Never {
    print("error \(message)")
    exit(1)
}

let input = URL(fileURLWithPath: positional[0])
let output = URL(fileURLWithPath: positional[1])
// "auto:1920": the video's own shape, 1920 on its long side (never larger than the video).
nonisolated(unsafe) var size: CGSize = {
    let parts = (options["size"] ?? "1080x1920").split(separator: "x").compactMap { Double($0) }
    return parts.count == 2 ? CGSize(width: parts[0], height: parts[1]) : CGSize(width: 1080, height: 1920)
}()

// --- colour: the editor's shader (src/gl/renderer.ts), ported line for line to
// Metal, so a clip looks exactly like its preview. Compiled when the helper
// starts; it runs inside Core Image on each output frame.

let lutSize = 33
let gradeSource = """
#include <metal_stdlib>
using namespace metal;

// p: 0-11 exposure contrast highlights shadows whites blacks temp tint vibrance saturation grain vignette
//    12 strength, 13 hasLut, 14 log, 15 seed (frame), 16-17 width height,
//    18-24 fade soften halation fringe scanlines weave leak, 25-26 this tile's origin
#define P(i) p[i]

static float s2l(float x) { return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4); }
static float l2s(float x) { x = max(x, 0.0); return x <= 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
static float3 s2l(float3 c) { return float3(s2l(c.r), s2l(c.g), s2l(c.b)); }
static float3 l2s(float3 c) { return float3(l2s(c.r), l2s(c.g), l2s(c.b)); }
static float luma(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }

static float3 develop(float3 c, constant float *p) {
  float3 lin = s2l(c);
  float t = P(6) / 100.0, m = P(7) / 100.0;
  lin *= float3(1.0 + 0.18 * t + 0.04 * m, 1.0 - 0.12 * m, 1.0 - 0.18 * t + 0.04 * m);
  lin *= exp2(P(0));
  float3 v = l2s(lin);
  float l0 = luma(v);
  float l = l0;
  float lc = clamp(l, 0.0, 1.0);
  l += (P(1) / 100.0) * (lc * lc * (3.0 - 2.0 * lc) - lc);
  float h = P(2) / 100.0;
  float wh = smoothstep(0.45, 1.0, l);
  l += h < 0.0 ? h * 0.35 * wh * l : h * 0.2 * wh * max(1.2 - l, 0.0);
  l += (P(3) / 100.0) * 0.25 * (1.0 - smoothstep(0.0, 0.55, l)) * smoothstep(0.0, 0.15, l);
  l += (P(4) / 100.0) * 0.15 * smoothstep(0.6, 1.0, l);
  l += (P(5) / 100.0) * 0.12 * (1.0 - smoothstep(0.0, 0.35, l));
  v = l0 > 1e-4 ? v * (l / l0) : v + (l - l0);
  v = clamp(v, 0.0, 1.0);
  float chroma = max(v.r, max(v.g, v.b)) - min(v.r, min(v.g, v.b));
  float y = luma(v);
  float f = (1.0 + P(8) / 100.0 * (1.0 - chroma)) * (1.0 + P(9) / 100.0);
  return clamp(y + (v - y) * f, 0.0, 1.0);
}

static float3 look(float3 v, texture3d<float> lut, constant float *p) {
  if (P(13) < 0.5 || P(12) <= 0.0) return v;
  constexpr sampler s(filter::linear, address::clamp_to_edge, coord::normalized);
  float n = \(lutSize).0;
  float3 l = lut.sample(s, v * ((n - 1.0) / n) + 0.5 / n).rgb;
  return mix(v, l, P(12));
}

static uint scramble(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  return x ^ (x >> 16u);
}
static uint cellHash(int2 c, uint layer) {
  return scramble(uint(c.x) ^ scramble(uint(c.y) ^ scramble(layer)));
}
static float bell(int2 c, uint layer) {
  uint4 b = (uint4(cellHash(c, layer)) >> uint4(0u, 8u, 16u, 24u)) & 255u;
  return (dot(float4(b), float4(1.0)) / 255.0 - 2.0) * 1.732;
}
static float2 easeCell(float2 q, thread int2 &c) {
  float2 i = floor(q);
  c = int2(i);
  float2 f = q - i;
  return f * f * (3.0 - 2.0 * f);
}
static float clump(float2 q, uint layer) {
  int2 c;
  float2 f = easeCell(q, c);
  return mix(mix(bell(c, layer), bell(c + int2(1, 0), layer), f.x),
             mix(bell(c + int2(0, 1), layer), bell(c + int2(1, 1), layer), f.x), f.y);
}
static float3 rgbAt(int2 c, uint layer) {
  uint3 b = (uint3(cellHash(c, layer)) >> uint3(0u, 8u, 16u)) & 255u;
  return (float3(b) / 255.0 - 0.5) * 3.464;
}
static float3 clumpRgb(float2 q, uint layer) {
  int2 c;
  float2 f = easeCell(q, c);
  return mix(mix(rgbAt(c, layer), rgbAt(c + int2(1, 0), layer), f.x),
             mix(rgbAt(c + int2(0, 1), layer), rgbAt(c + int2(1, 1), layer), f.x), f.y);
}
static float2 turn(float2 q, float a) { return float2x2(float2(cos(a), sin(a)), float2(-sin(a), cos(a))) * q; }
static float3 filmGrain(float2 q, uint s) {
  float2 o = float2(8192.0);
  float l = clump(turn(q, 0.43) + o, s)
          + 0.55 * clump(turn(q, 1.37) / 2.1 + o, s + 1u)
          + 0.25 * clump(turn(q, 2.29) / 4.3 + o, s + 2u);
  return float3(l / 0.87) + 0.22 * clumpRgb(turn(q, 0.91) + o, s + 3u) / 0.74;
}

static float slog3(float v) {
  return v >= 171.2102946929 / 1023.0
    ? pow(10.0, (v * 1023.0 - 420.0) / 261.5) * 0.19 - 0.01
    : (v * 1023.0 - 95.0) * 0.01125 / (171.2102946929 - 95.0);
}
static float3 fromSlog3(float3 c) {
  float3 lin = float3(slog3(c.r), slog3(c.g), slog3(c.b));
  lin = float3x3(float3(1.6269474, -0.1785155, -0.0444361), float3(-0.5401385, 1.4179409, -0.1959199), float3(-0.0868089, -0.2394254, 1.2403560)) * lin;
  lin = max(lin * 0.8, 0.0);
  float3 t = clamp((lin * (2.51 * lin + 0.03)) / (lin * (2.43 * lin + 0.59) + 0.14), 0.0, 1.0);
  return mix(t * 12.92, 1.055 * pow(t, float3(1.0 / 2.4)) - 0.055, step(0.0031308, t));
}

// The framed picture at an output position (0..1, y down), converted from S-Log3 when filmed in it.
static float3 picture(texture2d<float> src, float2 q, constant float *p) {
  constexpr sampler s(filter::linear, address::clamp_to_edge, coord::normalized);
  float3 c = src.sample(s, q).rgb;
  return P(14) > 0.5 ? fromSlog3(c) : c;
}
// Twelve taps on two rings, radius r (of the height).
static float3 blurred(texture2d<float> src, float2 q, float r, float2 size, constant float *p) {
  float2 k = float2(r * size.y / size.x, r);
  float3 sum = float3(0.0);
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5236 + (i < 6 ? 0.0 : 0.2618);
    sum += picture(src, q + float2(cos(a), sin(a)) * k * (i < 6 ? 0.5 : 1.0), p);
  }
  return sum / 12.0;
}
static float rnd(uint n) { return float(scramble(n) & 65535u) / 65535.0; }

kernel void grade(texture2d<float, access::sample> src [[texture(0)]],
                  texture2d<float, access::write> dst [[texture(1)]],
                  texture3d<float> lut [[texture(2)]],
                  constant float *p [[buffer(0)]],
                  uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;
  float2 size = float2(P(16), P(17));
  float2 q = (float2(gid) + float2(P(25), P(26)) + 0.5) / size;
  float2 uv = q;
  uint frame = uint(P(15));
  q += (float2(rnd(frame * 7u + 1u), rnd(frame * 7u + 2u)) - 0.5) * (P(23) / 100.0) * float2(0.004, 0.006);
  float rows = 240.0;
  q.x += (rnd(uint(q.y * rows) + frame * 977u) - 0.5) * (P(22) / 100.0) * 0.0025;
  float3 c = picture(src, q, p);
  if (P(21) > 0.0) {
    float2 d = q - 0.5;
    float k = (P(21) / 100.0) * 0.008;
    c = float3(picture(src, 0.5 + d * (1.0 + k), p).r, c.g, picture(src, 0.5 + d * (1.0 - k), p).b);
  }
  if (P(19) > 0.0) c = mix(c, blurred(src, q, 0.006, size, p), 0.75 * P(19) / 100.0);
  c = look(develop(c, p), lut, p);
  if (P(20) > 0.0) {
    float3 h = blurred(src, q, 0.018, size, p);
    float glow = smoothstep(0.55, 1.0, luma(h));
    c += float3(1.0, 0.32, 0.12) * glow * (P(20) / 100.0) * 0.55;
  }
  float fd = P(18) / 100.0;
  c = c * (1.0 - 0.14 * fd) + 0.1 * fd;
  c *= 1.0 - (P(22) / 100.0) * 0.16 * (0.5 + 0.5 * cos(6.2832 * q.y * rows));
  if (P(24) > 0.0) {
    float t = float(frame) * 0.02;
    float2 at = float2(-0.05 + 0.1 * sin(t), 0.35 + 0.25 * sin(t * 0.63 + 1.0));
    float2 d = (q - at) * float2(size.x / size.y, 1.0);
    float w = exp(-dot(d, d) / 0.12) * (P(24) / 100.0) * 0.85;
    c = 1.0 - (1.0 - c) * (1.0 - w * float3(1.0, 0.5, 0.18));
  }
  float aspect = size.x / size.y;
  float2 dv = (uv - 0.5) * float2(aspect, 1.0);
  float r = length(dv) / length(float2(aspect, 1.0) * 0.5);
  c *= 1.0 + (P(11) / 100.0) * 0.85 * smoothstep(0.35, 1.05, r);
  if (P(10) > 0.0) {
    float cell = max(1.0, size.x / 1400.0) * 1.35;
    float3 g = filmGrain(uv * size / cell, uint(P(15)));
    float y = luma(c);
    c += g * (P(10) / 100.0) * 0.046 * (0.35 + 0.65 * (1.0 - abs(2.0 * y - 1.0)));
  }
  dst.write(float4(clamp(c, 0.0, 1.0), 1.0), gid);
}
"""

/// The app's look table: RGBA8, red changing fastest, 33³.
func lookTable(_ path: String) -> Data? {
    guard let bytes = FileManager.default.contents(atPath: path), bytes.count == lutSize * lutSize * lutSize * 4 else { return nil }
    return bytes
}
let lookData = options["lut"].flatMap(lookTable)
if options["lut"] != nil && lookData == nil { fail("the look's table couldn't be read") }
let strength = min(max(num("strength", 1), 0), 1)
let isLog = flags.contains("log")

/// The Metal side, made once per GPU: the compiled shader and the look table.
final class GPU: @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var made: [ObjectIdentifier: (MTLComputePipelineState, MTLTexture)] = [:]
    static func state(_ device: MTLDevice) throws -> (MTLComputePipelineState, MTLTexture) {
        lock.lock()
        defer { lock.unlock() }
        if let s = made[ObjectIdentifier(device)] { return s }
        let library = try device.makeLibrary(source: gradeSource, options: nil)
        guard let fn = library.makeFunction(name: "grade") else { throw NSError(domain: "clip", code: 1) }
        let pipe = try device.makeComputePipelineState(function: fn)
        let n = lookData == nil ? 2 : lutSize
        let desc = MTLTextureDescriptor()
        desc.textureType = .type3D
        desc.pixelFormat = .rgba8Unorm
        desc.width = n
        desc.height = n
        desc.depth = n
        desc.usage = .shaderRead
        guard let lut = device.makeTexture(descriptor: desc) else { throw NSError(domain: "clip", code: 2) }
        let bytes = lookData ?? Data(count: n * n * n * 4)
        bytes.withUnsafeBytes { raw in
            lut.replace(region: MTLRegionMake3D(0, 0, 0, n, n, n), mipmapLevel: 0, slice: 0, withBytes: raw.baseAddress!, bytesPerRow: n * 4, bytesPerImage: n * n * 4)
        }
        made[ObjectIdentifier(device)] = (pipe, lut)
        return (pipe, lut)
    }
}

final class Grade: CIImageProcessorKernel {
    override class var outputFormat: CIFormat { .RGBAh }
    override class func formatForInput(at input: Int32) -> CIFormat { .RGBAh }
    // The whole frame comes in: blur, fringes and weave look beyond each pixel.
    override class func roi(forInput input: Int32, arguments: [String: Any]?, outputRect: CGRect) -> CGRect {
        CGRect(x: 0, y: 0, width: (arguments?["width"] as? Double) ?? Double(outputRect.maxX), height: (arguments?["height"] as? Double) ?? Double(outputRect.maxY))
    }
    override class func process(with inputs: [CIImageProcessorInput]?, arguments: [String: Any]?, output: CIImageProcessorOutput) throws {
        guard let input = inputs?.first, let src = input.metalTexture, let dst = output.metalTexture, let commands = output.metalCommandBuffer else {
            throw NSError(domain: "clip", code: 3, userInfo: [NSLocalizedDescriptionKey: "no GPU for the grade"])
        }
        let (pipe, lut) = try GPU.state(dst.device)
        var p = (arguments?["p"] as? [Float]) ?? []
        // Where this tile sits in the frame, rows counted from the top like the texture's.
        let full = (arguments?["height"] as? Double) ?? Double(output.region.maxY)
        p += [Float(output.region.minX), Float(full - output.region.maxY)]
        guard let enc = commands.makeComputeCommandEncoder() else { throw NSError(domain: "clip", code: 4) }
        enc.setComputePipelineState(pipe)
        enc.setTexture(src, index: 0)
        enc.setTexture(dst, index: 1)
        enc.setTexture(lut, index: 2)
        enc.setBytes(p, length: p.count * MemoryLayout<Float>.size, index: 0)
        let w = pipe.threadExecutionWidth
        let h = max(1, pipe.maxTotalThreadsPerThreadgroup / w)
        enc.dispatchThreads(MTLSize(width: dst.width, height: dst.height, depth: 1), threadsPerThreadgroup: MTLSize(width: w, height: h, depth: 1))
        enc.endEncoding()
    }
}

/// Colour, vignette and grain on a framed (output-size) image. `seed` moves the
/// grain: a new one every frame, like film; 17 matches the editor's still.
func grade(_ framed: CIImage, seed: Int) -> CIImage {
    let p: [Float] = [
        num("exposure"), num("contrast"), num("highlights"), num("shadows"), num("whites"), num("blacks"),
        num("temperature"), num("tint"), num("vibrance"), num("saturation"), num("grain"), num("vignette"),
    ].map(Float.init) + [Float(strength), lookData == nil ? 0 : 1, isLog ? 1 : 0, Float(seed), Float(size.width), Float(size.height)]
        + [num("fade"), num("soften"), num("halation"), num("fringe"), num("scanlines"), num("weave"), num("leak")].map(Float.init)
    // The shader works on sRGB-encoded values, as the editor's does.
    let encoded = framed.applyingFilter("CILinearToSRGBToneCurve")
    do {
        let graded = try Grade.apply(withExtent: framed.extent, inputs: [encoded], arguments: ["p": p, "width": Double(size.width), "height": Double(size.height)])
        return graded.applyingFilter("CISRGBToneCurveToLinear")
    } catch {
        fail("the grade couldn't run: \(error.localizedDescription)")
    }
}

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

/// Straighten, crop to the output's ratio around the chosen centre, and scale:
/// the same geometry as the app's `cropFor`.
func frame(_ image: CIImage) -> CIImage {
    let e = image.extent
    let W = Double(e.width)
    let H = Double(e.height)
    let outW = Double(size.width)
    let outH = Double(size.height)
    let a = outW / outH
    var w: Double = W
    var h: Double = W / a
    if h > H {
        h = H
        w = H * a
    }
    let zoom: Double = 1 + min(max(num("zoom"), 0), 100) / 100
    w /= zoom
    h /= zoom
    let deg: Double = min(max(num("straighten"), -45), 45)
    let t: Double = abs(deg) * Double.pi / 180
    let c: Double = Foundation.cos(t)
    let s: Double = Foundation.sin(t)
    let fitW: Double = W / (w * c + h * s)
    let fitH: Double = H / (w * s + h * c)
    let fit: Double = min(1, min(fitW, fitH))
    w *= fit
    h *= fit
    let bw: Double = w * c + h * s
    let bh: Double = w * s + h * c
    let wantX: Double = W * (0.5 + num("cropx") / 100)
    let cx: Double = min(max(wantX, bw / 2), W - bw / 2)
    // Core Image counts y from the bottom; the crop's offset counts down from the top.
    let wantY: Double = H * (0.5 + num("cropy") / 100)
    let cyTop: Double = min(max(wantY, bh / 2), H - bh / 2)
    let cy: Double = H - cyTop
    let scale: Double = outW / w
    var transform = CGAffineTransform(translationX: -(Double(e.minX) + cx), y: -(Double(e.minY) + cy))
    transform = transform.concatenating(CGAffineTransform(rotationAngle: -deg * Double.pi / 180))
    transform = transform.concatenating(CGAffineTransform(scaleX: scale, y: scale))
    transform = transform.concatenating(CGAffineTransform(translationX: outW / 2, y: outH / 2))
    return image.clampedToExtent().transformed(by: transform).cropped(to: CGRect(origin: .zero, size: size))
}

/// Reads the graded frames through the composition and writes H.264 at `bitrate`
/// bits per second (sound re-encoded to AAC 192 kb/s), over `range`.
func writeWithBitrate(asset: AVURLAsset, composition: AVVideoComposition, range: CMTimeRange, bitrate: Double) async throws {
    if let n = (try? FileManager.default.attributesOfItem(atPath: output.path))?[.size] as? Int, n == 0 {
        try? FileManager.default.removeItem(at: output)
    }
    let reader = try AVAssetReader(asset: asset)
    reader.timeRange = range
    let videoTracks = try await asset.loadTracks(withMediaType: .video)
    let audioTracks = try await asset.loadTracks(withMediaType: .audio)
    let vOut = AVAssetReaderVideoCompositionOutput(videoTracks: videoTracks, videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    vOut.videoComposition = composition
    vOut.alwaysCopiesSampleData = false
    reader.add(vOut)
    var aOut: AVAssetReaderAudioMixOutput?
    if !audioTracks.isEmpty {
        let o = AVAssetReaderAudioMixOutput(audioTracks: audioTracks, audioSettings: [AVFormatIDKey: kAudioFormatLinearPCM])
        reader.add(o)
        aOut = o
    }
    let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
    writer.shouldOptimizeForNetworkUse = true
    let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: Int(size.width),
        AVVideoHeightKey: Int(size.height),
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: Int(bitrate),
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoMaxKeyFrameIntervalDurationKey: 2,
        ],
    ])
    vIn.expectsMediaDataInRealTime = false
    writer.add(vIn)
    var aIn: AVAssetWriterInput?
    if aOut != nil {
        let i = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVNumberOfChannelsKey: 2, AVSampleRateKey: 48_000, AVEncoderBitRateKey: 192_000])
        i.expectsMediaDataInRealTime = false
        writer.add(i)
        aIn = i
    }
    guard reader.startReading() else { throw reader.error ?? NSError(domain: "clip", code: 1, userInfo: [NSLocalizedDescriptionKey: "couldn't read the video"]) }
    guard writer.startWriting() else { throw writer.error ?? NSError(domain: "clip", code: 2, userInfo: [NSLocalizedDescriptionKey: "couldn't write the clip"]) }
    writer.startSession(atSourceTime: range.start)
    let total = max(0.001, range.duration.seconds)
    let group = DispatchGroup()
    let queue = DispatchQueue(label: "clip.write")
    group.enter()
    vIn.requestMediaDataWhenReady(on: queue) {
        while vIn.isReadyForMoreMediaData {
            guard let buf = vOut.copyNextSampleBuffer() else { vIn.markAsFinished(); group.leave(); return }
            let t = CMSampleBufferGetPresentationTimeStamp(buf).seconds - range.start.seconds
            print(String(format: "progress %.3f", min(1, max(0, t / total))))
            vIn.append(buf)
        }
    }
    if let aIn, let aOut {
        group.enter()
        aIn.requestMediaDataWhenReady(on: DispatchQueue(label: "clip.audio")) {
            while aIn.isReadyForMoreMediaData {
                guard let buf = aOut.copyNextSampleBuffer() else { aIn.markAsFinished(); group.leave(); return }
                aIn.append(buf)
            }
        }
    }
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in group.notify(queue: queue) { c.resume() } }
    if reader.status == .failed { throw reader.error ?? NSError(domain: "clip", code: 3) }
    await writer.finishWriting()
    if writer.status != .completed { throw writer.error ?? NSError(domain: "clip", code: 4, userInfo: [NSLocalizedDescriptionKey: "the clip couldn't be finished"]) }
}

/// The video's sound as 16 kHz mono 16-bit PCM in a WAV file (what whisper.cpp reads).
func writeSpeechWav(asset: AVURLAsset) async throws {
    if let n = (try? FileManager.default.attributesOfItem(atPath: output.path))?[.size] as? Int, n == 0 {
        try? FileManager.default.removeItem(at: output)
    }
    let tracks = try await asset.loadTracks(withMediaType: .audio)
    guard !tracks.isEmpty else { throw NSError(domain: "clip", code: 10, userInfo: [NSLocalizedDescriptionKey: "no sound in this file"]) }
    let pcm: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false]
    let reader = try AVAssetReader(asset: asset)
    let out = AVAssetReaderAudioMixOutput(audioTracks: tracks, audioSettings: pcm)
    reader.add(out)
    let writer = try AVAssetWriter(outputURL: output, fileType: .wav)
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: pcm)
    input.expectsMediaDataInRealTime = false
    writer.add(input)
    guard reader.startReading(), writer.startWriting() else { throw reader.error ?? writer.error ?? NSError(domain: "clip", code: 11) }
    writer.startSession(atSourceTime: .zero)
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
        input.requestMediaDataWhenReady(on: DispatchQueue(label: "clip.wav")) {
            while input.isReadyForMoreMediaData {
                guard let buf = out.copyNextSampleBuffer() else { input.markAsFinished(); c.resume(); return }
                input.append(buf)
            }
        }
    }
    await writer.finishWriting()
    if writer.status != .completed { throw writer.error ?? NSError(domain: "clip", code: 12) }
}

let asset = AVURLAsset(url: input)
let done = DispatchSemaphore(value: 0)

Task {
    do {
        let duration = try await asset.load(.duration)
        if options["audio-wav"] != nil {
            // The sound alone, 16 kHz mono 16-bit WAV, for whisper.cpp (Amendment 9b).
            try await writeSpeechWav(asset: asset)
            print("done")
            done.signal()
            return
        }
        if options["info"] != nil {
            // « info W H FPS SECONDS »: what the export sheet needs for sizes and estimates.
            guard let track = try await asset.loadTracks(withMediaType: .video).first else { fail("no picture in this file") }
            let shown = try await track.load(.naturalSize).applying(try await track.load(.preferredTransform))
            let fps = try await track.load(.nominalFrameRate)
            print(String(format: "info %d %d %.3f %.3f", Int(abs(shown.width)), Int(abs(shown.height)), fps, duration.seconds))
            done.signal()
            return
        }
        if let spec = options["size"], spec.hasPrefix("auto:"), let long = Double(spec.dropFirst(5)) {
            guard let track = try await asset.loadTracks(withMediaType: .video).first else { fail("no picture in this file") }
            let shown = try await track.load(.naturalSize).applying(try await track.load(.preferredTransform))
            let (w, h) = (abs(Double(shown.width)), abs(Double(shown.height)))
            guard w > 0, h > 0 else { fail("couldn't read the video's size") }
            let scale = min(1, long / max(w, h))
            let even = { (v: Double) -> Double in max(2, (v * scale / 2).rounded() * 2) }
            size = CGSize(width: even(w), height: even(h))
        }
        if let still = options["still"].flatMap(Double.init) {
            // One frame, exactly as the clip will look.
            let gen = AVAssetImageGenerator(asset: asset)
            gen.appliesPreferredTrackTransform = true
            gen.requestedTimeToleranceBefore = .zero
            gen.requestedTimeToleranceAfter = .zero
            let at = CMTime(seconds: min(max(0, still), max(0, duration.seconds - 0.05)), preferredTimescale: 600)
            let (cg, _) = try await gen.image(at: at)
            let out = grade(frame(CIImage(cgImage: cg)), seed: 17)
            let context = CIContext()
            guard let jpeg = context.jpegRepresentation(of: out, colorSpace: srgb, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.9]) else {
                fail("could not make the still")
            }
            try jpeg.write(to: output, options: .atomic)
            print("done")
            done.signal()
            return
        }
        let composition = try await AVMutableVideoComposition.videoComposition(with: asset, applyingCIFiltersWithHandler: { request in
            // A new grain every frame, so it moves like film.
            let n = Int((request.compositionTime.seconds * 30).rounded())
            request.finish(with: grade(frame(request.sourceImage), seed: 17 + n), context: nil)
        })
        composition.renderSize = size
        let start0 = CMTime(seconds: max(0, num("start")), preferredTimescale: 600)
        let end0 = options["end"].flatMap(Double.init).map { CMTime(seconds: $0, preferredTimescale: 600) } ?? duration
        // An exact bitrate (the app's Quality row): written with AVAssetWriter, so the size is predictable.
        if let bitrate = options["bitrate"].flatMap(Double.init) {
            try await writeWithBitrate(asset: asset, composition: composition, range: CMTimeRange(start: start0, end: CMTimeMinimum(end0, duration)), bitrate: bitrate)
            print("done")
            done.signal()
            return
        }
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else { fail("this video can't be exported") }
        session.videoComposition = composition
        // The app reserves the file name with an empty file; the exporter won't write over one.
        if let size = (try? FileManager.default.attributesOfItem(atPath: output.path))?[.size] as? Int, size == 0 {
            try? FileManager.default.removeItem(at: output)
        }
        session.outputURL = output
        session.outputFileType = .mp4
        session.shouldOptimizeForNetworkUse = true
        let start = CMTime(seconds: max(0, num("start")), preferredTimescale: 600)
        let end = options["end"].flatMap(Double.init).map { CMTime(seconds: $0, preferredTimescale: 600) } ?? duration
        session.timeRange = CMTimeRange(start: start, end: CMTimeMinimum(end, duration))
        let ticker = Timer(timeInterval: 0.5, repeats: true) { _ in print(String(format: "progress %.3f", session.progress)) }
        RunLoop.main.add(ticker, forMode: .common)
        session.exportAsynchronously {
            ticker.invalidate()
            switch session.status {
            case .completed:
                print("done")
            default:
                print("error \(session.error?.localizedDescription ?? "export stopped")")
            }
            done.signal()
        }
    } catch {
        print("error \(error.localizedDescription)")
        done.signal()
    }
}

// Keep the main run loop turning for the progress timer while waiting.
while done.wait(timeout: .now() + 0.05) == .timedOut {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
}
