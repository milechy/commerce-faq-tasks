// src/api/admin/knowledge/bookChunkOptimisticLockSqlIntegration.test.ts
//
// PUT /v1/admin/knowledge/book-pdf/chunks/:chunkId の楽観ロックを「実際の Postgres」
// に対して検証する。
//
// ★このテストが埋める穴★
// bookPdfRoutes.test.ts はDBをモックしており、CASのUPDATE文が0行返すかどうかを
// JS側で自前に再実装したロジック(makeChunkDb)で判定していた。そのため、実際の
// SQLの WHERE 句(`IS NOT DISTINCT FROM` / `$4::boolean IS NOT TRUE OR ...`)を
// 書き換えても、モックのJS判定が別に生き残っていれば単体テストは落ちない
// (実際に確認済み: WHERE句から版チェック条件を削除しても44件全通過した)。
// ここでは実データを実Postgresに投入し、CASのUPDATE自体が版不一致を弾くこと・
// NULL同士(未編集チャンク)を正しく一致判定すること・pending中CASと同時に
// 効くことを、レスポンスだけでなくDBの実際の行の状態で証明する。
//
// ★安全装置: 専用の環境変数を使わず HERMES_MCP_SQL_TEST_DATABASE_URL を再利用する★
// SCRIPTS/ci-hermes-schema.sh に faq_embeddings / book_uploads を同居させたのと
// 同じ理由(Gate 4 は使い捨てPostgres・同一DBをジョブ全体で使い回す方針)。
//
// ★モックの範囲について★
// registerBookPdfRoutes は db を関数引数で受け取る設計(DI)のため、他の
// SQL統合テスト(hermesConsentSqlIntegration等)と違い jest.mock("../../../lib/db")
// は不要 — 実Poolをそのまま渡すだけでよい。embedText だけモックする
// (このテストは product_catalog スキーマのフィールドだけを使い埋め込み対象外の
// 経路を通すため実際には呼ばれない想定だが、想定が崩れても実APIへ絶対に
// 到達させないための安全網)。
//
// ローカルで実行する場合:
//   createdb hermes_sql_test
//   HERMES_MCP_SQL_TEST_DATABASE_URL=postgresql://localhost/hermes_sql_test \
//     bash SCRIPTS/ci-billing-schema.sh (DATABASE_URL に読み替えて実行)
//   HERMES_MCP_SQL_TEST_DATABASE_URL=postgresql://localhost/hermes_sql_test \
//     bash SCRIPTS/ci-hermes-schema.sh (同上)
//   HERMES_MCP_SQL_TEST_DATABASE_URL=postgresql://localhost/hermes_sql_test \
//     npx jest src/api/admin/knowledge/bookChunkOptimisticLockSqlIntegration.test.ts

import { Pool } from "pg";
import express from "express";
import { request } from "../../../../tests/helpers/testServer";

const DB_URL = process.env.HERMES_MCP_SQL_TEST_DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

jest.mock("../../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
}));

// 想定では呼ばれない(product_catalog スキーマは principleSchemaMap 対応表に
// 無く embeddingEligible=false になる)が、実OpenAI APIへ絶対に到達させない
// ための安全網としてモックする。
jest.mock("../../../agent/llm/openaiEmbeddingClient", () => ({
  embedText: jest.fn().mockRejectedValue(new Error("このテストでは呼ばれない想定")),
}));

import { registerBookPdfRoutes } from "./bookPdfRoutes";

let db: Pool;

function makeApp(opts: { role?: string; tenantId?: string | null; userId?: string } = {}) {
  const { role = "client_admin", tenantId = "tenant-a", userId = "user-1" } = opts;
  const app = express();
  app.use(express.json());
  const noopAuth = (req: any, _res: any, next: any) => {
    req.user = { id: userId, role, tenantId, email: "" };
    next();
  };
  registerBookPdfRoutes(app, db, noopAuth, (_r: any, _s: any, n: any) => n(), (_r: any, _s: any, n: any) => n());
  return app;
}

// faq_embeddings.embedding は NOT NULL(VECTOR(1536))。PUTハンドラは
// product_catalog フィールドのみを使う限り embedding 列を一切触らないため
// (embeddingEligible=false)、値そのものは何でもよい。挿入を通すためのダミー。
const ZERO_VECTOR = `[${Array.from({ length: 1536 }, () => 0).join(",")}]`;

async function insertBookUpload(tenantId: string): Promise<number> {
  const res = await db.query<{ id: number }>(
    `INSERT INTO book_uploads (tenant_id, title, original_filename, storage_path, file_size_bytes)
     VALUES ($1, 'テスト書籍', 'x.pdf', 'x/x.pdf', 100)
     RETURNING id`,
    [tenantId]
  );
  return res.rows[0]!.id;
}

async function insertChunk(opts: {
  tenantId: string;
  bookId: number;
  metadata: Record<string, unknown>;
}): Promise<number> {
  const res = await db.query<{ id: number }>(
    `INSERT INTO faq_embeddings (tenant_id, text, embedding, metadata, is_excluded_from_search)
     VALUES ($1, 'dummy', $2::vector, $3::jsonb, false)
     RETURNING id`,
    [opts.tenantId, ZERO_VECTOR, JSON.stringify({ source: "book", book_id: opts.bookId, chunk_index: 0, ...opts.metadata })]
  );
  return res.rows[0]!.id;
}

