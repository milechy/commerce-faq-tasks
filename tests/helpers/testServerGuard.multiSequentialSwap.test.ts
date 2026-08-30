// tests/helpers/testServer.ts のガード回帰テスト。
//
// dispatcherServer は「直近にrequest()されたapp」を currentApp として保持し、
// 実際にリクエストを処理するのは常にその時点の currentApp。既存の
// testServerGuard.sequential.test.ts は2つのappの逐次切り替えを確認しているが、
// 2回だけだと「1回目の差し替えは効くが2回目以降は最初のappに固定されたまま」
// のような回帰(オフバイワン)を見逃しうる。ここでは3つ以上のappを逐次に
// 切り替え、都度レスポンスが「その時点で送ったappのもの」であることを
// 確認する(古いappに届いていないことの確認)。
import express from "express";
import { request } from "./testServer";

function makeApp(label: string) {
  const app = express();
  app.get("/x", (_req, res) => {
    res.json({ label });
  });
  return app;
}

it("3つ以上のappを逐次に切り替えても、毎回その時点のappからレスポンスが返る", async () => {
  const labels = ["one", "two", "three", "four"];
  for (const label of labels) {
    const app = makeApp(label);
    // eslint-disable-next-line no-await-in-loop
    const res = await request(app).get("/x");
    expect(res.body).toEqual({ label });
  }
});
