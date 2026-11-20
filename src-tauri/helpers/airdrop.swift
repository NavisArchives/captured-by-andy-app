// airdrop <file>...
// Opens macOS's AirDrop window for these files and prints how it ended:
// "sent", "cancelled" or "unavailable". The files are only read.
import AppKit

setvbuf(stdout, nil, _IOLBF, 0)

final class Watcher: NSObject, NSSharingServiceDelegate {
    func sharingService(_ sharingService: NSSharingService, didShareItems items: [Any]) {
        print("sent")
        exit(0)
    }

    func sharingService(_ sharingService: NSSharingService, didFailToShareItems items: [Any], error: Error) {
        let cancelled = (error as NSError).code == NSUserCancelledError
        print(cancelled ? "cancelled" : "failed \(error.localizedDescription)")
        exit(cancelled ? 0 : 1)
    }
}

let urls = CommandLine.arguments.dropFirst().map { URL(fileURLWithPath: $0) }
guard !urls.isEmpty else {
    print("usage: airdrop <file>...")
    exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let watcher = Watcher()
DispatchQueue.main.async {
    guard let service = NSSharingService(named: .sendViaAirDrop), service.canPerform(withItems: urls) else {
        print("unavailable")
        exit(3)
    }
    service.delegate = watcher
    NSApp.activate(ignoringOtherApps: true)
    service.perform(withItems: urls)
}
// Never linger: give up after 15 minutes.
DispatchQueue.main.asyncAfter(deadline: .now() + 900) {
    print("cancelled")
    exit(0)
}
app.run()
