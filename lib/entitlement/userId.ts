import Purchases from 'react-native-purchases';

let cached: string | null = null;

export async function getEntitlementUserId(): Promise<string> {
  if (cached !== null) return cached;
  const id = await Purchases.getAppUserID();
  cached = id;
  return id;
}

// Test-only — drops the cache so the next call goes back to the SDK.
export function _resetEntitlementUserIdCacheForTests(): void {
  cached = null;
}
