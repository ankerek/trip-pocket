import { act, fireEvent, render } from '@testing-library/react-native';
import { ErrorToast } from '../ErrorToast';
import { showToast, dismissToast, _resetForTests } from '@/lib/toast/toast';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

beforeEach(() => {
  _resetForTests();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ErrorToast', () => {
  test('renders nothing when no toast is active', () => {
    const { queryByTestId } = render(<ErrorToast />);
    expect(queryByTestId('error-toast')).toBeNull();
  });

  test('renders the message after showToast', () => {
    const { queryByTestId, getByText } = render(<ErrorToast />);
    act(() => {
      showToast({ kind: 'error', message: 'Something failed' });
    });
    expect(queryByTestId('error-toast')).not.toBeNull();
    expect(getByText('Something failed')).toBeTruthy();
  });

  test('renders an action label when provided', () => {
    const { getByText } = render(<ErrorToast />);
    act(() => {
      showToast({
        kind: 'error',
        message: 'Permission off',
        action: { label: 'Open Settings', onPress: jest.fn() },
      });
    });
    expect(getByText('Open Settings')).toBeTruthy();
  });

  test('tapping the action runs handler then dismisses', () => {
    const onPress = jest.fn();
    const { getByText, queryByTestId } = render(<ErrorToast />);
    act(() => {
      showToast({
        kind: 'error',
        message: 'Permission off',
        action: { label: 'Open Settings', onPress },
      });
    });
    act(() => {
      fireEvent.press(getByText('Open Settings'));
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => {
      jest.runAllTimers();
    });
    expect(queryByTestId('error-toast')).toBeNull();
  });

  test('auto-dismisses after durationMs', () => {
    const { queryByTestId } = render(<ErrorToast />);
    act(() => {
      showToast({ kind: 'error', message: 'hi', durationMs: 1000 });
    });
    expect(queryByTestId('error-toast')).not.toBeNull();
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(queryByTestId('error-toast')).toBeNull();
  });

  test('dismissToast clears the toast', () => {
    const { queryByTestId } = render(<ErrorToast />);
    act(() => {
      showToast({ kind: 'error', message: 'hi' });
    });
    expect(queryByTestId('error-toast')).not.toBeNull();
    act(() => {
      dismissToast();
      jest.runAllTimers();
    });
    expect(queryByTestId('error-toast')).toBeNull();
  });
});
