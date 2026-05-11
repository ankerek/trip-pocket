import type { ReactNode } from 'react';

export const init = jest.fn();
export const addBreadcrumb = jest.fn();
export const captureException = jest.fn();
export const captureMessage = jest.fn();
export const setUser = jest.fn();
export const setTag = jest.fn();
export const setTags = jest.fn();
export const setContext = jest.fn();
export const setExtra = jest.fn();
export const nativeCrash = jest.fn();

// Render-prop / component-reference compatible no-op ErrorBoundary.
export function ErrorBoundary({ children }: { children?: ReactNode }) {
  return children ?? null;
}

export function withErrorBoundary<P extends Record<string, unknown>>(
  Component: (props: P) => unknown,
): (props: P) => unknown {
  return Component;
}
