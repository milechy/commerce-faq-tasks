// tests/e2e/config.ts
//
// E2E が向き先とする環境のbase URL。
// 既定値は本番(現時点でこのリポジトリに実在する唯一の環境。docs/24H_AUTONOMOUS_PLAYBOOK.md:3
// 「R2C は dev/staging を持たず本番 VPS のみ」)。
//
// ステージング環境が用意でき次第(Asana 1217045569747485 が前提条件)、
// E2E_BASE_URL / E2E_API_URL を CI/ローカルで設定するだけで向き先を切り替えられるように、
// 各 spec はこの定数を経由し、URL を直接ハードコードしない。

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * env から E2E の向き先を解決する(純粋関数)。src/lib/traffic/trafficSource.ts の
 * resolveTrafficSource と同じ形(入力を引数で受ける純粋関数)に合わせている。
 *
 * 片方だけ設定された場合は throw する: 管理画面はステージング・APIは本番、という
 * 混在状態が無警告で成立するのを防ぐため。
 */
export function resolveE2eBaseUrls(
  env: NodeJS.ProcessEnv = process.env,
): { adminBaseUrl: string; apiBaseUrl: string } {
  const rawAdmin = env.E2E_BASE_URL || '';
  const rawApi = env.E2E_API_URL || '';

  if (rawAdmin && !rawApi) {
    throw new Error(
      'E2E_BASE_URL のみが設定され、E2E_API_URL が未設定です。' +
        '管理画面とAPIの向き先が食い違う(例: 管理画面はステージング・APIは本番)状態を' +
        '防ぐため、両方を設定するか両方とも未設定のままにしてください。',
    );
  }
  if (rawApi && !rawAdmin) {
    throw new Error(
      'E2E_API_URL のみが設定され、E2E_BASE_URL が未設定です。' +
        '管理画面とAPIの向き先が食い違う(例: 管理画面はステージング・APIは本番)状態を' +
        '防ぐため、両方を設定するか両方とも未設定のままにしてください。',
    );
  }

  return {
    adminBaseUrl: stripTrailingSlash(rawAdmin || 'https://admin.r2c.biz'),
    apiBaseUrl: stripTrailingSlash(rawApi || 'https://api.r2c.biz'),
  };
}

const { adminBaseUrl, apiBaseUrl } = resolveE2eBaseUrls();

export const ADMIN_BASE_URL = adminBaseUrl;
export const API_BASE_URL = apiBaseUrl;
