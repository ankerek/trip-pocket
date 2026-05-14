// Minimal stub so test suites that transitively import
// react-native-purchases (e.g. via lib/entitlement/userId) can run without
// the native module. Tests that need real behaviour mock getEntitlementUserId
// directly via jest.mock('@/lib/entitlement/userId').
const Purchases = {
  getAppUserID: jest.fn(async () => '$RCAnonymousID:test'),
  configure: jest.fn(),
};

export default Purchases;
export type { CustomerInfo } from 'react-native-purchases';
