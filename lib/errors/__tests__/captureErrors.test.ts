import { classifyImportError } from '../captureErrors';

describe('classifyImportError', () => {
  test('ENOSPC substring → storage-full', () => {
    expect(classifyImportError(new Error('ENOSPC: no space left on device'))).toBe('storage-full');
  });

  test('NSFileWriteOutOfSpaceError name → storage-full', () => {
    expect(
      classifyImportError(new Error('NSFileWriteOutOfSpaceError The operation couldn’t be completed.')),
    ).toBe('storage-full');
  });

  test('Cocoa NSCocoaErrorDomain code 640 → storage-full', () => {
    const err = Object.assign(new Error('write failed'), {
      domain: 'NSCocoaErrorDomain',
      code: 640,
    });
    expect(classifyImportError(err)).toBe('storage-full');
  });

  test('Cocoa code 642 (read-only volume) → unknown', () => {
    const err = Object.assign(new Error('volume is read-only'), {
      domain: 'NSCocoaErrorDomain',
      code: 642,
    });
    expect(classifyImportError(err)).toBe('unknown');
  });

  test('"no space" substring → storage-full', () => {
    expect(classifyImportError(new Error('Couldn\'t copy: no space left'))).toBe('storage-full');
  });

  test('"out of space" substring → storage-full', () => {
    expect(classifyImportError(new Error('Out of space'))).toBe('storage-full');
  });

  test('"out of storage" substring → storage-full', () => {
    expect(classifyImportError(new Error('Device is out of storage'))).toBe('storage-full');
  });

  test('SQLite "database or disk is full" → storage-full', () => {
    expect(classifyImportError(new Error('database or disk is full'))).toBe('storage-full');
  });

  test('Case-insensitive matching', () => {
    expect(classifyImportError(new Error('ENOSPC'))).toBe('storage-full');
    expect(classifyImportError(new Error('enospc'))).toBe('storage-full');
    expect(classifyImportError(new Error('NO SPACE LEFT ON DEVICE'))).toBe('storage-full');
  });

  test('Unknown / unrelated error → unknown', () => {
    expect(classifyImportError(new Error('FOREIGN KEY constraint failed'))).toBe('unknown');
    expect(classifyImportError(new Error('Network request failed'))).toBe('unknown');
    expect(classifyImportError(new Error(''))).toBe('unknown');
  });

  test('Non-Error inputs', () => {
    expect(classifyImportError('ENOSPC')).toBe('storage-full');
    expect(classifyImportError('something')).toBe('unknown');
    expect(classifyImportError(null)).toBe('unknown');
    expect(classifyImportError(undefined)).toBe('unknown');
    expect(classifyImportError({ message: 'no space' })).toBe('storage-full');
    expect(classifyImportError({ code: 640, domain: 'NSCocoaErrorDomain' })).toBe('storage-full');
  });
});
