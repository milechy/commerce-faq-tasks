// src/api/admin/tuning/tuningRulesRepository.test.ts
// GID 1215916762299598: listRules への source/status フィルタ追加の回帰テスト

const mockQuery = jest.fn();
jest.mock('../../../lib/db', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { listRules } from './tuningRulesRepository';

describe('listRules', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('tenantId指定・filtersなし → 従来通りWHERE tenant_id/global のみ、引数は[tenantId]', async () => {
    await listRules('tenant-abc');

    const [sql, args] = mockQuery.mock.calls[0];
    expect(sql).toContain("tenant_id = $1 OR tenant_id = 'global'");
    expect(sql).not.toContain('source =');
    expect(sql).not.toContain('status =');
    expect(args).toEqual(['tenant-abc']);
  });

  it('tenantId + source + status 指定 → SQLに両条件が追加され、引数が正しい順で渡る', async () => {
    await listRules('tenant-abc', { source: 'judge', status: 'pending' });

    const [sql, args] = mockQuery.mock.calls[0];
    expect(sql).toContain('source = $2');
    expect(sql).toContain('status = $3');
    expect(args).toEqual(['tenant-abc', 'judge', 'pending']);
  });

  it('SELECT句にsource/status/evidence列が含まれる（AIReportTabがこれらを必要とする）', async () => {
    await listRules('tenant-abc');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SELECT[\s\S]*source[\s\S]*status[\s\S]*evidence/);
  });

  it('tenantId未指定(super_admin全件) + filters指定 → WHERE句がfiltersのみで構成され、引数は[source, status]', async () => {
    await listRules(undefined, { source: 'judge', status: 'pending' });

    const [sql, args] = mockQuery.mock.calls[0];
    expect(sql).toContain('WHERE source = $1 AND status = $2');
    expect(args).toEqual(['judge', 'pending']);
  });

  it('tenantId・filters両方未指定 → WHERE句なしで全件取得（従来挙動）', async () => {
    await listRules();

    const [sql, args] = mockQuery.mock.calls[0];
    expect(sql).not.toMatch(/WHERE/);
    expect(args).toEqual([]);
  });
});
