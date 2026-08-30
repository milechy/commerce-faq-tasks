// src/api/admin/knowledge/bookPdfRoutes.ts

// Phase44: 書籍PDFアップロードAPI — AES-256-GCM暗号化 + Supabase Storage
// Phase59: ZIPアップロード対応（複数PDF一括展開）

import type { Express, NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";
import crypto from "crypto";
import path from "path";
import AdmZip from "adm-zip";
import type { Pool } from "pg";
import { supabaseAdmin } from "../../../auth/supabaseClient";
import { pipelineQueue } from "../../../lib/book-pipeline/pipelineQueue";
import { deleteBookChunkFromEs, setBookChunkExcludedInEs, upsertToEs } from "../../../lib/book-pipeline/embedAndStore";
import { decryptText } from "../../../lib/crypto/textEncrypt";
import { logger } from '../../../lib/logger';
import { embedText } from "../../../agent/llm/openaiEmbeddingClient";
import { buildSearchText } from "../../../agent/knowledge/bookStructurizer";
import { buildSearchTextFields, PRINCIPLE_SCHEMA_MAPPINGS } from "../../../agent/psychology/principleSchemaMap";
import { KNOWN_SCHEMAS } from "../../../lib/book-pipeline/contentAnalyzer";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;
type BookPdfUser = { id?: string; role?: string; tenantId?: string | null };
type BookPdfReq = Request & { user?: BookPdfUser };

// GID 1217040818410419: 書籍/PDF取り込みはR2C運用限定(2026-07-31決定)。テナント(client_admin)から
// の投入導線をUIから外すだけでは直叩きで破られるため、投入系の2エンドポイントにサーバー側の
// ガードを置く。専門用語(403/権限/MIME等)を出さず、優しい日本語で拒否する。
const BOOK_PDF_TENANT_RESTRICTED_MESSAGE =
  "この機能は現在ご利用いただけません。内容を文章で教えていただければ、代わりに登録いたします。";

// ── 定数 ──────────────────────────────────────────────────────────────────
const ZIP_MIMETYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-zip",
  "multipart/x-zip",
]);
const MAX_ZIP_PDF_COUNT = 20;                  // ZIP内PDFファイル数上限
const MAX_ZIP_EXPANDED_BYTES = 200 * 1024 * 1024; // 展開後合計サイズ上限(200MB)
const CHUNK_EDIT_HISTORY_LIMIT = 20; // metadata.edit_history に保持する件数上限
// T6再レビュー(2026-08-29): embedding_status='pending' 書き込み後にプロセスが落ちると
// 従来はチャンクが永久に編集不能(409固定)になっていた。book_pipeline_jobs の
// checkStuckJobs()(started_at 1h超で検出)と同じ考え方で、一定時間より古い pending は
// 期限切れとみなしCASで奪えるようにする。同期実装の再埋め込みは数秒で終わるため5分で十分。
const CHUNK_STALE_PENDING_MS = 5 * 60 * 1000;

// ── Multer: メモリバッファ、50MB上限、PDF + ZIP ────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/pdf" && !ZIP_MIMETYPES.has(file.mimetype)) {
      cb(new Error("PDFまたはZIPファイルのみアップロードできます"));
      return;
    }
    cb(null, true);
  },
});

// ── AES-256-GCM バッファ暗号化 ─────────────────────────────────────────────
// authTag (16バイト) を末尾に連結して返す
function encryptBuffer(
  buffer: Buffer,
  keyHex: string
): { encrypted: Buffer; iv: string } {
  const key = Buffer.from(keyHex, "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([encrypted, authTag]),
    iv: iv.toString("hex"),
  };
}

// ── tenantId 解決（bodyから禁止 — CLAUDE.md） ─────────────────────────────
function resolveUploadTenantId(req: Request): string | null {
  const user = (req as BookPdfReq).user;
  if (user?.role === "super_admin") {
    // super_admin: queryパラメータで対象テナントを指定可
    const fromQuery =
      (req.query.tenant as string | undefined) ||
      (req.query.tenant_id as string | undefined);
    return fromQuery || user?.tenantId || null;
  }
  return user?.tenantId ?? null;
}

// ── チャンク編集: metadata から principleSchemaMap.ts 対応表のスキーマ種別を判定 ──
// book_uploads.content_type は使わない: 経路7(embedAndStore, schemaFields)は
// 書籍ごとに決まる content_type に従うが、経路8(bookStructurizer)は書籍の
// content_type に関わらず常に psychology_book 形のフィールドを書く。同じ book_id
// 配下に2経路のチャンクが混在しうるため、チャンク自身が持つキーで判定する。
function detectPrincipleContentType(metadata: Record<string, unknown>): string | null {
  for (const mapping of PRINCIPLE_SCHEMA_MAPPINGS) {
    const schemaKeys = (KNOWN_SCHEMAS[mapping.contentType] ?? []).map((f) => f.key);
    if (schemaKeys.some((k) => typeof metadata[k] === "string" && metadata[k] !== "")) {
      return mapping.contentType;
    }
  }
  return null;
}

// ── PDF 1件処理ヘルパー ────────────────────────────────────────────────────
// 単体PDFアップロードとZIP展開後の各PDFに共通して使う内部関数
type ProcessResult =
  | { ok: true; bookId: number; fileName: string; title: string }
  | { ok: false; fileName: string; error: string };

