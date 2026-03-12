// src/api/i18n/messages.ts
// Phase33: APIレスポンスメッセージ辞書

export type Lang = "ja" | "en";

const messages: Record<Lang, Record<string, string>> = {
  ja: {
    "error.not_found": "リソースが見つかりません",
    "error.unauthorized": "認証が必要です",
    "error.forbidden": "このリソースへのアクセス権限がありません",
    "error.validation": "入力内容に問題があります",
    "error.server": "サーバーエラーが発生しました。しばらくしてから再試行してください",
    "success.created": "作成しました",
    "success.updated": "更新しました",
    "success.deleted": "削除しました",
  },
  en: {
    "error.not_found": "Resource not found",
    "error.unauthorized": "Authentication is required",
    "error.forbidden": "You do not have permission to access this resource",
    "error.validation": "There was a problem with your input",
    "error.server": "A server error occurred. Please try again later",
    "success.created": "Successfully created",
    "success.updated": "Successfully updated",
    "success.deleted": "Successfully deleted",
  },
};

/**
 * 指定したキーのメッセージを返す。
 * キーが存在しない場合はキー自体を返す（フォールバック）。
 */
export function t(key: string, lang: Lang): string {
  return messages[lang]?.[key] ?? messages.ja[key] ?? key;
}
