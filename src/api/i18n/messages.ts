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
    "error.free_ad_quota_exceeded": "今月のご利用可能回数の上限に達しました。プランをアップグレードすると引き続きご利用いただけます。上限は毎月1日にリセットされます。",
    "error.billing_suspended": "お支払いの確認が取れないため、現在ご利用を一時停止しています。管理画面からお支払い情報をご確認ください。",
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
    "error.free_ad_quota_exceeded": "You've reached this month's usage limit. Upgrading your plan lets you keep chatting. The limit resets on the 1st of each month.",
    "error.billing_suspended": "Service is temporarily paused because we could not verify your payment. Please check your billing details in the admin console.",
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
