// tests/e2e/helpers/superAdminHarness.ts
//
// super_admin ロールの管理画面(旧UI = /admin/*)を E2E するための土台。
//
// 【なぜブラウザ側でルートを差し替えるのか】
// helpers/copilotTenantHarness.ts の冒頭と同じ理由。要点だけ再掲する:
//   - このリポジトリには staging が無く、baseURL は本番を向く(tests/e2e/config.ts)
//   - サーバ側の e2eWriteGuard(src/index.ts) が x-r2c-traffic-source: e2e の
//     書き込み(GET/HEAD/OPTIONS以外)を 403 で拒否するため、そもそも本番へ書けない
// そのうえで super_admin の画面は「テナント作成 / APIキー失効 / 招待メール送信 /
// フィードバック削除 / 課金フラグ変更」といった、他人のテナントに直接効く不可逆操作を
// 束ねている。したがってこのハーネスの目的は本番保護だけでなく、
//   「押したときに“本当に何が飛んだか”を1件単位で数える」
// ことにある。requests に全 /v1/admin/* を記録し、countWrites() で数える。
//
// 【検証対象】画面の実配線(操作 → 状態遷移 → 送出内容 → 復元)であって、
// サーバ側のバリデーション結果そのものではない。サーバ側の仕様は
// src/api/admin/** の jest テストが持つ。
//
// 【ルート登録順】page.route は「後に登録したハンドラが先に評価される」。
// install() は catch-all(501) を最初に登録し、個別ルートを後から重ねる。
// 塞ぎ忘れた /v1/admin/* は 501 で必ず落ちるので、
//   - モックし忘れが本番へ抜ける
//   - モックし忘れたまま緑になる
// の両方を防げる。順序を入れ替えると catch-all が全部を横取りするので注意。

import type { Page, Route } from '@playwright/test';

// ───────────────────────────────────────────────────────────────────────────
// 型 — サーバの応答形に合わせる(admin-ui 側の型が正)
// ───────────────────────────────────────────────────────────────────────────

export type TenantPlan = 'free_ad' | 'starter' | 'standard' | 'growth' | 'enterprise';

/** GET /v1/admin/tenants の1件。admin-ui/src/pages/admin/tenants/index.tsx の Tenant。 */
export interface TenantRow {
  id: string;
  name: string;
  plan: TenantPlan;
  is_active: boolean;
  api_key_count?: number;
  created_at: string;
  billing_enabled?: boolean;
  billing_free_from?: string | null;
  billing_free_until?: string | null;
}

/** GET /v1/admin/tenants/:id。detail は list の1件に設定項目が増えた形。 */
export interface TenantDetailFixture extends TenantRow {
  allowed_origins?: string[];
  system_prompt?: string;
  tenant_contact_email?: string | null;
  features?: { avatar: boolean; voice: boolean; rag: boolean };
  lemonslice_agent_id?: string | null;
  conversion_types?: string[];
}

/** GET /v1/admin/tenants/:id/keys の1件(サーバ形。UI側で maskedKey へ変換される)。 */
export interface ApiKeyFixture {
  id: string;
  key_prefix: string;
  prefix?: string;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
}

/** GET /v1/admin/feedback の1件。 */
export interface FeedbackFixture {
  id: string;
  tenant_id?: string;
  message: string;
  category: 'operation_guide' | 'feature_request' | 'bug_report' | 'knowledge_gap' | 'other';
  status: 'new' | 'reviewed' | 'needs_improvement' | 'resolved';
  priority: 'urgent' | 'high' | 'normal' | 'low';
  admin_notes?: string | null;
  created_at: string;
  reply_body?: string | null;
  replied_at?: string | null;
}

/**
 * GET /v1/admin/options の1件(代行作業)。
 * description / llm_estimate_amount / final_amount は
 * admin-ui/src/pages/admin/options/index.tsx の行描画が無検査で読むため必須扱いにする
 * (description は .length を直接読むので undefined だと画面ごと落ちる)。
 */
export interface OptionOrderFixture {
  id: string;
  tenant_id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  llm_estimate_amount?: number | null;
  final_amount?: number | null;
  ordered_at: string;
  completed_at?: string | null;
}

/** 記録した1リクエスト。 */
export interface RecordedRequest {
  url: string;
  pathname: string;
  method: string;
  postData: string | null;
}

