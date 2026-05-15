import { LAPSE_PAYWALL_ROUTE, openLapsePaywall } from '@/lib/paywall/openLapsePaywall';

type RouterStub = {
  push: jest.Mock;
};

function makeRouter(): RouterStub {
  return { push: jest.fn() };
}

describe('openLapsePaywall', () => {
  it('pushes the lapse paywall route when not already there', () => {
    const router = makeRouter();
    openLapsePaywall(router as unknown as never, '/(tabs)/(places)');
    expect(router.push).toHaveBeenCalledWith(LAPSE_PAYWALL_ROUTE);
  });

  it('no-ops when already on the lapse paywall', () => {
    const router = makeRouter();
    openLapsePaywall(router as unknown as never, LAPSE_PAYWALL_ROUTE);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('no-ops on sub-paths under the lapse route', () => {
    const router = makeRouter();
    openLapsePaywall(router as unknown as never, `${LAPSE_PAYWALL_ROUTE}/something`);
    expect(router.push).not.toHaveBeenCalled();
  });
});
