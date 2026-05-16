import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SubscriptionSection } from '@/components/settings/SubscriptionSection';

// Names must start with `mock*` to be referenceable inside the jest.mock
// factory — Babel-jest rejects out-of-scope variables otherwise.
const mockRestore = jest.fn();
const mockPush = jest.fn();

type MockEntitlement = {
  productIdentifier: string;
  willRenew: boolean;
  periodType: 'NORMAL' | 'INTRO' | 'TRIAL' | 'PREPAID';
  expirationDate: string | null;
} | null;

const mockState: {
  status: 'loading' | 'active' | 'inactive';
  entitlement: MockEntitlement;
  hasOfferings: boolean;
} = {
  status: 'active',
  entitlement: null,
  hasOfferings: false,
};

function mockBuildCustomerInfo() {
  if (!mockState.entitlement) return null;
  return {
    entitlements: { active: { pro: mockState.entitlement } },
  };
}

function mockBuildOfferings() {
  if (!mockState.hasOfferings) return null;
  return {
    current: {
      availablePackages: [
        {
          product: { identifier: 'trip_pocket_pro_yearly', priceString: '$39.99' },
        },
        {
          product: { identifier: 'trip_pocket_pro_weekly', priceString: '$3.99' },
        },
      ],
    },
  };
}

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('@/lib/entitlement/provider', () => ({
  useEntitlement: () => ({
    status: mockState.status,
    customerInfo: mockBuildCustomerInfo(),
    offerings: mockBuildOfferings(),
    refresh: jest.fn(),
    purchasePlan: jest.fn(),
    restore: mockRestore,
    registerResumeHandler: jest.fn(() => () => undefined),
    registerOnResumed: jest.fn(() => () => undefined),
  }),
}));

beforeEach(() => {
  mockRestore.mockReset();
  mockPush.mockReset();
  mockState.status = 'active';
  mockState.entitlement = null;
  mockState.hasOfferings = false;
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('SubscriptionSection — restore flow', () => {
  test('successful restore with an active entitlement surfaces a confirmation', async () => {
    mockRestore.mockResolvedValue({ ok: true, entitled: true });
    const { getByLabelText } = render(<SubscriptionSection />);
    await act(async () => {
      fireEvent.press(getByLabelText('Restore purchases'));
    });
    expect(Alert.alert).toHaveBeenCalledWith('Restored', 'Your subscription is active.');
  });

  test('successful restore with no entitlement explains there was nothing to restore', async () => {
    mockRestore.mockResolvedValue({ ok: true, entitled: false });
    const { getByLabelText } = render(<SubscriptionSection />);
    await act(async () => {
      fireEvent.press(getByLabelText('Restore purchases'));
    });
    expect(Alert.alert).toHaveBeenCalledWith(
      'Nothing to restore',
      'No active subscription was found on this Apple ID.',
    );
  });

  test('failed restore prompts the user to try again', async () => {
    mockRestore.mockResolvedValue({ ok: false });
    const { getByLabelText } = render(<SubscriptionSection />);
    await act(async () => {
      fireEvent.press(getByLabelText('Restore purchases'));
    });
    expect(Alert.alert).toHaveBeenCalledWith(
      'Couldn’t restore',
      'Please check your connection and try again.',
    );
  });
});

describe('SubscriptionSection — inactive (free) state', () => {
  beforeEach(() => {
    mockState.status = 'inactive';
    mockState.hasOfferings = true;
  });

  test('shows both plan cards as paywall CTAs', () => {
    const { queryByLabelText } = render(<SubscriptionSection />);
    expect(queryByLabelText('Subscribe yearly')).not.toBeNull();
    expect(queryByLabelText('Subscribe weekly')).not.toBeNull();
  });

  test('tapping a plan card opens the paywall', () => {
    const { getByLabelText } = render(<SubscriptionSection />);
    fireEvent.press(getByLabelText('Subscribe yearly'));
    expect(mockPush).toHaveBeenCalledWith('/paywall-lapse');
  });

  test('hides the manage-subscription affordance', () => {
    const { queryByLabelText } = render(<SubscriptionSection />);
    expect(queryByLabelText('Cancel or change plan')).toBeNull();
    expect(queryByLabelText('Manage subscription')).toBeNull();
  });
});

describe('SubscriptionSection — active + auto-renew', () => {
  beforeEach(() => {
    mockState.status = 'active';
    mockState.hasOfferings = true;
    mockState.entitlement = {
      productIdentifier: 'trip_pocket_pro_yearly',
      willRenew: true,
      periodType: 'NORMAL',
      expirationDate: '2027-05-14T00:00:00Z',
    };
  });

  test('shows the crossgrade card for the other plan', () => {
    const { queryByLabelText } = render(<SubscriptionSection />);
    expect(queryByLabelText('Switch to weekly')).not.toBeNull();
  });

  test('shows the cancel-or-change row', () => {
    const { queryByLabelText } = render(<SubscriptionSection />);
    expect(queryByLabelText('Cancel or change plan')).not.toBeNull();
  });

  test('does not surface the inactive plan CTAs', () => {
    const { queryByLabelText } = render(<SubscriptionSection />);
    expect(queryByLabelText('Subscribe yearly')).toBeNull();
    expect(queryByLabelText('Subscribe weekly')).toBeNull();
  });
});

describe('SubscriptionSection — active + cancelled', () => {
  beforeEach(() => {
    mockState.status = 'active';
    mockState.entitlement = {
      productIdentifier: 'trip_pocket_pro_yearly',
      willRenew: false,
      periodType: 'NORMAL',
      expirationDate: '2027-05-14T00:00:00Z',
    };
  });

  test('shows the Resume subscription CTA', () => {
    const { queryByLabelText } = render(<SubscriptionSection />);
    expect(queryByLabelText('Resume subscription')).not.toBeNull();
  });

  test('hides the crossgrade and cancel rows', () => {
    const { queryByLabelText } = render(<SubscriptionSection />);
    expect(queryByLabelText('Switch to weekly')).toBeNull();
    expect(queryByLabelText('Cancel or change plan')).toBeNull();
  });
});

describe('SubscriptionSection — active + trial', () => {
  beforeEach(() => {
    mockState.status = 'active';
    mockState.entitlement = {
      productIdentifier: 'trip_pocket_pro_yearly',
      willRenew: true,
      periodType: 'TRIAL',
      expirationDate: '2026-05-22T00:00:00Z',
    };
  });

  test('shows the Cancel trial CTA instead of the cancel/change row', () => {
    const { queryByLabelText } = render(<SubscriptionSection />);
    expect(queryByLabelText('Cancel trial')).not.toBeNull();
    expect(queryByLabelText('Cancel or change plan')).toBeNull();
  });
});

describe('SubscriptionSection — loading state', () => {
  beforeEach(() => {
    mockState.status = 'loading';
  });

  test('renders only the restore link and a status banner', () => {
    const { queryByLabelText } = render(<SubscriptionSection />);
    expect(queryByLabelText('Restore purchases')).not.toBeNull();
    expect(queryByLabelText('Subscribe yearly')).toBeNull();
    expect(queryByLabelText('Cancel or change plan')).toBeNull();
    expect(queryByLabelText('Resume subscription')).toBeNull();
  });
});
