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
}

const WIDGET_SRC_PATH = path.resolve(process.cwd(), "public", "widget.js");

/** Generate a 24h widget session token (tenantId + nonce) */
export function generateWidgetToken(tenantId: string): string {
  const secret = process.env.SUPABASE_JWT_SECRET ?? process.env.WIDGET_JWT_SECRET ?? "widget-secret-dev";
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
  const configBlock = `/* RAJIUCE Widget — tenant:${config.tenantId} */
(function(){
  var ${prefix}_cfg = {
    tenantId: ${JSON.stringify(config.tenantId)},
    apiBase: ${JSON.stringify(config.apiBaseUrl)},
    themeColor: ${JSON.stringify(config.themeColor ?? "#22c55e")},
    avatarEnabled: ${JSON.stringify(config.avatarEnabled ?? false)},
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
