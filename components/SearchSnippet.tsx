import { Text } from '@/tw';

const STX = '';
const ETX = '';

/**
 * Parse the output of FTS5's `snippet(t, c, char(2), char(3), '…', n)` into
 * alternating plain / highlighted runs. The STX/ETX byte pair is used as
 * the marker because OCR text is guaranteed not to contain them — no HTML
 * parsing needed.
 */
export function parseSnippet(raw: string): Array<{ text: string; bold: boolean }> {
  const out: Array<{ text: string; bold: boolean }> = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const stxIdx = raw.indexOf(STX, cursor);
    if (stxIdx === -1) {
      out.push({ text: raw.slice(cursor), bold: false });
      break;
    }
    if (stxIdx > cursor) {
      out.push({ text: raw.slice(cursor, stxIdx), bold: false });
    }
    const etxIdx = raw.indexOf(ETX, stxIdx + 1);
    if (etxIdx === -1) {
      // Malformed — render the rest as plain text.
      out.push({ text: raw.slice(stxIdx + 1), bold: false });
      break;
    }
    out.push({ text: raw.slice(stxIdx + 1, etxIdx), bold: true });
    cursor = etxIdx + 1;
  }
  return out;
}

export function SearchSnippet({ raw, className }: { raw: string; className?: string }) {
  const pieces = parseSnippet(raw);
  return (
    <Text className={className} numberOfLines={2} ellipsizeMode="tail">
      {pieces.map((p, i) =>
        p.bold ? (
          <Text key={i} className="font-semibold text-slate-900">
            {p.text}
          </Text>
        ) : (
          <Text key={i}>{p.text}</Text>
        ),
      )}
    </Text>
  );
}
