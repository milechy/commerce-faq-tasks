// tests/helpers/testServer.ts のガード回帰テスト。
// 完了を待ってから別の app にリクエストする(=in-flightではない)場合は
// 異なる app でも例外にならないことを確認する。
import express from "express";
import { request } from "./testServer";

function makeApp(label: string) {
  const app = express();
  app.get("/x", (_req, res) => {
    setTimeout(() => res.json({ label }), 20);
  });
  return app;
}

it("逐次(完了を待ってから次)なら異なるappでも問題ない", async () => {
  const appA = makeApp("A2");
  const appB = makeApp("B2");
  const a = await request(appA).get("/x");
  const b = await request(appB).get("/x");
  expect(a.body.label).toBe("A2");
  expect(b.body.label).toBe("B2");
});