async function readMetadata(chunkId: number): Promise<Record<string, unknown>> {
  const res = await db.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM faq_embeddings WHERE id = $1`,
    [chunkId]
  );
  return res.rows[0]!.metadata;
}

d("PUT /v1/admin/knowledge/book-pdf/chunks/:chunkId — 楽観ロック(実Postgres)", () => {
  beforeAll(() => {
    db = new Pool({ connectionString: DB_URL, options: "-c timezone=UTC" });
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE faq_embeddings, book_uploads RESTART IDENTITY CASCADE");
  });

  it("版が一致すれば更新される(1行更新・content_updated_atが進む)", async () => {
    const bookId = await insertBookUpload("tenant-a");
    const chunkId = await insertChunk({
      tenantId: "tenant-a",
      bookId,
      metadata: { product_name: "旧商品", content_updated_at: "2020-01-01T00:00:00.000Z" },
    });

    const res = await request(makeApp())
      .put(`/v1/admin/knowledge/book-pdf/chunks/${chunkId}`)
      .send({ product_name: "新商品", expected_content_updated_at: "2020-01-01T00:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body.metadata.product_name).toBe("新商品");

    // レスポンスだけでなく実DBの行そのものを見る(モックでは検証できない部分)
    const metadata = await readMetadata(chunkId);
    expect(metadata["product_name"]).toBe("新商品");
    expect(metadata["content_updated_at"]).toBeDefined();
    expect(metadata["content_updated_at"]).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("版が不一致なら1行も更新されない(他人の変更が上書きされない) — 409(conflict)で、DBの行は一切変わらない", async () => {
    const bookId = await insertBookUpload("tenant-a");
    const chunkId = await insertChunk({
      tenantId: "tenant-a",
      bookId,
      metadata: { product_name: "誰かが既に保存した商品", content_updated_at: "2020-01-01T00:00:00.000Z" },
    });

    const res = await request(makeApp())
      .put(`/v1/admin/knowledge/book-pdf/chunks/${chunkId}`)
      .send({
        product_name: "自分が古いまま送った値",
        // 実際に保存されている版(2020-01-01T00:00:00.000Z)とは異なる、
        // 自分が読み込んだ時点の(古い)版を送る想定
        expected_content_updated_at: "2019-01-01T00:00:00.000Z",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflict");

    // ★核心: DBの行が実際に一切変わっていないことを直接SELECTで確認する★
    // (モックでは「サーバーがどう振る舞うと自分でJSで書いたか」しか検証できない)
    const metadata = await readMetadata(chunkId);
    expect(metadata["product_name"]).toBe("誰かが既に保存した商品");
    expect(metadata["content_updated_at"]).toBe("2020-01-01T00:00:00.000Z");
  });

  it("未編集チャンク(版がNULL)で expected も NULL なら更新される — IS NOT DISTINCT FROM の肝", async () => {
    const bookId = await insertBookUpload("tenant-a");
    // content_updated_at キー自体を持たない(=一度も編集されていない)チャンク。
    // metadata->>'content_updated_at' は SQL上 NULL になる。
    const chunkId = await insertChunk({
      tenantId: "tenant-a",
      bookId,
      metadata: { product_name: "未編集の商品" },
    });

    const res = await request(makeApp())
      .put(`/v1/admin/knowledge/book-pdf/chunks/${chunkId}`)
      .send({ product_name: "初めての編集", expected_content_updated_at: null });

    expect(res.status).toBe(200);

    const metadata = await readMetadata(chunkId);
    expect(metadata["product_name"]).toBe("初めての編集");
    // NULLだったcontent_updated_atが、この保存で初めて具体的な値を持つ
    expect(metadata["content_updated_at"]).toBeDefined();
    expect(metadata["content_updated_at"]).not.toBeNull();
  });

  it("版は一致していても、embedding_status='pending'がまだ新しい(反映処理中)間は更新されない — 2つのCAS条件が同じUPDATEで両方効く", async () => {
    const bookId = await insertBookUpload("tenant-a");
    const chunkId = await insertChunk({
      tenantId: "tenant-a",
      bookId,
      metadata: {
        product_name: "反映処理中の商品",
        content_updated_at: "2020-01-01T00:00:00.000Z",
        embedding_status: "pending",
        embedding_updated_at: new Date().toISOString(), // たった今pendingになった(新しい)
      },
    });

    const res = await request(makeApp())
      .put(`/v1/admin/knowledge/book-pdf/chunks/${chunkId}`)
      .send({
        product_name: "版は合っているのに弾かれるはず",
        expected_content_updated_at: "2020-01-01T00:00:00.000Z", // 版は一致させる
      });

    // 版は一致しているのに、pending中CASの条件だけで弾かれる(=同じUPDATEの
    // 中で2つの条件が独立してANDされている証拠)。エラーは「反映処理中」であって
    // 「conflict」ではない(版不一致とは原因が違うため)。
    expect(res.status).toBe(409);
    expect(res.body.error).not.toBe("conflict");

    const metadata = await readMetadata(chunkId);
    expect(metadata["product_name"]).toBe("反映処理中の商品");
  });

  it("版が不一致で、かつpending中CASの条件は通る(反映は完了済み)場合でも、版不一致のほうを理由として409(conflict)にする", async () => {
    const bookId = await insertBookUpload("tenant-a");
    const chunkId = await insertChunk({
      tenantId: "tenant-a",
      bookId,
      metadata: {
        product_name: "反映は完了済みの商品",
        content_updated_at: "2020-01-01T00:00:00.000Z",
        embedding_status: "done", // pending中CASの条件は通る(反映処理中ではない)
      },
    });

    const res = await request(makeApp())
      .put(`/v1/admin/knowledge/book-pdf/chunks/${chunkId}`)
      .send({
        product_name: "古い版のまま送る",
        expected_content_updated_at: "2019-01-01T00:00:00.000Z", // 版だけ不一致
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflict");

    const metadata = await readMetadata(chunkId);
    expect(metadata["product_name"]).toBe("反映は完了済みの商品");
    expect(metadata["embedding_status"]).toBe("done"); // pending化すらしていない(部分適用が無い)
  });
});
