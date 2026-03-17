import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

/**
 * true = 正常設定, false = 未設定 → App.tsx が設定エラー画面を表示する。
 * このフラグが false の場合、supabase クライアントは実際の API 呼び出しを行わない。
 */
export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

if (!supabaseConfigured) {
  console.error(
    "[supabaseClient] VITE_SUPABASE_URL または VITE_SUPABASE_ANON_KEY が設定されていません。" +
    " admin-ui/.env.local を確認してください。"
  );
}

// 未設定時でもcreateClient()を呼ぶ（"" を渡すと例外が出るためダミー値を使用）。
// supabaseConfigured=false の場合 App.tsx が設定エラー画面を返すので
// 実際の Supabase API 呼び出しは発生しない。
// NOTE: ダミー値に supabase.co ドメインを使わない（バンドル検証で誤検知を防ぐ）。
export const supabase = createClient(
  supabaseUrl || "https://not-configured.invalid",
  supabaseAnonKey || "not-configured"
);
