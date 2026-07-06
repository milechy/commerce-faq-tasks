// src/lib/sai/saiTaskRulesRepository.test.ts
// Phase6 (Sai Judge学習ループ): sai_task_rules DBリポジトリのテスト

const mockQuery = jest.fn();
jest.mock('../db', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import {
  listSaiRules,
  getActiveSaiRulesForTenant,
  insertSuggestedSaiRule,
  approveSaiRule,
  rejectSaiRule,
  matchesSaiTriggerPattern,
  buildSaiPromptSection,
  type SaiTaskRule,
} from './saiTaskRulesRepository';

beforeEach(() => {
  mockQuery.mockReset();
});

describe('matchesSaiTriggerPattern', () => {
  it('カンマ区切りキーワードのいずれかが部分一致すればtrue', () => {
    expect(matchesSaiTriggerPattern('FAQ登録代行をお願いします', 'FAQ登録,在庫更新')).toBe(true);
    expect(matchesSaiTriggerPattern('在庫更新の作業です', 'FAQ登録,在庫更新')).toBe(true);
  });

  it('一致しなければfalse', () => {
    expect(matchesSaiTriggerPattern('全く関係ない作業', 'FAQ登録,在庫更新')).toBe(false);
  });

  it('大文字小文字を区別しない', () => {
    expect(matchesSaiTriggerPattern('Please open chromium', 'CHROMIUM')).toBe(true);
  });
});

describe('buildSaiPromptSection', () => {
  it('ルールが空なら空文字を返す', () => {
    expect(buildSaiPromptSection([])).toBe('');
  });

  it('ルールをテキストブロックに変換する', () => {
    const rules = [
      { trigger_pattern: 'FAQ登録', expected_behavior: '保存ボタンは画面右上にある' } as SaiTaskRule,
    ];
    const result = buildSaiPromptSection(rules);
    expect(result).toContain('FAQ登録');
    expect(result).toContain('保存ボタンは画面右上にある');
  });
});

describe('listSaiRules', () => {
  it('tenantId指定時はtenant_id/globalの条件を付ける', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listSaiRules('tenant-x');
    const [sql, args] = mockQuery.mock.calls[0];
    expect(sql).toContain("tenant_id = $1 OR tenant_id = 'global'");
    expect(args).toEqual(['tenant-x']);
  });

  it('source/statusフィルタを付与する', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listSaiRules(undefined, { source: 'sai_judge', status: 'pending' });
    const [sql, args] = mockQuery.mock.calls[0];
    expect(sql).toContain('source = $1');
    expect(sql).toContain('status = $2');
    expect(args).toEqual(['sai_judge', 'pending']);
  });
});

describe('getActiveSaiRulesForTenant', () => {
  it('is_active=trueのみ取得する', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getActiveSaiRulesForTenant('tenant-x');
    const [sql, args] = mockQuery.mock.calls[0];
    expect(sql).toContain('is_active = true');
    expect(args).toEqual(['tenant-x']);
  });
});

describe('insertSuggestedSaiRule', () => {
  it('デフォルトでsource=sai_judgeとして挿入する(is_activeはテーブルのデフォルトfalseに任せる)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, source: 'sai_judge' }] });
    await insertSuggestedSaiRule({
      tenant_id: 'tenant-x', trigger_pattern: 'FAQ登録', expected_behavior: 'y',
    });
    const [sql, args] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO sai_task_rules');
    expect(args).toEqual(['tenant-x', 'FAQ登録', 'y', 0, 'sai_judge', null, null]);
  });
});

describe('approveSaiRule / rejectSaiRule', () => {
  it('approveSaiRule: status=active かつ is_active=true を同時に更新する', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, status: 'active' }] });
    await approveSaiRule(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain('is_active = true');
  });

  it('rejectSaiRule: status=rejected かつ is_active=false を同時に更新する', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, status: 'rejected' }] });
    await rejectSaiRule(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("status = 'rejected'");
    expect(sql).toContain('is_active = false');
  });

  it('tenantId指定時は所有権チェックの条件を付ける', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await approveSaiRule(1, 'tenant-x');
    const [sql, args] = mockQuery.mock.calls[0];
    expect(sql).toContain('AND tenant_id = $2');
    expect(args).toEqual([1, 'tenant-x']);
  });
});
