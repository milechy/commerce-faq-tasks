// tests/helpers/testServer.ts のガード回帰テスト。
// 異なる app への未完了リクエストが競合すると silent failure になりうるため、
// 検出して例外を投げることを確認する(実装は beginRequest の in-flight チェック)。
import express from "express";
import { request } from "./testServer";

function makeApp(label: string) {
  const app = express();
  app.get("/x", (_req, res) => {
    setTimeout(() => res.json({ label }), 20);
  });
  return app;
}

it("異なるappへの並行(in-flight)リクエストは例外になる", () => {
  const appA = makeApp("A");
  const appB = makeApp("B");
  expect(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    request(appA).get("/x");
    request(appB).get("/x");
  }).toThrow(/未完了リクエスト/);
});
