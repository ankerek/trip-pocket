import { DETAIL_ROUTE_OPTIONS } from '@/lib/navigation/detailHeaderOptions';

describe('detail header options', () => {
  it('keeps native headers out of detail transitions', () => {
    expect(DETAIL_ROUTE_OPTIONS).toMatchObject({
      headerShown: false,
    });
  });
});
