// tests/helpers/testServer.ts
//
// 背景: supertest は `request(app)` のたびに Express アプリを ephemeral port に
// bind し、レスポンス後に close する。さらに supertest はデフォルトで
// コネクションプーリングを無効化する(`agent: false`)ため、1回のHTTPリクエスト
// ごとに新規TCPコネクションを張って閉じる。
// 117ファイル・約5,700テスト規模でこれを行うと、この開発機の ephemeral ポート
// (net.inet.ip.portrange.first=49152〜last=65535, 16,384個) と TIME_WAIT
// (net.inet.tcp.msl=15000ms → 実質30秒間ポートが再利用不可) が枯渇し、
// `pnpm test` がスイート単位でランダムに EADDRNOTAVAIL 落ちするようになった
// (ポート涸渇問題)。
//
// このヘルパーは supertest の `request()` の代替品で、既存テストの書き方
// (`request(app).get(url).set(...).expect(...)`) を一切変えずに済むよう、
// 呼び出し方はそのままで内部だけ次の2点を変える:
//   1. 直前と同じ app(関数)を渡した場合は listen 済みの http.Server を使い回す
//      (beforeEach で app を毎回作り直すテストでも、そのテストの中で複数回
//      HTTPリクエストするなら bind は1回で済む)
//   2. 全リクエストで同一の keep-alive http.Agent を使い回し、TCPコネクション
//      自体を再利用する(supertest はデフォルトで `agent: false` = プーリング無効)
// テストの検証内容(アサーション)には一切影響しない — supertest に渡る実体が
// 変わるだけで、リクエスト/レスポンスの経路・ヘッダ・ボディは同じ。
import http from "http";
import supertestRequest from "supertest";

const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });

// Jest はテストファイルごとにモジュールを分離ロードするため、このキャッシュは
// ファイル間で共有されない。
//
// ポイント: dispatcherServer はファイル内で「初回リクエスト時に1回だけ」bind し、
// 以降は beforeEach 等で app が何度差し替わっても再bindしない。実際にリクエストを
// 転送する先(currentApp)だけを毎回差し替える固定のリクエストハンドラを持たせる
// ことで、テスト数だけ bind/close が発生していた問題を解消する。
let dispatcherServer: http.Server | undefined;
let currentApp: unknown;

function serverFor(target: unknown): http.Server {
  // 既に listen 済みの Server がそのまま渡された場合はそのまま使う
  if (target instanceof http.Server) {
    return target;
  }
  if (!dispatcherServer) {
    dispatcherServer = http.createServer((req, res) => {
      if (typeof currentApp !== "function") {
        throw new Error("testServer: request() に app が渡される前にリクエストが発生しました");
      }
      (currentApp as http.RequestListener)(req, res);
    });
    dispatcherServer.listen(0);
  }
  currentApp = target;
  return dispatcherServer;
}

// テストファイルの終了時に必ず close する(force exit 前提でも念のため)
afterAll(() => {
  dispatcherServer?.close();
  dispatcherServer = undefined;
  currentApp = undefined;
});

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

type SupertestChain = ReturnType<typeof supertestRequest>[typeof HTTP_METHODS[number]] extends (
  ...args: never[]
) => infer R
  ? R
  : never;

/**
 * supertest の `request(app)` の代替。呼び出し方(`.get(url).set(...).expect(...)`)は
 * 完全互換で、内部で サーバの使い回し + keep-alive agent を自動付与する。
 */
export function request(target: unknown): Record<(typeof HTTP_METHODS)[number] | "del", (url: string) => SupertestChain> {
  const server = serverFor(target);
  const base = supertestRequest(server as never) as unknown as Record<
    (typeof HTTP_METHODS)[number],
    (url: string) => SupertestChain
  >;
  const wrapped = {} as Record<(typeof HTTP_METHODS)[number] | "del", (url: string) => SupertestChain>;
  for (const method of HTTP_METHODS) {
    wrapped[method] = (url: string) => (base[method](url) as unknown as { agent: (a: http.Agent) => SupertestChain }).agent(keepAliveAgent);
  }
  wrapped.del = wrapped.delete;
  return wrapped;
}

// `import supertest from "supertest"` 形式で使っているテスト向けのエイリアス
export const supertest = request;