async function processOnePdf(
  buffer: Buffer,
  fileName: string,
  title: string,
  tenantId: string,
  userId: string,
  db: Pool
): Promise<ProcessResult> {
  const encKey = process.env.KNOWLEDGE_ENCRYPTION_KEY;
  let uploadBuffer = buffer;
  let encryptionIv: string | null = null;

  if (encKey) {
    const result = encryptBuffer(buffer, encKey);
    uploadBuffer = result.encrypted;
    encryptionIv = result.iv;
  } else {
    logger.warn("[book-pdf] KNOWLEDGE_ENCRYPTION_KEY未設定: 平文保存フォールバック");
  }

  if (!supabaseAdmin) {
    return { ok: false, fileName, error: "ストレージサービスが設定されていません" };
  }

  const storagePath = `${tenantId}/${crypto.randomUUID()}.pdf${encKey ? ".enc" : ""}`;

  const { error: storageError } = await supabaseAdmin.storage
    .from("book-pdfs")
    .upload(storagePath, uploadBuffer, {
      contentType: "application/octet-stream",
      upsert: false,
    });

  if (storageError) {
    logger.error("[book-pdf] Storage error:", storageError.message);
    return { ok: false, fileName, error: "アップロードに失敗しました。もう一度お試しください" };
  }

  const result = await db.query(
    `INSERT INTO book_uploads
       (tenant_id, title, original_filename, storage_path, file_size_bytes, encryption_iv, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, title, status, created_at`,
    [tenantId, title, fileName, storagePath, buffer.length, encryptionIv, userId || null]
  );

  const bookId: number = result.rows[0].id;
  void pipelineQueue.enqueue(bookId, { db });

  return { ok: true, bookId, fileName, title };
}

// ── ZIP展開処理 ───────────────────────────────────────────────────────────
async function handleZipUpload(
  zipBuffer: Buffer,
  tenantId: string,
  userId: string,
  db: Pool,
  res: Response
): Promise<Response> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    return res.status(400).json({ error: "ZIPファイルの読み込みに失敗しました。正しいZIPファイルを選択してください。" });
  }

  const entries = zip.getEntries();

  // セキュリティ: パストラバーサル検出
  for (const entry of entries) {
    const normalizedName = entry.entryName.replace(/\\/g, "/");
    if (normalizedName.includes("../") || normalizedName.includes("..\\")) {
      return res.status(400).json({ error: "不正なファイルパスが含まれています。別のZIPファイルをお試しください。" });
    }
  }

  // PDFエントリを抽出（__MACOSX, ドットファイル, ディレクトリを除外）
  const pdfEntries = entries.filter((e) => {
    const name = e.entryName.replace(/\\/g, "/");
    return (
      !e.isDirectory &&
      name.toLowerCase().endsWith(".pdf") &&
      !name.startsWith("__MACOSX/") &&
      !path.basename(name).startsWith(".")
    );
  });

  if (pdfEntries.length === 0) {
    return res.status(400).json({ error: "ZIPファイル内にPDFが見つかりません。PDFファイルを含むZIPを選択してください。" });
  }

  if (pdfEntries.length > MAX_ZIP_PDF_COUNT) {
    return res.status(400).json({
      error: `PDFの数が多すぎます。1つのZIPには${MAX_ZIP_PDF_COUNT}件まで入れてください。（現在: ${pdfEntries.length}件）`,
    });
  }

  // セキュリティ: ZIP爆弾対策（展開後合計サイズ）
  let totalUncompressedBytes = 0;
  for (const entry of pdfEntries) {
    totalUncompressedBytes += entry.header.size;
    if (totalUncompressedBytes > MAX_ZIP_EXPANDED_BYTES) {
      return res.status(400).json({
        error: `ZIPを展開した合計サイズが上限（200MB）を超えています。ファイルを分割してアップロードしてください。`,
      });
    }
  }

  // 各PDFを順次処理
  const results: Array<{ fileName: string; bookId?: number; status: "ok" | "error"; error?: string }> = [];
  for (const entry of pdfEntries) {
    const fileName = path.basename(entry.entryName);
    const title = fileName.replace(/\.pdf$/i, "");
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = entry.getData();
    } catch {
      results.push({ fileName, status: "error", error: "ファイルの展開に失敗しました" });
      continue;
    }

    const result = await processOnePdf(pdfBuffer, fileName, title, tenantId, userId, db);
    if (result.ok) {
      results.push({ fileName, bookId: result.bookId, status: "ok" });
    } else {
      results.push({ fileName, status: "error", error: result.error });
    }
  }

  const successCount = results.filter((r) => r.status === "ok").length;
  logger.info(`[book-pdf] ZIP upload: ${successCount}/${pdfEntries.length} PDFs processed for tenant ${tenantId}`);

  return res.status(201).json({
    message: `${successCount}件のPDFをアップロードしました`,
    total: pdfEntries.length,
    results,
  });
}

