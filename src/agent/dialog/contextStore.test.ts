import { appendToSessionHistory, getSessionHistory } from "./contextStore";

describe("contextStore", () => {
  it("同一sessionIdでも別tenantの履歴は取得できない", () => {
    appendToSessionHistory("tenant-a", "session-1", [
      { role: "user", content: "tenant-a の発話" },
    ]);

    expect(getSessionHistory("tenant-a", "session-1")).toEqual([
      { role: "user", content: "tenant-a の発話" },
    ]);
    expect(getSessionHistory("tenant-b", "session-1")).toEqual([]);
  });

  it("同一sessionIdでも別tenantへの追記が互いの履歴を汚染しない", () => {
    appendToSessionHistory("tenant-c", "session-2", [
      { role: "user", content: "tenant-c の発話" },
    ]);
    appendToSessionHistory("tenant-d", "session-2", [
      { role: "user", content: "tenant-d の発話" },
    ]);

    expect(getSessionHistory("tenant-c", "session-2")).toEqual([
      { role: "user", content: "tenant-c の発話" },
    ]);
    expect(getSessionHistory("tenant-d", "session-2")).toEqual([
      { role: "user", content: "tenant-d の発話" },
    ]);
  });

  it("存在しないsession/tenantの組み合わせは空配列を返す", () => {
    expect(getSessionHistory("tenant-unknown", "session-unknown")).toEqual([]);
  });
});
