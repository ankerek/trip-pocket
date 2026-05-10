import { render } from '@testing-library/react-native';
import { ProcessingBanner } from '../ProcessingBanner';

describe('ProcessingBanner', () => {
  it('renders null at count=0', () => {
    const { queryByTestId } = render(<ProcessingBanner count={0} />);
    expect(queryByTestId('processing-banner')).toBeNull();
  });

  it('renders the singular form at count=1', () => {
    const { getByText } = render(<ProcessingBanner count={1} />);
    expect(getByText('Processing 1 screenshot…')).toBeTruthy();
  });

  it('renders the plural form at count>1', () => {
    const { getByText } = render(<ProcessingBanner count={3} />);
    expect(getByText('Processing 3 screenshots…')).toBeTruthy();
  });
});
