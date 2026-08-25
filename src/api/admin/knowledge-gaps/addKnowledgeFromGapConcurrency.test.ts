// src/api/admin/knowledge-gaps/addKnowledgeFromGapConcurrency.test.ts
//
// 壊れやすいポイント監査(2026-08-25、実装済み機能のテスト強化の一環):
// addKnowledgeFromGap は以前「SELECTでrecommendation_status='approved'を確認
// →faq_docsにINSERT→UPDATEでresolvedにする」という3ステップが1トランザクション
// になっておらず、承認済みギャップに対してほぼ同時に2回呼ばれる
// (店主のダブルクリック・2タブでの操作・チャットとadmin-uiからの同時操作)と、
// 両方がSELECTの時点でapprovedを見てしまい、同じギャップから2件のFAQが
// 重複作成される可能性があった(TOCTOU: check-then-act 競合)。
//
// 是正: recommendation_status: 'approved' → 'resolved' への遷移を、
// `UPDATE ... WHERE recommendation_status = 'approved'` という条件付きUPDATEで
// 原子的に「claim」する。Postgresの行ロックにより、同時に発行された2つの
// UPDATEのうち先着1件だけがこの条件にマッチしてFAQ作成に進み、
// 後着はrows=0を受け取ってnot_approvedとして安全に失敗する。
//
// このテストはDBの行ロック挙動そのものは検証できない(unitテストの限界)が、
// 「2回目の呼び出しがclaim UPDATEで0行しか返さなかった場合に、
// addKnowledgeFromGapがFAQを作らずnot_approvedを返す」という、
// 是正後のロジックが正しく1回だけの成功を保証する形になっていることを検証する。

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../agent/llm/openaiEmbeddingClient', () => ({
  embedText: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

const mockQuery = jest.fn();
jest.mock('../../../lib/db', () => ({
  getPool: () => ({ query: mockQuery }),
}));

const originalFetch = global.fetch;
beforeAll(() => {
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({}) }) as unknown as Response);
});
afterAll(() => {
  global.fetch = originalFetch;
});

import { addKnowledgeFromGap } from './routes';

const GAP_ID = 123;
const TENANT = 't1';

beforeEach(() => {
  jest.clearAllMocks();
  process.env['ES_URL'] = 'http://es.test:9200';
});

afterEach(() => {
  delete process.env['ES_URL'];
});

/**
 * 「DBに1行だけ承認済みギャップがある」状態を模したステートフルモック。
 * claim UPDATE は最初の1回だけ成功し(rows>=1)、2回目以降は既にrecommendation_status
 * が'resolved'に変わっているため WHERE 句にマッチせず0行を返す(実際のPostgres行ロック
 * によるものと同じ結果になるよう、呼び出し側で状態を手動シミュレートする)。
 */
function makeSingleClaimMock() {
  let claimed = false;
  return jest.fn().mockImplementation((sql: string) => {
    if (/UPDATE knowledge_gaps\s+SET recommendation_status = 'resolved'/.test(sql)) {
      if (claimed) return Promise.resolve({ rows: [] });
      claimed = true;
      return Promise.resolve({
        rows: [{ tenant_id: TENANT, user_question: '返品できますか', detection_source: 'no_rag', frequency: 1 }],
      });
    }
    if (/SELECT tenant_id, recommendation_status FROM knowledge_gaps/.test(sql)) {
      // claim後に失敗側が理由特定のために読むフォールバックSELECT
      return Promise.resolve({ rows: [{ tenant_id: TENANT, recommendation_status: 'resolved' }] });
    }
    if (/INSERT INTO faq_docs/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 999 }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

describe('addKnowledgeFromGap — 壊れやすいポイント: 同時呼び出しでのTOCTOU競合対策', () => {
  it('承認済みギャップに対する2回のほぼ同時呼び出しのうち、先着1回だけがFAQを作成し、後着はnot_approvedになる', async () => {
    mockQuery.mockImplementation(makeSingleClaimMock());

    const [first, second] = await Promise.all([
      addKnowledgeFromGap(GAP_ID, '30日以内であれば返品可能です', null, TENANT, false),
      addKnowledgeFromGap(GAP_ID, '別の回答文', null, TENANT, false),
    ]);

    const results = [first, second];
    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as { ok: false; reason: string }).reason).toBe('not_approved');

    // faq_docs への INSERT は1回だけ(重複FAQが作られていない)
    const insertCalls = mockQuery.mock.calls.filter(([sql]: [string]) => /INSERT INTO faq_docs/.test(sql));
    expect(insertCalls).toHaveLength(1);
  });

  it('claim UPDATEがWHERE句にtenant_id条件を含む(super_admin以外はテナント越境してclaimできない)', async () => {
    mockQuery.mockImplementation(makeSingleClaimMock());

    await addKnowledgeFromGap(GAP_ID, 'answer', null, TENANT, false);

    const claimCall = mockQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE knowledge_gaps\s+SET recommendation_status = 'resolved'/.test(sql),
    );
    expect(claimCall).toBeDefined();
    const [sql, params] = claimCall as [string, unknown[]];
    expect(sql).toContain('tenant_id');
    expect(params).toContain(TENANT);
  });

  it('super_adminはclaim UPDATEにtenant_id条件を付けない(既存の越境免除の踏襲)', async () => {
    mockQuery.mockImplementation(makeSingleClaimMock());

    await addKnowledgeFromGap(GAP_ID, 'answer', null, TENANT, true);

    const claimCall = mockQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE knowledge_gaps\s+SET recommendation_status = 'resolved'/.test(sql),
    );
    const [sql] = claimCall as [string, unknown[]];
    // RETURNING句にはtenant_idが含まれるため、WHERE句だけを見て絞り込み条件の有無を確認する
    const whereClause = sql.split('RETURNING')[0]!;
    expect(whereClause).not.toContain('tenant_id');
  });
});
