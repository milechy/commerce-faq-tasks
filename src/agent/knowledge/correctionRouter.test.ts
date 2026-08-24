// 誤答是正の着地層判定。3層の役割分担を守る要なので、境界を厚めに固定する。
// D5(要件定義 v1.3): 迷ったら知識(事実)に倒す。
import { routeCorrection, type CorrectionInput } from "./correctionRouter";

const ctx = (correction: string): CorrectionInput => ({
  question: "保証期間は？",
  answer: "1年です。",
  correction,
});

const layerOf = (c: string) => routeCorrection(ctx(c)).layer;

describe("事実の訂正は知識へ", () => {
  it.each([
    ["保証は2年です", "期間"],
    ["価格は12800円です", "金額"],
    ["営業時間は10:00からです", "時刻"],
    ["発送は3営業日かかります", "日数"],
    ["正しくは日本製です", "訂正の言い回し"],
    ["1年ではなく2年です", "否定による訂正"],
    ["創業は2015年4月1日です", "日付"],
    ["送料は無料ではありません", "否定による訂正"],
  ])("%s → knowledge (%s)", (correction) => {
    expect(layerOf(correction)).toBe("knowledge");
  });
});

describe("振る舞いの指示はルールへ", () => {
  it.each([
    ["もっと丁寧に answer してほしい"],
    ["値引きの話は避けてください"],
    ["保証について聞かれたら在庫も案内して"],
    ["カジュアルな口調で話してください"],
    ["競合の話は言わないでください"],
    ["必ず問い合わせ先を伝えて"],
  ])("%s → rule", (correction) => {
    const r = routeCorrection(ctx(correction));
    expect(r.layer).toBe("rule");
    expect(r.requiresTrigger).toBe(true);
  });
});

describe("D5: 迷ったら知識に倒す", () => {
  it("事実と方針が混在する指摘は知識へ（事実を優先）", () => {
    const r = routeCorrection(ctx("保証は2年なので、聞かれたらそう答えて"));
    expect(r.layer).toBe("knowledge");
    expect(r.signals.fact.length).toBeGreaterThan(0);
    expect(r.signals.policy.length).toBeGreaterThan(0);
    expect(r.reason).toContain("事実を優先");
  });

  it.each([
    ["これは違う"],
    ["ちがいます"],
    ["🙅"],
    ["あ"],
  ])("判断材料が乏しい指摘 %s は知識へ", (correction) => {
    expect(layerOf(correction)).toBe("knowledge");
  });

  it("空文字でも落ちず知識へ倒す", () => {
    const r = routeCorrection(ctx(""));
    expect(r.layer).toBe("knowledge");
    expect(r.requiresTrigger).toBe(false);
    expect(r.reason).toContain("D5");
  });

  it("空白のみの指摘も空として扱う", () => {
    expect(routeCorrection(ctx("　  \n ")).layer).toBe("knowledge");
  });
});

describe("境界・異常系", () => {
  it("1万字の指摘でも落ちない", () => {
    const long = "保証は2年です。".repeat(1200).slice(0, 10000);
    expect(layerOf(long)).toBe("knowledge");
  });

  it("correction が undefined でも落ちない（LLM出力の欠損を想定）", () => {
    const r = routeCorrection({ question: "q", answer: "a" } as unknown as CorrectionInput);
    expect(r.layer).toBe("knowledge");
  });

  // 「層」だけを見ると既定(knowledge)に落ちて通ってしまい、正規化が壊れても気づけない。
  // シグナルを直接検証する。
  it("全角数字の期間も事実シグナルとして拾う(表記ゆれで不発にしない)", () => {
    const r = routeCorrection(ctx("保証は２年です"));
    expect(r.signals.fact).toContain("期間");
    expect(r.layer).toBe("knowledge");
  });

  it("全角の金額・時刻も拾う", () => {
    expect(routeCorrection(ctx("価格は１２８００円です")).signals.fact).toContain("金額・割合");
    expect(routeCorrection(ctx("営業時間は１０：００からです")).signals.fact).toContain("時刻");
  });

  it("rule に着地するときは必ず requiresTrigger=true（空triggerでの保存事故を防ぐ）", () => {
    const r = routeCorrection(ctx("値引きの話は避けて"));
    expect(r.layer).toBe("rule");
    expect(r.requiresTrigger).toBe(true);
  });

  it("knowledge に着地するときは requiresTrigger=false", () => {
    expect(routeCorrection(ctx("保証は2年です")).requiresTrigger).toBe(false);
  });

  it("reason は必ず非空で、なぜその層かを説明する", () => {
    for (const c of ["保証は2年です", "丁寧に話して", "", "あ"]) {
      expect(routeCorrection(ctx(c)).reason.length).toBeGreaterThan(0);
    }
  });
});

describe("純関数であること", () => {
  it("同じ入力で常に同じ結果を返す", () => {
    const a = routeCorrection(ctx("保証は2年です"));
    const b = routeCorrection(ctx("保証は2年です"));
    expect(a).toEqual(b);
  });

  it("入力オブジェクトを変更しない", () => {
    const input = ctx("保証は2年です");
    const snapshot = JSON.stringify(input);
    routeCorrection(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
