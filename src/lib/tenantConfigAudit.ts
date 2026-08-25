// src/lib/tenantConfigAudit.ts
//
// P0-5 (GID 1217808301788163): allowed_origins / system_prompt の設定ミスを検出する
// 純粋な判定関数。SCRIPTS/audit-tenant-config.ts (読み取り専用CLI) から呼ばれる。
//
// 背景: carnation(稼働中テナント)の allowed_origins が R2C 自身の運用ドメイン
// (admin.r2c.biz / api.r2c.biz) のみで、テナントの実サイトが1つも登録されていなかった
// (2026-08-25 実測)。allowed_origins が空なら originCheck.ts が全ドメイン許可に
// フォールバックするが、値が入っていて中身が誤っているこのケースは無言で止まる。
// テナント数が増えると目視監査は必ず漏れるため、ここに機械判定として切り出す。
//
// ワイルドカードの安全性判定(SAFE_WILDCARD_PATTERN / KNOWN_PUBLIC_SUFFIXES)は
// 再実装しない — originCheck.ts の isValidOriginPattern を単一の情報源として使う。

import { isValidOriginPattern } from "../api/middleware/originCheck";

/** R2C 自身の運用ドメイン。allowed_origins がこれしか含まなければ、テナントの実サイトが未設定。 */
const R2C_OWN_HOSTS = new Set(["admin.r2c.biz", "api.r2c.biz", "r2c.biz"]);

/**
 * `https://<host>` (パス無し) からホスト部を取り出す。
 * originCheck.ts の SAFE_WILDCARD_PATTERN と同じく「パスを含まない」形を前提にする。
 */
function extractHost(origin: string): string | null {
  const m = /^https:\/\/([^/]+)$/.exec(origin.trim());
  return m ? m[1] : null;
}

function isR2cOwnHost(origin: string): boolean {
  const host = extractHost(origin);
  return host !== null && R2C_OWN_HOSTS.has(host);
}

/** allowed_origins が空 = fail-open(既存タスク 1217807010191802 と同じ穴)。 */
export function hasEmptyOrigins(allowedOrigins: string[]): boolean {
  return allowedOrigins.length === 0;
}

/**
 * allowed_origins に値は入っているが、その全てが R2C 自身の運用ドメインだけ
 * (テナントの実サイトのドメインが1つも無い)場合に true を返す。
 * 空配列は原因が異なる(誤設定 vs fail-open)ため hasEmptyOrigins 側で検出し、
 * こちらは false を返す。
 */
export function isR2cOwnDomainOnly(allowedOrigins: string[]): boolean {
  if (allowedOrigins.length === 0) return false;
  return allowedOrigins.every(isR2cOwnHost);
}

/**
 * 保存時バリデーション(admin/tenants/routes.ts)・照合(originCheck.ts)と同じ
 * isValidOriginPattern で不正な形(パブリックサフィックスワイルドカード等)を検出する。
 * 過去に手動UPDATE等で入り込んだ値の後方点検が目的。
 */
export function hasInvalidOriginPattern(allowedOrigins: string[]): boolean {
  return allowedOrigins.some((origin) => !isValidOriginPattern(origin));
}

export function hasEmptySystemPrompt(systemPrompt: string | null | undefined): boolean {
  return !systemPrompt || systemPrompt.trim().length === 0;
}

export interface TenantConfigIssues {
  emptyOrigins: boolean;
  r2cOwnDomainOnly: boolean;
  invalidOriginPattern: boolean;
  emptySystemPrompt: boolean;
}

export function auditTenantConfig(input: {
  allowedOrigins: string[];
  systemPrompt: string | null | undefined;
}): TenantConfigIssues {
  return {
    emptyOrigins: hasEmptyOrigins(input.allowedOrigins),
    r2cOwnDomainOnly: isR2cOwnDomainOnly(input.allowedOrigins),
    invalidOriginPattern: hasInvalidOriginPattern(input.allowedOrigins),
    emptySystemPrompt: hasEmptySystemPrompt(input.systemPrompt),
  };
}

export function hasAnyIssue(issues: TenantConfigIssues): boolean {
  return (
    issues.emptyOrigins ||
    issues.r2cOwnDomainOnly ||
    issues.invalidOriginPattern ||
    issues.emptySystemPrompt
  );
}
