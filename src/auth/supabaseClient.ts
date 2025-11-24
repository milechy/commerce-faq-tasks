import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.warn(
    "[supabaseClient] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set. Supabase Admin client is disabled."
  );
}

/**
 * サーバーサイド専用の Supabase Admin クライアント
 * - RLS を無視できる強いキー（service_role）を使うので
 *   絶対にフロントには渡さない！
 */
export const supabaseAdmin =
  supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, {
        auth: {
          persistSession: false,
        },
      })
    : null;
