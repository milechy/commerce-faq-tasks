// src/api/admin/knowledge/bookPdfRoutes.ts
// Phase44: 書籍PDFアップロードAPI — AES-256-GCM暗号化 + Supabase Storage

import type { Express, NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";
import crypto from "crypto";
// @ts-ignore
import type { Pool } from "pg";
import { supabaseAdmin } from "../../../auth/supabaseClient";
import { runBookPipeline } from "../../../lib/book-pipeline/pipeline";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

// ── Multer: メモリバッファ、50MB上限、PDFのみ ─────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      cb(new Error("PDFファイルのみアップロードできます"));
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
  const user = (req as any).user as
    | { role?: string; tenantId?: string | null }
    | undefined;
  if (user?.role === "super_admin") {
    // super_admin: queryパラメータで対象テナントを指定可
    const fromQuery =
      (req.query.tenant as string | undefined) ||
      (req.query.tenant_id as string | undefined);
    return fromQuery || user?.tenantId || null;
  }
  return user?.tenantId ?? null;
}

// ── ルート登録 ─────────────────────────────────────────────────────────────
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
          if (multerErr.message.includes("PDFファイルのみ")) {
            res.status(400).json({ error: multerErr.message });
            return;
          }
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

        // multerはContent-Dispositionのfilenameをlatin1でデコードするため、
        // 日本語ファイル名はlatin1→utf8で再デコードが必要
        let originalFilename = file.originalname;
        try {
          originalFilename = Buffer.from(file.originalname, "latin1").toString("utf8");
        } catch {
          // デコード失敗時はそのまま使用
          originalFilename = file.originalname;
        }

        const title = ((req.body as Record<string, unknown>)?.title as string | undefined)?.trim();
        if (!title) {
          return res.status(400).json({ error: "書籍のタイトルを入力してください" });
        }

        // tenantId: JWT から取得（body 禁止）
        const tenantId = resolveUploadTenantId(req);
        if (!tenantId) {
          return res.status(403).json({ error: "テナント情報が取得できません" });
        }

        const userId: string =
          ((req as any).user as { id?: string } | undefined)?.id ?? "";

        // 暗号化（KNOWLEDGE_ENCRYPTION_KEY 未設定時は平文フォールバック + warn）
        const encKey = process.env.KNOWLEDGE_ENCRYPTION_KEY;
        let uploadBuffer = file.buffer;
        let encryptionIv: string | null = null;

        if (encKey) {
          const result = encryptBuffer(file.buffer, encKey);
          uploadBuffer = result.encrypted;
          encryptionIv = result.iv;
        } else {
          console.warn(
            "[book-pdf] KNOWLEDGE_ENCRYPTION_KEY未設定: 平文保存フォールバック"
          );
        }

        // Supabase Storage がない場合はエラー
        if (!supabaseAdmin) {
          return res.status(500).json({
            error: "ストレージサービスが設定されていません。もう一度お試しください",
          });
        }

        const storagePath = `${tenantId}/${crypto.randomUUID()}.pdf${encKey ? ".enc" : ""}`;

        const { error: storageError } = await supabaseAdmin.storage
          .from("book-pdfs")
          .upload(storagePath, uploadBuffer, {
            contentType: "application/octet-stream",
            upsert: false,
          });

        if (storageError) {
          console.error("[book-pdf] Storage error:", storageError.message);
          return res.status(500).json({
            error: "アップロードに失敗しました。もう一度お試しください",
          });
        }

        // DB 挿入 — storage_path はサーバー内部のみ保持
        const result = await db.query(
          `INSERT INTO book_uploads
             (tenant_id, title, original_filename, storage_path, file_size_bytes, encryption_iv, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, title, status, created_at`,
          [
            tenantId,
            title,
            originalFilename,
            storagePath,
            file.size,
            encryptionIv,
            userId || null,
          ]
        );

        const bookId = result.rows[0].id;

        // バックグラウンドでパイプライン自動実行（レスポンスはブロックしない）
        runBookPipeline(bookId, { db }).catch((pipelineErr: unknown) => {
          console.error(
            "[book-pdf] auto-pipeline error book_id=%d:",
            bookId,
            pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr)
          );
        });

        // storage_path はレスポンスに含めない（セキュリティ）
        return res.status(201).json(result.rows[0]);
      } catch (err: unknown) {
        console.error(
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
      const user = (req as any).user as
        | { role?: string; tenantId?: string | null }
        | undefined;
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
        console.error(
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
      const user = (req as any).user as
        | { role?: string; tenantId?: string | null }
        | undefined;
      const isSuperAdmin = user?.role === "super_admin";

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: "無効なIDです" });
      }

      try {
        const result = await db.query(
          `SELECT id, tenant_id, title, original_filename, status, page_count,
                  chunk_count, file_size_bytes, error_message, uploaded_by, created_at, updated_at
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
        console.error(
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
      const user = (req as any).user as
        | { role?: string; tenantId?: string | null }
        | undefined;
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
            console.warn(
              "[book-pdf] Storage delete warning:",
              storageErr.message
            );
          }
        }

        // 関連 faq_embeddings 削除
        await db.query(
          `DELETE FROM faq_embeddings
           WHERE metadata->>'source' = 'book' AND metadata->>'book_id' = $1::text`,
          [id]
        );

        // book_uploads レコード削除
        await db.query("DELETE FROM book_uploads WHERE id = $1", [id]);

        return res.json({ ok: true, deleted: id });
      } catch (err: unknown) {
        console.error(
          "[book-pdf] DELETE error:",
          err instanceof Error ? err.message : String(err)
        );
        return res.status(500).json({ error: "削除に失敗しました" });
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
      const user = (req as any).user as
        | { role?: string; tenantId?: string | null }
        | undefined;
      const isSuperAdmin = user?.role === "super_admin";

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

        // バックグラウンド実行（エラーはログのみ）
        runBookPipeline(id, { db }).catch((err: unknown) => {
          console.error(
            "[book-pdf] pipeline error book_id=%d:",
            id,
            err instanceof Error ? err.message : String(err)
          );
        });

        return;
      } catch (err: unknown) {
        console.error(
          "[book-pdf] POST process error:",
          err instanceof Error ? err.message : String(err)
        );
        return res.status(500).json({ error: "処理の開始に失敗しました" });
      }
    }
  );
}
