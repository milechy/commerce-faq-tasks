// src/api/admin/feedback/feedbackRoutes.ts

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import {
  getMessages,
  sendMessage,
  getThreads,
  markAsRead,
  markSuperAdminMessagesAsRead,
  getUnreadCount,
} from "./feedbackRepository";
import { generateFeedbackReply } from "./feedbackAI";
import { sanitizeInput, blockReasonToMessage } from "../../../lib/security/inputSanitizer";

const sendSchema = z.object({
  content: z.string().min(1).max(4000),
  tenant_id: z.string().min(1).max(100).optional(),
});

export function registerFeedbackRoutes(app: Express): void {
  app.use("/v1/admin/feedback", supabaseAuthMiddleware);

  // -----------------------------------------------------------------------
  // GET /v1/admin/feedback/threads — Super Admin: テナント別スレッド一覧
  // NOTE: /threads を /:id より先に登録すること
  // -----------------------------------------------------------------------
  app.get("/v1/admin/feedback/threads", async (req: Request, res: Response) => {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const isSuperAdmin: boolean =
      (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";

    if (!isSuperAdmin) {
      return res.status(403).json({ error: "super_admin のみアクセス可能です" });
    }

    try {
      const threads = await getThreads();
      return res.json({ threads });
    } catch (err) {
      console.warn("[GET /v1/admin/feedback/threads]", err);
      return res.status(500).json({ error: "スレッド一覧の取得に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // GET /v1/admin/feedback — メッセージ一覧
  // -----------------------------------------------------------------------
  app.get("/v1/admin/feedback", async (req: Request, res: Response) => {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
    const isSuperAdmin: boolean =
      (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";

    const tenantId = isSuperAdmin
      ? ((req.query["tenant"] as string | undefined) || "")
      : jwtTenantId;

    if (!tenantId) {
      return res.status(400).json({ error: "tenant_id が必要です" });
    }

    const limit = Math.min(parseInt((req.query["limit"] as string) ?? "50", 10), 200);
    const offset = parseInt((req.query["offset"] as string) ?? "0", 10);

    try {
      const result = await getMessages({ tenantId, limit, offset });

      // 既読処理: スレッドを開いたら相手のメッセージを既読にする
      if (isSuperAdmin) {
        await markAsRead(tenantId).catch(() => {});
      } else {
        await markSuperAdminMessagesAsRead(tenantId).catch(() => {});
      }

      return res.json(result);
    } catch (err) {
      console.warn("[GET /v1/admin/feedback]", err);
      return res.status(500).json({ error: "メッセージ一覧の取得に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // POST /v1/admin/feedback — メッセージ送信
  // -----------------------------------------------------------------------
  app.post("/v1/admin/feedback", async (req: Request, res: Response) => {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
    const isSuperAdmin: boolean =
      (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";
    const email: string = su?.email ?? "";

    const parsed = sendSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }

    const { content, tenant_id } = parsed.data;

    // 入力サニタイズ（URL拒否 + XSS防止）
    const inputCheck = sanitizeInput(content);
    if (!inputCheck.safe) {
      return res.status(400).json({
        error: blockReasonToMessage(inputCheck.reason ?? "blocked_content"),
      });
    }

    // tenant_id の解決
    const resolvedTenantId = isSuperAdmin
      ? (tenant_id ?? "")
      : jwtTenantId;

    if (!resolvedTenantId) {
      return res
        .status(400)
        .json({ error: "super_admin は tenant_id を指定してください" });
    }

    // client_admin は自テナント以外に送信不可
    if (!isSuperAdmin && tenant_id && tenant_id !== jwtTenantId) {
      return res.status(403).json({ error: "他テナントへの送信はできません" });
    }

    try {
      const msg = await sendMessage({
        tenantId: resolvedTenantId,
        senderRole: isSuperAdmin ? "super_admin" : "client_admin",
        senderEmail: email || undefined,
        content,
      });

      // client_admin のメッセージに対してLLM自動返答（fire-and-forget）
      if (!isSuperAdmin) {
        generateFeedbackReply(content, resolvedTenantId)
          .then(async (aiReply) => {
            if (aiReply) {
              await sendMessage({
                tenantId: resolvedTenantId,
                senderRole: "super_admin",
                senderEmail: "ai-assistant",
                content: aiReply,
              });
            }
          })
          .catch((err) => console.warn("[feedback] AI reply failed:", err));
      }

      return res.status(201).json(msg);
    } catch (err) {
      console.warn("[POST /v1/admin/feedback]", err);
      return res.status(500).json({ error: "メッセージの送信に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // PATCH /v1/admin/feedback/read — 既読処理
  // -----------------------------------------------------------------------
  app.patch("/v1/admin/feedback/read", async (req: Request, res: Response) => {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
    const isSuperAdmin: boolean =
      (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";

    const tenantId = isSuperAdmin
      ? ((req.body as Record<string, string>)?.["tenant_id"] ?? "")
      : jwtTenantId;

    if (!tenantId) {
      return res.status(400).json({ error: "tenant_id が必要です" });
    }

    try {
      if (isSuperAdmin) {
        await markAsRead(tenantId);
      } else {
        await markSuperAdminMessagesAsRead(tenantId);
      }
      return res.json({ ok: true });
    } catch (err) {
      console.warn("[PATCH /v1/admin/feedback/read]", err);
      return res.status(500).json({ error: "既読処理に失敗しました" });
    }
  });

  // -----------------------------------------------------------------------
  // GET /v1/admin/feedback/unread-count — 未読数取得
  // -----------------------------------------------------------------------
  app.get("/v1/admin/feedback/unread-count", async (req: Request, res: Response) => {
    const su = (req as any).supabaseUser as Record<string, any> | undefined;
    const jwtTenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? "";
    const isSuperAdmin: boolean =
      (su?.app_metadata?.role ?? su?.user_metadata?.role ?? "") === "super_admin";

    // super_admin: 全テナント合算の未読数
    try {
      if (isSuperAdmin) {
        const threads = await getThreads();
        const total = threads.reduce((sum, t) => sum + t.unread_count, 0);
        return res.json({ count: total });
      } else {
        if (!jwtTenantId) return res.json({ count: 0 });
        const count = await getUnreadCount(jwtTenantId, "client_admin");
        return res.json({ count });
      }
    } catch (err) {
      console.warn("[GET /v1/admin/feedback/unread-count]", err);
      return res.json({ count: 0 });
    }
  });
}
