// Metro firehose: when enabled (dev build + Settings toggle), every stage
// transition logs a structured one-liner with full content props. Off by
// default; persisted rows never carry content regardless of this flag.

import type { Database } from '@/modules/storage';
import { getDatabaseHandle } from '@/modules/storage';

const META_KEY = 'pipeline_firehose';
const MAX_STR_VALUE_LEN = 500;

// Module-level cache so reads are O(1). initFirehose() seeds it from the meta
// table; setFirehoseEnabled() updates it synchronously before scheduling the
// SQLite write, so the next track() call honours the new state immediately.
let firehoseEnabled = false;

export function isFirehoseEnabled(): boolean {
  return firehoseEnabled;
}

export async function initFirehose(db?: Database): Promise<void> {
  const handle = db ?? getDatabaseHandle();
  if (!handle) {
    firehoseEnabled = false;
    return;
  }
  const row = await handle.getFirstAsync<{ value: string | null }>(
    'SELECT value FROM meta WHERE key = ?',
    META_KEY,
  );
  firehoseEnabled = row?.value === '1';
}

export async function setFirehoseEnabled(enabled: boolean, db?: Database): Promise<void> {
  // Update memory first so any track() in-flight sees the new state without
  // waiting for SQLite.
  firehoseEnabled = enabled;
  const handle = db ?? getDatabaseHandle();
  if (!handle) return;
  await handle.runAsync(
    'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
    META_KEY,
    enabled ? '1' : '0',
  );
}

export type FirehoseExtra = Record<string, unknown>;

/**
 * Format and log one stage transition. No-op unless firehose is enabled AND
 * we're in a dev build. Both gates apply: production builds never log content
 * regardless of the flag state.
 */
export function logToFirehose(args: {
  stage: string;
  status: 'done' | 'failed';
  sourceId: string | null;
  durationMs: number;
  errorSummary: string | null;
  extra: FirehoseExtra;
}): void {
  // __DEV__ is the hard production gate. The runtime cache check is cheap and
  // does the right thing in tests where __DEV__ is true (so the firehose code
  // path is exercised when flagged on).
  // eslint-disable-next-line no-undef
  if (typeof __DEV__ !== 'undefined' && !__DEV__) return;
  if (!firehoseEnabled) return;

  const parts: string[] = [`[pipeline] ${args.stage} ${args.status} in ${args.durationMs}ms`];
  if (args.sourceId !== null) parts.push(`source=${args.sourceId}`);
  for (const [key, value] of Object.entries(args.extra)) {
    const rendered = renderValue(value);
    if (rendered === null) continue;
    parts.push(`${key}=${rendered}`);
  }
  if (args.errorSummary !== null) {
    parts.push(`error=${quote(args.errorSummary)}`);
  }
  // eslint-disable-next-line no-console
  console.log(parts.join(' '));
}

function renderValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return quote(JSON.stringify(value));
  } catch {
    return null;
  }
}

function quote(s: string): string {
  const truncated = s.length > MAX_STR_VALUE_LEN ? s.slice(0, MAX_STR_VALUE_LEN) + '…' : s;
  return `"${truncated.replace(/"/g, '\\"')}"`;
}

// Test-only: reset module state between tests so cache doesn't leak.
export function _resetFirehoseForTests(): void {
  firehoseEnabled = false;
}
