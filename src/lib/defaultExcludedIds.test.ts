// src/lib/defaultExcludedIds.test.ts
// Phase69-2: fetchDefaultExcludedIds + mergeExcludedIds の単体テスト

jest.mock('./db', () => ({
  pool: { query: jest.fn() },
}));

import { pool } from './db';
import { fetchDefaultExcludedIds, mergeExcludedIds } from './defaultExcludedIds';

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => {
  mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// fetchDefaultExcludedIds
// ---------------------------------------------------------------------------

describe('fetchDefaultExcludedIds', () => {
  it('returns ids from DB when column has values', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ default_excluded_ids: ['id1', 'id2'] }],
    });
    const result = await fetchDefaultExcludedIds('tenant-a');
    expect(result).toEqual(['id1', 'id2']);
  });

  it('returns [] when DB column is NULL', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ default_excluded_ids: null }],
    });
    const result = await fetchDefaultExcludedIds('tenant-a');
    expect(result).toEqual([]);
  });

  it('returns [] when tenant not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await fetchDefaultExcludedIds('unknown-tenant');
    expect(result).toEqual([]);
  });

  it('returns [] on DB error (silent fail)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB down'));
    const result = await fetchDefaultExcludedIds('tenant-a');
    expect(result).toEqual([]);
  });

  it('returns [] when tenantId is empty string', async () => {
    const result = await fetchDefaultExcludedIds('');
    expect(result).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// mergeExcludedIds
// ---------------------------------------------------------------------------

describe('mergeExcludedIds', () => {
  it('returns undefined when both inputs are empty', () => {
    expect(mergeExcludedIds(undefined, [])).toBeUndefined();
    expect(mergeExcludedIds([], [])).toBeUndefined();
  });

  it('returns request ids when defaultIds is empty', () => {
    expect(mergeExcludedIds(['a', 'b'], [])).toEqual(['a', 'b']);
  });

  it('returns defaultIds when requestIds is undefined', () => {
    expect(mergeExcludedIds(undefined, ['x', 'y'])).toEqual(['x', 'y']);
  });

  it('merges both arrays and deduplicates', () => {
    const result = mergeExcludedIds(['a', 'b'], ['b', 'c']);
    expect(result).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(result).toHaveLength(3);
  });

  it('request ids appear before default ids (request priority)', () => {
    const result = mergeExcludedIds(['req1'], ['def1']);
    expect(result).toEqual(['req1', 'def1']);
  });
});
