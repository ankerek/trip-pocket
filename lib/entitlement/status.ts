import type { CustomerInfo } from 'react-native-purchases';

export type EntitlementStatus = 'active' | 'inactive';
export const ENTITLEMENT_KEY = 'pro';

export function entitlementStatus(info: CustomerInfo | null): EntitlementStatus {
  if (!info) return 'inactive';
  return info.entitlements.active[ENTITLEMENT_KEY] ? 'active' : 'inactive';
}
