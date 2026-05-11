import { showToast, dismissToast, _subscribe, _getCurrent, _resetForTests } from '../toast';

beforeEach(() => {
  _resetForTests();
});

describe('toast emitter', () => {
  test('showToast notifies subscribers with the new toast', () => {
    const seen: Array<ReturnType<typeof _getCurrent>> = [];
    const unsubscribe = _subscribe((t) => seen.push(t));

    showToast({ kind: 'error', message: 'boom' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'error', message: 'boom' });

    unsubscribe();
  });

  test('new showToast replaces current (single-slot)', () => {
    const seen: Array<ReturnType<typeof _getCurrent>> = [];
    _subscribe((t) => seen.push(t));

    showToast({ kind: 'error', message: 'first' });
    showToast({ kind: 'error', message: 'second' });

    expect(seen).toHaveLength(2);
    expect(seen[1]?.message).toBe('second');
    expect(_getCurrent()?.message).toBe('second');
  });

  test('dismissToast clears and notifies null', () => {
    const seen: Array<ReturnType<typeof _getCurrent>> = [];
    _subscribe((t) => seen.push(t));

    showToast({ kind: 'success', message: 'hello' });
    dismissToast();

    expect(seen[seen.length - 1]).toBeNull();
    expect(_getCurrent()).toBeNull();
  });

  test('default durationMs is 5000 (no action) / 8000 (with action)', () => {
    showToast({ kind: 'error', message: 'no action' });
    expect(_getCurrent()?.durationMs).toBe(5000);

    showToast({
      kind: 'error',
      message: 'with action',
      action: { label: 'Retry', onPress: () => {} },
    });
    expect(_getCurrent()?.durationMs).toBe(8000);
  });

  test('explicit durationMs overrides defaults', () => {
    showToast({ kind: 'error', message: 'custom', durationMs: 1234 });
    expect(_getCurrent()?.durationMs).toBe(1234);
  });

  test('unsubscribe stops receiving updates', () => {
    const seen: Array<ReturnType<typeof _getCurrent>> = [];
    const unsubscribe = _subscribe((t) => seen.push(t));

    showToast({ kind: 'error', message: 'first' });
    unsubscribe();
    showToast({ kind: 'error', message: 'second' });

    expect(seen).toHaveLength(1);
  });

  test('each toast has a stable id; ids are unique across showToast calls', () => {
    showToast({ kind: 'error', message: 'a' });
    const first = _getCurrent();
    showToast({ kind: 'error', message: 'b' });
    const second = _getCurrent();

    expect(first?.id).toBeDefined();
    expect(second?.id).toBeDefined();
    expect(first?.id).not.toBe(second?.id);
  });
});
