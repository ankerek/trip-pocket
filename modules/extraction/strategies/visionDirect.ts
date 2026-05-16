import { extractFromProxyVision } from '../proxy';
import type { ExtractionResult } from '../extraction';
import type { ExtractionStrategy, StrategyInput } from './types';

export type VisionDirectOptions = {
  proxyUrl: string;
  readFileBase64: (filePath: string) => Promise<string>;
};

/**
 * Send the image bytes directly to the vision LLM. Caption (if any) is
 * intentionally ignored — this strategy is the clean "image-only" A/B
 * counterpart to `captionPlusVision`.
 */
export function createVisionLLMDirect(opts: VisionDirectOptions): ExtractionStrategy {
  return {
    name: 'vision',
    async extract(input: StrategyInput): Promise<ExtractionResult> {
      if (input.kind !== 'image') {
        throw new Error(`visionLLMDirect: unsupported input kind ${input.kind}`);
      }
      const imageBase64 = await opts.readFileBase64(input.filePath);
      return extractFromProxyVision(imageBase64, undefined, opts.proxyUrl);
    },
  };
}
