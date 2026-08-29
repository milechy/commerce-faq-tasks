// tests/e2e/helpers/copilotTenantHarness.ts
//
// /copilot-preview をテナントロール(client_admin)で E2E するための土台。
//
// 【なぜブラウザ側でルートを差し替えるのか】
// このリポジトリには staging が無く、playwright.config.ts の baseURL は本番を向く
// (tests/e2e/config.ts)。加えてサーバ側に e2eWriteGuard(src/index.ts:547)があり、
// x-r2c-traffic-source: e2e が付いたリクエストの書き込み(GET/HEAD/OPTIONS 以外)は
// 一律 403 で拒否される。つまり「E2E から本番の管理APIへ書き込む」経路は設計として
// 塞がれている。
//
// そこで page.route でブラウザ内で応答を差し替える。狙いは3つ:
//   1. 本番DB・本番の集計指標を一切汚さない(リクエストがブラウザから出ない)
//   2. LLM(Groq)・fal.ai・Fish Audio の従量課金を発生させない
//   3. 「新規アカウント作成直後」のような、本番では意図的に作れない状態を再現する
// 検証対象はあくまで画面の実配線(操作 → 状態遷移 → 送出内容 → 復元)であり、
// LLM の応答内容そのものではない。qa-copilot-preview.spec.ts の CP-B-3 が同じ理由で
// 同じ作法を採っており、本ファイルはそれを再利用可能な形に一般化したもの。
//
// 実バックエンドに対して本当にテナントを新規作成して回したい場合は
// newTenantAccount.ts を参照(本番向けには意図的に失敗する)。

import type { Page, Request, Route } from '@playwright/test';

// ───────────────────────────────────────────────────────────────────────────
// エージェント応答の型。サーバ(agentRoutes.ts)が返す形に合わせる。
// card の形は admin-ui/src/lib/useAgentChatTransport.ts の *AgentActionCard 群が正。
// ───────────────────────────────────────────────────────────────────────────

export interface AgentAction {
  tool: string;
  result: string;
  card?: Record<string, unknown>;
}

export interface AgentReply {
  reply: string;
  actions?: AgentAction[];
  answered_from?: 'faq_list' | 'tool_action' | 'general';
  session_id?: string;
}

/** 1件のチャット応答ルール。上から順に評価し、最初に match したものを返す。 */
export interface ChatRule {
  /** message に対する判定。文字列を渡した場合は includes 判定。 */
  when: string | ((message: string) => boolean);
  /** 200で返す本文。関数なら message を受け取って組み立てる。 */
  reply?: AgentReply | ((message: string) => AgentReply);
  /** 非200を返したい場合のステータス(reply より優先)。 */
  status?: number;
  /** status 指定時のレスポンス本文(既定は {error:"..."} 相当の空JSON)。 */
  errorBody?: unknown;
  /** 応答を遅らせる(送信中ロック・連打の検証用)。 */
  delayMs?: number;
  /** 接続断を再現する(fulfill せず abort する)。 */
  abort?: boolean;
  /** 一度きりで使い切る(2回目以降は後続ルールへ流す)。再送・リトライの検証用。 */
  once?: boolean;
}

/** オンボーディング4段階。すべて false = 新規アカウント作成直後。 */
export interface OnboardingStageFlags {
  industryAnswered: boolean;
  knowledgePublished: boolean;
  widgetInstalled: boolean;
  firstConversation: boolean;
  hasDraftFaq: boolean;
}

export const BRAND_NEW_ACCOUNT_STAGE: OnboardingStageFlags = {
  industryAnswered: false,
  knowledgePublished: false,
  widgetInstalled: false,
  firstConversation: false,
  hasDraftFaq: false,
};

export const FULLY_ONBOARDED_STAGE: OnboardingStageFlags = {
  industryAnswered: true,
  knowledgePublished: true,
  widgetInstalled: true,
  firstConversation: true,
  hasDraftFaq: true,
};

export interface HarnessOptions {
  /** GET /v1/admin/my-tenant が返すオンボーディング段階。null なら段階を返さない。 */
  stage?: OnboardingStageFlags | null;
  /** GET /v1/admin/my-tenant が返すプラン。 */
  plan?: 'free_ad' | 'starter' | 'standard' | 'growth' | 'enterprise';
  /** 左レールのバッジ件数。 */
  gapsCount?: number;
  escalationsCount?: number;
  /** 相談窓口の未読返信。 */
  /** id は文字列(lib/feedbackReplies.ts の FeedbackReply.id に合わせる)。 */
  feedbackReplies?: Array<{
    id: string;
    message: string;
    reply_body: string;
    replied_at?: string | null;
  }>;
  /** my-tenant を 500 で返す(取得失敗のフォールバック検証用)。 */
  myTenantFails?: boolean;
  /** バッジ2本を 500 で返す(取得失敗でも画面が壊れないことの検証用)。 */
  railCountsFail?: boolean;
}

