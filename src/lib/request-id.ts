import type { NextFunction, Request, Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * サーバが必ず新規採番する、このHTTPリクエストの正規ID。
       * usage_logs.request_id（グローバル UNIQUE + ON CONFLICT DO NOTHING）の
       * 冪等キーとして課金計上に流れるため、クライアント制御の値を絶対に混ぜない。
       */
      requestId: string;
      /**
       * 受信した `X-Request-ID` の生値（トレース相関専用）。
       * ★課金・冪等・識別には決して使わない★。ログ相関のためだけに保持する。
       */
      clientTraceId?: string;
    }
  }
}

const REQUEST_ID_HEADER = "x-request-id";

/**
 * トレース相関用に保持する受信IDの最大長。
 * クライアント制御値なので、ログ肥大化・注入を避けるため上限で切り詰める。
 */
const MAX_CLIENT_TRACE_LEN = 200;

/**
 * Express middleware: 全リクエストに `req.requestId` を付与する。
 *
 * ★セキュリティ不変条件（[P0] 課金回避の封鎖）★
 * `req.requestId` は必ず `crypto.randomUUID()` でサーバ新規採番する。
 * 受信した `X-Request-ID` ヘッダは決して再利用しない。
 *
 * 理由: `req.requestId` は usageTracker の INSERT で
 * `usage_logs.request_id`（グローバル UNIQUE + `ON CONFLICT (request_id) DO NOTHING`）
 * の冪等キーとして課金計上へ直結する。ここで受信ヘッダを再利用すると、固定/再利用の
 * `X-Request-ID` を送り続けるだけで、2回目以降の INSERT が ON CONFLICT で握り潰され、
 * LLM 原価は発生させつつ usage_logs には記録されない = Stripe 請求からも free_ad の
 * 生リクエスト上限からも黙って消える（課金回避手口）。
 *
 * 正当なリトライの冪等性は request_id では担保していない（各HTTPリクエストは
 * 別のLLM呼び出し = 別コスト = 別行として数えるのが正しい）。会話単位の請求は
 * usage_logs.session_id によるグルーピング（chat/route.ts / stripeSync.ts）で担保しており、
 * 本変更はそこに一切触れないため会話ベースの請求額は変わらない。
 * 再実行時の二重計上を request_id で防ぎたい内部呼び出し（book-structurize:${bookId} /
 * sai-task:${saiTaskId} 等）は、自前でサーバ生成の決定的キーを trackUsage に直接渡しており
 * `req.requestId` を経由しないため、本変更の影響を受けない。
 *
 * - `req.requestId`: 常にサーバ新規採番（課金・ログの正規ID）
 * - `req.clientTraceId`: 受信 `X-Request-ID` の生値（トレース相関専用・課金には未使用）
 * - レスポンスヘッダ `X-Request-ID`: サーバ採番した正規IDを返す（下流はこれを信頼できる）
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestId = crypto.randomUUID();
  req.requestId = requestId;

  // 受信 X-Request-ID はトレース相関のためだけに保持する（課金・識別には使わない）。
  const incoming = req.headers[REQUEST_ID_HEADER];
  if (typeof incoming === "string" && incoming.length > 0) {
    req.clientTraceId = incoming.slice(0, MAX_CLIENT_TRACE_LEN);
  }

  // 下流・上流には常にサーバ採番の正規IDを返す（受信値のエコーバックはしない）。
  res.setHeader(REQUEST_ID_HEADER, requestId);

  next();
}
