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

  it("tenantIdが空文字列でも他テナントの履歴と混ざらない", () => {
    appendToSessionHistory("", "session-empty-tenant", [
      { role: "user", content: "空tenantIdの発話" },
    ]);
    appendToSessionHistory("tenant-e", "session-empty-tenant", [
      { role: "user", content: "tenant-e の発話" },
    ]);

    expect(getSessionHistory("", "session-empty-tenant")).toEqual([
      { role: "user", content: "空tenantIdの発話" },
    ]);
    expect(getSessionHistory("tenant-e", "session-empty-tenant")).toEqual([
      { role: "user", content: "tenant-e の発話" },
    ]);
  });

  it("上限到達（MAX_HISTORY_LENGTH=20件）はテナント単位で独立している", () => {
    const twentyMessages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `tenant-full の発話${i}`,
    }));
    appendToSessionHistory("tenant-full", "session-limit", twentyMessages);
    // tenant-full は上限ちょうど20件
    expect(getSessionHistory("tenant-full", "session-limit")).toHaveLength(20);

    // 別テナントが同じsessionIdへ1件だけ追記しても、tenant-full 側の20件は変化しない
    appendToSessionHistory("tenant-other", "session-limit", [
      { role: "user", content: "tenant-other の発話" },
    ]);
    expect(getSessionHistory("tenant-full", "session-limit")).toHaveLength(20);
    expect(getSessionHistory("tenant-other", "session-limit")).toHaveLength(1);

    // tenant-full がさらに追記すると古い方から切り詰められる（先頭が押し出される）
    appendToSessionHistory("tenant-full", "session-limit", [
      { role: "user", content: "tenant-full の21件目" },
    ]);
    const trimmed = getSessionHistory("tenant-full", "session-limit");
    expect(trimmed).toHaveLength(20);
    expect(trimmed[0].content).toBe("tenant-full の発話1"); // 発話0 が押し出された
    expect(trimmed[19].content).toBe("tenant-full の21件目");
  });

  describe("キー連結（`${tenantId}::${sessionId}`）のセパレータ衝突", () => {
    it("【既知の制約】sessionId/tenantIdに区切り文字`::`を含む値を組み合わせると、異なるテナント/セッションの組が同一内部キーに衝突しうる", () => {
      // tenantId="A", sessionId="B::C" と tenantId="A::B", sessionId="C" は
      // どちらも内部キー "A::B::C" になり、同じ履歴を共有してしまう。
      // sessionId はクライアント（req.body.sessionId）が任意の文字列を送れるため、
      // 攻撃者が他テナントのIDを知っていれば意図的にこの衝突を起こせる可能性がある。
      appendToSessionHistory("A", "B::C", [
        { role: "user", content: "tenant=A, session=B::C の発話" },
      ]);
      appendToSessionHistory("A::B", "C", [
        { role: "user", content: "tenant=A::B, session=C の発話" },
      ]);

      // 現状の実装では両者が同一キーに収束し、appendToSessionHistory はマージ（追記）
      // であるため、上書きではなく「両テナントのメッセージが同一配列に混在する」
      // というさらに深刻な形で現れる。このテストは「安全である」ことの証明ではなく、
      // 現状の挙動を固定して可視化するためのもの。tenantId/sessionId に
      // エスケープ不能な区切り文字を許す設計は残存リスクとして別途対応を検討すべき。
      const viaA = getSessionHistory("A", "B::C");
      const viaAB = getSessionHistory("A::B", "C");
      expect(viaA).toEqual(viaAB); // 衝突している＝本来は異なるべき2つの取得結果が一致してしまう
      expect(viaA).toEqual([
        { role: "user", content: "tenant=A, session=B::C の発話" },
        { role: "user", content: "tenant=A::B, session=C の発話" }, // 別テナントの発話が同一履歴に混入
      ]);
    });
  });
});
