import ExpoModulesCore
import Vision
import CoreGraphics
import ImageIO

// On-device Apple Vision OCR. Exposes a single async function to JS:
//
//   recognizeText(imagePath: String) -> String
//
// Concatenated text in top-to-bottom reading order, joined by newlines.
// Throws on file or decode errors; the JS side (modules/processing) treats
// throws as a transient failure and retries up to maxRetries.
public class VisionOCRModule: Module {

  // Defense-in-depth serializer. The JS-side queue in modules/processing
  // already guarantees one OCR call at a time, but pinning Vision work to
  // a private serial DispatchQueue means the main thread stays clear and
  // a future caller that bypasses modules/processing still can't run two
  // concurrent VNRecognizeTextRequests.
  private let queue = DispatchQueue(label: "com.trippocket.VisionOCR.queue", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("VisionOCR")

    AsyncFunction("recognizeText") { (imagePath: String, promise: Promise) in
      self.queue.async {
        do {
          let text = try VisionOCRModule.recognize(imagePath: imagePath)
          promise.resolve(text)
        } catch {
          promise.reject(error)
        }
      }
    }
  }

  // MARK: - Internals

  private static func recognize(imagePath: String) throws -> String {
    let path = Self.normalize(path: imagePath)
    let url = URL(fileURLWithPath: path)

    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
      throw VisionOCRError.imageOpenFailed(path: path)
    }
    guard let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
      throw VisionOCRError.imageDecodeFailed(path: path)
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if #available(iOS 16.0, *) {
      request.automaticallyDetectsLanguage = true
    }

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])

    guard let observations = request.results else { return "" }
    let lines = observations.compactMap { $0.topCandidates(1).first?.string }
    return lines.joined(separator: "\n")
  }

  private static func normalize(path: String) -> String {
    if path.hasPrefix("file://") {
      return String(path.dropFirst("file://".count))
    }
    return path
  }
}

private enum VisionOCRError: Error, LocalizedError {
  case imageOpenFailed(path: String)
  case imageDecodeFailed(path: String)

  var errorDescription: String? {
    switch self {
    case .imageOpenFailed(let path):
      return "VisionOCR: failed to open image source at \(path)"
    case .imageDecodeFailed(let path):
      return "VisionOCR: failed to decode image at \(path)"
    }
  }
}
