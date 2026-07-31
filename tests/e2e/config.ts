// tests/e2e/config.ts
//
// E2E が向き先とする環境のbase URL。
// 既定値は本番(現時点でこのリポジトリに実在する唯一の環境。docs/24H_AUTONOMOUS_PLAYBOOK.md:3
// 「R2C は dev/staging を持たず本番 VPS のみ」)。
//
// ステージング環境が用意でき次第(Asana 1217045569747485 が前提条件)、
// E2E_BASE_URL / E2E_API_URL を CI/ローカルで設定するだけで向き先を切り替えられるように、
// 各 spec はこの定数を経由し、URL を直接ハードコードしない。
export const ADMIN_BASE_URL = process.env.E2E_BASE_URL || 'https://admin.r2c.biz';
export const API_BASE_URL = process.env.E2E_API_URL || 'https://api.r2c.biz';
