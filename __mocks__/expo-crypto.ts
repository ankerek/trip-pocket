import { randomUUID as nodeRandomUUID, createHash } from 'crypto';

export function randomUUID(): string {
  return nodeRandomUUID();
}

export async function digest(
  algorithm: string,
  data: Uint8Array | ArrayBuffer | ArrayBufferView,
): Promise<ArrayBuffer> {
  // Expo uses 'SHA-256'; Node uses 'sha256'.
  const nodeAlg = algorithm.toLowerCase().replace(/-/g, '');
  const buf =
    data instanceof Uint8Array
      ? data
      : new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer);
  const h = createHash(nodeAlg);
  h.update(Buffer.from(buf));
  const out = h.digest();
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export function getRandomValues(typedArray: unknown): unknown {
  return typedArray;
}

export const CryptoDigestAlgorithm = {
  SHA1: 'SHA-1',
  SHA256: 'SHA-256',
  SHA384: 'SHA-384',
  SHA512: 'SHA-512',
  MD2: 'MD2',
  MD4: 'MD4',
  MD5: 'MD5',
};

export const CryptoEncoding = {
  HEX: 'hex',
  BASE64: 'base64',
};
