import { randomUUID as nodeRandomUUID } from 'crypto';

export function randomUUID(): string {
  return nodeRandomUUID();
}

export async function digestStringAsync(
  _algorithm: string,
  _data: string,
  _options?: unknown,
): Promise<string> {
  return '';
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
