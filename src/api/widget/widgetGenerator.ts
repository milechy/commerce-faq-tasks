// src/api/widget/widgetGenerator.ts
// Dynamic per-tenant widget.js generator.
// Reads public/widget.js, injects tenant config, applies obfuscation.

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import jwt from "jsonwebtoken";

export interface TenantWidgetConfig {
  tenantId: string;
  apiBaseUrl: string;
  themeColor?: string;
  avatarEnabled?: boolean;
  /** GID 1216978855735482: アバターA/Bテストの割当実験ID（実験が無ければnull） */
  abExperimentId?: number | null;
  /** GID 1216978855735482: アバターA/Bテストの割当variant（実験が無ければnull） */
  abVariant?: "a" | "b" | null;
  /** 「Powered by R2C」バッジを表示するか（Growth以上は非表示。fail-safeで未設定時はtrue側） */
  showBrandingBadge?: boolean;
  /** バッジのリンク先（着地ページ、UTM + テナント識別子付き） */
  badgeUrl?: string;
  /** R2C自身の広告帯を表示するか（free_adプラン限定。fail-safeで未設定時はfalse側） */
  showAdPromo?: boolean;
  /** 広告帯のリンク先（着地ページ、UTM + テナント識別子付き） */
  adPromoUrl?: string;
  /**
   * ウィジェットを表示しないページのパスパターン（tenants.excluded_page_patterns）。
   * fail-safeはshowBrandingBadgeと同じ「表示する」側（未設定時は空配列=全ページ表示）。
   * 判定不能時に全ページで消えてしまう方が、出すぎるより重い事故なため。
   */
  excludedPagePatterns?: string[];
}

const WIDGET_SRC_PATH = path.resolve(process.cwd(), "public", "widget.js");

/** Generate a 24h widget session token (tenantId + nonce) */
function generateWidgetToken(tenantId: string): string {
  // 公開配布される widget token は管理API(SUPABASE_JWT_SECRET)とは別鍵で署名する。
  // 同じ鍵を使うと、widget.js に埋め込まれたトークンが Bearer として管理APIを通過してしまう。
  const secret = process.env.WIDGET_JWT_SECRET;
  if (!secret) {
    throw new Error("[widgetGenerator] WIDGET_JWT_SECRET is not configured");
  }
  return jwt.sign(
    {
      sub: tenantId,
      purpose: "widget-session",
      nonce: crypto.randomBytes(8).toString("hex"),
    },
    secret,
    { expiresIn: "24h" }
  );
}


/** Build a randomised variable name prefix for obfuscation */
function randomPrefix(): string {
  return "_r" + crypto.randomBytes(4).toString("hex");
}

const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  selfDefending: false,
  disableConsoleOutput: true,
} as const;

/**
 * public/widget.js の本文（全テナント共通・tenant設定を含まない）を難読化した結果を
 * プロセス内に1度だけキャッシュする。
 *
 * 背景: GET /widget/:tenantSlug.js の Cache-Control を 24h→5分に短縮した結果、
 * オリジンへのリクエスト頻度が最大288倍に増えうる。obfuscate() は約156KBのソースに対し
 * 実測 約250ms かかる同期処理でイベントループを止めるため、リクエスト毎の実行は
 * デプロイ直後のトラフィック下でAPI全体を詰まらせる恐れがある。
 * 本文はテナント間で完全に同一（tenant設定を含まない）ため、キャッシュしても
 * テナントごとの出し分けやトークンの鮮度には影響しない。プロセス再起動（=デプロイ毎）
 * でのみ再計算される。
 */
let cachedBody: { code: string; obfuscated: boolean } | null = null;

function getObfuscatedBody(): { code: string; obfuscated: boolean } {
  if (cachedBody) return cachedBody;
  const source = fs.readFileSync(WIDGET_SRC_PATH, "utf-8");
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const JavaScriptObfuscator = require("javascript-obfuscator");
    const result = JavaScriptObfuscator.obfuscate(source, {
      ...OBFUSCATOR_OPTIONS,
      seed: Math.floor(Math.random() * 1_000_000),
    });
    cachedBody = { code: result.getObfuscatedCode(), obfuscated: true };
  } catch {
    // Obfuscator not available in prod — cache the plain source instead
    // (availability doesn't change at runtime, so this is stable for the process lifetime).
    cachedBody = { code: source, obfuscated: false };
  }
  return cachedBody;
}

/**
 * Generate per-tenant widget JS.
 * Injects a config block at the top, then applies light variable-name randomisation.
 * Falls back to plain config injection if javascript-obfuscator is unavailable.
 */
export async function generateWidgetJs(config: TenantWidgetConfig): Promise<string> {
  const token = generateWidgetToken(config.tenantId);
  const prefix = randomPrefix();

  // Config block injected before the widget source
  const configBlock = `/* R2C Widget — tenant:${config.tenantId} */
(function(){
  var ${prefix}_cfg = {
    tenantId: ${JSON.stringify(config.tenantId)},
    apiBase: ${JSON.stringify(config.apiBaseUrl)},
    themeColor: ${JSON.stringify(config.themeColor ?? "#22c55e")},
    avatarEnabled: ${JSON.stringify(config.avatarEnabled ?? false)},
    abExperimentId: ${JSON.stringify(config.abExperimentId ?? null)},
    abVariant: ${JSON.stringify(config.abVariant ?? null)},
    showBrandingBadge: ${JSON.stringify(config.showBrandingBadge ?? true)},
    badgeUrl: ${JSON.stringify(config.badgeUrl ?? null)},
    // showBrandingBadge(fail-safe: 未設定時true)とは既定値が逆。広告は判定不能時に
    // 掲出しない側へ倒す(有料テナントへの誤掲出の方が無料テナントの掲出漏れより重い)。
    showAdPromo: ${JSON.stringify(config.showAdPromo ?? false)},
    adPromoUrl: ${JSON.stringify(config.adPromoUrl ?? null)},
    excludedPagePatterns: ${JSON.stringify(config.excludedPagePatterns ?? [])},
    _wt: ${JSON.stringify(token)}
  };
  if (typeof window !== "undefined") {
    window.__RAJIUCE_TENANT_CFG__ = ${prefix}_cfg;
  }
})();
`;

  const body = getObfuscatedBody();
  if (!body.obfuscated) {
    // Obfuscator not available — return config-injected plain source (existing fallback path).
    return configBlock + "\n" + body.code;
  }

  // トークン(_wt)はリクエスト毎に新しいnonceで署名される（使い回しでの推測可能性を
  // 避けるため）。そのため設定ブロックは本文キャッシュとは別に、毎回このリクエスト分だけ
  // 難読化する。156KBの本文に対する約250msに対し、この小さなブロックは約10msで済む。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const JavaScriptObfuscator = require("javascript-obfuscator");
    const result = JavaScriptObfuscator.obfuscate(configBlock, {
      ...OBFUSCATOR_OPTIONS,
      seed: Math.floor(Math.random() * 1_000_000),
    });
    return result.getObfuscatedCode() + "\n" + body.code;
  } catch {
    return configBlock + "\n" + body.code;
  }
}
