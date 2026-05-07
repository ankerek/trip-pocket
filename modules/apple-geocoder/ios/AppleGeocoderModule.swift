import ExpoModulesCore
import MapKit
import Contacts

// On-device geocoder backed by MKLocalSearch. Exposes a single async
// function to JS:
//
//   geocodePlace(name: String, city: String) -> GeocodeResult | nil
//
// Returns the first MKMapItem result. Best-effort: a null return covers
// "no matches", "timeout", and any other recoverable failure. The JS side
// (modules/extraction) persists the place without geocoding when null,
// and falls back to a query-string Apple Maps deep link.
public class AppleGeocoderModule: Module {

  // Defense-in-depth serializer. MKLocalSearch documents a per-app rate
  // limit (~50/sec); pinning calls to a private serial DispatchQueue keeps
  // bursts from overwhelming it and stops two extractions from racing.
  private let queue = DispatchQueue(label: "com.trippocket.AppleGeocoder.queue", qos: .userInitiated)

  // 5-second wall-clock cap. Anything longer is treated as null.
  private static let timeout: TimeInterval = 5

  public func definition() -> ModuleDefinition {
    Name("AppleGeocoder")

    AsyncFunction("geocodePlace") { (name: String, city: String, promise: Promise) in
      let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmedName.isEmpty else {
        promise.resolve(nil)
        return
      }

      let queryParts = [trimmedName, city.trimmingCharacters(in: .whitespacesAndNewlines)].filter { !$0.isEmpty }
      let query = queryParts.joined(separator: ", ")

      let request = MKLocalSearch.Request()
      request.naturalLanguageQuery = query

      let search = MKLocalSearch(request: request)

      // Timeout guard. MKLocalSearch can hang on degraded networks; we
      // resolve with nil at the deadline rather than make the JS-side
      // queue stall.
      var didResolve = false
      let resolveOnce: (Any?) -> Void = { value in
        guard !didResolve else { return }
        didResolve = true
        promise.resolve(value)
      }

      DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + Self.timeout) {
        if !didResolve {
          search.cancel()
          resolveOnce(nil)
        }
      }

      search.start { response, error in
        if error != nil {
          resolveOnce(nil)
          return
        }
        guard let item = response?.mapItems.first else {
          resolveOnce(nil)
          return
        }
        let coord = item.placemark.coordinate
        resolveOnce([
          "latitude": coord.latitude,
          "longitude": coord.longitude,
          "formattedAddress": Self.formatAddress(item.placemark),
          "appleMapsUrl": Self.appleMapsUrl(name: trimmedName, lat: coord.latitude, lng: coord.longitude),
        ])
      }
    }.runOnQueue(queue)
  }

  // MARK: - Internals

  private static func formatAddress(_ placemark: MKPlacemark) -> String {
    if let postal = placemark.postalAddress {
      let formatter = CNPostalAddressFormatter()
      formatter.style = .mailingAddress
      // Single-line for table display.
      return formatter.string(from: postal).replacingOccurrences(of: "\n", with: ", ")
    }
    // Fallback when postalAddress is unavailable.
    return [placemark.name, placemark.locality, placemark.country]
      .compactMap { $0 }
      .joined(separator: ", ")
  }

  private static func appleMapsUrl(name: String, lat: CLLocationDegrees, lng: CLLocationDegrees) -> String {
    var components = URLComponents(string: "https://maps.apple.com/")!
    components.queryItems = [
      URLQueryItem(name: "ll", value: "\(lat),\(lng)"),
      URLQueryItem(name: "q", value: name),
    ]
    return components.url?.absoluteString ?? "https://maps.apple.com/?q=\(name)"
  }
}
