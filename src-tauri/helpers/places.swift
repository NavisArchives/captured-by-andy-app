// places: names places from their coordinates, on this Mac (Apple's reverse
// geocoding). Reads "lat<TAB>lon" lines on stdin, answers one line each:
//   ok<TAB>locality<TAB>sub-area<TAB>area<TAB>country   or   err<TAB>why
// One request at a time, spaced out, as Apple asks.
import CoreLocation
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let input = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
let geocoder = CLGeocoder()
for line in input.split(separator: "\n") {
    let p = line.split(separator: "\t").compactMap { Double($0) }
    guard p.count == 2 else {
        print("err\tnot a coordinate")
        continue
    }
    var answer: String?
    geocoder.reverseGeocodeLocation(CLLocation(latitude: p[0], longitude: p[1]), preferredLocale: Locale(identifier: "en_US")) { marks, error in
        if let m = marks?.first {
            answer = ["ok", m.locality ?? "", m.subAdministrativeArea ?? "", m.administrativeArea ?? "", m.country ?? ""].joined(separator: "\t")
        } else {
            answer = "err\t\(error?.localizedDescription ?? "no place there")"
        }
    }
    let deadline = Date() + 20
    while answer == nil && Date() < deadline { RunLoop.main.run(until: Date() + 0.05) }
    print(answer ?? "err\tno answer")
    RunLoop.main.run(until: Date() + 1.2)
}
