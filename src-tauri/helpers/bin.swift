// Clean up's hands. Moves files to the Bin the way Finder does (a file on
// Google Drive lands in Drive's own Bin, kept 30 days), puts them back, and
// finds and deletes the same photos in Apple Photos, where Apple asks first and
// keeps them in Recently Deleted for 30 days. Reads its work from stdin.
//
//   bin trash          lines: <path>                 → ok\t<path>\t<where it went> | err\t<path>\t<why>
//   bin restore        lines: <binned>\t<original>   → ok\t<original> | err\t<original>\t<why>
//   bin photos-find    lines: <key>\t<stem>\t<local capture time, 2026-03-18T06:35:29>
//                                                    → found\t<key>\t<Photos id> …, then done\t<found>\t<asked>
//   bin photos-delete  lines: <Photos id>            → deleted\t<n> | cancelled | denied | err\t<why>
import AppKit
import Foundation
import Photos

setvbuf(stdout, nil, _IOLBF, 0)
let args = CommandLine.arguments
let lines = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
let input = lines.split(separator: "\n").map(String.init).filter { !$0.isEmpty }

func out(_ parts: String...) { print(parts.joined(separator: "\t")) }

/// Photos access, asked once (the system shows the question in the app's name).
func photosAccess() -> Bool {
    var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    if status == .notDetermined {
        let done = DispatchSemaphore(value: 0)
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { s in
            status = s
            done.signal()
        }
        while done.wait(timeout: .now() + 0.05) == .timedOut { RunLoop.main.run(until: Date() + 0.05) }
    }
    return status == .authorized || status == .limited
}

switch args.count > 1 ? args[1] : "" {
case "trash":
    for path in input {
        var landed: NSURL?
        do {
            try FileManager.default.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: &landed)
            out("ok", path, landed?.path ?? "")
        } catch {
            out("err", path, error.localizedDescription)
        }
    }

case "restore":
    for line in input {
        let p = line.components(separatedBy: "\t")
        guard p.count == 2 else { continue }
        let (binned, original) = (URL(fileURLWithPath: p[0]), URL(fileURLWithPath: p[1]))
        do {
            if FileManager.default.fileExists(atPath: original.path) { throw NSError(domain: "bin", code: 1, userInfo: [NSLocalizedDescriptionKey: "a file with that name is back already"]) }
            try FileManager.default.createDirectory(at: original.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: binned, to: original)
            out("ok", original.path)
        } catch {
            out("err", original.path, error.localizedDescription)
        }
    }

case "photos-find":
    guard photosAccess() else {
        out("denied")
        exit(0)
    }
    // The library knows a photo by its file name and the local time it was taken;
    // Photos by its original file name and the absolute time. Same name, and the
    // times differ by a whole time zone (a multiple of 15 minutes): the same photo.
    let fmt = DateFormatter()
    fmt.locale = Locale(identifier: "en_US_POSIX")
    fmt.timeZone = TimeZone(identifier: "UTC")
    fmt.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
    var found = 0
    for line in input {
        let p = line.components(separatedBy: "\t")
        guard p.count == 3, let local = fmt.date(from: String(p[2].prefix(19))) else { continue }
        let stems = Set([p[1].lowercased(), p[1].lowercased().replacingOccurrences(of: #" \d+$"#, with: "", options: .regularExpression)])
        let opts = PHFetchOptions()
        opts.includeHiddenAssets = true
        opts.predicate = NSPredicate(format: "creationDate >= %@ AND creationDate <= %@", local.addingTimeInterval(-15 * 3600) as NSDate, local.addingTimeInterval(15 * 3600) as NSDate)
        let assets = PHAsset.fetchAssets(with: opts)
        var match: PHAsset?
        assets.enumerateObjects { a, _, stop in
            guard let made = a.creationDate else { return }
            let off = abs(made.timeIntervalSince(local)).truncatingRemainder(dividingBy: 900)
            guard off <= 2 || off >= 898 else { return }
            let names = PHAssetResource.assetResources(for: a).map { ($0.originalFilename as NSString).deletingPathExtension.lowercased() }
            if names.contains(where: { stems.contains($0) }) {
                match = a
                stop.pointee = true
            }
        }
        if let m = match {
            found += 1
            out("found", p[0], m.localIdentifier)
        }
    }
    out("done", String(found), String(input.count))

case "photos-delete":
    guard photosAccess() else {
        out("denied")
        exit(0)
    }
    let assets = PHAsset.fetchAssets(withLocalIdentifiers: input, options: nil)
    guard assets.count > 0 else {
        out("deleted", "0")
        exit(0)
    }
    // Apple's own "Delete N photos?" question needs an app to show it in.
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.activate(ignoringOtherApps: true)
    var result: (Bool, Error?)?
    PHPhotoLibrary.shared().performChanges({ PHAssetChangeRequest.deleteAssets(assets) }) { ok, err in result = (ok, err) }
    while result == nil { RunLoop.main.run(until: Date() + 0.05) }
    switch result! {
    case (true, _): out("deleted", String(assets.count))
    case (false, let e?) where (e as NSError).code == 3072: out("cancelled")
    case (false, let e): out("err", e?.localizedDescription ?? "Photos didn't delete them")
    }

default:
    FileHandle.standardError.write("usage: bin trash|restore|photos-find|photos-delete (work on stdin)\n".data(using: .utf8)!)
    exit(2)
}
