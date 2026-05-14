import type { CustomerInfo } from 'react-native-purchases';
import { entitlementStatus, ENTITLEMENT_KEY } from '../status';

function customer(activeEntitlements: string[]): CustomerInfo {
  return {
    entitlements: {
      active: Object.fromEntries(activeEntitlements.map((k) => [k, { identifier: k } as never])),
      all: {},
    },
  } as unknown as CustomerInfo;
}

describe('entitlementStatus', () => {
  test('returns inactive when info is null', () => {
    expect(entitlementStatus(null)).toBe('inactive');
  });

  test('returns inactive when active entitlements is empty', () => {
    expect(entitlementStatus(customer([]))).toBe('inactive');
  });

  test('returns inactive when only an unrelated entitlement is active', () => {
    expect(entitlementStatus(customer(['something-else']))).toBe('inactive');
  });

  test('returns active when the pro entitlement is in active', () => {
    expect(entitlementStatus(customer([ENTITLEMENT_KEY]))).toBe('active');
  });

  test('ENTITLEMENT_KEY is the literal "pro"', () => {
    expect(ENTITLEMENT_KEY).toBe('pro');
  });
});
