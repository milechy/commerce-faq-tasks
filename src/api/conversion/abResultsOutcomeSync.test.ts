// src/api/conversion/abResultsOutcomeSync.test.ts
// GID 1216978855735482: アバター効果A/Bテスト基盤 — 成果の遅延反映
// PR-3訂正(GID 1216970103691946): metadata列の存在を動的確認する
// information_schemaクエリは誤った前提(列が無いかもしれない)に基づいていたため撤去。
// sourceフィルタは常時付与される(2クエリのみ発行)。
// PR-6訂正: NON_CONVERTING_OUTCOMESの全テナント共通ハードコード('離脱','不明')は
// conversion_typesをカスタマイズしたテナントで誤判定していたため撤去。
// tenants.conversion_types の末尾2件をそのテナントの「非成約終端」として使う。

const mockGetConversionTypes = jest.fn();
jest.mock('../admin/chat-history/chatHistoryRepository', () => ({
  getConversionTypes: (...args: unknown[]) => mockGetConversionTypes(...args),
}));

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

const DEFAULT_CONVERSION_TYPES = ['購入完了', '予約完了', '問い合わせ送信', '離脱', '不明'];

beforeEach(() => {
  mockGetConversionTypes.mockReset().mockResolvedValue(DEFAULT_CONVERSION_TYPES);
});

describe('reconcileAbResultOutcomes', () => {
  it('UPDATEを2本発行し、両方にsourceフィルタ(source=user OR NULL)が常に付与される', async () => {
    const pool = makePool([
      { rows: [], rowCount: 3 }, // reached_two_plus_exchanges UPDATE
      { rows: [], rowCount: 1 }, // converted UPDATE
    ]);
    await reconcileAbResultOutcomes(pool as any, 42, 'tenant-a');

    expect(pool.query).toHaveBeenCalledTimes(2);
    const [reachedSql] = pool.calls[0] as [string, unknown[]];
    const [convertedSql] = pool.calls[1] as [string, unknown[]];
    expect(reachedSql).toContain("cs.metadata->>'source' = 'user'");
    expect(reachedSql).toContain("cs.metadata->>'source' IS NULL");
    expect(convertedSql).toContain("cs.metadata->>'source' = 'user'");
    expect(convertedSql).toContain("cs.metadata->>'source' IS NULL");
    expect(reachedSql).toContain('message_count >=');
    expect(convertedSql).toContain('outcome <> ALL(');
  });

  it('reached_two_plus_exchangesのUPDATEはexperimentIdと閾値(4)をパラメータに渡す', async () => {
    const pool = makePool([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    await reconcileAbResultOutcomes(pool as any, 42, 'tenant-a');
    const [, params] = pool.calls[0] as [string, unknown[]];
    expect(params).toEqual([42, 4]);
  });

  it('1本目のUPDATEが失敗すると例外がそのまま伝播する（呼び出し元でtry/catchする設計）', async () => {
    const pool = makePool([
      new Error('update failed'),
    ]);
    await expect(reconcileAbResultOutcomes(pool as any, 42, 'tenant-a')).rejects.toThrow('update failed');
  });

  it('ab_results.session_id(UUID)とchat_sessions.session_id(TEXT)の型不一致を::textキャストで吸収する', async () => {
    // chat_sessions.session_id は TEXT 型（widget側でcrypto.randomUUID()により常にUUID形式の
    // 値が入るが、カラム型としてはTEXT）。ab_results.session_id は UUID 型のため、
    // PostgresはUUID=TEXTの暗黙キャストを行わずエラーになる。r.session_id::text で
    // 明示キャストしていることを確認する（実DBでの型エラー再発防止の回帰テスト）。
    const pool = makePool([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    await reconcileAbResultOutcomes(pool as any, 42, 'tenant-a');
    const [reachedSql] = pool.calls[0] as [string, unknown[]];
    const [convertedSql] = pool.calls[1] as [string, unknown[]];
    expect(reachedSql).toContain('r.session_id::text = cs.session_id');
    expect(convertedSql).toContain('r.session_id::text = cs.session_id');
  });

  // PR-6: NON_CONVERTING_OUTCOMES はテナントの conversion_types 末尾2件から動的に導出する
  describe('非成約終端の判定(テナントのconversion_types末尾2件)', () => {
    it('既定のconversion_typesなら末尾2件「離脱」「不明」を非成約終端として使う', async () => {
      const pool = makePool([
        { rows: [], rowCount: 0 },
        { rows: [], rowCount: 0 },
      ]);
      await reconcileAbResultOutcomes(pool as any, 42, 'tenant-a');

      expect(mockGetConversionTypes).toHaveBeenCalledWith('tenant-a');
      const [, params] = pool.calls[1] as [string, unknown[]];
      expect(params).toEqual([42, ['離脱', '不明']]);
    });

    it('カスタムconversion_typesのテナントでは、そのテナント自身の末尾2件を使う(全テナント共通ハードコードをしない)', async () => {
      mockGetConversionTypes.mockResolvedValue(['成約', 'キャンセル', '対応中']);
      const pool = makePool([
        { rows: [], rowCount: 0 },
        { rows: [], rowCount: 0 },
      ]);
      await reconcileAbResultOutcomes(pool as any, 99, 'tenant-custom');

      const [, params] = pool.calls[1] as [string, unknown[]];
      // '離脱'/'不明' という全テナント共通のハードコード値ではなく、
      // このテナント自身のconversion_types末尾2件('キャンセル','対応中')を使う
      expect(params).toEqual([99, ['キャンセル', '対応中']]);
    });
  });
});