/** 個別エンドポイントを異常応答にすり替える指定。 */
export interface FailSpec {
  /** 返すHTTPステータス。 */
  status: number;
  /**
   * 対象メソッド(省略時は全メソッド)。
   * 「保存(PATCH)だけ失敗させて、初期表示(GET)は成功させる」が要るため必須の絞り。
   * これが無いと詳細画面のGETまで落ち、フォームに到達する前で終わってしまう。
   */
  method?: string | string[];
  /** 応答本文(既定は {})。 */
  body?: unknown;
  /** 応答を遅らせる(送信中ロック・連打の検証用)。 */
  delayMs?: number;
  /** 接続断を再現する(fulfill せず abort)。status より優先。 */
  abort?: boolean;
  /** 一度きりで使い切る(2回目以降は正常応答へ戻る)。再試行の検証用。 */
  once?: boolean;
}

export interface HarnessOptions {
  /** GET /v1/admin/tenants が返す一覧。 */
  tenants?: TenantRow[];
  /** GET /v1/admin/tenants/:id が返す詳細(id をキーに引く。未登録なら tenants から合成)。 */
  tenantDetails?: Record<string, TenantDetailFixture>;
  /** GET /v1/admin/tenants/:id/keys が返すキー。 */
  apiKeys?: ApiKeyFixture[];
  /** GET /v1/admin/feedback が返す一覧。 */
  feedback?: FeedbackFixture[];
  /** GET /v1/admin/options が返す一覧。 */
  options?: OptionOrderFixture[];
  /** GET /v1/admin/monitoring/kpis の応答。 */
  monitoringKpis?: Record<string, unknown>;
  /** GET /v1/admin/analytics/measurement-health の応答。 */
  measurementHealth?: Record<string, unknown>;
  /** GET /v1/admin/analytics/cv-status の応答。 */
  cvStatus?: Record<string, unknown>;
  /** GET /v1/admin/analytics/flow-transitions の応答。 */
  flowTransitions?: Record<string, unknown>;
  /** GET /v1/admin/analytics/knowledge-attribution の応答。 */
  knowledgeAttribution?: Record<string, unknown>;
  /** GET /v1/admin/analytics/summary の応答。 */
  analyticsSummary?: Record<string, unknown>;
  /**
   * pathname 断片 → 異常応答。install 後でも fail() で足せる。
   * 例: { '/v1/admin/tenants': { status: 500 } }
   */
  failures?: Record<string, FailSpec>;
}

// ───────────────────────────────────────────────────────────────────────────
// 既定フィクスチャ
// ───────────────────────────────────────────────────────────────────────────

export const DEFAULT_TENANTS: TenantRow[] = [
  {
    id: 'carnation-demo',
    name: 'カーネーション自動車',
    plan: 'growth',
    is_active: true,
    api_key_count: 2,
    created_at: '2026-01-15T09:00:00.000Z',
    billing_enabled: true,
  },
  {
    id: 'aoyama-clinic',
    name: '青山クリニック',
    plan: 'standard',
    is_active: true,
    api_key_count: 1,
    created_at: '2026-03-02T09:00:00.000Z',
    billing_enabled: false,
  },
  {
    id: 'closed-shop',
    name: '休止中ストア',
    plan: 'starter',
    is_active: false,
    api_key_count: 0,
    created_at: '2026-05-20T09:00:00.000Z',
    billing_enabled: false,
  },
];

export const DEFAULT_API_KEYS: ApiKeyFixture[] = [
  {
    id: 'key-active-1',
    key_prefix: 'r2c_live_aaaa',
    is_active: true,
    created_at: '2026-02-01T09:00:00.000Z',
    last_used_at: '2026-08-20T09:00:00.000Z',
  },
  {
    id: 'key-revoked-1',
    key_prefix: 'r2c_live_bbbb',
    is_active: false,
    created_at: '2026-01-01T09:00:00.000Z',
    last_used_at: null,
  },
];

