// tests/phase60/featureCheck.test.ts
// Phase60-C: isDeepResearchEnabled ユニットテスト（実装をテスト）

const mockDbQuery = jest.fn();
jest.mock('../../src/lib/db', () => ({
  getPool: () => ({ query: mockDbQuery }),
  pool: null,
}));

jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { isDeepResearchEnabled } from '../../src/lib/research/featureCheck';

beforeEach(() => {
  jest.clearAllMocks();
});

// 10. features.deep_research=true → true
it('10. features.deep_research=true → true', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ features: { deep_research: true } }] });
  const result = await isDeepResearchEnabled('tenant-test');
  expect(result).toBe(true);
});

// 11. features.deep_research=false → false
it('11. features.deep_research=false → false', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ features: { deep_research: false } }] });
  const result = await isDeepResearchEnabled('tenant-test');
  expect(result).toBe(false);
});

// 12. features未設定 → false（デフォルト）
it('12. features=null → false（デフォルト）', async () => {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ features: null }] });
  const result = await isDeepResearchEnabled('tenant-test');
  expect(result).toBe(false);
});

// 空tenantId → false
it('tenantId が空文字 → false', async () => {
  const result = await isDeepResearchEnabled('');
  expect(result).toBe(false);
  expect(mockDbQuery).not.toHaveBeenCalled();
});

// DBエラー → false（silent fail）
it('DB エラー → false（silent fail）', async () => {
  mockDbQuery.mockRejectedValueOnce(new Error('DB connection lost'));
  const result = await isDeepResearchEnabled('tenant-test');
  expect(result).toBe(false);
});
