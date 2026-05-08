# Trip Pocket — Design System Master

> **LOGIC:** When building a specific page, first check `design-system/trip-pocket/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file. Otherwise, strictly follow the rules below.
> Source spec: `docs/superpowers/specs/2026-05-08-app-redesign-design.md`.

**Project:** Trip Pocket  ·  **Stack:** Expo SDK 55, React Native 0.83, NativeWind v5, expo-router, Reanimated 4  ·  **Platform:** iOS-first

## Direction (locked)

| Axis        | Decision                                     |
| ----------- | -------------------------------------------- |
| Personality | iOS Native Premium                           |
| Motion      | Expressive — shared-element morph + spring   |
| IA          | Two tabs (Pocket, Trips) + center capture FAB |
| Triage UX   | Hero photo + bottom sheet                    |
| Color modes | Light + dark, both first-class               |

## Color tokens

| Role             | Light                           | Dark                                | NativeWind class           |
| ---------------- | ------------------------------- | ----------------------------------- | -------------------------- |
| `bg`             | `#ffffff`                       | `#020617`                           | `bg-bg`                    |
| `surface`        | `#f8fafc` (Snow)                | `#0f172a`                           | `bg-surface`               |
| `text`           | `#0c4a6e` (Sea)                 | `#e2e8f0`                           | `text-text`                |
| `text-muted`     | `#64748b`                       | `#94a3b8`                           | `text-text-muted`          |
| `accent`         | `#14b8a6` (Teal)                | `#2dd4bf`                           | `bg-accent` / `text-accent` |
| `info-bg`        | `#ccfbf1` (Mint)                | `#134e4a`                           | `bg-info-bg`               |
| `info-text`      | `#115e59`                       | `#5eead4`                           | `text-info-text`           |
| `hairline`       | `rgba(15,23,42,0.06)`           | `rgba(255,255,255,0.08)`            | `border-hairline`          |
| `overlay-strong` | `rgba(0,0,0,0.45)`              | `rgba(0,0,0,0.55)`                  | photo-name gradient bottom |

## Typography

System fonts only — no Google Fonts. iOS provides SF Pro Display ≥17pt and SF Pro Text below that automatically.

| Token        | Size | Weight | Letter-spacing | Use                    |
| ------------ | ---- | ------ | -------------- | ---------------------- |
| `display-xl` | 34   | 700    | -0.5           | Tab home large titles  |
| `display-lg` | 28   | 700    | -0.4           | Place name             |
| `title`      | 22   | 700    | -0.3           | Triage AI-extracted    |
| `headline`   | 17   | 600    | -0.2           | Section heads          |
| `body`       | 15   | 400    | 0              | Default text           |
| `caption`    | 12   | 500    | 0              | Meta, dates            |
| `micro`      | 10   | 600    | 0.4            | Chips, kickers         |

Use `tabular-nums` font-variant for counts and durations.

## Spacing & rhythm

- Page horizontal padding: **14pt**
- Grid gutter: **6pt**
- Tile aspect ratio: **3 / 4**
- Tile corner radius: **12pt**
- Sheet top radius: **20pt**
- Section vertical rhythm: **16pt**

## Materials & elevation

- Tab bar, headers, sheets: native `BlurView` with `systemMaterial` (matches the existing `SHARED_HEADER_OPTIONS` in `app/_layout.tsx`).
- Cards/tiles are flat (no shadow) by default. Elevated card: `0 6px 16px rgba(15,23,42,0.10)`.
- Hairline borders: 1px at 6% opacity.

## Motion presets

```ts
spring: { damping: 18, stiffness: 240, mass: 1 }   // shared-element default
springOvershoot: { damping: 14, stiffness: 220 }   // triage card-in
ease.in: cubic-bezier(0.42, 0, 1, 1)               // exiting elements
ease.out: cubic-bezier(0, 0, 0.58, 1)              // entering elements (default)
ease.standard: cubic-bezier(0.32, 0.72, 0, 1)      // sheet rise / dismiss
duration.micro: 180                                 // taps, chip toggles
duration.short: 280                                 // sheet, modal
duration.medium: 380                                // shared-element morph
```

Reduce-motion fallback: replace springs with `ease.out` linear interpolation, drop parallax, drop stagger.

## Iconography

- Use Apple SF Symbols via `expo-symbols` (existing `Icon.tsx` component pattern).
- 22pt default size, 26pt for primary nav.
- Tint with `text` token by default; `accent` for active state.
- **No emoji as icons.**

## Lists & images

- Long lists must use `FlatList` with stable `keyExtractor` (id, never index) and tuned `windowSize` (5 for grid, 10 for trip list).
- Images use `expo-image` with explicit `width`/`height` props and `cachePolicy="memory-disk"`. Always specify `contentFit`.
- Reserve aspect ratio at parent (3/4 for tile, 1/1 for thumbs) to prevent layout shift while photos load.

## Accessibility floor

- Touch targets ≥ **44 × 44pt**.
- Photo-overlay text contrast verified against worst-case luminance (use 0–45% black gradient stop).
- All interactive elements have `accessibilityLabel` + `accessibilityRole`.
- Dynamic Type honored — type tokens scale with system size; grid collapses to 1 column at XL+.
- `useReducedMotion()` from Reanimated drives the motion fallback path.
- No color-only state — active pills also have weight/contrast change, errors include an icon.

## Anti-patterns (do not use)

- Inter font (system fonts only on iOS).
- Web-style box shadows on tiles (use materials/blur instead).
- `ScrollView` + `map()` for >10 items (use `FlatList`).
- Gold CTA / Liquid Glass / Skeuomorphic textures (off-brand).
- Linear easing for UI transitions.
- Animations on more than 2 simultaneous elements.
