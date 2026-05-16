import type { ExtractionResult } from '../extraction';

// The `video` variant is the follow-up explicitly forecast in the rev-2
// composability spec — see `docs/superpowers/specs/
// 2026-05-16-video-place-extraction-design.md`. `coverFilePath` is required
// so the strategy's fallback to captionPlusVision is always well-typed; if
// a row has no downloadable cover, `strategyForUrlAfterFetch` refuses
// `videoPlusCaption` and soft-degrades to `ocrTextLLM` instead.
export type StrategyInput =
  | { kind: 'image'; filePath: string; ocrText?: string; caption?: string }
  | { kind: 'text'; text: string }
  | {
      kind: 'video';
      videoUrl: string;
      coverFilePath: string;
      caption?: string;
      durationSec?: number;
    };

export type StrategyName = 'ocrTextLLM' | 'vision' | 'captionPlusVision' | 'videoPlusCaption';

export interface ExtractionStrategy {
  name: StrategyName;
  extract(input: StrategyInput): Promise<ExtractionResult>;
}
