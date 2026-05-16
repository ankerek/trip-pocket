import { extractFromProxyVision } from '../proxy';
import type { ExtractionResult } from '../extraction';
import type { ExtractionStrategy, StrategyInput } from './types';

export type CaptionPlusVisionOptions = {
  proxyUrl: string;
  readFileBase64: (filePath: string) => Promise<string>;
};

/**
 * Send both the image bytes and the user-supplied caption to the vision LLM.
 * Selected by the orchestrator when a URL source has both an image and a
 * non-empty caption after worker /fetch-post completes.
 */
export function createCaptionPlusVision(opts: CaptionPlusVisionOptions): ExtractionStrategy {
  return {
    name: 'captionPlusVision',
    async extract(input: StrategyInput): Promise<ExtractionResult> {
      if (input.kind !== 'image') {
        throw new Error(`captionPlusVision: unsupported input kind ${input.kind}`);
      }
      const imageBase64 = await opts.readFileBase64(input.filePath);
      return extractFromProxyVision(imageBase64, input.caption, opts.proxyUrl);
    },
  };
}
