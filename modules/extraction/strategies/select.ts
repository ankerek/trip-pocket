import type { ExtractionStrategyName } from '@/modules/storage/sources';

/**
 * Four valid forceStrategy values, mirroring app.config.ts.extra.forceStrategy.
 * `captionPlusVision` and `videoPlusCaption` are intentionally NOT forceable —
 * they're `auto`-only choices triggered by the presence of a caption / video
 * URL. The forceable values name *preferences*; absent prerequisites send a
 * row down the safe path (see soft-degrade table below).
 */
export type ForceStrategy = 'auto' | 'ocrTextLLM' | 'vision' | 'video';

/**
 * Strategy stamped on an image source at the moment of import.
 *
 * `hasCaption` is true when the picker derived a "Photo taken in X" hint
 * from EXIF GPS — present only for camera photos, never for screenshots.
 * When set, the strategy upgrades to `captionPlusVision` so Gemini gets the
 * location hint alongside the image.
 *
 *   force=auto + hasCaption        → captionPlusVision
 *   force=auto + !hasCaption       → vision
 *   force=vision                   → vision (ignores caption — force flag
 *                                    is the developer override)
 *   force=video                    → vision (no video bytes on an image
 *                                    import; soft-degrade)
 *   force=ocrTextLLM               → ocrTextLLM
 */
export function strategyForImageImport(
  force: ForceStrategy,
  hasCaption = false,
): ExtractionStrategyName {
  if (force === 'ocrTextLLM') return 'ocrTextLLM';
  if (force === 'vision') return 'vision';
  if (force === 'video') return 'vision';
  return hasCaption ? 'captionPlusVision' : 'vision';
}

/**
 * Strategy stamped on a URL source AFTER the worker /fetch-post call returns.
 * At import time the strategy stays NULL — the extraction sweep gates on
 * file_path so a NULL-strategy URL row sits idle until fetch completes anyway.
 *
 *   hasVideo  hasFile  hasCap  force=auto         force=video        force=vision  force=ocrTextLLM
 *   true      true     *       videoPlusCaption   videoPlusCaption   vision        ocrTextLLM
 *   true      false    *       ocrTextLLM         ocrTextLLM         ocrTextLLM    ocrTextLLM
 *   false     true     true    captionPlusVision  ocrTextLLM         vision        ocrTextLLM
 *   false     true     false   vision             ocrTextLLM         vision        ocrTextLLM
 *   false     false    *       ocrTextLLM         ocrTextLLM         ocrTextLLM    ocrTextLLM
 *
 * Soft-degrade rules:
 * - `videoPlusCaption` requires a cover file (the strategy's internal fallback
 *   to `captionPlusVision` needs it). A video without a downloadable cover
 *   falls all the way back to `ocrTextLLM` on the caption text.
 * - `force=video` on a row without a video, and `force=vision` on a row
 *   without a file, both follow the same convention: forced value names the
 *   *preferred* strategy; missing prerequisites send the row down the safe
 *   path.
 *
 * The `hasVideo=true, hasFile=false` row is rare in practice — IG/TikTok
 * always include a cover frame today — but the soft-degrade keeps the type
 * system honest: `videoPlusCaption` requires `coverFilePath`, so the picker
 * cannot pick it without a file.
 */
export function strategyForUrlAfterFetch(
  force: ForceStrategy,
  hasFile: boolean,
  hasCaption: boolean,
  hasVideo = false,
): ExtractionStrategyName {
  if (force === 'ocrTextLLM') return 'ocrTextLLM';
  if (!hasFile) return 'ocrTextLLM';
  if (hasVideo) {
    if (force === 'auto' || force === 'video') return 'videoPlusCaption';
    // force=vision wins over hasVideo: developer override.
    return 'vision';
  }
  // hasFile === true && hasVideo === false
  if (force === 'video') return 'ocrTextLLM';
  if (force === 'vision') return 'vision';
  return hasCaption ? 'captionPlusVision' : 'vision';
}
