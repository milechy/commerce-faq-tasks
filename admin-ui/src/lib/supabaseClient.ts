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

// 未設定時でもプレースホルダーで createClient() を呼ぶ。
// createClient("", "") は例外を投げるため、有効なURL形式のダミー値を渡す。
// supabaseConfigured=false の場合 App.tsx が設定エラー画面を返すので
// 実際の Supabase API 呼び出しは発生しない。
export const supabase = createClient(
  supabaseUrl || "https://placeholder-unconfigured.supabase.co",
  supabaseAnonKey || "placeholder-anon-key-unconfigured-placeholder-00000000"
);
