// tests/helpers/testServer.ts のガード回帰テスト。
// 同一appへの並行リクエストは正常系であり、例外にならないことを確認する。
// (このシナリオだけ別ファイルにしているのは、testServer.ts のモジュール状態が
// ファイル単位のため、シナリオごとに新しいモジュールインスタンスで検証するため)
import express from "express";
import { request } from "./testServer";

function makeApp(label: string) {
  const app = express();
  app.get("/x", (_req, res) => {
    setTimeout(() => res.json({ label }), 20);
  });
  return app;
}

it("同一appへの並行リクエストは許可される", async () => {
  const app = makeApp("same");
  const [a, b] = await Promise.all([
    request(app).get("/x"),
    request(app).get("/x"),
  ]);
  expect(a.body.label).toBe("same");
  expect(b.body.label).toBe("same");
});
