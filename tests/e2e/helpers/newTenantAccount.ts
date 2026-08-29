// tests/e2e/helpers/newTenantAccount.ts
//
// 「新規アカウント作成から」の起点を用意するヘルパー。
//
// ■ 実バックエンドに本当にテナント+ユーザーを作れるか
// 本番(api.r2c.biz)に対しては現状 **作れない**。理由は3つあり、いずれも設計上の意図:
//
//   1. e2eWriteGuard (src/api/middleware/e2eWriteGuard.ts, src/index.ts:547)
//      playwright.config.ts が全リクエストに x-r2c-traffic-source: e2e を付けるため、
//      /v1/admin 配下の GET/HEAD/OPTIONS 以外は一律 403。POST /v1/admin/tenants も対象。
//      「CI経由の事故で本番データが壊れるのを防ぐ」ために意図的に引かれた境界であり、
//      テストの都合で外してよいものではない。
//
//   2. テナント削除APIが存在しない
//      src/api/admin/tenants/routes.ts にあるのは GET/POST/PATCH と kill-switch のみ。
//      DELETE /v1/admin/tenants/:id は無い。一度作ると本番に恒久的に残る。
//
//   3. ユーザー作成が招待メール経由 (routes.ts:1249 inviteUserByEmail)
//      パスワード設定にメール受信が必要で、メールボックス連携なしには自動化できない。
//
// したがって本ヘルパーは「本番以外を向いているとき」だけ実作成を許可する。
// 本番を向いたまま実作成を要求された場合は、黙って落ちるのではなく理由を明示して
// 例外を投げる(向き先の誤りに気付けないまま本番へ書き込むのが最悪のため)。
//
// ■ 既定の経路
// E2E_ALLOW_REAL_TENANT=1 が無い場合は 'simulated' を返す。呼び出し側は
// CopilotTenantHarness で onboarding_stage を全 false にし、
// 「新規アカウント作成直後の初回ログイン」と同じ画面状態を作る。
// 検証対象(4段階オンボーディングの分岐・カード・チップ・送出内容)は
// この状態から先にしか無いため、simulated でも journey の網羅性は落ちない。

import { API_BASE_URL } from '../config';

export type ProvisioningMode = 'real' | 'simulated';

export interface NewTenantAccount {
  mode: ProvisioningMode;
  tenantId: string;
  tenantName: string;
  /** mode==='real' のときだけ埋まる。招待したclient_adminのメールアドレス。 */
  email?: string;
}

const PRODUCTION_HOST_PATTERN = /(^|\.)r2c\.biz$/i;

/** 向き先が本番かどうか。ホスト名で判定する(パスやスキームの差異に引きずられない)。 */
export function isProductionTarget(apiBaseUrl: string = API_BASE_URL): boolean {
  try {
    return PRODUCTION_HOST_PATTERN.test(new URL(apiBaseUrl).hostname);
  } catch {
    // URLとして読めない値は config.ts の assertUsableBaseUrl で弾かれている想定だが、
    // 判定不能なら安全側(本番扱い)に倒す。
    return true;
  }
}

/**
 * 実作成モードが使えるか。使えない場合は理由を返す(テスト側の skip 文言にそのまま使う)。
 */
export function realProvisioningBlockedReason(
  env: NodeJS.ProcessEnv = process.env,
  apiBaseUrl: string = API_BASE_URL,
): string | null {
  if (env.E2E_ALLOW_REAL_TENANT !== '1') {
    return 'E2E_ALLOW_REAL_TENANT=1 が未設定のため、実テナント作成はスキップします(既定は疑似作成)。';
  }
  if (isProductionTarget(apiBaseUrl)) {
    return (
      '向き先が本番(' +
      apiBaseUrl +
      ')のため、実テナント作成は行いません。' +
      'サーバ側の e2eWriteGuard が E2E 由来の書き込みを403で拒否し、' +
      'かつテナント削除APIが存在しないため、作成すると本番に恒久的に残ります。' +
      'E2E_BASE_URL / E2E_API_URL を本番以外へ向けてください。'
    );
  }
  if (!env.TEST_SUPERADMIN_ACCESS_TOKEN) {
    return 'TEST_SUPERADMIN_ACCESS_TOKEN が未設定のため、テナント作成APIを呼べません。';
  }
  return null;
}

/**
 * 実バックエンドにテナントを新規作成する(本番以外専用)。
 * ユーザーの招待まで行うかは inviteEmail の有無で決める。
 */
export async function createRealTenant(opts: {
  name: string;
  inviteEmail?: string;
  apiBaseUrl?: string;
  accessToken?: string;
}): Promise<NewTenantAccount> {
  const apiBaseUrl = opts.apiBaseUrl ?? API_BASE_URL;
  const blocked = realProvisioningBlockedReason(process.env, apiBaseUrl);
  if (blocked) throw new Error(`実テナント作成は実行できません: ${blocked}`);

  const token = opts.accessToken ?? process.env.TEST_SUPERADMIN_ACCESS_TOKEN;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const res = await fetch(`${apiBaseUrl}/v1/admin/tenants`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: opts.name }),
  });
  if (!res.ok) {
    throw new Error(`POST /v1/admin/tenants が失敗しました (status=${res.status}): ${await res.text()}`);
  }
  const created = (await res.json()) as { id?: string; tenant?: { id?: string } };
  const tenantId = created.id ?? created.tenant?.id;
  if (!tenantId) throw new Error('テナント作成レスポンスに id が含まれていません。');

  if (opts.inviteEmail) {
    const inviteRes = await fetch(`${apiBaseUrl}/v1/admin/tenants/${tenantId}/invite`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: opts.inviteEmail }),
    });
    if (!inviteRes.ok) {
      throw new Error(
        `POST /v1/admin/tenants/${tenantId}/invite が失敗しました (status=${inviteRes.status}): ${await inviteRes.text()}`,
      );
    }
  }

  return { mode: 'real', tenantId, tenantName: opts.name, email: opts.inviteEmail };
}

/**
 * 疑似の新規アカウント。onboarding_stage を全 false にして初回ログイン直後を再現する
 * (実際の値の投入は CopilotTenantHarness.install の stage オプションが担う)。
 */
export function simulatedNewTenant(name = 'E2E 新規テナント'): NewTenantAccount {
  return { mode: 'simulated', tenantId: 'e2e-new-tenant', tenantName: name };
}
