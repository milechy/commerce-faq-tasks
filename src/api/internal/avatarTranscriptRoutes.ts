// src/api/internal/avatarTranscriptRoutes.ts
//
// POST /api/internal/avatar-transcript
//   認証: X-Internal-Request: 1（他のinternalエンドポイントと同じ方式）
//   avatar-agent/agent.py の legacy/fallback パス(handle_chat: agent内でGroqを直接呼ぶ経路)
//   から、ユーザー発話・アバター応答テキストを受け取り chat_messages に永続化する。
//
//   注意: LemonSlice経由の「本体API」応答パス(tts_request経由)は、widget側が既に
//   通常のchat API(src/api/chat/route.ts)を叩いておりそちらで saveMessage() 済みのため、
//   ここで二重保存はしない。このエンドポイントは agent.py 内でGroqを直接呼ぶ
//   フォールバック経路の会話だけを対象にする。
//
// Body: { tenantId, sessionId, role: 'user'|'assistant', content }

import type { Express, Request, Response } from "express";
import { INTERNAL_REQUEST_HEADER } from "../../lib/metrics/kpiDefinitions";
import { internalNetworkOnly } from "../middleware/internalNetworkOnly";
import { saveMessage } from "../admin/chat-history/chatHistoryRepository";
import { logger } from "../../lib/logger";

export function registerInternalAvatarTranscriptRoutes(app: Express): void {
  app.post(
    "/api/internal/avatar-transcript",
    internalNetworkOnly,
    async (req: Request, res: Response) => {
      if (req.headers[INTERNAL_REQUEST_HEADER] !== "1") {
        return res.status(403).json({ error: "forbidden" });
      }

      const body = req.body ?? {};
      const { tenantId, sessionId, role, content } = body as {
        tenantId?: unknown;
        sessionId?: unknown;
        role?: unknown;
        content?: unknown;
      };

      if (!tenantId || typeof tenantId !== "string") {
        return res.status(400).json({ error: "tenantId required" });
      }
      if (!sessionId || typeof sessionId !== "string") {
        return res.status(400).json({ error: "sessionId required" });
      }
      if (role !== "user" && role !== "assistant") {
        return res.status(400).json({ error: "role must be 'user' or 'assistant'" });
      }
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "content required" });
      }

      try {
        await saveMessage({
          tenantId,
          sessionId,
          role,
          content,
          metadata: { source: "avatar", channel: "livekit" },
        });
        return res.status(202).json({ accepted: true });
      } catch (err) {
        logger.warn({ err }, "[avatar-transcript] saveMessage failed");
        return res.status(500).json({ error: "internal_error" });
      }
    },
  );
}
