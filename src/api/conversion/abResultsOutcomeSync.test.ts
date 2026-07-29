// src/api/conversion/abResultsOutcomeSync.test.ts
// GID 1216978855735482: アバター効果A/Bテスト基盤 — 成果の遅延反映

import { reconcileAbResultOutcomes } from './abResultsOutcomeSync';

function makePool(queryResponses: Array<{ rows: any[]; rowCount?: number } | Error>) {
  let callCount = 0;
  const calls: unknown[][] = [];
  return {
    query: jest.fn().mockImplementation((...args: unknown[]) => {
      calls.push(args);
      const resp = queryResponses[callCount++] ?? { rows: [], rowCount: 0 };
      if (resp instanceof Error) return Promise.reject(resp);
      return Promise.resolve(resp);
    }),
    calls,
  };
}

describe('reconcileAbResultOutcomes', () => {
  it('metadata列が存在しない場合はsourceフィルタ無しでUPDATEを2本発行する', async () => {
    const pool = makePool([
      { rows: [{ exists: false }] }, // information_schema
      { rows: [], rowCount: 3 }, // reached_two_plus_exchanges UPDATE
      { rows: [], rowCount: 1 }, // converted UPDATE
    ]);
    await reconcileAbResultOutcomes(pool as any, 42);

    expect(pool.query).toHaveBeenCalledTimes(3);
    const [reachedSql] = pool.calls[1] as [string, unknown[]];
    const [convertedSql] = pool.calls[2] as [string, unknown[]];
    expect(reachedSql).not.toContain("metadata->>'source'");
    expect(convertedSql).not.toContain("metadata->>'source'");
    expect(reachedSql).toContain('message_count >=');
    expect(convertedSql).toContain('outcome <> ALL(');
  });

  it('metadata列が存在する場合はsourceフィルタ(source=user OR NULL)を付与する', async () => {
    const pool = makePool([
      { rows: [{ exists: true }] },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    await reconcileAbResultOutcomes(pool as any, 42);

    const [reachedSql] = pool.calls[1] as [string, unknown[]];
    const [convertedSql] = pool.calls[2] as [string, unknown[]];
    expect(reachedSql).toContain("cs.metadata->>'source' = 'user'");
    expect(reachedSql).toContain("cs.metadata->>'source' IS NULL");
    expect(convertedSql).toContain("cs.metadata->>'source' = 'user'");
  });

  it('information_schemaクエリが例外を投げても列なし扱い(false)にフォールバックし、UPDATEは実行される', async () => {
    const pool = makePool([
      new Error('information_schema unavailable'),
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    await expect(reconcileAbResultOutcomes(pool as any, 42)).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it('reached_two_plus_exchangesのUPDATEはexperimentIdと閾値(4)をパラメータに渡す', async () => {
    const pool = makePool([
      { rows: [{ exists: false }] },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    await reconcileAbResultOutcomes(pool as any, 42);
    const [, params] = pool.calls[1] as [string, unknown[]];
    expect(params).toEqual([42, 4]);
  });

  it('1本目のUPDATEが失敗すると例外がそのまま伝播する（呼び出し元でtry/catchする設計）', async () => {
    const pool = makePool([
      { rows: [{ exists: false }] },
      new Error('update failed'),
    ]);
    await expect(reconcileAbResultOutcomes(pool as any, 42)).rejects.toThrow('update failed');
  });

  it('ab_results.session_id(UUID)とchat_sessions.session_id(TEXT)の型不一致を::textキャストで吸収する', async () => {
    // chat_sessions.session_id は TEXT 型（widget側でcrypto.randomUUID()により常にUUID形式の
    // 値が入るが、カラム型としてはTEXT）。ab_results.session_id は UUID 型のため、
    // PostgresはUUID=TEXTの暗黙キャストを行わずエラーになる。r.session_id::text で
    // 明示キャストしていることを確認する（実DBでの型エラー再発防止の回帰テスト）。
    const pool = makePool([
      { rows: [{ exists: false }] },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    await reconcileAbResultOutcomes(pool as any, 42);
    const [reachedSql] = pool.calls[1] as [string, unknown[]];
    const [convertedSql] = pool.calls[2] as [string, unknown[]];
    expect(reachedSql).toContain('r.session_id::text = cs.session_id');
    expect(convertedSql).toContain('r.session_id::text = cs.session_id');
  });
});
