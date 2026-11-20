// webshot <url> <out.jpg> [--width 1200] [--height 1500]
// A picture of a web page as it first opens (its landing view), for an
// inspiration save: the page is loaded in a private, off-screen WebKit view
// at a desktop width, given a moment to settle, and snapshotted as a JPEG.
// Prints "done" or "error <message>".
import AppKit
import WebKit

setvbuf(stdout, nil, _IOLBF, 0)
let args = CommandLine.arguments
guard args.count >= 3, let target = URL(string: args[1]) else {
    print("usage: webshot <url> <out.jpg> [--width 1200] [--height 1500]")
    exit(2)
}
let output = URL(fileURLWithPath: args[2])
func opt(_ name: String, _ fallback: CGFloat) -> CGFloat {
    guard let i = args.firstIndex(of: "--\(name)"), i + 1 < args.count, let v = Double(args[i + 1]) else { return fallback }
    return CGFloat(v)
}
let size = NSSize(width: opt("width", 1200), height: opt("height", 1500))

/// Calls a yes/no setter by name when the object has it.
func setFlag(_ object: NSObject, _ name: String, _ value: Bool) {
    let sel = NSSelectorFromString(name)
    guard object.responds(to: sel) else { return }
    typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
    unsafeBitCast(object.method(for: sel), to: Setter.self)(object, sel, value)
}

final class Shot: NSObject, WKNavigationDelegate {
    let window: NSWindow
    let view: WKWebView
    let url: URL
    let out: URL
    var finished = false

    init(url: URL, out: URL, size: NSSize) {
        self.url = url
        self.out = out
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.mediaTypesRequiringUserActionForPlayback = []
        view = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        view.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
        // An off-screen view counts as hidden, and WebKit pauses animations in
        // hidden pages: intros that fade in would never finish. Keep it running
        // (WebKit's own switches for this, used only when they exist).
        setFlag(view, "_setWindowOcclusionDetectionEnabled:", false)
        setFlag(config.preferences, "_setHiddenPageDOMTimerThrottlingEnabled:", false)
        setFlag(config.preferences, "_setPageVisibilityBasedProcessSuppressionEnabled:", false)
        // Off screen, but in a window: WebKit only paints what's in one.
        window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        super.init()
        view.navigationDelegate = self
        window.orderBack(nil)
    }

    func start() {
        view.load(URLRequest(url: url, timeoutInterval: 20))
        // Some pages never say they finished (endless trackers): take what's there.
        DispatchQueue.main.asyncAfter(deadline: .now() + 18) { self.snap() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Fonts, fade-ins and hero images settle a moment after load.
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.snap() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { done("error \(error.localizedDescription)") }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { done("error \(error.localizedDescription)") }

    /// Tries left before settling for a plain picture (a loading screen).
    var patience = 5

    func snap() {
        guard !finished else { return }
        let config = WKSnapshotConfiguration()
        config.rect = NSRect(origin: .zero, size: view.frame.size)
        config.snapshotWidth = NSNumber(value: Double(view.frame.width))
        view.takeSnapshot(with: config) { image, error in
            guard let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                return self.done("error \(error?.localizedDescription ?? "no picture")")
            }
            // Still a loading screen (nearly one colour)? Give it a little longer.
            if self.plain(cg) && self.patience > 0 {
                self.patience -= 1
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.snap() }
                return
            }
            let rep = NSBitmapImageRep(cgImage: cg)
            guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else { return self.done("error no picture") }
            do {
                try jpeg.write(to: self.out, options: .atomic)
                self.done("done")
            } catch {
                self.done("error \(error.localizedDescription)")
            }
        }
    }

    /// Whether a picture is (almost) one flat colour: a 32×32 grey copy barely varies.
    func plain(_ cg: CGImage) -> Bool {
        let n = 32
        var px = [UInt8](repeating: 0, count: n * n)
        guard let ctx = CGContext(data: &px, width: n, height: n, bitsPerComponent: 8, bytesPerRow: n, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0) else { return false }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: n, height: n))
        let mean = px.reduce(0.0) { $0 + Double($1) } / Double(px.count)
        let spread = (px.reduce(0.0) { $0 + pow(Double($1) - mean, 2) } / Double(px.count)).squareRoot()
        return spread < 6
    }

    func done(_ line: String) {
        guard !finished else { return }
        finished = true
        print(line)
        exit(line == "done" ? 0 : 1)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let shot = Shot(url: target, out: output, size: size)
shot.start()
DispatchQueue.main.asyncAfter(deadline: .now() + 40) { shot.done("error the page took too long") }
app.run()
