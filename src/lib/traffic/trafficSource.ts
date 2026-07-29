// src/lib/traffic/trafficSource.ts
// GID 1216970103691946: 実エンドユーザーとテスト/デモトラフィックを区別するための
// トラフィックソース判定。A/Bテスト実装(lane-plans)を含む全ての集計指標
// (継続率・CV率・Judgeスコア等)の前提となる。
//
// 背景: 本番DBのchat_sessions調査で、7月分292件中82%が集中日(7/17・7/18・7/28)に
// 偏っており、いずれもE2Eテストを本番に対して大量実行した日と一致した。しかも
// 該当日は2往復以上の会話が皆無で実ユーザーの振る舞いとは考えにくい。
// metadataが空でテストと実ユーザーを区別する手がかりが一切なかったため、
// 全指標(継続率・CV率・Judgeスコア)が汚染されていた。
//
// 契約 (lane-plansと共有。変更する場合は必ずteam-leadに相談すること):
//   chat_sessions.metadata.source に以下のいずれかを記録する:
//     'user'       = 実エンドユーザー(デフォルト)
//     'e2e'        = Playwright/CI由来
//     'chat_test'  = 管理画面のテストチャット
//     'demo'       = デモページ(carnation-demo・LP埋め込み等)由来
//     'unknown'    = 判定不能・過去データ(このモジュールが書き込むことはない。
//                    集計側で `metadata->>'source' = 'user'` フィルタをかければ
//                    NULL/未設定の過去データは自動的に除外される)
//   集計は source='user' のみを対象にする。

export type TrafficSource = "user" | "e2e" | "chat_test" | "demo" | "unknown";

/** E2Eテスト(Playwright)が明示的に付与するヘッダ名。 */
export const TRAFFIC_SOURCE_HEADER = "x-r2c-traffic-source";

/** ヘッダで明示されうる値のうち、判定に使うもの。 */
const EXPLICIT_E2E_HEADER_VALUE = "e2e";

/** UAベースのE2E判定(ヘッダが付与されなかった場合のフォールバック)。 */
const HEADLESS_UA_PATTERNS: RegExp[] = [/HeadlessChrome/i, /Playwright/i];

/**
 * デモページ由来の判定(Referer/Origin ベース)。
 * carnation-demo (社内デモ用テナント) と LP自体に埋め込まれたウィジェットの両方を対象にする。
 * 特定タグエントの API キー自体では判定しない(そのテナントが将来実顧客の実サイトから
 * 同じキーで呼ばれるケースを誤って"demo"扱いしないため。Refererで発生元ページを見る)。
 */
const DEMO_REFERER_PATTERNS: RegExp[] = [
  /\/carnation-demo(?:\/|\.html|$)/i,
  /\/lp\/?(?:$|[/?#])/i,
];

export interface TrafficSourceInput {
  /** x-r2c-traffic-source ヘッダの値 */
  headerValue?: string | null;
  /** User-Agent ヘッダ */
  userAgent?: string | null;
  /** Referer/Referrer ヘッダ */
  referer?: string | null;
  /**
   * authMiddleware が chat-test JWT (purpose: "chat-test") を検証済みの場合に true。
   * src/agent/http/authMiddleware.ts が既に req.isChatTestToken として設定している
   * 既存の仕組みをそのまま利用する(新規実装不要)。
   */
  isChatTestToken?: boolean;
}

/**
 * リクエストの各種シグナルからトラフィックソースを判定する(純粋関数・副作用なし)。
 *
 * 優先順位:
 *   1. isChatTestToken → 'chat_test' (無条件。管理画面テストチャット由来と確定しているため)
 *   2. 明示的なE2Eヘッダ → 'e2e'
 *   3. UAによるヘッドレスブラウザ判定 → 'e2e' (ヘッダ付与漏れのフォールバック)
 *   4. デモページ由来のReferer → 'demo'
 *   5. 上記いずれにも該当しない → 'user'
 */
export function resolveTrafficSource(input: TrafficSourceInput): TrafficSource {
  if (input.isChatTestToken) return "chat_test";

  if (input.headerValue && input.headerValue.toLowerCase() === EXPLICIT_E2E_HEADER_VALUE) {
    return "e2e";
  }

  if (input.userAgent && HEADLESS_UA_PATTERNS.some((p) => p.test(input.userAgent!))) {
    return "e2e";
  }

  if (input.referer && DEMO_REFERER_PATTERNS.some((p) => p.test(input.referer!))) {
    return "demo";
  }

  return "user";
}
