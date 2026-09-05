// src/api/admin/resources/routes.ts
//
// 資料オファー機能: テナント向け資料（PDF or 外部URL）の管理API。
// 1テナント1件固定（tenant_resources.tenant_id の UNIQUE 制約が保証する）。
// docs/RESOURCE_OFFER_REQUIREMENTS.md §4/5 準拠。

import type { Express, NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";
import crypto from "crypto";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { logger } from "../../../lib/logger";
import {
  getResource,
  upsertResource,
  deleteResource,
  setPublished,
  uploadResourcePdfToStorage,
  getResourcePublicUrl,
  type TenantResourceRow,
} from "./resourcesRepository";
import { extractResourcePdfText, ResourcePdfExtractError } from "../../../lib/resourcePdfExtract";
import { checkResourceTextForInfringement } from "../../../lib/resourceContentGuard";

// ---------------------------------------------------------------------------
// ALLOWED_ROLES whitelist（avatar/routes.ts と同じ規約）
// ---------------------------------------------------------------------------

const ALLOWED_RESOURCE_ROLES = ["super_admin", "client_admin"] as const;
type AllowedResourceRole = (typeof ALLOWED_RESOURCE_ROLES)[number];
function isAllowedResourceRole(role: unknown): role is AllowedResourceRole {
  return typeof role === "string" && (ALLOWED_RESOURCE_ROLES as readonly string[]).includes(role);
}

// ---------------------------------------------------------------------------
// ヘルパー: JWT から tenantId / super_admin 判定（avatar/routes.ts の extractAuth と同型）
// ---------------------------------------------------------------------------

function extractAuth(req: Request) {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  const role = su?.app_metadata?.role;
  const tenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
  const isSuperAdmin: boolean = role === "super_admin";
  return { role, tenantId, isSuperAdmin };
}

/**
 * super_admin は ?tenant= でプレビュー中の対象テナントを指定できる
 * （avatar/routes.ts の filterTenantId と同じパターン）。
 * client_admin は必ず JWT 由来の tenantId のみを使う（body からは絶対に取らない）。
 */
function resolveTenantId(req: Request): string | null {
  const { tenantId, isSuperAdmin } = extractAuth(req);
  if (isSuperAdmin) {
    const fromQuery = (req.query["tenant"] as string | undefined)?.trim();
    return fromQuery || tenantId || null;
  }
  return tenantId || null;
}

// ---------------------------------------------------------------------------
// SSRF ガード: external_url の検証
// originCheck.ts は Origin ヘッダの許可リスト照合が目的で、任意URLのホスト検証には
// 使えないため、資料URL専用の簡易チェックをここに置く。
// ---------------------------------------------------------------------------

function isPrivateOrIpv4LocalHost(host: string): boolean {
  if (host === "localhost" || host === "0.0.0.0") return true;
  if (host.startsWith("127.")) return true;
  if (host.startsWith("169.254.")) return true;
  if (host.startsWith("10.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.startsWith("192.168.")) return true;
  return false;
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  // URL#hostname returns IPv6 hosts in bracketed form (e.g. "[::1]"), which
  // must be stripped before comparing against the bare "::1" literal below —
  // otherwise an IPv6-loopback external_url silently bypasses this guard.
  // A trailing dot (DNS root label, e.g. "localhost.") is also stripped —
  // browsers/Node treat "localhost." as equivalent to "localhost", but a naive
  // exact-match check would not, letting it slip past the guard.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (host === "::1") return true;
  // IPv4-mapped IPv6 (e.g. "::ffff:127.0.0.1") is always normalized by Node's
  // URL parser to the compressed hex-group form "::ffff:7f00:1" — decode the
  // embedded IPv4 address and re-run the same private-range checks against it,
  // otherwise a mapped private/loopback address bypasses every check above.
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateOrIpv4LocalHost(ipv4);
  }
  return isPrivateOrIpv4LocalHost(host);
}

// 資料オファーのCopilot UIツール(actionExecutor.ts の upload_resource)が外部URLの
// LLM経由入力を同じ基準で検証するために export する(SSRFガードの二重実装を避ける)。
export function isValidExternalResourceUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return !isPrivateOrLocalHostname(parsed.hostname);
}

// ---------------------------------------------------------------------------
// Zod: アップロード/更新の本文（multipart/form-data のテキストフィールドは常に文字列）
// ---------------------------------------------------------------------------

const boolFromFormField = z.preprocess((v) => {
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}, z.boolean());

const upsertBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  external_url: z.string().trim().min(1).optional(),
  rights_confirmed: boolFromFormField,
});