/** 記録された1回のチャット送信。 */
export interface ChatCall {
  message: string;
  surface?: string;
  sessionId?: string;
  targetTenantId?: string;
  raw: Record<string, unknown>;
}

/** 記録された1回の任意リクエスト。 */
export interface RecordedRequest {
  url: string;
  method: string;
  postData: string | null;
}

/**
 * /copilot-preview 用のルート差し替えと、送出内容の記録をまとめて持つ。
 *
 * 使い方:
 *   const h = new CopilotTenantHarness(page);
 *   await h.install({ stage: BRAND_NEW_ACCOUNT_STAGE });
 *   h.chat([{ when: 'ログインしたところです', reply: { reply: '...' } }]);
 *   await h.open();
 */
export class CopilotTenantHarness {
  readonly chatCalls: ChatCall[] = [];
  readonly requests: RecordedRequest[] = [];

  private rules: ChatRule[] = [];
  private consumed = new Set<ChatRule>();
  private options: HarnessOptions = {};

  constructor(private readonly page: Page) {}

  // ── 設定 ────────────────────────────────────────────────────────────────

  /** チャット応答ルールを差し替える(呼ぶたびに置き換え。追記は addChat)。 */
  chat(rules: ChatRule[]): this {
    this.rules = rules;
    this.consumed = new Set();
    return this;
  }

  /** チャット応答ルールを先頭に足す(既存より優先させたい時)。 */
  addChat(rules: ChatRule[]): this {
    this.rules = [...rules, ...this.rules];
    return this;
  }

  // ── ルート差し替え ──────────────────────────────────────────────────────

  /**
   * ページを開く前に必ず呼ぶ。/copilot-preview がマウント時に叩く全エンドポイントを
   * 塞ぐ。ここで塞ぎ漏らすと、そのリクエストだけ本番へ抜ける。
   */
  async install(options: HarnessOptions = {}): Promise<void> {
    this.options = options;

    // 記録は「本当に何が飛んだか」を後から検証するため。route より先に付ける。
    this.page.on('request', (req: Request) => {
      const url = req.url();
      if (!url.includes('/v1/admin/')) return;
      this.requests.push({ url, method: req.method(), postData: req.postData() });
    });

    // page.route は「後に登録したハンドラが先に評価される」。捕捉漏れ検出用の
    // catch-all を最初に登録し、個別のルートを後から重ねることで、
    //   - 塞ぎ忘れた /v1/admin/* は 501 で必ず落ちる(本番へ抜けない・黙って緑にならない)
    //   - 明示的に塞いだものは個別ハンドラが勝つ
    // の両立になる。順序を入れ替えると catch-all が全部を横取りする。
    await this.routeUnhandledAdminApi();
    await this.routeMyTenant();
    await this.routeRailCounts();
    await this.routeFeedback();
    await this.routeNotifications();
    await this.routeUiEvent();
    await this.routeAgentChat();
  }

  private async routeMyTenant(): Promise<void> {
    await this.page.route('**/v1/admin/my-tenant', (route) => {
      if (this.options.myTenantFails) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      }
      const body: Record<string, unknown> = { plan: this.options.plan ?? 'standard' };
      if (this.options.stage !== null) {
        body.onboarding_stage = this.options.stage ?? FULLY_ONBOARDED_STAGE;
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });
  }

