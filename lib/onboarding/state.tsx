import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { readOnboardingAnswers, writeOnboardingAnswers } from './storage';

export type Destination =
  | 'japan'
  | 'sea'
  | 'europe'
  | 'us-roadtrip'
  | 'city-break'
  | 'bucket-list'
  | 'general';

// v2 (2026-05-13) — slimmed to a single field. The prior shape carried
// `painPoints`, `agreedPains`, `categories`, `photosPrimed`, and
// `starterPlaces`; none of those fields had any downstream consumer in
// the redesigned flow, so they're gone. `painPoints` is now ephemeral
// state inside `app/onboarding/pain-points.tsx` only.
//
// Spec: docs/superpowers/specs/2026-05-13-onboarding-redesign-design.md
export type OnboardingAnswers = {
  destination: Destination | null;
};

const EMPTY_ANSWERS: OnboardingAnswers = {
  destination: null,
};

type Ctx = {
  answers: OnboardingAnswers;
  set: <K extends keyof OnboardingAnswers>(key: K, value: OnboardingAnswers[K]) => void;
  reset: () => void;
};

const OnboardingContext = createContext<Ctx | null>(null);

function loadInitial(): OnboardingAnswers {
  // Explicit key extraction so old v1 payloads (with `categories`,
  // `painPoints`, etc.) don't leak unknown fields into the v2 runtime
  // object. Spread (`{ ...EMPTY_ANSWERS, ...parsed }`) would carry them
  // through even though the TypeScript type doesn't include them.
  try {
    const raw = readOnboardingAnswers();
    if (!raw) return EMPTY_ANSWERS;
    const parsed = JSON.parse(raw) as Partial<OnboardingAnswers>;
    return {
      destination: parsed.destination ?? null,
    };
  } catch {
    return EMPTY_ANSWERS;
  }
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [answers, setAnswers] = useState<OnboardingAnswers>(loadInitial);

  const set = useCallback(
    <K extends keyof OnboardingAnswers>(key: K, value: OnboardingAnswers[K]) => {
      setAnswers((prev) => {
        const next = { ...prev, [key]: value };
        try {
          writeOnboardingAnswers(JSON.stringify(next));
        } catch {
          // Persistence is a nice-to-have; in-memory state is the source
          // of truth during the flow.
        }
        return next;
      });
    },
    [],
  );

  const reset = useCallback(() => {
    setAnswers(EMPTY_ANSWERS);
    try {
      writeOnboardingAnswers(JSON.stringify(EMPTY_ANSWERS));
    } catch {
      // Same — best-effort.
    }
  }, []);

  const value = useMemo<Ctx>(() => ({ answers, set, reset }), [answers, set, reset]);
  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding(): Ctx {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error('useOnboarding must be used inside <OnboardingProvider>');
  return ctx;
}

export const DESTINATION_LABEL: Record<Destination, string> = {
  japan: 'Japan',
  sea: 'Southeast Asia',
  europe: 'Europe',
  'us-roadtrip': 'US road trip',
  'city-break': 'city break',
  'bucket-list': 'bucket list',
  general: 'next trip',
};