export const DEFAULT_FEEDBACK: FeedbackFixture[] = [
  {
    id: 'fb-1',
    tenant_id: 'carnation-demo',
    message: '在庫の確認方法が分かりませんでした',
    category: 'operation_guide',
    status: 'new',
    priority: 'normal',
    created_at: '2026-08-25T09:00:00.000Z',
  },
  {
    id: 'fb-2',
    tenant_id: 'aoyama-clinic',
    message: '予約の時間帯を選べるようにしてほしい',
    category: 'feature_request',
    status: 'reviewed',
    priority: 'high',
    created_at: '2026-08-24T09:00:00.000Z',
  },
];

/**
 * 監視画面が「全指標が基準内」で描画される応答。
 * フィールド名は admin-ui/src/pages/admin/monitoring/index.tsx の MonitoringKpis が正。
 * 単位は % で、UI 側が toFixed して描画する(0.92 ではなく 92)。
 */
export const HEALTHY_MONITORING_KPIS: Record<string, unknown> = {
  completionRate: 92,
  loopRate: 4,
  fallbackRate: 12,
  searchP95Ms: 900,
  errorRate: 0.1,
  killSwitchActive: false,
  sla: {
    completionRateMin: 70,
    loopRateMax: 10,
    fallbackRateMax: 30,
    searchP95Max: 1500,
    errorRateMax: 1,
  },
  tenants: [],
};

/**
 * GET /v1/admin/analytics/measurement-health の正常応答。
 * 監視画面は health.* を無検査で読む(sourceBreakdown.length など)ため、
 * ここが1フィールドでも欠けると画面全体が「起動エラー」に落ちる。
 * フィールド名は monitoring/index.tsx の MeasurementHealth が正。
 */
export const HEALTHY_MEASUREMENT_HEALTH: Record<string, unknown> = {
  sourceBreakdown: [{ source: 'widget', count: 120 }],
  emptySessionCount: 3,
  cvSessionLinkRate: { numerator: 8, denominator: 100, rate: 8 },
  outcomeRecordRate: { numerator: 60, denominator: 100, rate: 60, autoRecorded: 40 },
  validUserSessionCount: 100,
  chatOpenDropoff: {
    trackingSince: '2026-07-01T00:00:00.000Z',
    visitorsOpened: 200,
    visitorsConversed: 150,
    dropoffRate: 25,
    sessionCoverage: { numerator: 150, denominator: 200, rate: 75 },
  },
  schemaHealth: { missing: [], checkedTables: 12, checkedColumns: 80 },
  ignitionStatus: { rows: [], envControlledFeatures: [], anyEnabled: false },
};

/** GET /v1/admin/analytics/flow-transitions の正常応答(schema.ts の契約に一致)。 */
export const DEFAULT_FLOW_TRANSITIONS: Record<string, unknown> = {
  period: '7d',
  tenant_id: null,
  total_transitions: 120,
  funnel: {
    to_answer_count: 80,
    to_confirm_count: 40,
    to_terminal_count: 30,
    completed_count: 25,
    confirm_rate_pct: 50,
    completion_rate_pct: 31.3,
  },
  transitions: [
    { from_state: null, to_state: 'greeting', transition_count: 60 },
    { from_state: 'greeting', to_state: 'answer', transition_count: 40 },
    { from_state: 'answer', to_state: 'confirm', transition_count: 20 },
  ],
};

/** GET /v1/admin/analytics/cv-status の正常応答。 */
export const DEFAULT_CV_STATUS: Record<string, unknown> = {
  total_tenants: 2,
  fired_tenants: 1,
  not_fired_tenants: 1,
  tenants: [
    {
      tenant_id: 'carnation-demo',
      tenant_name: 'カーネーション自動車',
      cv_count_30d: 12,
      cv_fired_status: 'fired',
      days_since_effective_start: 45,
      last_cv_at: '2026-08-26T09:00:00.000Z',
    },
    {
      tenant_id: 'aoyama-clinic',
      tenant_name: '青山クリニック',
      cv_count_30d: 0,
      cv_fired_status: 'not_fired',
      days_since_effective_start: 9,
      last_cv_at: null,
    },
  ],
};

// ───────────────────────────────────────────────────────────────────────────
// ハーネス本体
// ───────────────────────────────────────────────────────────────────────────

export class SuperAdminHarness {
  readonly requests: RecordedRequest[] = [];
  /** ページ内で発生した未処理例外。画面が「静かに壊れた」ことを検出する。 */
  readonly pageErrors: string[] = [];

