// src/api/admin/agent/actionExecutorFaqEsSync.test.ts
//
// FAQ→ES同期の一本化(GID [LAUNCH][P0])で、actionExecutor.ts の delete_faq のみが
// ES同期を欠いていたことが判明した。それ以外の add_faq / update_faq /
// set_faq_published / save_faq などは既に faqCrudRoutes.ts 由来の
// insertEmbeddingAsync / upsertToEsAsync (= faqIndexSync.ts の再エクスポート) を
// 呼んでいたため変更していない。ここでは delete_faq が deleteFaqFromEs を
// 呼ぶことだけを確認する（他caseの回帰は既存の faqCrud/faqAdmin 系テストが担う）。

jest.mock("../../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockDeleteFaqFromEs = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../lib/knowledge/faqIndexSync", () => ({
  deleteFaqFromEs: (...args: unknown[]) => mockDeleteFaqFromEs(...args),
}));

import type { Pool } from "pg";
import { executeToolCall } from "./actionExecutor";

const TENANT = "acme";
const ACTOR = { role: "owner", email: "owner@example.com" };

function makeMockPool(queryImpl: jest.Mock): Pool {
  return { query: queryImpl } as unknown as Pool;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("executeToolCall: delete_faq → ES同期", () => {
  it("confirmed=true で削除すると deleteFaqFromEs(tenantId, id) を呼ぶ", async () => {
    const queryMock = jest
      .fn()
      // SELECT id, tenant_id, question FROM faq_docs WHERE id = $1
      .mockResolvedValueOnce({ rows: [{ id: 7, tenant_id: TENANT, question: "Q" }] })
      // DELETE FROM faq_embeddings ...
      .mockResolvedValueOnce({ rows: [] })
      // DELETE FROM faq_docs ...
      .mockResolvedValueOnce({ rows: [] });
    const db = makeMockPool(queryMock);

    const result = await executeToolCall(
      "delete_faq",
      { id: 7, confirmed: true },
      TENANT,
      db,
      "session-1",
      false,
      ACTOR
    );

    expect(result).toContain("削除しました");
    expect(mockDeleteFaqFromEs).toHaveBeenCalledWith(TENANT, 7);
  });

  it("他テナント所有のFAQは削除せず、ESにも同期しない", async () => {
    const queryMock = jest.fn().mockResolvedValueOnce({
      rows: [{ id: 7, tenant_id: "other-tenant", question: "Q" }],
    });
    const db = makeMockPool(queryMock);

    const result = await executeToolCall(
      "delete_faq",
      { id: 7, confirmed: true },
      TENANT,
      db,
      "session-1",
      false,
      ACTOR
    );

    expect(result).toContain("アクセス権限がありません");
    expect(mockDeleteFaqFromEs).not.toHaveBeenCalled();
  });

  it("confirmed未指定なら削除もES同期も実行しない", async () => {
    const queryMock = jest.fn();
    const db = makeMockPool(queryMock);

    const result = await executeToolCall(
      "delete_faq",
      { id: 7 },
      TENANT,
      db,
      "session-1",
      false,
      ACTOR
    );

    expect(result).toContain("確認が必要です");
    expect(queryMock).not.toHaveBeenCalled();
    expect(mockDeleteFaqFromEs).not.toHaveBeenCalled();
  });
});
