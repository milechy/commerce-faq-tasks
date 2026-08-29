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
 * 解決後のURLが実際に到達可能な形をしているか検証する。
 * ここを通さないと、'/' や 'not-a-url' のような値が黙って全specに配られ、
 * 103テストが原因不明の失敗を起こす(向き先の誤りだと気付けない)。
 * ローカル/自前ステージングは http のことがあるため https 限定にはしない。
 */
function assertUsableBaseUrl(value: string, envName: string): string {
  if (!/^https?:\/\/./i.test(value)) {
    throw new Error(
      `${envName} の値が URL として解釈できません(解決結果: ${JSON.stringify(value)})。` +
        'http:// または https:// で始まるホスト名付きのURLを指定してください。',
    );
  }
  return value;
}

/**
 * env から E2E の向き先を解決する(純粋関数)。src/lib/traffic/trafficSource.ts の
 * resolveTrafficSource と同じ形(入力を引数で受ける純粋関数)に合わせている。
 *
 * 片方だけ設定された場合は throw する: 管理画面はステージング・APIは本番、という
 * 混在状態が無警告で成立するのを防ぐため。
 *
 * 値は trim してから判定する: CI の Secrets や .env 経由の値は末尾に改行や空白が
 * 混入しやすく、trim しないと `https://example.com\n/health` のような
 * 一見正しく見えるURLになって原因特定が困難になるため。
 */
export function resolveE2eBaseUrls(
  env: NodeJS.ProcessEnv = process.env,
): { adminBaseUrl: string; apiBaseUrl: string } {
  const rawAdmin = (env.E2E_BASE_URL || '').trim();
  const rawApi = (env.E2E_API_URL || '').trim();

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
    adminBaseUrl: assertUsableBaseUrl(
      stripTrailingSlash(rawAdmin || 'https://admin.r2c.biz'),
      'E2E_BASE_URL',
    ),
    apiBaseUrl: assertUsableBaseUrl(
      stripTrailingSlash(rawApi || 'https://api.r2c.biz'),
      'E2E_API_URL',
    ),
  };
}

const { adminBaseUrl, apiBaseUrl } = resolveE2eBaseUrls();

export const ADMIN_BASE_URL = adminBaseUrl;
export const API_BASE_URL = apiBaseUrl;

// carnation-demo(社内デモ用テナント)のURL。複数のspecが同じパスを個別に
// 組み立てていた重複を解消するための派生定数。
export const DEMO_BASE_URL = `${API_BASE_URL}/carnation-demo`;
export const DEMO_INDEX_URL = `${DEMO_BASE_URL}/index.html`;

// E2E 失敗時アーティファクト回収のための一時コメント（PR #1046 の効果を確認し、失敗の一次証拠を取得する目的。計測後に破棄する）
