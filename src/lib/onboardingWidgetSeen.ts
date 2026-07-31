// src/lib/onboardingWidgetSeen.ts
//
// Asana 1217040715801275: オンボーディング4段階(docs/ONBOARDING_FIRST_LOGIN.md §3.1③)の
// うち「設置検知」を記録する。呼び出し元は GET /api/widget/features
// (src/index.ts。widget.js がページ読み込みごと・apiKey保有時に必ず叩くエンドポイント)。
//
// 単独ファイルに切り出した理由: src/index.ts はエントリポイントで、モジュールを
// import した時点で startServer() が無条件に実行される(app を export していない
// ため、既存のどのテストも src/index.ts を直接importしていない)。DB書き込みを
// 伴うこの処理だけは単体テスト可能にする必要があるため、ここへ抽出した
// (CLAUDE.md「新規ファイルを作ってよいのは、テスト可能な純関数として切り出す場合のみ」に該当)。
//
// fire-and-forget: 記録の失敗がウィジェットのレスポンスに影響してはならない。
// 初回のみ記録する(WHERE onboarding_widget_seen_at IS NULL で以降のUPDATEを防ぐ)。

import type { Pool } from "pg";
import { logger } from "./logger";

export async function recordWidgetSeenOnce(db: Pool, tenantId: string): Promise<void> {
  try {
    // オンボ 是正D-1: is_active 条件が無く、停止中テナントのAPIキーでもウィジェット
    // 設置検知が立ってしまっていた(呼び出し元 src/index.ts では is_active チェックより
    // 前にこの関数を呼ぶため、ここ自体に条件を持たせる必要がある)。
    await db.query(
      "UPDATE tenants SET onboarding_widget_seen_at = NOW() WHERE id = $1 AND onboarding_widget_seen_at IS NULL AND is_active = true",
      [tenantId],
    );
  } catch (err) {
    logger.warn("[onboardingWidgetSeen] onboarding_widget_seen_at update failed", err);
  }
}
