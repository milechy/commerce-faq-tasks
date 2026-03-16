/**
 * tz-middleware-template.ts — タイムゾーン対応ミドルウェア テンプレート
 * (Phase33 Stream D — CDN・タイムゾーン対応)
 *
 * 【統合役（Stream Integration）への注意】
 * このファイルはテンプレートです。
 * src/api/middleware/timezone.ts に配置して src/index.ts の apiStack に追加してください。
 *
 * 統合方法:
 *   1. このファイルを src/api/middleware/timezone.ts にコピー
 *   2. src/index.ts の apiStack に langDetectMiddleware の直後に追加:
 *      import { timezoneMiddleware } from "./api/middleware/timezone";
 *      const apiStack = [..., langDetectMiddleware, timezoneMiddleware];
 *
 * 機能:
 *   - リクエストヘッダー X-Timezone からクライアントのタイムゾーンを取得
 *   - テナント設定にタイムゾーンが設定されていればそちらを優先
 *   - req.timezone に IANA タイムゾーン文字列をセット（例: "Asia/Tokyo"）
 *   - レスポンスに X-Timezone ヘッダーを付与（クライアント確認用）
 *   - 不正な TZ は UTC にフォールバック（エラーにしない）
 */

import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";

// -----------------------------------------------------------------------
// Request 型拡張 — req.timezone を追加
// -----------------------------------------------------------------------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** IANA timezone string resolved for this request (e.g. "Asia/Tokyo") */
      timezone: string;
    }
  }
}

// -----------------------------------------------------------------------
// 有効な IANA タイムゾーン文字列かどうかを検証
// -----------------------------------------------------------------------

const TIMEZONE_CACHE = new Map<string, boolean>();
const TZ_MAX_LENGTH = 64;

function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > TZ_MAX_LENGTH) return false;

  const cached = TIMEZONE_CACHE.get(tz);
  if (cached !== undefined) return cached;

  try {
    // Intl.DateTimeFormat がサポートする TZ かどうかで検証
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    TIMEZONE_CACHE.set(tz, true);
    return true;
  } catch {
    TIMEZONE_CACHE.set(tz, false);
    return false;
  }
}

// -----------------------------------------------------------------------
// タイムゾーン解決の優先順位
// -----------------------------------------------------------------------
//
//  1. テナント設定 (req.tenantConfig?.timezone) — 最優先
//  2. X-Timezone リクエストヘッダー
//  3. UTC（フォールバック）
//
// -----------------------------------------------------------------------

const DEFAULT_TIMEZONE = "UTC";

export function createTimezoneMiddleware(opts: { logger?: Logger } = {}) {
  const logger = opts.logger;

  return function timezoneMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    let resolved = DEFAULT_TIMEZONE;

    // 1. テナント設定を優先（TenantConfig に timezone フィールドがある場合）
    // NOTE: tenantContext ミドルウェアの後に配置することが前提
    const tenantTz = (req as any).tenantConfig?.timezone as string | undefined;
    if (tenantTz && isValidTimezone(tenantTz)) {
      resolved = tenantTz;
    } else {
      // 2. X-Timezone ヘッダーから取得
      const headerTz = req.headers["x-timezone"] as string | undefined;
      if (headerTz) {
        const trimmed = headerTz.trim();
        if (isValidTimezone(trimmed)) {
          resolved = trimmed;
        } else {
          logger?.warn(
            { timezone: trimmed, path: req.path },
            "[timezone] invalid X-Timezone header, falling back to UTC"
          );
        }
      }
    }

    req.timezone = resolved;

    // クライアントが解決されたタイムゾーンを確認できるよう X-Timezone をレスポンスに付与
    res.setHeader("X-Timezone", resolved);

    next();
  };
}

// -----------------------------------------------------------------------
// APIレスポンスの日時フィールドをタイムゾーン付きでフォーマットするユーティリティ
// -----------------------------------------------------------------------

/**
 * Date を指定タイムゾーンの ISO 8601 風文字列に変換する
 *
 * @example
 * formatDateInTimezone(new Date(), "Asia/Tokyo")
 * // => "2026-03-12T15:30:00+09:00"
 */
export function formatDateInTimezone(date: Date, timezone: string): string {
  try {
    // Intl.DateTimeFormat で各フィールドを取得してオフセット付き文字列を組み立てる
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "shortOffset",
    });

    const parts = fmt.formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";

    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hour = get("hour") === "24" ? "00" : get("hour");
    const minute = get("minute");
    const second = get("second");

    // timeZoneName は "GMT+9" 形式 → "+09:00" に変換
    const tzName = get("timeZoneName"); // e.g. "GMT+9" or "GMT-5:30"
    const offset = tzName.replace("GMT", "").replace(/^([+-])(\d)$/, "$10$2:00").replace(/^([+-]\d{2})$/, "$1:00") || "+00:00";

    return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
  } catch {
    // フォールバック: UTC ISO 文字列
    return date.toISOString();
  }
}

/**
 * APIレスポンスオブジェクト中の日時フィールドをタイムゾーン変換するヘルパー
 *
 * @param obj     変換対象のオブジェクト（浅いコピーを返す）
 * @param fields  変換するフィールド名リスト（デフォルト: ["createdAt", "updatedAt", "timestamp"]）
 * @param timezone IANA タイムゾーン文字列
 */
export function convertDatesToTimezone(
  obj: Record<string, unknown>,
  timezone: string,
  fields: string[] = ["createdAt", "updatedAt", "timestamp"]
): Record<string, unknown> {
  const result = { ...obj };
  for (const field of fields) {
    const val = result[field];
    if (val instanceof Date) {
      result[field] = formatDateInTimezone(val, timezone);
    } else if (typeof val === "string" && !Number.isNaN(Date.parse(val))) {
      result[field] = formatDateInTimezone(new Date(val), timezone);
    } else if (typeof val === "number" && val > 0) {
      // Unix ミリ秒タイムスタンプとみなす
      result[field] = formatDateInTimezone(new Date(val), timezone);
    }
  }
  return result;
}