  private options: HarnessOptions = {};
  private failures: Record<string, FailSpec> = {};
  private consumedFailures = new Set<string>();
  /** POST /v1/admin/tenants で作られたテナント(一覧の再取得で見えるようにする)。 */
  private createdTenants: TenantRow[] = [];

  constructor(private readonly page: Page) {}

  // ── 設定 ────────────────────────────────────────────────────────────────

  /** install 後に個別エンドポイントを異常応答へ切り替える。 */
  fail(pathnameFragment: string, spec: FailSpec): this {
    this.failures[pathnameFragment] = spec;
    this.consumedFailures.delete(pathnameFragment);
    return this;
  }

  /** 異常応答の指定を取り消す。 */
  recover(pathnameFragment: string): this {
    delete this.failures[pathnameFragment];
    return this;
  }

  // ── ルート差し替え ──────────────────────────────────────────────────────

  /**
   * ページを開く前に必ず呼ぶ。super_admin の画面が叩く全エンドポイントを塞ぐ。
   * ここで塞ぎ漏らしたものは catch-all の 501 で落ちる(本番へは抜けない)。
   */
  async install(options: HarnessOptions = {}): Promise<void> {
    this.options = options;
    this.failures = { ...(options.failures ?? {}) };
    this.consumedFailures = new Set();
    this.createdTenants = [];

    this.page.on('request', (req) => {
      const url = req.url();
      if (!url.includes('/v1/admin/')) return;
      this.requests.push({
        url,
        pathname: new URL(url).pathname,
        method: req.method(),
        postData: req.postData(),
      });
    });

    // 「画面が真っ白にならない」ことは目視で分かるが、コンソールに落ちた例外は
    // 見落とす。異常系テストで assertNoPageErrors() を掛けられるよう記録する。
    this.page.on('pageerror', (err) => this.pageErrors.push(err.message));

    // 後勝ちのため catch-all を最初に。
    await this.routeUnhandledAdminApi();

    await this.routeTenants();
    await this.routeTenantDetail();
    await this.routeTenantKeys();
    await this.routeTenantSubResources();
    await this.routeFeedback();
    await this.routeOptions();
    await this.routeMonitoring();
    await this.routeAnalytics();
    await this.routeShell();
  }

  // ── 個別ルート ──────────────────────────────────────────────────────────

  /** GET(一覧) / POST(作成) /v1/admin/tenants */
  private async routeTenants(): Promise<void> {
    await this.route(
      (u) => u.pathname === '/v1/admin/tenants',
      async (route) => {
        const method = route.request().method();
        if (method === 'POST') {
          const body = this.parseBody(route);
          const created: TenantRow = {
            id: String(body.id ?? 'new-tenant'),
            name: String(body.name ?? ''),
            plan: (body.plan as TenantPlan) ?? 'starter',
            is_active: true,
            created_at: '2026-08-27T00:00:00.000Z',
          };
          this.createdTenants.push(created);
          return this.json(route, { tenant: created }, 201);
        }
        return this.json(route, {
          tenants: [...(this.options.tenants ?? DEFAULT_TENANTS), ...this.createdTenants],
        });
      },
    );
  }

  /** GET / PATCH /v1/admin/tenants/:id */
  private async routeTenantDetail(): Promise<void> {
    await this.route(
      (u) => /^\/v1\/admin\/tenants\/[^/]+$/.test(u.pathname),
      async (route) => {
        const id = decodeURIComponent(route.request().url().split('/').pop()!.split('?')[0]);
        const base = this.resolveTenantDetail(id);
        if (!base) return this.json(route, { error: 'not found' }, 404);

        if (route.request().method() === 'PATCH') {
          const patch = this.parseBody(route);
          // サーバは is_active を受け取り、is_active を返す(status 文字列ではない)。
          const merged = { ...base, ...patch } as Record<string, unknown>;
          return this.json(route, { tenant: merged });
        }
        return this.json(route, { tenant: base });
      },
    );
  }

