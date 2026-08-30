// tests/helpers/testServer.ts の互換性回帰テスト。
//
// このヘルパーは「既存テストの書き方(`request(app).get(url).set(...).expect(...)`)を
// 一切変えずに済む」ことを前提に113ファイル・約5,900テストへ導入されている。
// つまり `.set()` / `.expect()` / ステータス / ヘッダ / ボディ / `.del()` エイリアスの
// いずれかが素の supertest と僅かでも異なる挙動になると、この前提が崩れて
// 全ファイルに影響しうる。ガード/keep-aliveの正しさとは別に、この互換性そのものを
// 直接確認する。
import express from "express";
import { request } from "./testServer";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get("/echo-header", (req, res) => {
    res.set("x-response-marker", "from-server");
    res.json({ receivedHeader: req.get("x-request-marker") ?? null });
  });
  app.post("/echo-body", (req, res) => {
    res.status(201).json({ received: req.body });
  });
  app.delete("/thing/:id", (req, res) => {
    res.status(204).end();
  });
  app.get("/not-found", (_req, res) => {
    res.status(404).json({ error: "not found" });
  });
  return app;
}

it(".set()で送ったリクエストヘッダがサーバに届き、レスポンスヘッダも読み取れる", async () => {
  const app = makeApp();
  const res = await request(app).get("/echo-header").set("x-request-marker", "hello");
  expect(res.body).toEqual({ receivedHeader: "hello" });
  expect(res.headers["x-response-marker"]).toBe("from-server");
});

it(".send()で送ったJSONボディがサーバに届き、ステータス201・レスポンスボディが読み取れる", async () => {
  const app = makeApp();
  const res = await request(app)
    .post("/echo-body")
    .send({ foo: "bar" })
    .set("content-type", "application/json");
  expect(res.status).toBe(201);
  expect(res.body).toEqual({ received: { foo: "bar" } });
});

it(".expect()による成功時のステータスコード検証が通る", async () => {
  const app = makeApp();
  await request(app).get("/not-found").expect(404);
});

it(".expect()による失敗時、supertestと同様のAssertionErrorがthrowされる", async () => {
  const app = makeApp();
  await expect(request(app).get("/not-found").expect(200)).rejects.toThrow();
});

it("wrapped.del が .delete と同じメソッドのリクエストを発行する(エイリアス互換)", async () => {
  const app = makeApp();
  const res = await request(app).del("/thing/123");
  expect(res.status).toBe(204);
});
