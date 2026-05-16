import type { ExtractionStrategyName } from '@/modules/storage/sources';

/**
 * Three valid forceStrategy values, mirroring app.config.ts.extra.forceStrategy.
 * `captionPlusVision` is intentionally NOT forceable — it's an `auto` choice
 * triggered by a caption being present.
 */
export type ForceStrategy = 'auto' | 'ocrTextLLM' | 'vision';

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
 *   force=ocrTextLLM               → ocrTextLLM
 */
export function strategyForImageImport(
  force: ForceStrategy,
  hasCaption = false,
): ExtractionStrategyName {
  if (force === 'ocrTextLLM') return 'ocrTextLLM';
  if (force === 'vision') return 'vision';
  return hasCaption ? 'captionPlusVision' : 'vision';
}

/**
 * Strategy stamped on a URL source AFTER the worker /fetch-post call returns.
 * At import time the strategy stays NULL — the extraction sweep gates on
 * file_path so a NULL-strategy URL row sits idle until fetch completes anyway.
 *
 *   hasFile  hasCaption  force=auto         force=vision  force=ocrTextLLM
 *   -------  ----------  -----------------  ------------  ----------------
 *   true     true        captionPlusVision  vision        ocrTextLLM
 *   true     false       vision             vision        ocrTextLLM
 *   false    *           ocrTextLLM         ocrTextLLM    ocrTextLLM
 *
 * The `!hasFile` row covers the soft-degrade path where the worker returned a
 * caption-only result (Apify disabled / IG carousel cover missing): falling
 * back to ocrTextLLM means the caption text still feeds the LLM via the
 * text-mode runner. Vision can't help when there's no image.
 */
export function strategyForUrlAfterFetch(
  force: ForceStrategy,
  hasFile: boolean,
  hasCaption: boolean,
): ExtractionStrategyName {
  if (force === 'ocrTextLLM') return 'ocrTextLLM';
  if (!hasFile) return 'ocrTextLLM';
  if (force === 'vision') return 'vision';
  return hasCaption ? 'captionPlusVision' : 'vision';
}
