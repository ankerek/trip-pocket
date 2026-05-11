export type CaptureErrorKind = 'storage-full' | 'unknown';

const STORAGE_FULL_SUBSTRINGS = [
  'enospc',
  'nsfilewriteoutofspaceerror',
  'no space',
  'out of space',
  'out of storage',
  'database or disk is full',
];

// Cocoa code 640 is NSFileWriteOutOfSpaceError. 642 is NSFileWriteVolumeReadOnlyError —
// intentionally excluded; read-only-volume is not out-of-space.
const STORAGE_FULL_COCOA_CODES = new Set([640]);

export function classifyImportError(err: unknown): CaptureErrorKind {
  if (err === null || err === undefined) return 'unknown';

  const obj = err as { code?: unknown; domain?: unknown; message?: unknown };
  const domain = typeof obj.domain === 'string' ? obj.domain : '';
  const code = typeof obj.code === 'number' ? obj.code : null;
  if (
    domain === 'NSCocoaErrorDomain' &&
    code !== null &&
    STORAGE_FULL_COCOA_CODES.has(code)
  ) {
    return 'storage-full';
  }

  const haystack = (
    typeof obj.message === 'string' ? obj.message : String(err)
  ).toLowerCase();

  for (const needle of STORAGE_FULL_SUBSTRINGS) {
    if (haystack.includes(needle)) return 'storage-full';
  }

  return 'unknown';
}
