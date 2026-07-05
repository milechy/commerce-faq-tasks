// src/api/chat/escalationRoutes.ts
// GID 1216275508391900: 有人チャットへのシームレスエスカレーション
//
// Widget向け (apiStack: x-api-key + tenant解決を経由):
//   POST /api/chat/escalate — セッションを有人対応待ちにする
//   GET  /api/chat/poll     — 有人オペレーターからの新着返信をポーリング取得

import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import {
  escalateSession,
  getNewOperatorMessages,
} from "../admin/chat-history/chatHistoryRepository";
import { createNotification } from "../../lib/notifications";
import { logger } from "../../lib/logger";

const EscalateSchema = z.object({
  sessionId: z.string().min(1).max(128),
});

export function registerEscalationRoutes(app: Express, apiStack: RequestHandler[]): void {
  // -------------------------------------------------------------------------
  // POST /api/chat/escalate
  // -------------------------------------------------------------------------
  app.post("/api/chat/escalate", ...apiStack, async (req: Request, res: Response) => {
    const tenantId = (req as Request & { tenantId?: string }).tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: "tenant_not_found" });
    }

    const parsed = EscalateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
    }

    try {
      const { alreadyEscalated } = await escalateSession({
        tenantId,
        sessionId: parsed.data.sessionId,
      });

      if (!alreadyEscalated) {
        const preview = `セッション: ${parsed.data.sessionId.slice(0, 20)}`;
        void createNotification({
          recipientRole: "client_admin",
          recipientTenantId: tenantId,
          type: "chat_escalated",
          title: "有人対応のリクエストがあります",
          message: `お客様が有人スタッフとの会話を希望しています（${preview}）`,
          link: "/admin/escalations",
          metadata: { tenantId, sessionId: parsed.data.sessionId },
        });
        void createNotification({
          recipientRole: "super_admin",
          type: "chat_escalated",
          title: "有人対応のリクエストがあります",
          message: `テナント「${tenantId}」でお客様が有人スタッフとの会話を希望しています`,
          link: "/admin/escalations",
          metadata: { tenantId, sessionId: parsed.data.sessionId },
        });
      }

      return res.json({ ok: true, already_escalated: alreadyEscalated });
    } catch (err) {
      logger.warn("[POST /api/chat/escalate]", err);
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/chat/poll — オペレーター返信のポーリング取得（エスカレーション後のみ使用）
  // -------------------------------------------------------------------------
  app.get("/api/chat/poll", ...apiStack, async (req: Request, res: Response) => {
    const tenantId = (req as Request & { tenantId?: string }).tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: "tenant_not_found" });
    }

    const sessionId = req.query["sessionId"] as string | undefined;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }
    const since = req.query["since"] as string | undefined;

    try {
      const messages = await getNewOperatorMessages({ tenantId, sessionId, since });
      return res.json({ messages });
    } catch (err) {
      logger.warn("[GET /api/chat/poll]", err);
      return res.status(500).json({ error: "internal_error" });
    }
  });
}
