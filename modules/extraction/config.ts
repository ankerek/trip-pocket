import Constants from 'expo-constants';
import type { ForceStrategy } from './strategies/select';

// Default for safety: if forceStrategy is missing or unrecognized, fall back
// to the legacy OCR-text-LLM path. Matches PR 3 ship behavior; PR 4 changes
// the default in app.config.ts.extra.forceStrategy to 'auto'.
const DEFAULT_FORCE: ForceStrategy = 'ocrTextLLM';

/**
 * Read the global forceStrategy from `app.config.ts.extra.forceStrategy`.
 *
 * Single point of consultation for import-time strategy stamping
 * (importImage, importUrl/applyUrlFetchResult). Tests that need a specific
 * value can mock `expo-constants`.
 */
export function getForceStrategy(): ForceStrategy {
  const raw = Constants.expoConfig?.extra?.forceStrategy;
  if (raw === 'auto' || raw === 'ocrTextLLM' || raw === 'vision' || raw === 'video') return raw;
  return DEFAULT_FORCE;
}
