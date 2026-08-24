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

/**
 * Generate per-tenant widget JS.
 * Injects a config block at the top, then applies light variable-name randomisation.
 * Falls back to plain config injection if javascript-obfuscator is unavailable.
 */
export async function generateWidgetJs(config: TenantWidgetConfig): Promise<string> {
  const source = fs.readFileSync(WIDGET_SRC_PATH, "utf-8");
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
    _wt: ${JSON.stringify(token)}
  };
  if (typeof window !== "undefined") {
    window.__RAJIUCE_TENANT_CFG__ = ${prefix}_cfg;
  }
})();
`;

  const fullSource = configBlock + "\n" + source;

  // Attempt dynamic obfuscation (javascript-obfuscator may be a devDep)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const JavaScriptObfuscator = require("javascript-obfuscator");
    const result = JavaScriptObfuscator.obfuscate(fullSource, {
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      stringArray: true,
      stringArrayEncoding: ["base64"],
      selfDefending: false,
      disableConsoleOutput: true,
      seed: Math.floor(Math.random() * 1_000_000),
    });
    return result.getObfuscatedCode();
  } catch {
    // Obfuscator not available in prod — return config-injected source
    return fullSource;
  }
}
