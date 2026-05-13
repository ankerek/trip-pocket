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

export type Category = 'food' | 'culture' | 'nature' | 'stays' | 'shopping' | 'nightlife';

export type DemoPlacePick = {
  id: string;
  name: string;
  city: string;
  category: 'place' | 'food' | 'activity';
  imageUrl: string;
};

export type OnboardingAnswers = {
  destination: Destination | null;
  painPoints: string[];
  agreedPains: string[];
  categories: Category[];
  photosPrimed: boolean;
  starterPlaces: DemoPlacePick[];
};

const EMPTY_ANSWERS: OnboardingAnswers = {
  destination: null,
  painPoints: [],
  agreedPains: [],
  categories: [],
  photosPrimed: false,
  starterPlaces: [],
};

type Ctx = {
  answers: OnboardingAnswers;
  set: <K extends keyof OnboardingAnswers>(key: K, value: OnboardingAnswers[K]) => void;
  reset: () => void;
};

const OnboardingContext = createContext<Ctx | null>(null);

function loadInitial(): OnboardingAnswers {
  try {
    const raw = readOnboardingAnswers();
    if (!raw) return EMPTY_ANSWERS;
    const parsed = JSON.parse(raw) as Partial<OnboardingAnswers>;
    return { ...EMPTY_ANSWERS, ...parsed };
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