  private async routeRailCounts(): Promise<void> {
    await this.page.route('**/v1/admin/knowledge-gaps/count*', (route) =>
      this.options.railCountsFail
        ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ count: this.options.gapsCount ?? 0 }),
          }),
    );
    await this.page.route('**/v1/admin/chat-history/escalations*', (route) =>
      this.options.railCountsFail
        ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              escalations: Array.from({ length: this.options.escalationsCount ?? 0 }, (_, i) => ({
                id: i + 1,
              })),
            }),
          }),
    );
  }

  private async routeFeedback(): Promise<void> {
    // 未読返信の取得(GET)と、既読化(PATCH)・再相談(POST)。
    await this.page.route('**/v1/admin/feedback**', (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: this.options.feedbackReplies ?? [] }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
  }

  private async routeNotifications(): Promise<void> {
    await this.page.route('**/v1/admin/notifications**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], notifications: [], unread_count: 0 }),
      }),
    );
  }

  private async routeUiEvent(): Promise<void> {
    await this.page.route('**/v1/admin/agent/ui-event', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
    );
  }

  private async routeAgentChat(): Promise<void> {
    await this.page.route('**/v1/admin/agent/chat', async (route: Route) => {
      const raw = JSON.parse(route.request().postData() || '{}') as Record<string, unknown>;
      const message = String(raw.message ?? '');
      this.chatCalls.push({
        message,
        surface: raw.surface as string | undefined,
        sessionId: raw.sessionId as string | undefined,
        targetTenantId: raw.targetTenantId as string | undefined,
        raw,
      });

      const rule = this.rules.find((r) => {
        if (r.once && this.consumed.has(r)) return false;
        return typeof r.when === 'string' ? message.includes(r.when) : r.when(message);
      });

      if (!rule) {
        // 想定していない送信文。無言で汎用応答を返すと「そこを通ったこと」が
        // 見えなくなるため、本文に明示して失敗時に原因が分かるようにする。
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            reply: `[E2E未定義の送信文] ${message}`,
            actions: [],
          } satisfies AgentReply),
        });
      }
      if (rule.once) this.consumed.add(rule);

      if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
      if (rule.abort) return route.abort('connectionfailed');
      if (rule.status && rule.status !== 200) {
        return route.fulfill({
          status: rule.status,
          contentType: 'application/json',
          body: JSON.stringify(rule.errorBody ?? {}),
        });
      }

      const payload = typeof rule.reply === 'function' ? rule.reply(message) : rule.reply;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload ?? { reply: '', actions: [] }),
      });
    });
  }

  /**
   * 明示的に塞いでいない /v1/admin/* を 501 で落とす。
   * 「モックし忘れが本番に飛ぶ」と「モックし忘れたまま緑になる」の両方を防ぐ。
   * install() の先頭で登録し、個別ルートを後から重ねること(後勝ちのため)。
   */
  private async routeUnhandledAdminApi(): Promise<void> {
    await this.page.route('**/v1/admin/**', (route) =>
      route.fulfill({
        status: 501,
        contentType: 'application/json',
        body: JSON.stringify({
          error: `E2E: このエンドポイントはハーネスで塞がれていません: ${route.request().method()} ${route.request().url()}`,
        }),
      }),
    );
  }

  // ── アバター系(必要なテストだけが呼ぶ) ─────────────────────────────────

  /**
   * アバターの画像生成・高品質生成・声検索・声作成・採用(PATCH)・クローンを塞ぐ。
   * fal.ai / Fish Audio の実課金を発生させないために、アバターを触る全テストで必須。
   */
  async stubAvatarBackend(opts: {
    images?: string[];
    premiumImageUrl?: string | null;
    voiceRecommendations?: Array<{ id: string; title: string; description: string; score: number }>;
    designCandidates?: Array<{ id: string; audioBase64: string; text: string | null }>;
    generateStatus?: number;
    generateErrorBody?: unknown;
    premiumStatus?: number;
    premiumErrorBody?: unknown;
    matchVoiceStatus?: number;
    designVoiceStatus?: number;
    patchStatus?: number;
    patchErrorBody?: unknown;
    voiceCloneStatus?: number;
    voiceCloneErrorBody?: unknown;
    generateDelayMs?: number;
  } = {}): Promise<void> {
    const {
      // 候補は必ず別URLにする。同一URLだと1枚採用した時点で adoptedUrl === url が
      // 4枚すべてに成立し、「1枚だけ採用される」ことを検証できなくなる
      // (フラグメントは画像のデコードに影響しないので、見た目は同じまま区別できる)。
      images = [1, 2, 3, 4].map((n) => `${PLACEHOLDER_IMAGE}#candidate-${n}`),
      premiumImageUrl = PLACEHOLDER_IMAGE,
      voiceRecommendations = [
        { id: 'voice-1', title: 'やわらかい女性の声', description: '落ち着いた話し方', score: 0.92 },
        { id: 'voice-2', title: 'はきはきした男性の声', description: '明るい話し方', score: 0.81 },
      ],
      designCandidates = [
        { id: 'cand-aaaaaaaa-1', audioBase64: TINY_WAV_BASE64, text: null },
        { id: 'cand-bbbbbbbb-2', audioBase64: TINY_WAV_BASE64, text: null },
      ],
    } = opts;

    await this.page.route('**/v1/admin/avatar/fal/generate*', async (route) => {
      if (opts.generateDelayMs) await new Promise((r) => setTimeout(r, opts.generateDelayMs));
      if (opts.generateStatus && opts.generateStatus !== 200) {
        return route.fulfill({
          status: opts.generateStatus,
          contentType: 'application/json',
          body: JSON.stringify(opts.generateErrorBody ?? {}),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ images }),
      });
    });

    await this.page.route('**/v1/admin/avatar/generate-premium*', (route) => {
      if (opts.premiumStatus && opts.premiumStatus !== 200) {
        return route.fulfill({
          status: opts.premiumStatus,
          contentType: 'application/json',
          body: JSON.stringify(opts.premiumErrorBody ?? {}),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(premiumImageUrl ? { imageUrl: premiumImageUrl } : {}),
      });
    });

    await this.page.route('**/v1/admin/avatar/match-voice*', (route) => {
      if (opts.matchVoiceStatus && opts.matchVoiceStatus !== 200) {
        return route.fulfill({ status: opts.matchVoiceStatus, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ recommendations: voiceRecommendations }),
      });
    });

    await this.page.route('**/v1/admin/avatar/design-voice*', (route) => {
      if (opts.designVoiceStatus && opts.designVoiceStatus !== 200) {
        return route.fulfill({ status: opts.designVoiceStatus, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ candidates: designCandidates }),
      });
    });

    // Playwright のグロブでは * が / を跨がないため、`configs/*` は
    // `configs/:id/voice-clone` には一致しない。両者は競合せず、順序も問わない。
    await this.page.route('**/v1/admin/avatar/configs/*/voice-clone', (route) => {
      if (opts.voiceCloneStatus && opts.voiceCloneStatus !== 200) {
        return route.fulfill({
          status: opts.voiceCloneStatus,
          contentType: 'application/json',
          body: JSON.stringify(opts.voiceCloneErrorBody ?? {}),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ voiceId: 'cloned-voice-1' }),
      });
    });

    await this.page.route('**/v1/admin/avatar/configs/*/adopt-designed-voice', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ voiceId: 'designed-voice-1' }),
      }),
    );

    await this.page.route('**/v1/admin/avatar/configs/*', (route) => {
      if (opts.patchStatus && opts.patchStatus !== 200) {
        return route.fulfill({
          status: opts.patchStatus,
          contentType: 'application/json',
          body: JSON.stringify(opts.patchErrorBody ?? {}),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
  }

  /** 書籍PDF取り込み。テナント(client_admin)は本来ここへ到達しない(R2C運用限定)。 */
  async stubBookPdf(opts: { status?: number; body?: unknown } = {}): Promise<void> {
    await this.page.route('**/v1/admin/knowledge/book-pdf*', (route) =>
      route.fulfill({
        status: opts.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(opts.body ?? { ok: true }),
      }),
    );
  }

  // ── 画面操作 ────────────────────────────────────────────────────────────

  /** /copilot-preview を開き、初期描画(左レール)まで待つ。 */
  async open(adminBaseUrl: string, query = ''): Promise<void> {
    await this.page.goto(`${adminBaseUrl}/copilot-preview${query}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await this.page.getByRole('button', { name: 'ログアウト' }).waitFor({ timeout: 30000 });
  }

  /** 直近に送られたチャット本文。 */
  lastMessage(): string | undefined {
    return this.chatCalls[this.chatCalls.length - 1]?.message;
  }

  /** 指定文字列を含む送信が何回あったか。連打の検証に使う。 */
  countMessages(substring: string): number {
    return this.chatCalls.filter((c) => c.message.includes(substring)).length;
  }

  /** 指定URL断片への書き込み(GET以外)リクエスト数。 */
  countWrites(urlSubstring: string): number {
    return this.requests.filter((r) => r.url.includes(urlSubstring) && r.method !== 'GET').length;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 固定データ
// ───────────────────────────────────────────────────────────────────────────

/** 1x1 透明PNG。外部ホストへ画像を取りに行かせないため data URI を使う。 */
export const PLACEHOLDER_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 44バイトの無音WAVヘッダ。<audio> が data URI として受け取れる最小構成。 */
export const TINY_WAV_BASE64 =
  'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

/** すぐ使える「起動時ブリーフィング」応答。 */
export const BOOTSTRAP_RULE: ChatRule = {
  when: 'ログインしたところです',
  reply: {
    reply: '今週は落ち着いています。まずは知識データの整備から始めましょう。',
    answered_from: 'tool_action',
    actions: [],
  },
};
