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

/**
 * ブラウザが送る Origin ヘッダの正規形に寄せる。
 * originCheck.ts の matchesPattern は完全一致(`pattern === origin`)で照合するため、
 * 末尾スラッシュ・大文字・既定ポート・パスが付いた値は「どのOriginにも一致しない
 * 死んだ登録」になる。R2C自身のドメイン判定がその表記揺れで漏れないよう、
 * 判定前にここで正規化する(照合そのものを変えるわけではない)。
 */
function normalizeOriginForHostCheck(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

function isR2cOwnHost(origin: string): boolean {
  const normalized = normalizeOriginForHostCheck(origin);
  const host = extractHost(normalized);
  if (host === null) return false;
  // 既定ポートは Origin ヘッダに現れないため、付いていても同一ホストとみなす
  const withoutDefaultPort = host.replace(/:443$/, "");
  return R2C_OWN_HOSTS.has(withoutDefaultPort);
}

/**
 * ブラウザの Origin ヘッダと決して一致しない形の登録を検出する。
 *
 * originCheck.ts の matchesPattern は完全一致で照合し、ブラウザが送る Origin は
 * 「スキーム + ホスト(+既定でないポート)」のみ・小文字・末尾スラッシュ無し。
 * よって末尾スラッシュ / 大文字 / パス付き / 前後空白 / 既定ポート明記 の登録は
 * **一件も一致せず、ウィジェットが全ページで無言で止まる**。
 * allowed_origins が空なら fail-open で全許可になるのに対し、こちらは fail-close で
 * 画面上は何のエラーも出ないため、機械監査でしか気付けない。
 */
export function findUnmatchableOrigins(allowedOrigins: string[]): string[] {
  return allowedOrigins.filter((raw) => {
    if (raw.trim().length === 0) return true; // 空行は何にも一致しない
    if (raw !== raw.trim()) return true; // 前後空白
    if (raw !== raw.toLowerCase()) return true; // 大文字
    if (/\/$/.test(raw)) return true; // 末尾スラッシュ
    if (/:443$/.test(raw)) return true; // 既定ポートはOriginに現れない
    // スキーム直後より後ろにパスが付いている
    if (/^https?:\/\/[^/]+\/./.test(raw)) return true;
    return false;
  });
}

/**
 * allowed_origins が実質空 = fail-open(既存タスク 1217807010191802 と同じ穴)。
 * 空白のみの行だけが入っている場合も、照合には一切使われないため空と同じ扱いにする
 * (`[""]` を「1件登録済み」と数えると、fail-open していることに気付けない)。
 */
export function hasEmptyOrigins(allowedOrigins: string[]): boolean {
  return allowedOrigins.every((o) => o.trim().length === 0);
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
 * A2A-0j: allowed_origins に R2C 自身の運用ドメインが1件以上含まれるが、
 * テナントの実サイトのドメインも含まれている(=全件一致ではない)場合に true を返す。
 * 全件が R2C 自身のみの致命的ケース(ウィジェットが1ページも動かない)は
 * isR2cOwnDomainOnly が担当する。こちらは「動きはするが不要なエントリが混ざっている」
 * 軽度のケース(例: Accept の実データ, 2026-09-02 実測)を拾う。
 * サイト訪問者のブラウザが送る Origin はテナントの実ドメインだけなので、
 * R2C自身のエントリはどの場面でも一致せず、削除しても支障がない。
 */
export function isR2cOwnDomainMixed(allowedOrigins: string[]): boolean {
  if (allowedOrigins.length === 0) return false;
  const ownCount = allowedOrigins.filter(isR2cOwnHost).length;
  return ownCount > 0 && ownCount < allowedOrigins.length;
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
  /** A2A-0j: 全件一致ではなく、R2C自身のドメインが実ドメインに混在している(軽度)。 */
  r2cOwnDomainMixed: boolean;
  invalidOriginPattern: boolean;
  /** ブラウザのOriginと決して一致しない登録(表記揺れ)。空なら問題なし。 */
  unmatchableOrigins: string[];
  emptySystemPrompt: boolean;
}

export function auditTenantConfig(input: {
  allowedOrigins: string[];
  systemPrompt: string | null | undefined;
}): TenantConfigIssues {
  return {
    emptyOrigins: hasEmptyOrigins(input.allowedOrigins),
    r2cOwnDomainOnly: isR2cOwnDomainOnly(input.allowedOrigins),
    r2cOwnDomainMixed: isR2cOwnDomainMixed(input.allowedOrigins),
    invalidOriginPattern: hasInvalidOriginPattern(input.allowedOrigins),
    unmatchableOrigins: findUnmatchableOrigins(input.allowedOrigins),
    emptySystemPrompt: hasEmptySystemPrompt(input.systemPrompt),
  };
}

export function hasAnyIssue(issues: TenantConfigIssues): boolean {
  return (
    issues.emptyOrigins ||
    issues.r2cOwnDomainOnly ||
    issues.r2cOwnDomainMixed ||
    issues.invalidOriginPattern ||
    issues.unmatchableOrigins.length > 0 ||
    issues.emptySystemPrompt
  );
}
