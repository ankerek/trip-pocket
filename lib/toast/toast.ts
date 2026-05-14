// Imperative toast emitter. Modules can fire toasts from non-React code
// without context plumbing — the root-mounted <ErrorToast /> subscribes
// via the `useToastSubscription` hook.
//
// Single-slot: a new toast replaces the current one immediately. No queue.

export type ToastKind = 'error' | 'success';

export type ToastAction = {
  label: string;
  onPress: () => void;
};

export type ToastInput = {
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  durationMs?: number;
};

export type Toast = ToastInput & {
  id: number;
  durationMs: number;
};

type Listener = (current: Toast | null) => void;

const DEFAULT_DURATION_MS = 5000;
const DEFAULT_DURATION_MS_WITH_ACTION = 8000;

let current: Toast | null = null;
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener(current);
}

export function showToast(input: ToastInput): void {
  const durationMs =
    input.durationMs ?? (input.action ? DEFAULT_DURATION_MS_WITH_ACTION : DEFAULT_DURATION_MS);
  current = { ...input, id: nextId++, durationMs };
  emit();
}

export function dismissToast(): void {
  if (current === null) return;
  current = null;
  emit();
}

// --- Internal API consumed by useToastSubscription / tests ---

export function _subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function _getCurrent(): Toast | null {
  return current;
}

export function _resetForTests(): void {
  current = null;
  nextId = 1;
  listeners.clear();
}
