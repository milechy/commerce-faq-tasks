// src/lib/resourceContentGuard.ts
//
// 資料（PDF抽出テキスト）の著作権侵害・不適切表現チェック。
// imageContentGuard.ts と同じ「ドメイン別モデレーション薄ラッパー」枠のテキスト版。
// Gemini呼び出し自体は複製せず、既存の callGeminiJudge()（テキスト入出力の汎用
// プリミティブ、src/lib/gemini/client.ts）をそのまま使う。
//
// フェイルオープン方針: imageContentGuard.ts と同じく、Gemini API障害時はアップロード
// をブロックしない。障害は監視できるようログのみ残す。

import { callGeminiJudge } from './gemini/client';
import { logger } from './logger';

export interface ResourceModerationResult {
  blocked: boolean;
  reason?: string;
}

const MODERATION_PROMPT_HEADER = `You are a content moderation classifier for a business-facing marketing document (a whitepaper or sales resource shown to a company's prospective customers).
Analyze the following document text and answer strictly in this JSON format, with no surrounding text or markdown fences:
{"copyright_infringement": boolean, "inappropriate_content": boolean, "reason": "brief Japanese explanation if any flag is true, else empty string"}

Flag "copyright_infringement" if the text appears to be copied verbatim from a copyrighted book, article, or other third-party work without attribution.
Flag "inappropriate_content" if the text contains content clearly inappropriate for a business-facing marketing document (e.g. hate speech, sexual content, illegal solicitation).
If none apply, both flags must be false.

Document text:
`;

// 書籍内容と同様、資料本文もログ・メトリクスに出さない（Anti-Slopルール）。
// プロンプトに含める長さも上限を設け、Gemini呼び出しの入力トークンを抑える。
const MAX_MODERATION_TEXT_CHARS = 8000;

/**
 * 資料PDFから抽出したテキストを著作権侵害・不適切表現の観点で判定する。
 * usageContext は callGeminiJudge の既定（billable=false・featureUsed='admin_tuning'）に
 * 委ねる — R2C運用側のモデレーション処理であり、テナントへの課金対象ではないため。
 */
export async function checkResourceTextForInfringement(
  text: string,
  usageContext: { tenantId: string; requestId: string }
): Promise<ResourceModerationResult> {
  try {
    const prompt = MODERATION_PROMPT_HEADER + text.slice(0, MAX_MODERATION_TEXT_CHARS);
    const raw = await callGeminiJudge(prompt, {
      tenantId: usageContext.tenantId,
      requestId: usageContext.requestId,
    });
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned) as {
      copyright_infringement?: boolean;
      inappropriate_content?: boolean;
      reason?: string;
    };
    const blocked = Boolean(parsed.copyright_infringement || parsed.inappropriate_content);
    return blocked
      ? { blocked: true, reason: parsed.reason || '不適切なコンテンツが検出されました' }
      : { blocked: false };
  } catch (err) {
    logger.warn('[resourceContentGuard] moderation check failed — allowing upload (fail-open)', err);
    return { blocked: false };
  }
}
