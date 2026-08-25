// src/api/admin/knowledge-gaps/approveAfterResolveGuard.test.ts
//
// 壊れやすいポイント監査(2026-08-25)、addKnowledgeFromGapConcurrency.test.ts の
// 追加是正: 「同時に2回」のTOCTOU対策(claim UPDATE)だけでは、以下の
// **逐次的な**再利用による重複FAQ作成を防げなかった:
//
//   1. ギャップを承認 → 知識化 → FAQ作成成功(status='resolved',
//      recommendation_status='resolved')
//   2. 同じギャップに approve_gap_recommendation を再度呼ぶ
//      → 以前は現在の状態を確認せず recommendation_status を無条件に
//        'approved' へ上書きしていたため、成功してしまっていた
//   3. add_knowledge_from_gap を呼ぶ → claimのWHERE句は
//      recommendation_status='approved' しか見ていなかったため通ってしまい、
//      2件目のFAQが作成されていた
//
// 是正: 両関数のUPDATEに `AND status != 'resolved'` を追加し、
// knowledge_gaps.status(解決済みの不変の記録。resolved_faq_idと同時に
// 確定する)を基準に、解決済みギャップへの再承認・再知識化そのものを拒否する。

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

import { addKnowledgeFromGap, approveGapRecommendation } from './routes';

const GAP_ID = 123;
const TENANT = 't1';

beforeEach(() => {
  jest.clearAllMocks();
  process.env['ES_URL'] = 'http://es.test:9200';
});

afterEach(() => {
  delete process.env['ES_URL'];
});

describe('approveGapRecommendation — 解決済みギャップの再承認を拒否する', () => {
  it('status=resolvedのギャップは再承認できず、recommendation_statusも書き換わらない(claim UPDATEが0行)', async () => {
    // claim UPDATE(WHERE ... AND status != 'resolved')は解決済みのため0行。
    mockQuery.mockImplementation((sql: string) => {
      if (/UPDATE knowledge_gaps SET recommendation_status = \$1/.test(sql)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (/SELECT status FROM knowledge_gaps/.test(sql)) {
        return Promise.resolve({ rows: [{ status: 'resolved' }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await approveGapRecommendation(GAP_ID, TENANT, false);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe('already_resolved');

    // モックはSQL文の中身を見ずに「claim UPDATEは0行」を返すだけなので、
    // 上のアサーションだけでは本番コードからガード条件自体が消えても検知できない。
    // WHERE句に実際にstatus != 'resolved'が含まれることを直接検証する。
    const claimCall = mockQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE knowledge_gaps SET recommendation_status = \$1/.test(sql),
    );
    expect(claimCall).toBeDefined();
    const [claimSql] = claimCall as [string, unknown[]];
    expect(claimSql).toContain("status != 'resolved'");
  });

  it('未解決(status=open)のギャップは通常どおり承認できる(回帰)', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/UPDATE knowledge_gaps SET recommendation_status = \$1/.test(sql)) {
        return Promise.resolve({
          rows: [{ user_question: '返品できますか', detection_source: 'no_rag', frequency: 1 }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await approveGapRecommendation(GAP_ID, TENANT, false);

    expect(result.ok).toBe(true);
  });
});

describe('addKnowledgeFromGap — 「解決済み→再承認→再知識化」の逐次的な重複作成を拒否する', () => {
  it('status=resolvedのギャップ(recommendation_statusが再承認でapprovedに戻っていても)からは2件目のFAQを作らない', async () => {
    // claim UPDATE(WHERE ... AND recommendation_status='approved' AND status != 'resolved')
    // は既にresolved済みのため0行。probe SELECTでstatus='resolvedを確認しalready_resolvedを返す。
    mockQuery.mockImplementation((sql: string) => {
      if (/UPDATE knowledge_gaps\s+SET recommendation_status = 'resolved'/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/SELECT tenant_id, recommendation_status, status FROM knowledge_gaps/.test(sql)) {
        // 再承認によりrecommendation_status='approved'に戻っているが、statusは'resolved'のまま
        return Promise.resolve({ rows: [{ tenant_id: TENANT, recommendation_status: 'approved', status: 'resolved' }] });
      }
      if (/INSERT INTO faq_docs/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 999 }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await addKnowledgeFromGap(GAP_ID, '2件目の回答', null, TENANT, false);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toBe('already_resolved');
    // faq_docsへのINSERTは一度も発生しない(重複FAQが作られていない)
    const insertCalls = mockQuery.mock.calls.filter(([sql]: [string]) => /INSERT INTO faq_docs/.test(sql));
    expect(insertCalls).toHaveLength(0);

    // モックの分岐はSQL文の中身を見ないため、claim UPDATEのWHERE句に
    // 実際にstatus != 'resolved'が含まれることを直接検証する。
    const claimCall = mockQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE knowledge_gaps\s+SET recommendation_status = 'resolved'/.test(sql),
    );
    expect(claimCall).toBeDefined();
    const [claimSql] = claimCall as [string, unknown[]];
    expect(claimSql).toContain("status != 'resolved'");
  });

  it('未解決(status=open)かつapprovedのギャップは通常どおり知識化できる(回帰)', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/UPDATE knowledge_gaps\s+SET recommendation_status = 'resolved'/.test(sql)) {
        return Promise.resolve({
          rows: [{ tenant_id: TENANT, user_question: '返品できますか', detection_source: 'no_rag', frequency: 1 }],
        });
      }
      if (/INSERT INTO faq_docs/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 999 }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await addKnowledgeFromGap(GAP_ID, '回答', null, TENANT, false);

    expect(result.ok).toBe(true);
  });
});