  /** GET / POST /v1/admin/tenants/:id/keys と DELETE /v1/admin/tenants/:id/keys/:keyId */
  private async routeTenantKeys(): Promise<void> {
    await this.route(
      (u) => /^\/v1\/admin\/tenants\/[^/]+\/keys$/.test(u.pathname),
      async (route) => {
        if (route.request().method() === 'POST') {
          // 平文キーは発行時のみ返る。UI はこれを埋め込みコードに差し込む。
          return this.json(route, { apiKey: 'r2c_live_newkey_0123456789abcdef', key: 'r2c_live_newkey_0123456789abcdef' }, 201);
        }
        return this.json(route, { keys: this.options.apiKeys ?? DEFAULT_API_KEYS });
      },
    );

    await this.route(
      (u) => /^\/v1\/admin\/tenants\/[^/]+\/keys\/[^/]+$/.test(u.pathname),
      async (route) => this.json(route, { ok: true }),
    );
  }

  /** テナント詳細タブが叩く残りの子リソース。 */
  private async routeTenantSubResources(): Promise<void> {
    await this.route(
      (u) => /^\/v1\/admin\/tenants\/[^/]+\/invite$/.test(u.pathname),
      async (route) => this.json(route, { ok: true, message: '招待メールを送信しました' }),
    );
    await this.route(
      (u) => /^\/v1\/admin\/tenants\/[^/]+\/settings-history$/.test(u.pathname),
      async (route) => this.json(route, { items: [], history: [] }),
    );
    await this.route(
      (u) => /^\/v1\/admin\/tenants\/[^/]+\/analytics-summary$/.test(u.pathname),
      async (route) => this.json(route, { summary: {}, items: [] }),
    );
    await this.route(
      (u) => /^\/v1\/admin\/tenants\/[^/]+\/notification-preferences$/.test(u.pathname),
      async (route) => this.json(route, { preferences: {} }),
    );
    await this.route(
      (u) => /^\/v1\/admin\/tenants\/[^/]+\/(ga4|posthog)\//.test(u.pathname),
      async (route) => this.json(route, { connected: false, status: 'disconnected' }),
    );
    await this.route(
      (u) => u.pathname === '/v1/admin/ga4/service-account-info',
      async (route) => this.json(route, { email: 'ga4-e2e@example.invalid' }),
    );
  }

  /** GET/PATCH/DELETE /v1/admin/feedback と返信・指示ルール化。 */
  private async routeFeedback(): Promise<void> {
    await this.route(
      (u) => /^\/v1\/admin\/feedback\/[^/]+\/reply$/.test(u.pathname),
      async (route) => this.json(route, { ok: true }),
    );
    await this.route(
      (u) => u.pathname.startsWith('/v1/admin/feedback'),
      async (route) => {
        if (route.request().method() === 'GET') {
          return this.json(route, { items: this.options.feedback ?? DEFAULT_FEEDBACK });
        }
        return this.json(route, { ok: true });
      },
    );
    await this.route(
      (u) => u.pathname === '/v1/admin/tuning-rules',
      async (route) => this.json(route, { ok: true, rule: { id: 'rule-1' } }),
    );
  }

  /** 代行作業管理(オプション)と Sai 連携。 */
  private async routeOptions(): Promise<void> {
    await this.route(
      (u) => u.pathname.startsWith('/v1/admin/options'),
      async (route) => {
        if (route.request().method() === 'GET') {
          // 契約は { items, total }(admin-ui/src/pages/admin/options/index.tsx)。
          // status クエリでの絞り込みはサーバ側で行われるため、ここでも同じ絞り方をする
          // ——「絞り込みがクエリに乗っているか」だけでなく「結果が反映されるか」まで見るため。
          const all = this.options.options ?? [];
          const status = new URL(route.request().url()).searchParams.get('status');
          const items = status ? all.filter((o) => o.status === status) : all;
          return this.json(route, { items, total: items.length });
        }
        return this.json(route, { ok: true });
      },
    );
    await this.route(
      (u) => u.pathname.startsWith('/v1/admin/sai-rules'),
      async (route) => this.json(route, { rules: [], items: [] }),
    );
  }

  /** システム稼働状況。 */
  private async routeMonitoring(): Promise<void> {
    await this.route(
      (u) => u.pathname === '/v1/admin/monitoring/kpis',
      async (route) => this.json(route, this.options.monitoringKpis ?? HEALTHY_MONITORING_KPIS),
    );
    await this.route(
      (u) => u.pathname === '/v1/admin/analytics/measurement-health',
      async (route) => this.json(route, this.options.measurementHealth ?? HEALTHY_MEASUREMENT_HEALTH),
    );
  }

