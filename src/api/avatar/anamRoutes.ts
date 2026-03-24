// src/api/avatar/anamRoutes.ts
// Phase42: Anam.ai — セッショントークン取得エンドポイント
// POST /api/avatar/anam-session
//   認証: apiStack (authMiddleware → tenantId)
//   active な avatar_config の avatar_provider を確認し、
//   'anam' なら Anam API セッショントークンを取得して返す。
//   'lemonslice' または未設定なら { enabled: false, avatarProvider: 'lemonslice' } を返す。

import type { Express, Request, Response, RequestHandler } from 'express';
// @ts-ignore
import { Pool } from 'pg';
import type { AuthedRequest } from '../../agent/http/authMiddleware';

const ANAM_API_BASE = 'https://api.anam.ai';

export function registerAnamRoutes(app: Express, apiStack: RequestHandler[]): void {
  console.log('[anamRoutes] POST /api/avatar/anam-session registered');

  app.post('/api/avatar/anam-session', ...apiStack, async (req: Request, res: Response) => {
    const tenantId = (req as AuthedRequest).tenantId;
    if (!tenantId) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const pool = (req as any).app.locals.db as any;
    if (!pool) {
      return res.json({ enabled: false, avatarProvider: 'lemonslice' });
    }

    try {
      // アクティブなavatar_configを取得
      const result = await pool.query(
        `SELECT name, personality_prompt, anam_avatar_id, anam_voice_id, anam_llm_id, anam_persona_id, avatar_provider
         FROM avatar_configs
         WHERE tenant_id = $1 AND is_active = true
         LIMIT 1`,
        [tenantId]
      );

      if (result.rows.length === 0) {
        return res.json({ enabled: false, avatarProvider: 'lemonslice' });
      }

      const config = result.rows[0] as {
        name: string;
        personality_prompt: string | null;
        anam_avatar_id: string | null;
        anam_voice_id: string | null;
        anam_llm_id: string | null;
        anam_persona_id: string | null;
        avatar_provider: string;
      };

      // Lemonsliceプロバイダーの場合は既存フローへ
      if (!config.avatar_provider || config.avatar_provider !== 'anam') {
        return res.json({ enabled: false, avatarProvider: 'lemonslice' });
      }

      // Anam APIキー確認
      const anamApiKey = process.env.ANAM_API_KEY?.trim();
      if (!anamApiKey) {
        console.warn('[anamRoutes] ANAM_API_KEY not set');
        return res.json({ enabled: false, avatarProvider: 'lemonslice' });
      }

      // Anam API: セッショントークン取得（インラインpersonaConfig方式）
      // Client-Side Custom LLM: llmId='CUSTOMER_CLIENT_V1' でAnam内蔵AI無効化
      // LLM処理はRAJIUCE側（Groq）が担当し、Anamはアバター映像+TTSのみ担当
      const personaConfig: Record<string, unknown> = {
        name: config.name || 'Sales Assistant',
        avatarId: config.anam_avatar_id,
        voiceId: config.anam_voice_id,
        avatarModel: 'cara-3',
        languageCode: 'ja',
        llmId: 'CUSTOMER_CLIENT_V1',
        voiceGenerationOptions: {
          stability: 0.5,
          similarityBoost: 0.8,
          speed: 1.0,
        },
      };
      // systemPromptはRAJIUCE側のchat-streamで制御するためAnamには渡さない

      const anamRes = await fetch(`${ANAM_API_BASE}/v1/auth/session-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${anamApiKey}`,
        },
        body: JSON.stringify({ personaConfig }),
      });

      if (!anamRes.ok) {
        const errText = await anamRes.text();
        console.error(`[anamRoutes] Anam API error ${anamRes.status}: ${errText.slice(0, 200)}`);
        return res.status(502).json({ error: 'Anam APIエラー', enabled: false });
      }

      const anamData = await anamRes.json() as { sessionToken?: string; token?: string };
      const sessionToken = anamData.sessionToken ?? anamData.token ?? '';

      if (!sessionToken) {
        console.error('[anamRoutes] Anam API returned no session token');
        return res.status(502).json({ error: 'セッショントークンが取得できませんでした', enabled: false });
      }

      return res.json({
        enabled: true,
        avatarProvider: 'anam',
        sessionToken,
        avatarName: config.name || null,
      });

    } catch (err: any) {
      if (err?.code === '42703') {
        // マイグレーション未実行 — lemonsliceフォールバック
        return res.json({ enabled: false, avatarProvider: 'lemonslice' });
      }
      console.error('[POST /api/avatar/anam-session]', err);
      return res.json({ enabled: false, avatarProvider: 'lemonslice' });
    }
  });
}