// PDF: メモリバッファ。1テナント1件の資料想定のため book-pdf(50MB)より厳しい上限にする。
const MAX_RESOURCE_PDF_SIZE = 20 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RESOURCE_PDF_SIZE },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      cb(new Error("PDFファイルのみアップロードできます"));
      return;
    }
    cb(null, true);
  },
});

function toPublicShape(row: TenantResourceRow) {
  return {
    ...row,
    download_url: row.storage_path ? getResourcePublicUrl(row.storage_path) : row.external_url,
  };
}

export function registerResourceRoutes(app: Express, db: any): void {
  if (!db) return;

  app.use("/v1/admin/resources", supabaseAuthMiddleware);

  // -----------------------------------------------------------------------
  // GET /v1/admin/resources — テナントの資料（1件固定）を取得。
  // 未登録は「不存在」であり故障ではないため 404 ではなく resource: null を返す。
  // -----------------------------------------------------------------------
  app.get("/v1/admin/resources", async (req: Request, res: Response) => {
    const { role } = extractAuth(req);
    if (!isAllowedResourceRole(role)) {
      return res.status(403).json({ error: "この操作を実行する権限がありません" });
    }
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(403).json({ error: "テナント情報が取得できません" });
    }
    try {
      const resource = await getResource(db, tenantId);
      return res.json({ resource: resource ? toPublicShape(resource) : null });
    } catch (err) {
      logger.warn("[GET /v1/admin/resources]", err);
      return res.status(500).json({ error: "資料の取得に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /v1/admin/resources — アップロード/更新（PDF または external_url、1テナント1件固定）
  // multipart/form-data: file(任意, PDF) + title + description(任意) + external_url(任意)
  //                       + rights_confirmed
  // -----------------------------------------------------------------------
  app.put(
    "/v1/admin/resources",
    (req: Request, res: Response, next: NextFunction) => {
      upload.single("file")(req, res, (multerErr: unknown) => {
        if (multerErr instanceof MulterError) {
          if (multerErr.code === "LIMIT_FILE_SIZE") {
            res.status(413).json({ error: "ファイルサイズが大きすぎます（上限: 20MB）" });
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
      const { role } = extractAuth(req);
      if (!isAllowedResourceRole(role)) {
        return res.status(403).json({ error: "この操作を実行する権限がありません" });
      }
      const tenantId = resolveTenantId(req);
      if (!tenantId) {
        return res.status(403).json({ error: "テナント情報が取得できません" });
      }

      const parsed = upsertBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
      }
      const { title, description, external_url, rights_confirmed } = parsed.data;

      // 要件書5.2・CLAUDE.md禁止5: 著作権確認チェックボックスはハードゲート。
      // クライアント側の無効化だけに頼らずサーバ側でも拒否する（クライアントバイパス対策）。
      if (rights_confirmed !== true) {
        return res.status(400).json({
          error: "rights_not_confirmed",
          message: "第三者の著作権等を侵害しないことの確認が必要です。",
        });
      }

      const file = req.file;
      if (!file && !external_url) {
        return res.status(400).json({ error: "PDFファイルまたは外部URLのいずれかを指定してください" });
      }
      if (file && external_url) {
        return res.status(400).json({ error: "PDFファイルと外部URLは同時に指定できません" });
      }
      if (external_url && !isValidExternalResourceUrl(external_url)) {
        return res.status(400).json({
          error: "invalid_url",
          message: "外部URLの形式が正しくないか、利用できないアドレスです。",
        });
      }

      try {
        // 既存資料があれば同じidを再利用する（Storageパスを固定し、上書きアップロードにする）。
        const existing = await getResource(db, tenantId);
        const resourceId = existing?.id ?? crypto.randomUUID();

        if (file) {
          let extractedText: string | null = null;
          try {
            extractedText = await extractResourcePdfText(file.buffer);
          } catch (err) {
            if (!(err instanceof ResourcePdfExtractError)) throw err;
            // 抽出失敗は「未検査(pending)」のまま保存する。通過扱いにはしない
            // （要件書6.2 §17: 壊れたPDF等での抽出失敗を黙って握りつぶさない）。
          }

          const storagePath = await uploadResourcePdfToStorage(file.buffer, tenantId, resourceId);
          if (!storagePath) {
            logger.warn("[PUT /v1/admin/resources] storage upload returned null", { tenantId, resourceId });
            return res.status(500).json({ error: "資料の保存に失敗しました" });
          }

          let moderationStatus: "pending" | "approved" | "rejected" = "pending";
          let moderationReason: string | null = "テキスト抽出に失敗したため自動モデレーション未実施です";
          if (extractedText !== null) {
            try {
              const moderation = await checkResourceTextForInfringement(extractedText, {
                tenantId,
                requestId: (req as any).requestId ?? `resource-${resourceId}-${Date.now()}`,
              });
              moderationStatus = moderation.blocked ? "rejected" : "approved";
              moderationReason = moderation.blocked ? moderation.reason ?? null : null;
            } catch (err) {
              // checkResourceTextForInfringement は内部でfail-open(APIエラーはwarnログの
              // みでblocked:falseを返す)する設計だが、その内部契約が万一破れて例外が
              // 漏れた場合の多層防御。ここで握りつぶさずアップロード全体を500にすると、
              // 「モデレーション障害でアップロードを止めない」という設計意図に反する。
              logger.warn("[PUT /v1/admin/resources] moderation check threw — treating as pending (fail-open)", err);
              moderationReason = "自動モデレーションの実行に失敗したため未検査です";
            }
          }

          const saved = await upsertResource(db, {
            id: resourceId,
            tenantId,
            title,
            description: description ?? null,
            storagePath,
            externalUrl: null,
            fileType: "pdf",
            moderationStatus,
            moderationReason,
            rightsConfirmed: rights_confirmed,
          });
          return res.status(201).json(toPublicShape(saved));
        }

        // external_url 資料: 抽出対象のテキストが無いため自動モデレーションは対象外。
        // 公開には引き続きテナント自身の「公開する」操作が必要（is_published は false のまま）。
        const saved = await upsertResource(db, {
          id: resourceId,
          tenantId,
          title,
          description: description ?? null,
          storagePath: null,
          externalUrl: external_url!,
          fileType: "external_url",
          moderationStatus: "pending",
          moderationReason: null,
          rightsConfirmed: rights_confirmed,
        });
        return res.status(201).json(toPublicShape(saved));
      } catch (err) {
        logger.warn("[PUT /v1/admin/resources]", err);
        return res.status(500).json({ error: "資料の保存に失敗しました" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // DELETE /v1/admin/resources — 削除
  // -----------------------------------------------------------------------
  app.delete("/v1/admin/resources", async (req: Request, res: Response) => {
    const { role } = extractAuth(req);
    if (!isAllowedResourceRole(role)) {
      return res.status(403).json({ error: "この操作を実行する権限がありません" });
    }
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(403).json({ error: "テナント情報が取得できません" });
    }
    try {
      const deleted = await deleteResource(db, tenantId);
      if (!deleted) {
        return res.status(404).json({ error: "資料が見つかりません" });
      }
      return res.json({ ok: true });
    } catch (err) {
      logger.warn("[DELETE /v1/admin/resources]", err);
      return res.status(500).json({ error: "資料の削除に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // POST /v1/admin/resources/publish — 公開する（moderation_status='rejected' は拒否）
  // -----------------------------------------------------------------------
  app.post("/v1/admin/resources/publish", async (req: Request, res: Response) => {
    const { role } = extractAuth(req);
    if (!isAllowedResourceRole(role)) {
      return res.status(403).json({ error: "この操作を実行する権限がありません" });
    }
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(403).json({ error: "テナント情報が取得できません" });
    }
    try {
      const existing = await getResource(db, tenantId);
      if (!existing) {
        return res.status(404).json({ error: "資料が見つかりません" });
      }
      if (existing.moderation_status === "rejected") {
        return res.status(400).json({
          error: "moderation_rejected",
          message: "この資料はモデレーションで問題が検出されたため公開できません。",
          moderation_reason: existing.moderation_reason,
        });
      }
      const saved = await setPublished(db, tenantId, true);
      if (!saved) {
        // 事前チェックとこの更新の間に別リクエストがmoderation_statusを'rejected'へ
        // 変えた場合、setPublished内部のWHERE条件が0行にマッチしnullを返す(TOCTOU対策)。
        // 事前チェック時点の existing は使わず、現在の状態を取り直して正しいエラーを返す。
        const current = await getResource(db, tenantId);
        if (!current) {
          return res.status(404).json({ error: "資料が見つかりません" });
        }
        return res.status(400).json({
          error: "moderation_rejected",
          message: "この資料はモデレーションで問題が検出されたため公開できません。",
          moderation_reason: current.moderation_reason,
        });
      }
      return res.json(toPublicShape(saved));
    } catch (err) {
      logger.warn("[POST /v1/admin/resources/publish]", err);
      return res.status(500).json({ error: "資料の公開に失敗しました" });
    }
  });
}