// ── ルート登録 ─────────────────────────────────────────────────────────────
// 2026-08-25 是正時に調査した結果、_requireKnowledgeTenant は意図的に未使用のまま
// 残す。理由: この関数のミドルウェアは req.query.tenant / tenant_id からの
// テナント一致判定であり、本ファイルの全7ルートは :id / :chunkId というパス
// パラメータでリソースを特定する(query.tenant は送られない)。適用しても
// requestedTenant が常に空のため実質的に何も検証せず通過するだけで、
// 「多層防御が効いている」という誤った安心感だけを与える。実際の所有者検証は
// 各ルート内のDBルックアップ+tenant_id比較(:412,:461,:534,:661,:740,:809)が
// 唯一の実装であり、これを2箇所目の実装に複製しない(CLAUDE.md 禁止6)。
// POST /book-pdf(アップロード)は別途 super_admin 限定のインライン判定を持つため
// なおさら不要(requireKnowledgeTenant は super_admin を無条件通過させる)。
export function registerBookPdfRoutes(
  app: Express,
  db: Pool,
  knowledgeAuth: Middleware,
  requireKnowledgeRole: Middleware,
  _requireKnowledgeTenant: Middleware
): void {
  // -----------------------------------------------------------------------
  // POST /v1/admin/knowledge/book-pdf
  // multipart/form-data: file (PDF) + title (text)
  // multerエラーはコールバックパターンで処理（MulterError + fileFilter Error）
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/knowledge/book-pdf",
    knowledgeAuth,
    requireKnowledgeRole,
    // GID 1217040818410419: 書籍/PDF投入はR2C運用限定。multer(ファイル受信)より前に弾き、
    // 対象外ロールの通信・ストレージ処理を無駄にしない。
    (req: Request, res: Response, next: NextFunction) => {
      const isSuperAdmin = (req as BookPdfReq).user?.role === "super_admin";
      if (!isSuperAdmin) {
        res.status(403).json({ error: BOOK_PDF_TENANT_RESTRICTED_MESSAGE });
        return;
      }
      next();
    },
    (req: Request, res: Response, next: NextFunction) => {
      upload.single("file")(req, res, (multerErr: unknown) => {
        if (multerErr instanceof MulterError) {
          if (multerErr.code === "LIMIT_FILE_SIZE") {
            res.status(413).json({ error: "ファイルサイズが大きすぎます（上限: 50MB）" });
            return;
          }
          res.status(400).json({ error: multerErr.message });
          return;
        }
        if (multerErr instanceof Error) {
          res.status(400).json({ error: multerErr.message });
          return;
        }
        next();
      });
    },
    async (req: Request, res: Response) => {
      try {
        const file = req.file;
        if (!file) {
          return res.status(400).json({ error: "ファイルを選択してください" });
        }

        // tenantId: JWT から取得（body 禁止）
        const tenantId = resolveUploadTenantId(req);
        if (!tenantId) {
          return res.status(403).json({ error: "テナント情報が取得できません" });
        }

        const userId: string =
          (req as BookPdfReq).user?.id ?? "";

        // ── ZIPファイルの処理 ────────────────────────────────────────────
        if (ZIP_MIMETYPES.has(file.mimetype)) {
          return await handleZipUpload(file.buffer, tenantId, userId, db, res);
        }

        // ── 単体PDFの処理（従来ロジック） ────────────────────────────────
        // multerはContent-Dispositionのfilenameをlatin1でデコードするため、
        // 日本語ファイル名はlatin1→utf8で再デコードが必要
        let originalFilename = file.originalname;
        try {
          originalFilename = Buffer.from(file.originalname, "latin1").toString("utf8");
        } catch {
          originalFilename = file.originalname;
        }

        const title = ((req.body as Record<string, unknown>)?.title as string | undefined)?.trim();
        if (!title) {
          return res.status(400).json({ error: "書籍のタイトルを入力してください" });
        }

        const result = await processOnePdf(
          file.buffer, originalFilename, title, tenantId, userId, db
        );

        if (!result.ok) {
          return res.status(500).json({ error: result.error });
        }

        // storage_path はレスポンスに含めない（セキュリティ）
        const dbRow = await db.query(
          "SELECT id, title, status, created_at FROM book_uploads WHERE id = $1",
          [result.bookId]
        );
        return res.status(201).json(dbRow.rows[0]);
      } catch (err: unknown) {
        logger.error(
          "[book-pdf] POST error:",
          err instanceof Error ? err.message : String(err)
        );
        return res.status(500).json({
          error: "アップロードに失敗しました。もう一度お試しください",
        });
      }
    }
  );

  // -----------------------------------------------------------------------
  // GET /v1/admin/knowledge/book-pdf
  // super_admin: 全テナント or ?tenant=xxx でフィルタ
  // client_admin: 自テナントのみ
  // -----------------------------------------------------------------------
  app.get(
    "/v1/admin/knowledge/book-pdf",
    knowledgeAuth,
    requireKnowledgeRole,
    async (req: Request, res: Response) => {
      const user = (req as BookPdfReq).user;
      const isSuperAdmin = user?.role === "super_admin";

      let tenantId: string | null = null;
      if (isSuperAdmin) {
        tenantId =
          (req.query.tenant as string | undefined) ||
          (req.query.tenant_id as string | undefined) ||
          null;
      } else {
        tenantId = user?.tenantId ?? null;
        if (!tenantId) {
          return res.status(403).json({ error: "テナント情報が取得できません" });
        }
      }

      try {
        const params: unknown[] = [];
        let sql =
          "SELECT id, tenant_id, title, original_filename, status, page_count, chunk_count, file_size_bytes, created_at FROM book_uploads";

        if (tenantId) {
          params.push(tenantId);
          sql += " WHERE tenant_id = $1";
        }
        sql += " ORDER BY created_at DESC";

        const result = await db.query(sql, params);
        return res.json({ books: result.rows, total: result.rows.length });
      } catch (err: unknown) {
        logger.error(
          "[book-pdf] GET error:",
          err instanceof Error ? err.message : String(err)
        );
        return res.status(500).json({ error: "書籍一覧の取得に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // GET /v1/admin/knowledge/book-pdf/:id
  // storage_path はレスポンスに含めない
  // -----------------------------------------------------------------------
  app.get(
    "/v1/admin/knowledge/book-pdf/:id",
    knowledgeAuth,
    requireKnowledgeRole,
    async (req: Request, res: Response) => {
      const user = (req as BookPdfReq).user;
      const isSuperAdmin = user?.role === "super_admin";

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: "無効なIDです" });
      }

      try {
        const result = await db.query(
          `SELECT id, tenant_id, title, original_filename, status, page_count,
                  chunk_count, file_size_bytes, error_message, uploaded_by,
                  content_type, content_type_label, suggested_schema,
                  schema_confidence, schema_reasoning, created_at, updated_at
           FROM book_uploads WHERE id = $1`,
          [id]
        );
        if (result.rows.length === 0) {
          return res.status(404).json({ error: "書籍が見つかりません" });
        }

        const book = result.rows[0] as Record<string, unknown>;
        if (!isSuperAdmin && book.tenant_id !== user?.tenantId) {
          return res
            .status(403)
            .json({ error: "他のテナントのデータにはアクセスできません" });
        }

        return res.json(book);
      } catch (err: unknown) {
        logger.error(
          "[book-pdf] GET/:id error:",
          err instanceof Error ? err.message : String(err)
        );
        return res.status(500).json({ error: "書籍詳細の取得に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // DELETE /v1/admin/knowledge/book-pdf/:id
  // 自テナント or super_admin のみ
  // Storage + DB + faq_embeddings を削除
  // -----------------------------------------------------------------------
  app.delete(
    "/v1/admin/knowledge/book-pdf/:id",
    knowledgeAuth,
    requireKnowledgeRole,
    async (req: Request, res: Response) => {
      const user = (req as BookPdfReq).user;
      const isSuperAdmin = user?.role === "super_admin";

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: "無効なIDです" });
      }

      try {
        const lookup = await db.query(
          "SELECT id, tenant_id, storage_path FROM book_uploads WHERE id = $1",
          [id]
        );
        if (lookup.rows.length === 0) {
          return res.status(404).json({ error: "書籍が見つかりません" });
        }

        const book = lookup.rows[0] as {
          id: number;
          tenant_id: string;
          storage_path: string;
        };
        if (!isSuperAdmin && book.tenant_id !== user?.tenantId) {
          return res
            .status(403)
            .json({ error: "他のテナントのデータにはアクセスできません" });
        }

        // Supabase Storage から削除（best-effort）
        if (supabaseAdmin && book.storage_path) {
          const { error: storageErr } = await supabaseAdmin.storage
            .from("book-pdfs")
            .remove([book.storage_path]);
          if (storageErr) {
            logger.warn(
              "[book-pdf] Storage delete warning:",
              storageErr.message
            );
          }
        }

        // ES ドキュメントIDを先に確認しておく(削除後には計算できないため)。
        // 2026-08-25 是正: 以前は faq_embeddings のみ削除し ES を残していたため、
        // 削除した書籍が BM25 検索で引け続けていた。
        const chunkRows = await db.query<{ chunk_index: number }>(
          `SELECT (metadata->>'chunk_index')::int AS chunk_index
           FROM faq_embeddings
           WHERE metadata->>'source' = 'book' AND metadata->>'book_id' = $1::text`,
          [id]
        );

        // 関連 faq_embeddings 削除
        await db.query(
          `DELETE FROM faq_embeddings
           WHERE metadata->>'source' = 'book' AND metadata->>'book_id' = $1::text`,
          [id]
        );

        // ES ドキュメント削除(best-effort)
        const esUrl = process.env.ES_URL;
        if (esUrl) {
          await Promise.all(
            chunkRows.rows.map((r) =>
              deleteBookChunkFromEs(esUrl, book.tenant_id, `book_${id}_chunk_${r.chunk_index}`)
            )
          );
        }

        // book_uploads レコード削除
        await db.query("DELETE FROM book_uploads WHERE id = $1", [id]);

        return res.json({ ok: true, deleted: id });
      } catch (err: unknown) {
        logger.error(
          "[book-pdf] DELETE error:",
          err instanceof Error ? err.message : String(err)
        );
        return res.status(500).json({ error: "削除に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // PATCH /v1/admin/knowledge/book-pdf/:id/search-visibility
  // 書籍チャンクを削除せずに検索から外す/戻す(可逆)。
  //
  // tenant_id='global' の行はフラグ無しに全テナントの回答へ引かれる
  // (src/search/pgvectorSearch.ts:62)。投入内容に問題が見つかったとき、
  // これまでは DELETE(Storage ごと消える不可逆操作)しか手が無かった。
  // -----------------------------------------------------------------------
  app.patch(
    "/v1/admin/knowledge/book-pdf/:id/search-visibility",
    knowledgeAuth,
    requireKnowledgeRole,
    async (req: Request, res: Response) => {
      const user = (req as BookPdfReq).user;
      const isSuperAdmin = user?.role === "super_admin";

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: "無効なIDです" });
      }

      const excluded = (req.body as { excluded?: unknown })?.excluded;
      if (typeof excluded !== "boolean") {
        return res.status(400).json({ error: "excluded は boolean で指定してください" });
      }

      try {
        const lookup = await db.query(
          "SELECT id, tenant_id FROM book_uploads WHERE id = $1",
          [id]
        );
        if (lookup.rows.length === 0) {
          return res.status(404).json({ error: "書籍が見つかりません" });
        }

        const book = lookup.rows[0] as { id: number; tenant_id: string };
        if (!isSuperAdmin && book.tenant_id !== user?.tenantId) {
          return res
            .status(403)
            .json({ error: "他のテナントのデータにはアクセスできません" });
        }

        // pgvector 側。書籍チャンクは metadata.faq_id を持たない設計のため
        // faq_docs 側の可視性ゲートが効かず、ここが唯一効くフラグになる。
        const updated = await db.query<{ chunk_index: number }>(
          `UPDATE faq_embeddings
             SET is_excluded_from_search = $2
           WHERE metadata->>'source' = 'book' AND metadata->>'book_id' = $1::text
           RETURNING (metadata->>'chunk_index')::int AS chunk_index`,
          [id, excluded]
        );

        // ES 側も揃える(best-effort)。揃えないと BM25 経由で引け続ける。
        const esUrl = process.env.ES_URL;
        if (esUrl) {
          await Promise.all(
            updated.rows.map((r) =>
              setBookChunkExcludedInEs(
                esUrl,
                book.tenant_id,
                `book_${id}_chunk_${r.chunk_index}`,
                excluded
              )
            )
          );
        }

        logger.info(
          `[book-pdf] search-visibility book=${id} tenant=${book.tenant_id} excluded=${excluded} chunks=${updated.rowCount}`
        );

        return res.json({ ok: true, id, excluded, chunks: updated.rowCount });
      } catch (err: unknown) {
        logger.error(
          "[book-pdf] search-visibility error:",
          err instanceof Error ? err.message : String(err)
        );
        return res.status(500).json({ error: "更新に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // GET /v1/admin/knowledge/book-pdf/:id/chunks
  // 書籍IDに紐づくチャンク一覧
  // -----------------------------------------------------------------------
  app.get(
    "/v1/admin/knowledge/book-pdf/:id/chunks",
    knowledgeAuth,
    requireKnowledgeRole,
    async (req: Request, res: Response) => {
      const user = (req as BookPdfReq).user;
      const isSuperAdmin = user?.role === "super_admin";

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: "無効なIDです" });
      }

      try {
        // 書籍の存在とテナント確認
        const bookResult = await db.query(
          "SELECT id, tenant_id, title, uploaded_by FROM book_uploads WHERE id = $1",
          [id]
        );
        if (bookResult.rows.length === 0) {
          return res.status(404).json({ error: "書籍が見つかりません" });
        }

        const book = bookResult.rows[0] as {
          id: number;
          tenant_id: string;
          title: string;
          uploaded_by: string | null;
        };
        if (!isSuperAdmin && book.tenant_id !== user?.tenantId) {
          return res
            .status(403)
            .json({ error: "他のテナントのデータにはアクセスできません" });
        }

        // アップロード者本人かどうか判定
        const currentUserId = (req as BookPdfReq).user?.id ?? "";
        const isUploader = Boolean(currentUserId && book.uploaded_by && book.uploaded_by === currentUserId);

        // チャンク取得（embeddingベクトルは除外）
        const chunksResult = await db.query(
          `SELECT id, text, metadata
           FROM faq_embeddings
           WHERE metadata->>'source' = 'book' AND metadata->>'book_id' = $1::text
           ORDER BY (metadata->>'page_number')::int ASC NULLS LAST, id ASC`,
          [id]
        );

        const STRUCTURED_FIELDS = [
          "situation",
          "resistance",
          "principle",
          "contraindication",
          "example",
          "failure_example",
        ] as const;

        const chunks = chunksResult.rows.map(
          (row: {
            id: number;
            text: string;
            metadata: Record<string, unknown>;
          }) => {
            const meta = row.metadata ?? {};
            const isStructured = STRUCTURED_FIELDS.some(
              (f) => meta[f] != null && meta[f] !== ""
            );

            let chunkText: string | null = null;
            if (isUploader) {
              try {
                chunkText = decryptText(String(row.text ?? "")).slice(0, 200);
              } catch {
                chunkText = null;
              }
            }

            return {
              id: row.id,
              text: chunkText,
              text_restricted: !isUploader,
              text_restricted_reason: !isUploader
                ? "このコンテンツはアップロード者のみ閲覧できます"
                : undefined,
              // faq_embeddings.metadata をそのまま返す（動的スキーマフィールドを含む）
              metadata: meta,
              is_structured: isStructured,
            };
          }
        );

        return res.json({
          bookId: id,
          title: book.title,
          chunks,
          total: chunks.length,
        });
      } catch (err: unknown) {
        logger.error(
          "[book-pdf] GET chunks error:",
          err instanceof Error ? err.message : String(err)
        );
        return res.status(500).json({ error: "チャンク一覧の取得に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // PUT /v1/admin/knowledge/book-pdf/chunks/:chunkId
  // チャンクのメタデータ（構造化6フィールド）を編集
  // -----------------------------------------------------------------------
  app.put(
    "/v1/admin/knowledge/book-pdf/chunks/:chunkId",
    knowledgeAuth,
    requireKnowledgeRole,
    async (req: Request, res: Response) => {
      const user = (req as BookPdfReq).user;
      const isSuperAdmin = user?.role === "super_admin";

      const chunkId = parseInt(req.params.chunkId, 10);
      if (isNaN(chunkId)) {
        return res.status(400).json({ error: "無効なチャンクIDです" });
      }

      // 全スキーマ種別のフィールドキーをホワイトリスト化（動的スキーマ対応）
      const ALLOWED_FIELDS = [
        // psychology_book
        "situation", "resistance", "principle", "contraindication", "example", "failure_example",
        // sales_manual
        "target_customer", "problem", "solution", "benefit", "objection_handling",
        // product_catalog
        "product_name", "spec", "price_range", "target", "comparison",
        // business_document / general_report
        "topic", "key_finding", "data_point", "implication",
      ] as const;

      type AllowedField = (typeof ALLOWED_FIELDS)[number];

      try {
        // チャンク取得（book_idからbook_uploadsのtenant_idを確認）
        const chunkResult = await db.query(
          `SELECT fe.id, fe.metadata, fe.is_excluded_from_search, bu.tenant_id
           FROM faq_embeddings fe
           JOIN book_uploads bu ON bu.id = (fe.metadata->>'book_id')::int
           WHERE fe.id = $1 AND fe.metadata->>'source' = 'book'`,
          [chunkId]
        );
        if (chunkResult.rows.length === 0) {
          return res.status(404).json({ error: "チャンクが見つかりません" });
        }

        const chunk = chunkResult.rows[0] as {
          id: number;
          metadata: Record<string, unknown>;
          is_excluded_from_search: boolean;
          tenant_id: string;
        };
        if (!isSuperAdmin && chunk.tenant_id !== user?.tenantId) {
          return res
            .status(403)
            .json({ error: "他のテナントのデータにはアクセスできません" });
        }

        // ホワイトリスト方式でフィールド抽出・バリデーション
        const body = (req.body ?? {}) as Record<string, unknown>;
        const patch: Partial<Record<AllowedField, string | null>> = {};
        for (const field of ALLOWED_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(body, field)) {
            const val = body[field];
            if (val !== null && typeof val !== "string") {
              return res
                .status(400)
                .json({ error: `${field} は文字列またはnullで指定してください` });
            }
            patch[field] = val as string | null;
          }
        }

        if (Object.keys(patch).length === 0) {
          return res.status(400).json({ error: "更新するフィールドがありません" });
        }

        // 楽観ロック([T4-1]の tenants PATCH と同じ考え方: 変更を読み込んだ時点の版を
        // クライアントに送り返し、保存時に一致確認する)。faq_embeddings には updated_at
        // 列が無く、embedding_updated_at は再埋め込み対象外の編集(例: product_catalog)では
        // 更新されないため版として使えない。そのため metadata.content_updated_at を
        // 専用の版として新設する(embedding_updated_at とは独立)。未指定なら従来どおり
        // 版チェックをスキップする(後方互換。UI更新前の呼び出し元を壊さない)。
        const hasExpectedContentUpdatedAt = Object.prototype.hasOwnProperty.call(
          body,
          "expected_content_updated_at"
        );
        const expectedContentUpdatedAtRaw = body["expected_content_updated_at"];
        if (
          hasExpectedContentUpdatedAt &&
          expectedContentUpdatedAtRaw !== null &&
          typeof expectedContentUpdatedAtRaw !== "string"
        ) {
          return res
            .status(400)
            .json({ error: "expected_content_updated_at は文字列またはnullで指定してください" });
        }
        const expectedContentUpdatedAt = hasExpectedContentUpdatedAt
          ? (expectedContentUpdatedAtRaw as string | null)
          : null;

        // T6: 実際に値が変わったフィールドだけを編集履歴に残す(平文のmetadata差分のみ、
        // faq_embeddings.text の書籍原文は含めない — Anti-Slop)。連打で同じ値が送られた
        // 場合は差分が空になり、以降の再埋め込みもスキップする。
        const changes: Record<string, { from: string | null; to: string | null }> = {};
        for (const field of Object.keys(patch) as AllowedField[]) {
          const before = (chunk.metadata[field] as string | null | undefined) ?? null;
          const after = patch[field] ?? null;
          if (before !== after) {
            changes[field] = { from: before, to: after };
          }
        }

        if (Object.keys(changes).length === 0) {
          return res.json({ id: chunk.id, metadata: chunk.metadata, embedding_updated: false });
        }

        const historyEntry = {
          at: new Date().toISOString(),
          by: user?.id ?? null,
          changes,
        };
        const existingHistory = Array.isArray(chunk.metadata['edit_history'])
          ? (chunk.metadata['edit_history'] as unknown[])
          : [];
        const editHistory = [...existingHistory, historyEntry].slice(-CHUNK_EDIT_HISTORY_LIMIT);

        // 再埋め込み用の検索テキストは、パッチ適用後の metadata から組み立てる
        // (T5: buildSearchText / buildSearchTextFields をスキーマ非依存化済み)。
        // 対応表(principleSchemaMap.ts)に無いスキーマ(product_catalog等)は
        // searchText が空になり、再埋め込みをスキップする(意図的、principleSchemaMap.ts
        // のコメント参照 — 打ち手フィールドを持たないスキーマは対象外)。
        const mergedMetadata: Record<string, unknown> = { ...chunk.metadata, ...patch };
        const contentType = detectPrincipleContentType(mergedMetadata);
        const searchTextFields = contentType ? buildSearchTextFields(contentType, mergedMetadata) : [];
        const searchText = buildSearchText(searchTextFields);
        const embeddingEligible = searchText !== '';

        const nowIso = new Date().toISOString();
        const patchForDb: Record<string, unknown> = {
          ...patch,
          edit_history: editHistory,
          // 楽観ロックの版。埋め込み対象外のスキーマ(product_catalog等)でも
          // 編集のたびに必ず進む(embedding_updated_at は embeddingEligible の
          // ときしか進まないため、代わりに使えない)。
          content_updated_at: nowIso,
        };
        if (embeddingEligible) {
          patchForDb['embedding_status'] = 'pending';
          // 「状態が最後に変わった時刻」として使う(=CASの期限切れ判定の基準)。
          patchForDb['embedding_updated_at'] = nowIso;
        }

        // 保存ボタン連打対策: embedding_status='pending' の間は次の書き込みを CAS で弾く
        // (DBの状態で判定するため、プロセスが複数でも安全)。ただし pending のまま
        // CHUNK_STALE_PENDING_MS より古ければ「プロセスが落ちて放置された」とみなし、
        // 奪って再実行できるようにする(でないと運用者のDB直接操作でしか復帰できず、
        // 画面には「AIが覚え直しています」が出たまま永久に編集不能になる)。
        const staleCutoff = new Date(Date.now() - CHUNK_STALE_PENDING_MS).toISOString();
        // 楽観ロック条件。expected_content_updated_at 未指定なら常に真(スキップ)。
        // IS NOT DISTINCT FROM で NULL 同士(=一度も編集されていないチャンク)も
        // 正しく一致判定できるようにする(通常の = だと NULL = NULL は unknown になる)。
        const casResult = await db.query(
          `UPDATE faq_embeddings
           SET metadata = metadata || $1::jsonb
           WHERE id = $2
             AND (
               COALESCE(metadata->>'embedding_status', '') <> 'pending'
               OR metadata->>'embedding_updated_at' IS NULL
               OR (metadata->>'embedding_updated_at')::timestamptz < $3::timestamptz
             )
             AND ($4::boolean IS NOT TRUE OR metadata->>'content_updated_at' IS NOT DISTINCT FROM $5::text)
           RETURNING id, metadata`,
          [
            JSON.stringify(patchForDb),
            chunkId,
            staleCutoff,
            hasExpectedContentUpdatedAt,
            expectedContentUpdatedAt,
          ]
        );
        if (casResult.rows.length === 0) {
          // どちらの条件で弾かれたかをDBの最新状態から判別し、別のメッセージを返す
          // (「反映処理中」と「他の人が更新した」は原因も対処も違うため混ぜない)。
          if (hasExpectedContentUpdatedAt) {
            const latest = await db.query(
              `SELECT metadata FROM faq_embeddings WHERE id = $1`,
              [chunkId]
            );
            const latestMetadata = (latest.rows[0]?.metadata ?? {}) as Record<string, unknown>;
            const latestContentUpdatedAt =
              (latestMetadata['content_updated_at'] as string | undefined) ?? null;
            if (latestContentUpdatedAt !== expectedContentUpdatedAt) {
              return res.status(409).json({
                error: "conflict",
                message: "他の人がこのチャンクを更新しました。最新の内容を読み直してから編集してください。",
                metadata: latestMetadata,
              });
            }
          }
          return res
            .status(409)
            .json({ error: "他の編集が反映処理中です。少し待ってからもう一度お試しください。" });
        }

        let savedRow = casResult.rows[0] as { id: number; metadata: Record<string, unknown> };

        if (!embeddingEligible) {
          return res.json({ id: savedRow.id, metadata: savedRow.metadata, embedding_updated: false });
        }

        // 埋め込みAPI障害時も文言の保存自体は既に成功させている(上のUPDATE)。
        // ここから先は「保存済み」と「反映済み」を別状態として扱う。
        let vector: number[] | null = null;
        try {
          vector = await embedText(searchText, { tenantId: chunk.tenant_id, billable: false });
        } catch (err: unknown) {
          logger.warn(
            "[book-pdf] PUT chunk re-embed failed (metadata saved, embedding not updated):",
            err instanceof Error ? err.message : String(err)
          );
        }

        if (vector) {
          const doneResult = await db.query(
            `UPDATE faq_embeddings
             SET embedding = $1::vector,
                 metadata = metadata || $2::jsonb
             WHERE id = $3
             RETURNING id, metadata`,
            [
              `[${vector.join(',')}]`,
              JSON.stringify({
                embedding_status: 'done',
                embedding_updated_at: new Date().toISOString(),
              }),
              chunkId,
            ]
          );
          savedRow = doneResult.rows[0];

          // ES 同期(best-effort)。upsertToEs は _doc への PUT(全置換)のため、
          // 検索フィルタが参照するフィールド(is_published / is_excluded_from_search)を
          // 落とさないよう mergedMetadata から作り直す(5引数呼び出しでフラグが
          // 巻き戻った過去の不具合と同じ轍を踏まない — knowledge.md 参照)。
          const esUrl = process.env.ES_URL;
          if (esUrl) {
            const bookId = mergedMetadata['book_id'];
            const chunkIndex = mergedMetadata['chunk_index'];
            const docId = `book_${bookId}_chunk_${chunkIndex}`;
            const esDoc: Record<string, unknown> = {
              tenant_id: chunk.tenant_id,
              source: 'book',
              book_id: bookId,
              chunk_index: chunkIndex,
              is_published: true,
              is_excluded_from_search: chunk.is_excluded_from_search ?? false,
            };
            if (typeof mergedMetadata['category'] === 'string') esDoc['category'] = mergedMetadata['category'];
            if (Array.isArray(mergedMetadata['keywords'])) esDoc['keywords'] = mergedMetadata['keywords'];
            if (typeof mergedMetadata['principle'] === 'string') esDoc['principle'] = mergedMetadata['principle'];
            if (searchTextFields[0]) esDoc['question'] = searchTextFields[0]!.value.slice(0, 200);
            const last = searchTextFields[searchTextFields.length - 1];
            if (last) esDoc['answer'] = last.value.slice(0, 200);
            void upsertToEs(esUrl, chunk.tenant_id, docId, esDoc);
          }
        } else {
          const failedResult = await db.query(
            `UPDATE faq_embeddings
             SET metadata = metadata || $1::jsonb
             WHERE id = $2
             RETURNING id, metadata`,
            [JSON.stringify({ embedding_status: 'failed' }), chunkId]
          );
          savedRow = failedResult.rows[0];
        }

        return res.json({ id: savedRow.id, metadata: savedRow.metadata, embedding_updated: vector !== null });
      } catch (err: unknown) {
        logger.error(
          "[book-pdf] PUT chunk error:",
          err instanceof Error ? err.message : String(err)
        );
        return res.status(500).json({ error: "チャンクの更新に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // DELETE /v1/admin/knowledge/book-pdf/chunks/:chunkId
  // チャンクを削除し、book_uploads.chunk_count をデクリメント
  // -----------------------------------------------------------------------
  app.delete(
    "/v1/admin/knowledge/book-pdf/chunks/:chunkId",
    knowledgeAuth,
    requireKnowledgeRole,
    async (req: Request, res: Response) => {
      const user = (req as BookPdfReq).user;
      const isSuperAdmin = user?.role === "super_admin";

      const chunkId = parseInt(req.params.chunkId, 10);
      if (isNaN(chunkId)) {
        return res.status(400).json({ error: "無効なチャンクIDです" });
      }

      try {
        // チャンク取得（book_idからbook_uploadsのtenant_idを確認）
        const chunkResult = await db.query(
          `SELECT fe.id, (fe.metadata->>'book_id')::int AS book_id, bu.tenant_id
           FROM faq_embeddings fe
           JOIN book_uploads bu ON bu.id = (fe.metadata->>'book_id')::int
           WHERE fe.id = $1 AND fe.metadata->>'source' = 'book'`,
          [chunkId]
        );
        if (chunkResult.rows.length === 0) {
          return res.status(404).json({ error: "チャンクが見つかりません" });
        }

        const chunk = chunkResult.rows[0] as {
          id: number;
          book_id: number;
          tenant_id: string;
        };
        if (!isSuperAdmin && chunk.tenant_id !== user?.tenantId) {
          return res
            .status(403)
            .json({ error: "他のテナントのデータにはアクセスできません" });
        }

        // チャンク削除
        const deleteResult = await db.query(
          `DELETE FROM faq_embeddings
           WHERE id = $1 AND metadata->>'source' = 'book'
           RETURNING id`,
          [chunkId]
        );
        if (deleteResult.rows.length === 0) {
          return res.status(404).json({ error: "チャンクが見つかりません" });
        }

        // chunk_count デクリメント（0未満にはしない）
        await db.query(
          `UPDATE book_uploads
           SET chunk_count = GREATEST(chunk_count - 1, 0)
           WHERE id = $1`,
          [chunk.book_id]
        );

        return res.json({ ok: true, deleted: chunkId });
      } catch (err: unknown) {
        logger.error(
          "[book-pdf] DELETE chunk error:",
          err instanceof Error ? err.message : String(err)
        );
        return res.status(500).json({ error: "チャンクの削除に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // POST /v1/admin/knowledge/book-pdf/:id/process
  // チャンク構造化パイプライン トリガー
  // 非同期処理: 202 Accepted を即返し、バックグラウンドで pipeline 実行
  // -----------------------------------------------------------------------
  app.post(
    "/v1/admin/knowledge/book-pdf/:id/process",
    knowledgeAuth,
    requireKnowledgeRole,
    async (req: Request, res: Response) => {
      const user = (req as BookPdfReq).user;
      const isSuperAdmin = user?.role === "super_admin";

      // GID 1217040818410419: 書籍/PDF投入(構造化パイプラインの起動含む)はR2C運用限定。
      if (!isSuperAdmin) {
        return res.status(403).json({ error: BOOK_PDF_TENANT_RESTRICTED_MESSAGE });
      }

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: "無効なIDです" });
      }

      try {
        const lookup = await db.query(
          "SELECT id, tenant_id, status FROM book_uploads WHERE id = $1",
          [id]
        );
        if (lookup.rows.length === 0) {
          return res.status(404).json({ error: "書籍が見つかりません" });
        }

        const book = lookup.rows[0] as { id: number; tenant_id: string; status: string };
        if (!isSuperAdmin && book.tenant_id !== user?.tenantId) {
          return res.status(403).json({ error: "他のテナントのデータにはアクセスできません" });
        }

        // 既に処理中 / 完了済みの場合は 409
        if (book.status === "processing") {
          return res.status(409).json({ error: "既に処理中です" });
        }
        if (book.status === "embedded") {
          return res.status(409).json({ error: "既に処理済みです" });
        }

        // 202 を即返してバックグラウンド実行
        res.status(202).json({ ok: true, bookId: id, message: "処理を開始しました" });

        // パイプライン実行（順次キュー経由）
        void pipelineQueue.enqueue(id, { db });

        return;
      } catch (err: unknown) {
        logger.error(
          "[book-pdf] POST process error:",
          err instanceof Error ? err.message : String(err)
        );
        return res.status(500).json({ error: "処理の開始に失敗しました" });
      }
    }
  );
}
