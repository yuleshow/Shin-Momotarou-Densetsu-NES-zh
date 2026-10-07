import Foundation
import Vision

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count >= 2 else {
    fatalError("Usage: swift tools/ocr-frames.swift LANGUAGE IMAGE...")
}
for filename in arguments.dropFirst() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/magick")
    process.arguments = [filename, "-filter", "point", "-resize", "400%", "png:-"]
    let pipe = Pipe()
    process.standardOutput = pipe
    try process.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { fatalError("Image conversion failed") }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = [arguments[0]]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(data: data).perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    let record: [String: Any] = ["frame": URL(fileURLWithPath: filename).deletingPathExtension().lastPathComponent, "text": text]
    let encoded = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
    print(String(decoding: encoded, as: UTF8.self))
}