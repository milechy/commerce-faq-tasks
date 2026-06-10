import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getPool } from "../../lib/db";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const LeadSchema = z.object({
  name:     z.string().min(1).max(100),
  company:  z.string().min(1).max(200),
  siteUrl:  z.string().url().max(500),
  email:    z.string().email().max(200),
  industry: z.string().max(50).optional(),
  message:  z.string().max(2000).optional(),
  _hp:      z.string().max(0).optional(), // honeypot — must be empty
});

// シンプルな IP ベースレートリミッター（40 req/hour）
// 大企業の共有 IP 対策で緩め。bot 防止は Cloudflare Turnstile に任せる。
const ipCounts = new Map<string, { count: number; resetAt: number }>();
function leadRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const WINDOW = 60 * 60 * 1000; // 1時間
  const MAX = 40;
  const entry = ipCounts.get(ip);
  if (!entry || entry.resetAt < now) {
    ipCounts.set(ip, { count: 1, resetAt: now + WINDOW });
    next();
    return;
  }
  if (entry.count >= MAX) {
    res.status(429).json({ success: false, message: "しばらく時間をおいてから再度お試しください。" });
    return;
  }
  entry.count++;
  next();
}

export function registerLeadInquiryRoutes(router: Router): void {
  router.post("/v1/public/lead-inquiry", leadRateLimit, async (req: Request, res: Response) => {
    const parsed = LeadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: "入力内容をご確認ください。" });
      return;
    }

    const { name, company, siteUrl, email, industry, message, _hp } = parsed.data;

    // Honeypot: filled → silent drop (botと判断)
    if (_hp && _hp.length > 0) {
      res.json({ success: true });
      return;
    }

    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "";
    const userAgent = (req.headers["user-agent"] ?? "").slice(0, 500);

    try {
      const db = getPool();
      await db.query(
        `INSERT INTO lp_leads (name, company, site_url, email, industry, message, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [name, company, siteUrl, email, industry ?? null, message ?? null, ip, userAgent],
      );

      logger.info({ email, company, industry }, "lp_lead: new inquiry");

      // SendGrid / Asana 連携は別途 env 設定後に追加
      // TODO: sendLeadNotification({ name, company, email, siteUrl, industry, message });

      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "lp_lead: db insert failed");
      res.status(500).json({ success: false, message: "送信に失敗しました。時間をおいて再度お試しください。" });
    }
  });
}
