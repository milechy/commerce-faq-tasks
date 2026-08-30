// tests/helpers/testServer.ts のガード回帰テスト。
// このリポジトリの113ファイル中97ファイルは「beforeEachでapp(express関数)を
// 毎回作り直し、各itで1回ずつリクエストする」形を取っている。app関数の参照は
// テストのたびに変わる(≠同一関数)ため、in-flightガードの「target !== currentApp」
// 判定に新しい関数参照が渡り続ける形になる。これ自体は正常系(逐次実行であり
// in-flightの衝突は起きない)だが、万一 dispatcherServer や inFlight のリセットが
// テスト境界を跨いで正しく行われていないと、2つ目以降の it で誤ってガードが
// 発火しうる。この典型パターンで複数の it を跨いでも例外にならないことを確認する。
import express from "express";
import { request } from "./testServer";

let app: ReturnType<typeof express>;

beforeEach(() => {
  // 実コードの beforeEach と同様、毎回新しい関数参照のappを作る。
  app = express();
  app.get("/x", (_req, res) => {
    res.json({ ok: true });
  });
});

it("1つ目のit: beforeEachで作り直したappにリクエストできる", async () => {
  const res = await request(app).get("/x");
  expect(res.body).toEqual({ ok: true });
});

it("2つ目のit: 別関数参照のappに差し替わってもガードは発火しない", async () => {
  const res = await request(app).get("/x");
  expect(res.body).toEqual({ ok: true });
});

it("3つ目のit: さらに差し替えても問題ない(2回連続での差し替えを確認)", async () => {
  const res = await request(app).get("/x");
  expect(res.body).toEqual({ ok: true });
});
