// src/api/conversion/avatarAbExperiment.test.ts
// GID 1216978855735482: アバター効果A/Bテスト基盤

import {
  findRunningAvatarExperiment,
  resolveAvatarAssignment,
  recordAvatarExposure,
} from './avatarAbExperiment';

function makePool(queryResponses: Array<{ rows: any[]; rowCount?: number } | Error>) {
  let callCount = 0;
  return {
    query: jest.fn().mockImplementation(() => {
      const resp = queryResponses[callCount++] ?? { rows: [], rowCount: 0 };
      if (resp instanceof Error) return Promise.reject(resp);
      return Promise.resolve(resp);
    }),
  };
}

describe('findRunningAvatarExperiment', () => {
  it('variant_a/variant_bともにavatarEnabledを持つrunning実験を返す', async () => {
    const pool = makePool([
      {
        rows: [
          {
            id: 5,
            variant_a: { avatarEnabled: true },
            variant_b: { avatarEnabled: false },
            traffic_split: '0.5',
          },
        ],
      },
    ]);
    const result = await findRunningAvatarExperiment(pool as any, 'tenant-a');
    expect(result).toEqual({
      id: 5,
      tenantId: 'tenant-a',
      variantA: { avatarEnabled: true },
      variantB: { avatarEnabled: false },
      trafficSplit: 0.5,
    });
  });

  it('avatarEnabledを持たない実験（プロンプトA/B等）はスキップしnullを返す', async () => {
    const pool = makePool([
      {
        rows: [
          { id: 1, variant_a: { prompt_modifier: 'x' }, variant_b: { prompt_modifier: 'y' }, traffic_split: '0.5' },
        ],
      },
    ]);
    const result = await findRunningAvatarExperiment(pool as any, 'tenant-a');
    expect(result).toBeNull();
  });

  it('複数running実験がある場合、avatarEnabled形式の最初の1件を採用する', async () => {
    const pool = makePool([
      {
        rows: [
          { id: 1, variant_a: { prompt_modifier: 'x' }, variant_b: { prompt_modifier: 'y' }, traffic_split: '0.5' },
          { id: 2, variant_a: { avatarEnabled: true }, variant_b: { avatarEnabled: false }, traffic_split: '0.3' },
        ],
      },
    ]);
    const result = await findRunningAvatarExperiment(pool as any, 'tenant-a');
    expect(result?.id).toBe(2);
  });

  it('running実験なし → null', async () => {
    const pool = makePool([{ rows: [] }]);
    const result = await findRunningAvatarExperiment(pool as any, 'tenant-a');
    expect(result).toBeNull();
  });

  it('DB障害時はfail-safeでnull（可用性優先）', async () => {
    const pool = makePool([new Error('db down')]);
    const result = await findRunningAvatarExperiment(pool as any, 'tenant-a');
    expect(result).toBeNull();
  });
});

describe('resolveAvatarAssignment', () => {
  it('defaultAvatarEnabled=false（features.avatarが無効）の場合は実験を一切参照せずfalseを返す', async () => {
    const pool = makePool([{ rows: [{ id: 1 }] }]); // もし呼ばれたら実験ありに見えてしまう罠
    const result = await resolveAvatarAssignment(pool as any, 'tenant-a', 'sticky-key', false);
    expect(result).toEqual({ avatarEnabled: false, experimentId: null, variant: null });
    // ガードにより ab_experiments へのクエリ自体が発生しないこと
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('実験なし → defaultAvatarEnabledをそのまま返す', async () => {
    const pool = makePool([{ rows: [] }]);
    const result = await resolveAvatarAssignment(pool as any, 'tenant-a', 'sticky-key', true);
    expect(result).toEqual({ avatarEnabled: true, experimentId: null, variant: null });
  });

  it('実験あり → sticky keyに基づき決定的にvariantを割り当てる（同一keyは同一結果）', async () => {
    const pool = makePool([
      {
        rows: [
          { id: 9, variant_a: { avatarEnabled: true }, variant_b: { avatarEnabled: false }, traffic_split: '0.5' },
        ],
      },
    ]);
    const result1 = await resolveAvatarAssignment(pool as any, 'tenant-a', 'same-key', true);

    const pool2 = makePool([
      {
        rows: [
          { id: 9, variant_a: { avatarEnabled: true }, variant_b: { avatarEnabled: false }, traffic_split: '0.5' },
        ],
      },
    ]);
    const result2 = await resolveAvatarAssignment(pool2 as any, 'tenant-a', 'same-key', true);

    expect(result1.variant).toBe(result2.variant);
    expect(result1.experimentId).toBe(9);
    expect(result1.avatarEnabled).toBe(result1.variant === 'a');
  });
});

describe('recordAvatarExposure', () => {
  it('ON CONFLICT DO NOTHINGで冪等にINSERTする', async () => {
    const pool = makePool([{ rows: [] }]);
    await recordAvatarExposure(pool as any, 9, 'a', '11111111-1111-1111-1111-111111111111');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (experiment_id, session_id) DO NOTHING'),
      [9, 'a', '11111111-1111-1111-1111-111111111111'],
    );
  });

  it('DB障害時は例外を投げずに握りつぶす（露出記録失敗でリクエストを壊さない）', async () => {
    const pool = makePool([new Error('insert failed')]);
    await expect(
      recordAvatarExposure(pool as any, 9, 'a', '11111111-1111-1111-1111-111111111111'),
    ).resolves.toBeUndefined();
  });
});
