import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { logger } from "../logger";

const TIMESTAMP_TOLERANCE_SEC = 300; // 5 minutes

export function verifyHmacSignature(
  secret: string,
  timestamp: string,
  body: unknown,
  signature: string,
): boolean {
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > TIMESTAMP_TOLERANCE_SEC) {
    return false;
  }
  const message = `${timestamp}:${JSON.stringify(body)}`;
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export function internalHmacMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.headers["x-internal-request"] !== "1") {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const secret = process.env.INTERNAL_API_HMAC_SECRET;
  if (!secret) {
    // HMAC secret 未設定は開発環境のみ許容
    if (process.env.NODE_ENV !== "production") {
      next();
      return;
    }
    res.status(500).json({ error: "HMAC secret not configured" });
    return;
  }

  const timestamp = req.headers["x-hmac-timestamp"] as string | undefined;
  const signature = req.headers["x-hmac-signature"] as string | undefined;

  if (!timestamp || !signature) {
    logger.warn("[hmacVerifier] missing HMAC headers");
    res.status(401).json({ error: "Missing HMAC headers" });
    return;
  }

  if (!verifyHmacSignature(secret, timestamp, req.body, signature)) {
    logger.warn("[hmacVerifier] invalid HMAC signature");
    res.status(401).json({ error: "Invalid HMAC signature" });
    return;
  }

  next();
}
