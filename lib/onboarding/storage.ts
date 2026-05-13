import { File, Paths } from 'expo-file-system';

// First-launch detection. Mirrors the file-flag pattern from
// modules/capture/owner.ts — small, sync, and survives app updates because
// Paths.document is the app's persistent sandbox.
const FLAG_FILE = 'onboarding-complete.txt';
const ANSWERS_FILE = 'onboarding-answers.json';

export function isOnboardingComplete(): boolean {
  return new File(Paths.document, FLAG_FILE).exists;
}

export function markOnboardingComplete(): void {
  const file = new File(Paths.document, FLAG_FILE);
  if (!file.exists) file.create();
  file.write(new Date().toISOString());
}

export function resetOnboarding(): void {
  const flag = new File(Paths.document, FLAG_FILE);
  if (flag.exists) flag.delete();
  const answers = new File(Paths.document, ANSWERS_FILE);
  if (answers.exists) answers.delete();
}

export function readOnboardingAnswers(): string | null {
  const file = new File(Paths.document, ANSWERS_FILE);
  if (!file.exists) return null;
  return file.textSync();
}

export function writeOnboardingAnswers(json: string): void {
  const file = new File(Paths.document, ANSWERS_FILE);
  if (!file.exists) file.create();
  file.write(json);
}
