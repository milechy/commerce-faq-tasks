// src/lib/healthBusiness.ts
// GET /health/business — 業務 KPI 確認エンドポイント
// UATa 事例 #6: scheduler_healthy 誤判断回避のための実務指標エンドポイント

import type { Request, Response } from "express";
import { pool } from "./db";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export interface BusinessHealthResponse {
  last_chat_message_at: string | null;
  chat_messages_24h: number;
  cv_events_24h: number;
  rag_searches_24h: number;
  tenants_active_24h: string[];
  warnings: string[];
}

interface BusinessMetrics {
  last_chat_message_at: string | null;
  chat_messages_24h: number;
  chat_messages_7d: number;
  cv_events_24h: number;
  rag_searches_24h: number;
  tenants_active_24h: string[];
}

async function fetchBusinessMetrics(): Promise<BusinessMetrics> {
  if (!pool) {
    return {
      last_chat_message_at: null,
      chat_messages_24h: 0,
      chat_messages_7d: 0,
      cv_events_24h: 0,
      rag_searches_24h: 0,
      tenants_active_24h: [],
    };
  }

  const [msgResult, msg7dResult, cvResult, ragResult, tenantResult] = await Promise.all([
    pool.query<{ cnt: string; last_at: string | null }>(`
      SELECT COUNT(*) AS cnt, MAX(created_at) AS last_at
      FROM chat_messages
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `),
    pool.query<{ cnt: string }>(`
      SELECT COUNT(*) AS cnt
      FROM chat_messages
      WHERE created_at > NOW() - INTERVAL '7 days'
    `),
    pool.query<{ cnt: string }>(`
      SELECT COUNT(*) AS cnt
      FROM conversion_attributions
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `),
    // RAG searches: assistant メッセージで rag_sources に 1 件以上含むもの
    pool.query<{ cnt: string }>(`
      SELECT COUNT(*) AS cnt
      FROM chat_messages
      WHERE created_at > NOW() - INTERVAL '24 hours'
        AND role = 'assistant'
        AND rag_sources IS NOT NULL
        AND jsonb_array_length(rag_sources) > 0
    `),
    pool.query<{ tenant_id: string }>(`
      SELECT DISTINCT tenant_id
      FROM chat_messages
      WHERE created_at > NOW() - INTERVAL '24 hours'
        AND tenant_id IS NOT NULL
      ORDER BY tenant_id
    `),
  ]);

  return {
    last_chat_message_at: msgResult.rows[0]?.last_at ?? null,
    chat_messages_24h: parseInt(msgResult.rows[0]?.cnt ?? "0", 10),
    chat_messages_7d: parseInt(msg7dResult.rows[0]?.cnt ?? "0", 10),
    cv_events_24h: parseInt(cvResult.rows[0]?.cnt ?? "0", 10),
    rag_searches_24h: parseInt(ragResult.rows[0]?.cnt ?? "0", 10),
    tenants_active_24h: tenantResult.rows.map((r) => r.tenant_id),
  };
}

export function buildWarnings(metrics: BusinessMetrics): string[] {
  const warnings: string[] = [];

  // 7日平均と比較: 50% 未満で warning
  const daily7dAvg = metrics.chat_messages_7d / 7;
  if (daily7dAvg > 0 && metrics.chat_messages_24h < daily7dAvg * 0.5) {
    const dropPct = Math.round((1 - metrics.chat_messages_24h / daily7dAvg) * 100);
    warnings.push(`chat_messages_24h dropped ${dropPct}% vs 7-day average`);
  }

  // last_chat_message_at が 6 時間以上前 (7d ベースラインがある場合のみ)
  if (metrics.chat_messages_7d > 0) {
    if (metrics.last_chat_message_at === null) {
      warnings.push("last_chat_message_at is null: no messages recorded");
    } else {
      const lastAt = new Date(metrics.last_chat_message_at).getTime();
      if (Date.now() - lastAt > SIX_HOURS_MS) {
        warnings.push("last_chat_message_at is older than 6 hours");
      }
    }
  }

  // rag_searches_24h が 0 (7d ベースラインがある場合のみ — ベースラインなし = 稼働前/閑散期)
  if (metrics.chat_messages_7d > 0 && metrics.rag_searches_24h === 0) {
    warnings.push("CRITICAL: rag_searches_24h is 0 — RAG pipeline may be down");
  }

  return warnings;
}

export async function businessHealthHandler(_req: Request, res: Response): Promise<void> {
  try {
    const metrics = await fetchBusinessMetrics();
    const warnings = buildWarnings(metrics);

    const body: BusinessHealthResponse = {
      last_chat_message_at: metrics.last_chat_message_at,
      chat_messages_24h: metrics.chat_messages_24h,
      cv_events_24h: metrics.cv_events_24h,
      rag_searches_24h: metrics.rag_searches_24h,
      tenants_active_24h: metrics.tenants_active_24h,
      warnings,
    };

    res.status(200).json(body);
  } catch {
    res.status(500).json({ error: "internal_error", message: "業務KPI取得に失敗しました" });
  }
}
