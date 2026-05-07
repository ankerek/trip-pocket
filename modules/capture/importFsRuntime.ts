import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import type { ImportFs } from './importImage';

export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const buf = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return arrayBufferToHex(buf);
}

function arrayBufferToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < view.length; i += 1) {
    const b = view[i] ?? 0;
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

export function createImportFs(): ImportFs {
  return {
    sha256: async (uri: string) => {
      const file = new File(uri);
      const bytes = file.bytesSync();
      return sha256OfBytes(bytes);
    },
    copy: async (from, to) => {
      const src = new File(from);
      const dst = new File(to);
      src.copy(dst);
    },
    move: async (from, to) => {
      const src = new File(from);
      const dst = new File(to);
      src.move(dst);
    },
    unlink: async (uri) => {
      const f = new File(uri);
      if (f.exists) f.delete();
    },
  };
}
