import { extractFromProxyVideo, VideoExtractionError } from '../proxy';
import type { ExtractionResult } from '../extraction';
import type { ExtractionStrategy, StrategyInput } from './types';

export type VideoPlusCaptionOptions = {
  proxyUrl: string;
  /**
   * Fallback for video-related failures. Wired by the orchestrator to the
   * existing `captionPlusVision` strategy, which uses the cover image + the
   * upstream caption — what we had before this spec.
   */
  fallback: ExtractionStrategy;
};

/**
 * Video extraction strategy. Sends the video URL (not the bytes) to the
 * worker; the worker fetches the CDN, decides between inline and Files API,
 * and runs Gemini Flash-Lite over the video + caption.
 *
 * Falls back internally to `captionPlusVision` only on infrastructure-level
 * failures (CDN fetch errors, Files API failures, duration / size bailouts).
 * A successful Gemini call that returns zero places is NOT a fallback case —
 * it's a valid "no place in this video" result.
 *
 * Spec: docs/superpowers/specs/2026-05-16-video-place-extraction-design.md
 */
export function createVideoPlusCaption(opts: VideoPlusCaptionOptions): ExtractionStrategy {
  return {
    name: 'videoPlusCaption',
    async extract(input: StrategyInput): Promise<ExtractionResult> {
      if (input.kind !== 'video') {
        throw new Error(`videoPlusCaption: unsupported input kind ${input.kind}`);
      }
      try {
        return await extractFromProxyVideo(input.videoUrl, input.caption, opts.proxyUrl, {
          durationSec: input.durationSec,
        });
      } catch (err) {
        if (!(err instanceof VideoExtractionError)) throw err;
        // Infrastructure-level video failure — fall back to caption+cover.
        // coverFilePath is required by the 'video' StrategyInput variant, so
        // captionPlusVision's `kind: 'image'` input is always well-typed.
        const fallbackResult = await opts.fallback.extract({
          kind: 'image',
          filePath: input.coverFilePath,
          caption: input.caption,
        });
        return {
          ...fallbackResult,
          telemetry: { ...fallbackResult.telemetry, fallbackUsed: true },
        };
      }
    },
  };
}
