/**
 * imageContentGuard.ts — アバター参照画像アップロードの著作権/NSFW防止ガード (COPY-1)
 *
 * contentGuard.ts はプロンプト文字列の固定ワード一致のみで、画像アップロード経路には
 * 何のチェックも無かった（サイズチェックのみ）。Gemini 2.5 Flash のマルチモーダル判定で
 * アップロード画像そのものを検査し、NSFW・著作権キャラクター・実在人物の肖像・商標ロゴを
 * 検出する。
 */

import { callGeminiVisionJudge } from './gemini/client';
import { logger } from './logger';

export interface ImageModerationResult {
  blocked: boolean;
  reason?: string;
}

const MODERATION_PROMPT = `You are a content moderation classifier for a business chat-avatar customization tool.
Analyze the attached image and answer strictly in this JSON format, with no surrounding text or markdown fences:
{"nsfw": boolean, "copyrighted_character": boolean, "celebrity_likeness": boolean, "trademarked_logo": boolean, "reason": "brief Japanese explanation if any flag is true, else empty string"}

Flag "copyrighted_character" if the image depicts a recognizable fictional character owned by a company or studio (anime, game, movie, comic characters, mascots).
Flag "celebrity_likeness" if the image depicts a real, identifiable public figure or celebrity.
Flag "trademarked_logo" if the image prominently contains a corporate logo or trademark.
Flag "nsfw" for nudity or sexual content.
If none apply, all flags must be false.`;

const DATA_URL_PATTERN = /^data:([^;]+);base64,(.+)$/;

/**
 * data: URL 形式のアップロード画像を検査する。data: URL でない場合(既にホスティング済みの
 * 生成画像URL等)はチェック対象外として false を返す。
 *
 * フェイルオープン方針: Gemini API障害時はアップロードをブロックしない。従来はこの経路に
 * チェック自体が存在しなかったため、障害時に旧挙動へ後退するだけであり悪化はしない。
 * 障害は監視できるようログのみ残す。
 */
export async function checkImageForInfringement(
  dataUrl: string,
  usageContext: { tenantId: string; requestId: string }
): Promise<ImageModerationResult> {
  const match = dataUrl.match(DATA_URL_PATTERN);
  if (!match) return { blocked: false };
  const [, mimeType, base64Data] = match as unknown as [string, string, string];

  try {
    const raw = await callGeminiVisionJudge(MODERATION_PROMPT, base64Data, mimeType, {
      tenantId: usageContext.tenantId,
      requestId: usageContext.requestId,
      featureUsed: 'avatar_image_moderation',
      billable: false,
    });
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned) as {
      nsfw?: boolean;
      copyrighted_character?: boolean;
      celebrity_likeness?: boolean;
      trademarked_logo?: boolean;
      reason?: string;
    };
    const blocked = Boolean(
      parsed.nsfw || parsed.copyrighted_character || parsed.celebrity_likeness || parsed.trademarked_logo
    );
    return blocked
      ? { blocked: true, reason: parsed.reason || '不適切なコンテンツが検出されました' }
      : { blocked: false };
  } catch (err) {
    logger.warn('[imageContentGuard] moderation check failed — allowing upload (fail-open)', err);
    return { blocked: false };
  }
}
