import type { ExtractionResult } from '../extraction';

// NOTE for future maintainers: video extraction (Instagram Reels, TikTok
// videos) is a separate spec. When it lands, extend this union with a
// `video` variant and add a new strategy module. Do not pre-bake the
// `video` type — see
// `docs/superpowers/specs/2026-05-16-extraction-pipeline-composability-design.md`
// §Scope (and the rev-2 YAGNI decision following Codex review).

export type StrategyInput =
  | { kind: 'image'; filePath: string; ocrText?: string; caption?: string }
  | { kind: 'text'; text: string };

export type StrategyName = 'ocrTextLLM' | 'vision' | 'captionPlusVision';

export interface ExtractionStrategy {
  name: StrategyName;
  extract(input: StrategyInput): Promise<ExtractionResult>;
}