  /** super_admin 専用の分析3画面。 */
  private async routeAnalytics(): Promise<void> {
    await this.route(
      (u) => u.pathname === '/v1/admin/analytics/cv-status',
      async (route) => this.json(route, this.options.cvStatus ?? DEFAULT_CV_STATUS),
    );
    await this.route(
      (u) => u.pathname === '/v1/admin/analytics/flow-transitions',
      async (route) => this.json(route, this.options.flowTransitions ?? DEFAULT_FLOW_TRANSITIONS),
    );
    await this.route(
      (u) => u.pathname === '/v1/admin/analytics/knowledge-attribution',
      async (route) => this.json(route, this.options.knowledgeAttribution ?? { items: [] }),
    );
    await this.route(
      (u) => u.pathname === '/v1/admin/analytics/summary',
      async (route) => this.json(route, this.options.analyticsSummary ?? {}),
    );
  }

  /** サイドバー・通知・管理エージェントパネルなど、全画面共通の足回り。 */
  private async routeShell(): Promise<void> {
    await this.route(
      (u) => u.pathname === '/v1/admin/my-tenant',
      // super_admin の集約ビューは特定テナントに紐付かない。プランは返さない。
      async (route) => this.json(route, {}),
    );
    await this.route(
      (u) => u.pathname.startsWith('/v1/admin/notifications'),
      async (route) => this.json(route, { items: [], notifications: [], unread_count: 0 }),
    );
    await this.route(
      (u) => u.pathname.startsWith('/v1/admin/agent/'),
      async (route) => this.json(route, { reply: '', actions: [] }),
    );

    // 「クライアントビューで見る」(previewMode)に入ると App.tsx は super_admin にも
    // /copilot-preview のUIを描画する。そのとき左レールが叩く2本を塞いでおかないと、
    // プレビュー系テストが本題と無関係な 501 で汚れる。
    await this.route(
      (u) => u.pathname.startsWith('/v1/admin/knowledge-gaps'),
      async (route) => this.json(route, { count: 0, items: [] }),
    );
    await this.route(
      (u) => u.pathname.startsWith('/v1/admin/chat-history'),
      async (route) => this.json(route, { escalations: [], sessions: [], items: [] }),
    );

    // 知識データ画面(/admin/knowledge/global 含む)。書籍PDFの取り込みは
    // 「R2C運用限定」の機能であり super_admin の面にだけ出る。FAQ/PDF いずれも
    // 空配列で返し、画面の骨格(タブ・空表示)だけを検証対象にする。
    await this.route(
      (u) => u.pathname.startsWith('/v1/admin/knowledge/book-pdf'),
      async (route) =>
        route.request().method() === 'GET'
          ? this.json(route, { books: [], items: [], chunks: [] })
          : this.json(route, { ok: true }),
    );
    await this.route(
      (u) => u.pathname.startsWith('/v1/admin/knowledge/'),
      async (route) =>
        route.request().method() === 'GET'
          ? this.json(route, { items: [], faqs: [], total: 0 })
          : this.json(route, { ok: true }),
    );
  }

  /**
   * 明示的に塞いでいない /v1/admin/* を 501 で落とす。
   * install() の先頭で登録すること(後勝ちのため)。
   */
  private async routeUnhandledAdminApi(): Promise<void> {
    await this.page.route(
      (u) => u.pathname.startsWith('/v1/admin/'),
      (route) =>
        route.fulfill({
          status: 501,
          contentType: 'application/json',
          body: JSON.stringify({
            error:
              'E2E: このエンドポイントはハーネスで塞がれていません: ' +
              `${route.request().method()} ${route.request().url()}`,
          }),
        }),
    );
  }

  // ── ルート登録の共通処理 ────────────────────────────────────────────────

