// tests/helpers/testServer.ts のガード回帰テスト。
//
// testServer.ts は `.end()` を1箇所だけラップして in-flight カウンタを解放する
// (`chain.end = (cb) => originalEnd((err, res) => { release(); if (cb) cb(err, res); })`)。
// supertest の `.expect(status)` はアサーション失敗時、内部で `.end()` の
// コールバックに AssertionError を渡して呼ぶ(通信自体は成功している)。
// もしこの release() が「エラーが無いとき(=アサーション成功時)だけ」呼ばれる
// 実装だったら、テスト内で1つでも `.expect()` のアサーションが失敗した瞬間に
// in-flight カウンタが解放されないまま残り、それ以降の別app宛リクエストが
// 軒並みガードの誤発火で落ちる(本来のアサーション失敗1件が、無関係な
// テスト群の巻き添え失敗に化ける)。
//
// 「アサーション失敗時もrelease()が走る」ことを、そのものずばり確認する。
import express from "express";
import { request } from "./testServer";

function makeApp(label: string) {
  const app = express();
  app.get("/x", (_req, res) => {
    res.json({ label });
  });
  return app;
}

it("1つ目のit: .expect()のアサーション失敗でも別appへのリクエストが巻き添えを食わない", async () => {
  const appA = makeApp("A");
  const appB = makeApp("B");

  // 実際のステータスは200なので、999を期待するこのexpectは必ず失敗する。
  await expect(request(appA).get("/x").expect(999)).rejects.toThrow();

  // アサーション失敗の直後に別appへリクエストしても、in-flightガードが
  // 誤発火しない(=release()がエラー経路でも呼ばれている)ことを確認する。
  const res = await request(appB).get("/x");
  expect(res.body).toEqual({ label: "B" });
});
