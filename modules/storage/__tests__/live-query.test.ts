import { renderHook, act, waitFor } from '@testing-library/react-native';
import { openDatabase, runMigrations, type Database } from '../db';
import { migrations } from '../migrations';
import { insertScreenshot } from '../screenshots';
import { provideDatabase, useLiveQuery, notifyChange } from '../live-query';

describe('useLiveQuery', () => {
  let db: Database;

  beforeEach(async () => {
    db = await openDatabase(':memory:');
    await runMigrations(db, migrations);
    provideDatabase(db);
  });

  it('returns the initial query result', async () => {
    const { result } = renderHook(() =>
      useLiveQuery<{ count: number }>(
        'SELECT COUNT(*) AS count FROM screenshots',
        [],
        ['screenshots'],
      ),
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.[0]?.count).toBe(0);
  });

  it('re-runs the query after notifyChange("screenshots")', async () => {
    const { result } = renderHook(() =>
      useLiveQuery<{ count: number }>(
        'SELECT COUNT(*) AS count FROM screenshots',
        [],
        ['screenshots'],
      ),
    );
    await waitFor(() => expect(result.current?.[0]?.count).toBe(0));
    await act(async () => {
      await insertScreenshot(db, {
        id: 'a',
        tripId: null,
        filePath: '/x/a.jpg',
        contentHash: 'h',
        source: 'share',
        capturedAt: '2026-05-04T00:00:00Z',
        ownerId: 'owner',
      });
      notifyChange('screenshots');
    });
    await waitFor(() => expect(result.current?.[0]?.count).toBe(1));
  });
});
