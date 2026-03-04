import type { NextFunction, Request, Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

const REQUEST_ID_HEADER = "x-request-id";

/**
 * Express middleware: 全リクエストに requestId を付与する。
 *
 * - 受信した `X-Request-ID` ヘッダがあれば再利用（上流ロードバランサとの相関追跡用）
 * - なければ `crypto.randomUUID()` で新規生成
 * - `req.requestId` に設定し、レスポンスヘッダ `X-Request-ID` に返す
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const requestId =
    typeof incoming === "string" && incoming.length > 0
      ? incoming
      : crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  next();
}
