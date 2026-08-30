// tests/helpers/testServer.ts のガード回帰テスト。
//
// beginRequest は `target instanceof http.Server` の場合、共有dispatcherServer
// (currentApp差し替え方式)を一切使わず、渡された専用サーバをそのまま返す
// (「既に listen 済みの Server がそのまま渡された場合は専用サーバなので対象外」)。
// つまりこの経路は in-flight ガードの対象外であり、共有dispatcherServer側の
// 状態(currentApp/inFlight)を汚染しない・汚染されない独立経路のはず。
// この性質(1: 素のhttp.Serverでも普通にリクエストできる, 2: 共有dispatcher側の
// in-flight状態と無関係に共存できる)を確認する。
import http from "http";
import express from "express";
import { request } from "./testServer";

function makeListeningServer(label: string): http.Server {
  const app = express();
  app.get("/x", (_req, res) => {
    res.json({ label });
  });
  const server = http.createServer(app);
  server.listen(0);
  return server;
}

function makeApp(label: string) {
  const app = express();
  app.get("/x", (_req, res) => {
    setTimeout(() => res.json({ label }), 20);
  });
  return app;
}

it("既にlisten済みのhttp.Serverを直接渡しても通常通りリクエストできる", async () => {
  const server = makeListeningServer("raw");
  try {
    const res = await request(server).get("/x");
    expect(res.body).toEqual({ label: "raw" });
  } finally {
    server.close();
  }
});

it("共有dispatcher側に別appへのin-flightリクエストがあっても、素のhttp.Serverへのリクエストは巻き込まれない", async () => {
  const server = makeListeningServer("raw2");
  const appA = makeApp("A");
  try {
    // dispatcherServer側のcurrentAppをappA向けにin-flightにしたまま、
    // 素のServerへ別途リクエストする。target instanceof http.Server の経路は
    // dispatcherServer/currentApp/inFlightを一切参照しないため、
    // 「別appへの未完了リクエストがある間の異なるappへのリクエスト」の
    // ガードに引っかかってはならない。
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    const pending = request(appA).get("/x");
    const rawRes = await request(server).get("/x");
    expect(rawRes.body).toEqual({ label: "raw2" });
    await pending;
  } finally {
    server.close();
  }
});
