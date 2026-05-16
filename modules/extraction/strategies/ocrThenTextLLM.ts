import { extractFromProxy } from '../proxy';
import type { ExtractionResult } from '../extraction';
import type { ExtractionStrategy, StrategyInput } from './types';

export type OcrThenTextLLMOptions = {
  proxyUrl: string;
  /** Optional: if provided, run OCR on the file when ocrText is missing.
   *  When omitted, image input without cached ocrText throws — the runner
   *  expects the sweep to have pre-warmed text. */
  ocr?: (filePath: string) => Promise<string>;
};

/**
 * The legacy strategy: OCR text → text-mode worker call. Kept as a first-class
 * fallback so a single config flip (`forceStrategy: 'ocrTextLLM'`) restores
 * pre-vision behavior across the app. When called with image input and the
 * OCR sweep hasn't populated `ocrText` yet, runs OCR inline if an `ocr`
 * provider was wired; otherwise rejects so the row stays pending.
 */
export function createOcrThenTextLLM(opts: OcrThenTextLLMOptions): ExtractionStrategy {
  return {
    name: 'ocrTextLLM',
    async extract(input: StrategyInput): Promise<ExtractionResult> {
      let text: string;
      if (input.kind === 'text') {
        text = input.text;
      } else {
        if (input.ocrText && input.ocrText.length > 0) {
          text = input.ocrText;
        } else if (opts.ocr) {
          text = await opts.ocr(input.filePath);
        } else {
          throw new Error(
            'ocrThenTextLLM: image input has no cached ocrText and no inline OCR was wired',
          );
        }
      }
      return extractFromProxy(text, opts.proxyUrl);
    },
  };
}
