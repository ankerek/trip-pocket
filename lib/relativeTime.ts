/**
 * Format an ISO timestamp as a "Captured ..." caption suitable for the
 * source meta line (triage card, source detail). Locale and timezone
 * follow the device. Today and yesterday get short labels; older dates
 * fall back to a date string. Same-year dates omit the year.
 *
 * Examples (en-US, 2026-05-09 14:22 device time):
 *   today, 14:22                 -> "Captured today · 14:22"
 *   yesterday, 09:01             -> "Captured yesterday · 09:01"
 *   2026-05-04 18:00             -> "Captured Mon, May 4 · 18:00"
 *   2025-12-31 23:59             -> "Captured Dec 31, 2025 · 23:59"
 */
export function formatCapturedAt(iso: string, now: Date = new Date()): string {
  const captured = new Date(iso);
  if (Number.isNaN(captured.getTime())) return 'Captured';

  const time = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(captured);

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfCaptured = new Date(
    captured.getFullYear(),
    captured.getMonth(),
    captured.getDate(),
  ).getTime();
  const dayDelta = Math.round((startOfToday - startOfCaptured) / 86_400_000);

  let day: string;
  if (dayDelta === 0) day = 'today';
  else if (dayDelta === 1) day = 'yesterday';
  else if (captured.getFullYear() === now.getFullYear()) {
    day = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(captured);
  } else {
    day = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(captured);
  }

  return `Captured ${day} · ${time}`;
}
