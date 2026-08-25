// src/admin/http/faqAdminRoutesEsExcludeFlag.test.ts
//
// ナレッジ配線是正 P5 (Asana GID 1217826843894174):
// PUT /admin/faqs/:id が upsertFaqToEs を5引数で呼んでおり、is_excluded_from_search
// を引き継いでいなかった。検索除外済みのFAQを質問/回答の編集だけで更新すると、
// ES 側の除外フラグが黙って false に巻き戻り BM25 検索に復活していた
// (actionExecutor.ts:1091 で先に見つかった同一バグの残存側。2026-08-25 是正)。
//
// POST(新規作成)は既存行の除外状態が無いため5引数のままで正しい。
// バグの対象は PUT(既存行の編集)のみ。

jest.mock("../../lib/db", () => ({ pool: { query: jest.fn() } }));
jest.mock("../../agent/llm/openaiEmbeddingClient", () => ({
  embedText: jest.fn().mockResolvedValue(Array.from({ length: 8 }, () => 0)),
}));
jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("./supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (req: any, res: any, next: any) => {
    const auth: string = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "Missing Bearer token" });
    req.supabaseUser = JSON.parse(Buffer.from(auth.slice(7), "base64").toString("utf8"));
    next();
  },
}));

const upsertFaqToEsMock = jest.fn();
jest.mock("../../lib/knowledge/faqIndexSync", () => ({
  upsertFaqToEs: (...args: unknown[]) => upsertFaqToEsMock(...args),
  deleteFaqFromEs: jest.fn(),
}));

import express from "express";
import request from "supertest";
import { pool } from "../../lib/db";
import { registerFaqAdminRoutes } from "./faqAdminRoutes";

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

function makeApp() {
  const app = express();
  app.use(express.json());
  registerFaqAdminRoutes(app);
  return app;
}

function bearerOf(user: object): string {
  return `Bearer ${Buffer.from(JSON.stringify(user)).toString("base64")}`;
}

const CLIENT_A = { app_metadata: { role: "client_admin", tenant_id: "tenant-a" } };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("PUT /admin/faqs/:id — ES検索除外フラグの引き継ぎ", () => {
  it("除外済み(is_excluded_from_search=true)のFAQを編集しても、ESへの引き継ぎで除外が維持される", async () => {
    mockQuery.mockResolvedValue({
      rowCount: 1,
      rows: [{
        id: 1, tenant_id: "tenant-a", question: "新しい質問", answer: "新しい回答",
        category: null, tags: null, is_published: true, is_excluded_from_search: true,
        created_at: "", updated_at: "",
      }],
    });
    const app = makeApp();

    const res = await request(app)
      .put("/admin/faqs/1")
      .set("Authorization", bearerOf(CLIENT_A))
      .send({ question: "新しい質問", answer: "新しい回答" });

    expect(res.status).toBe(200);
    expect(upsertFaqToEsMock).toHaveBeenCalledWith(
      "tenant-a", 1, "新しい質問", "新しい回答", true, true,
    );
  });

  it("除外されていない(is_excluded_from_search=false)FAQの編集では false が渡る(回帰)", async () => {
    mockQuery.mockResolvedValue({
      rowCount: 1,
      rows: [{
        id: 2, tenant_id: "tenant-a", question: "q2", answer: "a2",
        category: null, tags: null, is_published: true, is_excluded_from_search: false,
        created_at: "", updated_at: "",
      }],
    });
    const app = makeApp();

    await request(app)
      .put("/admin/faqs/2")
      .set("Authorization", bearerOf(CLIENT_A))
      .send({ question: "q2", answer: "a2" });

    expect(upsertFaqToEsMock).toHaveBeenCalledWith(
      "tenant-a", 2, "q2", "a2", true, false,
    );
  });

  it("UPDATE の RETURNING が is_excluded_from_search を含む", async () => {
    mockQuery.mockResolvedValue({
      rowCount: 1,
      rows: [{
        id: 3, tenant_id: "tenant-a", question: "q3", answer: "a3",
        category: null, tags: null, is_published: true, is_excluded_from_search: true,
        created_at: "", updated_at: "",
      }],
    });
    const app = makeApp();

    await request(app)
      .put("/admin/faqs/3")
      .set("Authorization", bearerOf(CLIENT_A))
      .send({ question: "q3", answer: "a3" });

    const updateCall = mockQuery.mock.calls.find(([sql]: [string]) => /UPDATE faq_docs/.test(sql));
    expect(updateCall![0]).toContain("is_excluded_from_search");
  });
});
