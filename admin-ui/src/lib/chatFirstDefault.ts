// admin-ui/src/lib/chatFirstDefault.ts
// Phase4: チャット・ファーストを既定ランディングにするかどうかの、ブラウザ単位オプトイン設定。
// このlocalStorageフラグだけで完結し、テナント全体・他ユーザー・サーバー側には一切影響しない。
// 既定は無効(false) = 従来のダッシュボードのまま。App.tsx と copilot-preview の両方から参照するため
// 循環import回避のためこのファイルに切り出している。

export const CHAT_FIRST_DEFAULT_KEY = "r2c_chat_first_default";

export function isChatFirstDefaultEnabled(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(CHAT_FIRST_DEFAULT_KEY) === "true";
  } catch {
    return false;
  }
}

export function setChatFirstDefaultEnabled(enabled: boolean): void {
  try {
    if (typeof window === "undefined") return;
    if (enabled) window.localStorage.setItem(CHAT_FIRST_DEFAULT_KEY, "true");
    else window.localStorage.removeItem(CHAT_FIRST_DEFAULT_KEY);
  } catch {
    // localStorage無効環境(プライベートブラウズ等)では静かに無視
  }
}
