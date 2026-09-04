// src/lib/excludedPagePattern.ts
// ウィジェットを表示しないページのパスパターン検証。
// 保存側(src/api/admin/tenants/routes.ts の zod スキーマ)とチャットツール側
// (src/api/admin/agent/actionExecutor.ts)が同じ判定を共有する。
// isValidOriginPattern(src/api/middleware/originCheck.ts)と同じ理由: 検証ロジックの
// 重複による片方だけ緩くなる事故(保存できたのに効かない)を防ぐ。
export function isValidExcludedPagePattern(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (value.includes("?") || value.includes("#")) return false;
  if (value.length < 1 || value.length > 200) return false;
  return true;
}

// public/widget.js の matchPathnameGlob と同一のグロブ構文(*, **)を実装する
// サーバー側版。あちらはブラウザに配信される単体スクリプトのため import できず、
// アルゴリズムをここに複製している。サーバー側で同じグロブ判定が必要になった
// 箇所(例: src/lib/sitemapDiscovery.ts のクロール除外)はこちらを使い、
// 3箇所目の実装を作らないこと。
export function matchesPathnameGlob(pathname: string, pattern: string): boolean {
  try {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "@@R2C_DBLSTAR@@")
      .replace(/\*/g, "[^/]*")
      .replace(/@@R2C_DBLSTAR@@/g, ".*");
    return new RegExp(`^${regexStr}$`).test(pathname);
  } catch {
    return false;
  }
}
