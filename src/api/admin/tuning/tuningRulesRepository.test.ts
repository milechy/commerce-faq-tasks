// src/api/admin/tuning/tuningRulesRepository.test.ts
// GID 1215916762299598: listRules への source/status フィルタ追加の回帰テスト

const mockQuery = jest.fn();
jest.mock('../../../lib/db', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { listRules, updateRule } from './tuningRulesRepository';

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

// updateRule: P4-1でstatus列(承認/却下)を追加した際、この関数自体の直接テストが
// 一つも無かった(agentRoutes.test.ts はupdateRule自体をjest.mockで丸ごと差し替えて
// いるため、実際のSQL・所有権チェック・COALESCE挙動は一度も実行されずに通っていた)。
// 特に所有権チェック(他テナントのルールを更新させない)は権限境界そのものであり、
// モック越しのテストでは検出できない。
describe('updateRule', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('自テナントのルールは更新でき、UPDATE文が実行される', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-abc' }] }) // 所有権確認SELECT
      .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-abc', is_active: true }] }); // UPDATE

    const result = await updateRule(1, { is_active: true }, 'tenant-abc');

    expect(result).toEqual({ id: 1, tenant_id: 'tenant-abc', is_active: true });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [updateSql, updateArgs] = mockQuery.mock.calls[1];
    expect(updateSql).toContain('UPDATE tuning_rules');
    expect(updateArgs).toEqual([null, null, null, true, null, null, 1]);
  });

  it('他テナントのルールは更新されない(所有権チェックで null を返し、UPDATE文は実行されない)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'other-tenant' }] }); // 所有権確認SELECT

    const result = await updateRule(1, { is_active: true }, 'tenant-abc');

    expect(result).toBeNull();
    // 所有権チェックで弾かれた場合、UPDATE文自体が発行されないことを確認する
    // (呼び出し回数が1のまま=SELECTのみ)。これが崩れると「見つからない」応答の
    // 裏で実際には他テナントのデータが書き換わる、という静かな権限漏れになる。
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('存在しないIDは null を返し、UPDATE文は実行されない', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // 所有権確認SELECT: 該当なし

    const result = await updateRule(999, { is_active: true }, 'tenant-abc');

    expect(result).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('super_admin(tenantId未指定)は他テナントのルールも更新できる', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-xyz' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-xyz', is_active: false }] });

    const result = await updateRule(1, { is_active: false }, undefined);

    expect(result).not.toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  // P4-1: status列(AI提案の承認='active'/却下='rejected')のCOALESCE挙動。
  // is_activeだけではpendingとrejectedを区別できないため、この列が正しく
  // 更新される/されないことは承認機能の正しさそのものに直結する。
  it('status="active"を指定するとUPDATE文の$6に"active"が渡る(承認)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-abc' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-abc', is_active: true, status: 'active' }] });

    await updateRule(1, { is_active: true, status: 'active' }, 'tenant-abc');

    const [updateSql, updateArgs] = mockQuery.mock.calls[1];
    expect(updateSql).toContain('status            = COALESCE($6, status)');
    expect(updateArgs[5]).toBe('active');
  });

  it('statusを指定しない場合、UPDATE文の$6はnull(COALESCEで既存値を維持)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-abc' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-abc' }] });

    await updateRule(1, { is_active: true }, 'tenant-abc');

    const [, updateArgs] = mockQuery.mock.calls[1];
    expect(updateArgs[5]).toBeNull();
  });

  // 壊れやすいポイント: is_active と status は呼び出し側(actionExecutor)が
  // 独立に渡せる。statusだけ'active'を指定してis_activeを指定し忘れても、
  // このリポジトリ層は片方だけを更新する(整合性強制は行わない設計)。
  // 呼び出し側の責務であることをここで固定しておく。
  it('statusのみ指定してis_activeを指定しない場合、is_active列(の引数)はnullのまま渡る', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-abc' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-abc' }] });

    await updateRule(1, { status: 'active' }, 'tenant-abc');

    const [, updateArgs] = mockQuery.mock.calls[1];
    expect(updateArgs[3]).toBeNull(); // is_active
    expect(updateArgs[5]).toBe('active'); // status
  });

  it('RETURNING句にsource/status/evidence列が含まれる(P4-1で追加、承認カードの表示に必須)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-abc' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-abc' }] });

    await updateRule(1, { is_active: true }, 'tenant-abc');

    const [updateSql] = mockQuery.mock.calls[1];
    expect(updateSql).toMatch(/RETURNING[\s\S]*source[\s\S]*status[\s\S]*evidence/);
  });

  it('approved_responsesを指定するとJSONBとして渡り、未指定時は既存値を維持する', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-abc' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, tenant_id: 'tenant-abc' }] });

    await updateRule(1, { approved_responses: [{ text: '2年です', style: 'plain', approved_at: '' }] }, 'tenant-abc');

    const [, updateArgs] = mockQuery.mock.calls[1];
    expect(updateArgs[4]).toBe(JSON.stringify([{ text: '2年です', style: 'plain', approved_at: '' }]));
  });
});
