// tests/helpers/testServer.ts のガード回帰テスト。
//
// 背景(実際に起きた事故): あるテストが `.end()`/`await` を一度も呼ばずに
// 終わる(タイムアウト・アサーション例外・書き忘れ等)と、beginRequest内で
// 同期的にインクリメントした inFlight カウンタが解放されないまま残る。
// これを次のテストの afterEach でリセットしていない実装だと、次のテストが
// 別のappにリクエストしただけで in-flight ガードが誤発火し、無関係な
// テストが「別のappへの未完了リクエストがある」という紛らわしいエラーで
// 落ちてしまう(元の問題を隠して別の失敗にすり替える二次被害)。
//
// このファイルでは、1つ目の it で意図的に `.end()`/`await` を呼ばずに
// request() だけ発火して終わり、2つ目の it(別app)がそれに巻き込まれず
// 正常に完了することを確認する。
import express from "express";
import { request } from "./testServer";

function makeApp(label: string) {
  const app = express();
  app.get("/x", (_req, res) => {
    res.json({ label });
  });
  return app;
}

it("1つ目のit: .end()/awaitを呼ばずにリクエストだけ発火して終わる(事故の再現)", () => {
  const abandonedApp = makeApp("abandoned");
  // 意図的に await も .end() も呼ばない。testServer.ts の実装では
  // beginRequest 内で inFlight++ が同期的に走るため、ここでカウンタだけが
  // 残る(実際のHTTPリクエストは supertest の仕様上 .end()/.then() を
  // 呼ばない限り発火しないため、サーバ側に副作用は残らない)。
  request(abandonedApp).get("/x");
});

it("2つ目のit: 別appへのリクエストが前のitの巻き添えでガード誤発火しない", async () => {
  const otherApp = makeApp("other");
  // afterEachでのリセットが効いていれば、ここは単なる正常な逐次リクエストとして
  // 通る。効いていなければ「別の app への未完了リクエストがある間に...」で
  // 例外が飛ぶ(このテスト自体が落ちることでリグレッションを検出する)。
  const res = await request(otherApp).get("/x");
  expect(res.body).toEqual({ label: "other" });
});
