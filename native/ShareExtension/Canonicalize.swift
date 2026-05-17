import Foundation
import CommonCrypto

// URL canonicalization for the share-extension pre-warm flow.
//
// MUST match modules/capture/importUrl.ts `normalizeUrl` byte-for-byte so
// that the contentHash computed here in the share extension matches what
// the app computes when ingesting the same shared URL. The TS fixture
// suite (__fixtures__/canonical-urls.json, exercised by
// lib/url/__tests__/canonicalize.test.ts) is the parity contract — any
// change to the algorithm here must update the TS side and the fixtures.
//
// Algorithm:
//   1. Parse URL. On failure return raw input unchanged.
//   2. Drop query string and fragment.
//   3. Lowercase host, strip a leading `www.` or `m.` prefix.
//   4. Ensure the path is at least `/` (URLComponents drops it for
//      bare-host inputs whereas JS's `new URL` always re-injects it).
//   5. Serialize. Strip a trailing `/` unless the path is exactly `/`.
enum Canonicalize {
  static func normalizeUrl(_ raw: String) -> String {
    guard var comps = URLComponents(string: raw),
          comps.scheme != nil,
          var host = comps.host else {
      return raw
    }
    comps.query = nil
    comps.fragment = nil

    host = host.lowercased()
    if host.hasPrefix("www.") { host.removeFirst("www.".count) }
    if host.hasPrefix("m.")   { host.removeFirst("m.".count) }
    comps.host = host

    // JS's `new URL("https://host")` re-serialises with a trailing `/`;
    // URLComponents leaves it empty. Inject so the two implementations
    // agree on bare-host inputs.
    if comps.path.isEmpty {
      comps.path = "/"
    }

    guard var out = comps.string else { return raw }

    // Strip trailing `/` when the path has any segment beyond root.
    if out.hasSuffix("/") && comps.path.count > 1 {
      out.removeLast()
    }
    return out
  }

  static func contentHash(_ raw: String) -> String {
    let normalized = normalizeUrl(raw)
    let data = Data(normalized.utf8)
    var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
      _ = CC_SHA256(bytes.baseAddress, CC_LONG(data.count), &hash)
    }
    return hash.map { String(format: "%02x", $0) }.joined()
  }
}
