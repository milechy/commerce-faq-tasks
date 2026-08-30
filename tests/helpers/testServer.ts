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
//
// ★制約(壊れ方の注意): dispatcherServer はモジュールスコープの `currentApp` を
// 「直近に request() された app」で差し替えるだけの実装なので、リクエストを
// 実際に処理するのは常に「その時点の currentApp」であって「呼び出し時に意図した
// app」ではない。同一ファイル内で異なる app に対して in-flight のリクエストを
// 並行に投げると、後から呼ばれた方の app が両方のリクエストを処理してしまい、
// エラーにならず静かに誤った結果を返す(silent failure)。これを検出するため、
// 「別の app への未完了リクエストがある間に異なる app へリクエストする」と
// 例外を投げるガードを入れている(下記 beginRequest 参照)。同一 app への
// 並行リクエスト(Promise.all 等)は正常系として許可される。
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
// currentApp 宛ての未完了(bind済みだが .end() が終わっていない)リクエスト数。
// 0より大きい間に異なる app への request() が来たら、上記の silent failure の
// おそれがあるため例外を投げる。
let inFlight = 0;

/**
 * 実際にHTTPメソッドが呼ばれた瞬間(=リクエストが発生する瞬間)に呼ぶ。
 * 異なる app への in-flight リクエストとの競合を検出し、なければ
 * dispatcherServer を bind/差し替えて返す。
 */
function beginRequest(target: unknown): http.Server {
  // 既に listen 済みの Server がそのまま渡された場合は専用サーバなので対象外
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
  if (inFlight > 0 && target !== currentApp) {
    throw new Error(
      "testServer: 別の app への未完了リクエストがある間に、異なる app へのリクエストが発行されました。\n" +
        "この testServer はファイル内で共有 dispatcher server 1本の転送先(currentApp)を差し替える実装のため、" +
        "2つの app に同時にリクエストすると後から呼ばれた方の app が両方を処理してしまい、" +
        "テストが失敗せずに誤った結果を返す(silent failure)おそれがあります。\n" +
        "同一 app への並行リクエスト(例: Promise.all)は問題ありません。" +
        "異なる app に本当に同時リクエストしたい場合は、このヘルパーを使わずテストごとに専用の http.Server を用意してください。"
    );
  }
  currentApp = target;
  return dispatcherServer;
}

// あるテストがタイムアウト/異常終了して .end() が一度も呼ばれず inFlight が
// 解放されないままだと、次のテストが別の app にリクエストするだけでガードが
// 誤発火してしまう(元のタイムアウトに便乗した無関係な失敗が増える)。
// テスト境界を跨いで in-flight 状態を持ち越す理由はない(並行リクエストの検出は
// 同一テスト内で完結する)ため、テストごとにリセットする。
afterEach(() => {
  inFlight = 0;
});

// テストファイルの終了時に必ず close する(force exit 前提でも念のため)
afterAll(() => {
  dispatcherServer?.close();
  dispatcherServer = undefined;
  currentApp = undefined;
  inFlight = 0;
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
  const wrapped = {} as Record<(typeof HTTP_METHODS)[number] | "del", (url: string) => SupertestChain>;
  for (const method of HTTP_METHODS) {
    wrapped[method] = (url: string) => {
      const server = beginRequest(target);
      const tracked = server === dispatcherServer;
      if (tracked) inFlight++;
      let released = false;
      const release = () => {
        if (tracked && !released) {
          released = true;
          inFlight = Math.max(0, inFlight - 1);
        }
      };

      const chain = (supertestRequest(server as never)[method](url) as unknown as {
        agent: (a: http.Agent) => SupertestChain;
      }).agent(keepAliveAgent) as unknown as { end: (cb?: (err: unknown, res: unknown) => void) => SupertestChain };

      // .then()(await 含む)も内部で .end() を呼ぶため、ここ1箇所のフックで
      // どちらの書き方でも in-flight 解除が効く。
      const originalEnd = chain.end.bind(chain);
      chain.end = (cb?: (err: unknown, res: unknown) => void) =>
        originalEnd((err, res) => {
          release();
          if (cb) cb(err, res);
        });

      return chain as unknown as SupertestChain;
    };
  }
  wrapped.del = wrapped.delete;
  return wrapped;
}

// `import supertest from "supertest"` 形式で使っているテスト向けのエイリアス
export const supertest = request;
