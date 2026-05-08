// Trip Pocket — JS-side mirror of the design tokens.
// CSS source of truth lives in global.css under the @theme block; this
// file exists for code that can't read CSS variables (Reanimated worklets,
// gesture-handler config, native module props). Keep both in sync.
// See docs/superpowers/specs/2026-05-08-app-redesign-design.md §6.

export const palette = {
  light: {
    bg: '#ffffff',
    surface: '#f8fafc',
    text: '#0c4a6e',
    textMuted: '#64748b',
    accent: '#14b8a6',
    accentStrong: '#0f9c8b',
    infoBg: '#ccfbf1',
    infoText: '#115e59',
    hairline: 'rgba(15, 23, 42, 0.06)',
    overlayStrong: 'rgba(0, 0, 0, 0.55)',
  },
  dark: {
    bg: '#020617',
    surface: '#0f172a',
    text: '#e2e8f0',
    textMuted: '#94a3b8',
    accent: '#2dd4bf',
    accentStrong: '#14b8a6',
    infoBg: '#134e4a',
    infoText: '#5eead4',
    hairline: 'rgba(255, 255, 255, 0.08)',
    overlayStrong: 'rgba(0, 0, 0, 0.55)',
  },
} as const;

export const radii = {
  tile: 12,
  sheet: 20,
  pill: 9999,
} as const;

export const spacing = {
  pagePadding: 14,
  gridGutter: 6,
  rhythm: 16,
} as const;

export const tile = {
  aspectRatio: 3 / 4,
} as const;

// Spring presets — Reanimated 4 withSpring config.
// `springOvershoot` is the triage card-in / sheet-rise feel.
export const springs = {
  default: { damping: 18, stiffness: 240, mass: 1 },
  overshoot: { damping: 14, stiffness: 220, mass: 1 },
} as const;

// Easing curves for the reduced-motion fallback path and exits.
// Keep in sync with the table in spec §6.2 / MASTER motion section.
export const easings = {
  in: [0.42, 0, 1, 1] as const, // exiting elements
  out: [0, 0, 0.58, 1] as const, // entering elements (default)
  standard: [0.32, 0.72, 0, 1] as const, // sheet rise / dismiss
} as const;

export const durations = {
  micro: 180,
  short: 280,
  medium: 380,
} as const;

// Photo-overlay gradient stops — single recipe (spec §9.2).
// Used by PlaceTile and any other component that puts text on a photo.
export const photoOverlay = {
  gradient: [
    { offset: 0, color: 'rgba(0,0,0,0)' },
    { offset: 0.55, color: 'rgba(0,0,0,0)' },
    { offset: 1, color: 'rgba(0,0,0,0.55)' },
  ],
  textShadow: { color: 'rgba(0,0,0,0.45)', offset: { width: 0, height: 1 }, radius: 2 },
} as const;
