import { File, Paths } from 'expo-file-system';
import { readCachedStatus, writeCachedStatus, resetCachedStatus } from '../storage';

jest.mock('expo-file-system', () => {
  const memory = new Map<string, string>();
  function key(dir: string, name: string): string {
    return `${dir}/${name}`;
  }
  return {
    Paths: { document: '/mock-doc' },
    File: class {
      private path: string;
      constructor(dir: string, name: string) {
        this.path = key(dir, name);
      }
      get exists(): boolean {
        return memory.has(this.path);
      }
      textSync(): string {
        return memory.get(this.path) ?? '';
      }
      create(): void {
        if (!memory.has(this.path)) memory.set(this.path, '');
      }
      write(text: string): void {
        memory.set(this.path, text);
      }
      delete(): void {
        memory.delete(this.path);
      }
    },
    __memory: memory,
  };
});

const fs = jest.requireMock('expo-file-system') as { __memory: Map<string, string> };

beforeEach(() => fs.__memory.clear());

describe('entitlement/storage', () => {
  test('readCachedStatus returns null when file missing', () => {
    expect(readCachedStatus()).toBeNull();
  });

  test('round-trips "active"', () => {
    writeCachedStatus('active');
    expect(readCachedStatus()).toBe('active');
  });

  test('round-trips "inactive"', () => {
    writeCachedStatus('inactive');
    expect(readCachedStatus()).toBe('inactive');
  });

  test('returns null when file content is garbage', () => {
    fs.__memory.set('/mock-doc/entitlement-status.txt', 'banana');
    expect(readCachedStatus()).toBeNull();
  });

  test('resetCachedStatus deletes the file', () => {
    writeCachedStatus('active');
    resetCachedStatus();
    expect(readCachedStatus()).toBeNull();
  });
});
