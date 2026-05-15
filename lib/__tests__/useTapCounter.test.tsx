import { act, renderHook } from '@testing-library/react-native';
import { useTapCounter } from '@/lib/useTapCounter';

describe('useTapCounter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-15T00:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  test('fires once threshold taps land inside the window', () => {
    const onTrigger = jest.fn();
    const { result } = renderHook(() => useTapCounter(7, 3000, onTrigger));
    act(() => {
      for (let i = 0; i < 7; i += 1) result.current();
    });
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  test('a gap longer than the window resets the counter', () => {
    const onTrigger = jest.fn();
    const { result } = renderHook(() => useTapCounter(7, 3000, onTrigger));
    act(() => {
      for (let i = 0; i < 6; i += 1) result.current();
    });
    act(() => {
      jest.advanceTimersByTime(4000);
      result.current();
    });
    expect(onTrigger).not.toHaveBeenCalled();
  });

  test('after firing, the counter resets so the next trigger needs another full streak', () => {
    const onTrigger = jest.fn();
    const { result } = renderHook(() => useTapCounter(3, 3000, onTrigger));
    act(() => {
      result.current();
      result.current();
      result.current();
    });
    expect(onTrigger).toHaveBeenCalledTimes(1);
    act(() => {
      result.current();
      result.current();
    });
    expect(onTrigger).toHaveBeenCalledTimes(1);
    act(() => {
      result.current();
    });
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });
});
