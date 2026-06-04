// src/admin/http/faqAdminRoutes.test.ts
// F1(HIGH): DELETE /admin/faqs/:id が faq_docs と faq_embeddings を連鎖削除することを検証。
// faq_embeddings は物理FKを持たず metadata->>'faq_id' 参照のため ON DELETE CASCADE が効かず、
// 旧ルートが embeddings を残して orphan を量産していた回帰を防ぐ。

import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// 外部依存モック（DELETE 経路は db.query のみ使用。残りは module ロード用にスタブ）
// ---------------------------------------------------------------------------
jest.mock("../../lib/db", () => ({
  pool: { query: jest.fn() },
}));
jest.mock("./supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = { app_metadata: { tenant_id: "tenant-a", role: "client_admin" } };
    next();
  },
}));
jest.mock("../../agent/llm/openaiEmbeddingClient", () => ({ embedText: jest.fn() }));
jest.mock("../../search/langIndex", () => ({
  resolveFaqWriteIndex: jest.fn(() => "faq_tenant-a"),
}));

import { pool } from "../../lib/db";
import { registerFaqAdminRoutes } from "./faqAdminRoutes";

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

function makeApp() {
  const app = express();
  app.use(express.json());
  registerFaqAdminRoutes(app);
  return app;
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe("DELETE /admin/faqs/:id — faq_embeddings 連鎖削除 (F1)", () => {
  it("正常系: faq_docs 削除に続けて faq_embeddings も同一 tenant/faq_id で削除する", async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5 }] }) // faq_docs 削除
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // faq_embeddings 削除

    const res = await request(makeApp()).delete("/admin/faqs/5");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: 5 });
    expect(mockQuery).toHaveBeenCalledTimes(2);

    // 2 回目の呼び出しが faq_embeddings の連鎖削除であること
    const [embedSql, embedParams] = mockQuery.mock.calls[1];
    expect(embedSql).toMatch(/DELETE FROM faq_embeddings/);
    expect(embedSql).toMatch(/metadata->>'faq_id'/);
    expect(embedParams).toEqual(["tenant-a", 5]);
  });

  it("404: FAQ が存在しない場合は faq_embeddings 削除を実行しない", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // faq_docs 該当なし

    const res = await request(makeApp()).delete("/admin/faqs/999");

    expect(res.status).toBe(404);
    expect(mockQuery).toHaveBeenCalledTimes(1); // embeddings 削除は呼ばれない
  });

  it("バリデーション: id が数値でない場合は 400 で DB を触らない", async () => {
    const res = await request(makeApp()).delete("/admin/faqs/not-a-number");

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
