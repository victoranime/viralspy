import Foundation
import Vision
import AppKit

struct FrameResult: Codable {
    let file: String
    let lines: [String]
    let text: String
}

let args = Array(CommandLine.arguments.dropFirst())
var results: [FrameResult] = []

for path in args {
    let url = URL(fileURLWithPath: path)
    guard let image = NSImage(contentsOf: url),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        results.append(FrameResult(file: path, lines: [], text: ""))
        continue
    }

    var detected: [String] = []
    let request = VNRecognizeTextRequest { req, _ in
        guard let observations = req.results as? [VNRecognizedTextObservation] else { return }
        for obs in observations {
            if let top = obs.topCandidates(1).first, top.confidence >= 0.35 {
                let s = top.string.trimmingCharacters(in: .whitespacesAndNewlines)
                if !s.isEmpty {
                    detected.append(s)
                }
            }
        }
    }
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try? handler.perform([request])

    results.append(FrameResult(file: path, lines: detected, text: detected.joined(separator: " ")))
}

let encoder = JSONEncoder()
if let data = try? encoder.encode(results), let str = String(data: data, encoding: .utf8) {
    print(str)
} else {
    print("[]")
}