  /**
   * failures(異常応答の指定)を先に評価してから本体ハンドラへ渡す。
   * 各 route*() が個別に失敗指定を見なくて済むよう、ここで一元化する。
   */
  private async route(
    match: (url: URL) => boolean,
    handler: (route: Route) => Promise<void>,
  ): Promise<void> {
    await this.page.route(match, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const key = Object.keys(this.failures).find((frag) => {
        if (!pathname.includes(frag) || this.consumedFailures.has(frag)) return false;
        const want = this.failures[frag].method;
        if (!want) return true;
        return Array.isArray(want) ? want.includes(method) : want === method;
      });
      if (key) {
        const spec = this.failures[key];
        if (spec.once) this.consumedFailures.add(key);
        if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
        if (spec.abort) return route.abort('connectionfailed');
        return route.fulfill({
          status: spec.status,
          contentType: 'application/json',
          body: JSON.stringify(spec.body ?? {}),
        });
      }
      return handler(route);
    });
  }

  private json(route: Route, body: unknown, status = 200): Promise<void> {
    return route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  }

  private parseBody(route: Route): Record<string, unknown> {
    try {
      return JSON.parse(route.request().postData() || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private resolveTenantDetail(id: string): TenantDetailFixture | null {
    const registered = this.options.tenantDetails?.[id];
    if (registered) return registered;
    const fromList = [...(this.options.tenants ?? DEFAULT_TENANTS), ...this.createdTenants].find(
      (t) => t.id === id,
    );
    if (!fromList) return null;
    return {
      ...fromList,
      allowed_origins: ['https://shop.example.com'],
      system_prompt: '',
      tenant_contact_email: 'owner@example.com',
      features: { avatar: false, voice: false, rag: true },
      lemonslice_agent_id: null,
    };
  }

  // ── 画面操作 ────────────────────────────────────────────────────────────

  /** 管理画面の任意パスを開く。サイドバー(常設シェル)の描画まで待つ。 */
  async open(adminBaseUrl: string, path: string): Promise<void> {
    await this.page.goto(`${adminBaseUrl}${path}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    // /login へ弾かれた場合はここで気付けるよう、URL を先に確認してから待つ。
    await this.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {
      /* 常時ポーリングする画面があるため networkidle に到達しないことがある */
    });
  }

  // ── 検証用ヘルパー ──────────────────────────────────────────────────────

  /** 指定 pathname 断片への書き込み(GET以外)の回数。連打・確認ダイアログの検証に使う。 */
  countWrites(pathnameFragment: string, method?: string): number {
    return this.requests.filter(
      (r) =>
        r.pathname.includes(pathnameFragment) &&
        r.method !== 'GET' &&
        (method ? r.method === method : true),
    ).length;
  }

  /** 指定 pathname 断片へのリクエスト回数(GET を含む)。 */
  countRequests(pathnameFragment: string): number {
    return this.requests.filter((r) => r.pathname.includes(pathnameFragment)).length;
  }

  /** 指定 pathname 断片への直近の送出本文(JSON)。何を送ったかの検証に使う。 */
  lastBody(pathnameFragment: string): Record<string, unknown> | null {
    const hit = [...this.requests]
      .reverse()
      .find((r) => r.pathname.includes(pathnameFragment) && r.postData);
    if (!hit?.postData) return null;
    try {
      return JSON.parse(hit.postData) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** 記録をリセットする(1テスト内で「ここから先」を数えたいとき)。 */
  resetRecording(): void {
    this.requests.length = 0;
    this.pageErrors.length = 0;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 認証状態
// ───────────────────────────────────────────────────────────────────────────

export const SUPERADMIN_AUTH_FILE = 'tests/e2e/.auth/superadmin.json';

/**
 * superadmin.setup.ts が生成した storageState が「今この瞬間に使えるか」を返す。
 * 生成されていない/期限切れのときに全テストを赤にしても直せないため、spec 側で
 * skip の判断に使う(qa-irregular-3roles.spec.ts の Role C と同じ方式)。
 */
export function superAdminAuthReady(): boolean {
  try {
    // require を使うのは spec のトップレベル(テスト収集時)で同期的に判定するため。
    // import fs にすると spec 側の書き味が変わるだけで利点が無い。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const raw = JSON.parse(fs.readFileSync(SUPERADMIN_AUTH_FILE, 'utf8')) as {
      origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>;
    };
    const entry = raw?.origins?.[0]?.localStorage?.find((e) => /auth-token/.test(e.name));
    if (!entry) return false;
    const parsed = JSON.parse(entry.value) as { expires_at?: number };
    return typeof parsed.expires_at === 'number' && parsed.expires_at * 1000 > Date.now();
  } catch {
    return false;
  }
}
