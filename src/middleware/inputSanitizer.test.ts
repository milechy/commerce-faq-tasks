// src/middleware/inputSanitizer.test.ts
// L5 Input Sanitizer: production 既定ON / development・test 既定OFF の確認

import { sanitizeInput } from "./inputSanitizer";

describe("sanitizeInput: enabled-flag default", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("production かつフラグ未設定なら既定ONでURLをブロックする", () => {
    process.env.NODE_ENV = "production";
    delete process.env.INPUT_SANITIZER_ENABLED;

    const result = sanitizeInput("http://evil.example の商品を教えて", "sess-prod-default");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("url_detected");
  });

  it("production かつ INPUT_SANITIZER_ENABLED=false なら明示的にOFFにできる", () => {
    process.env.NODE_ENV = "production";
    process.env.INPUT_SANITIZER_ENABLED = "false";

    const result = sanitizeInput("http://evil.example の商品を教えて", "sess-prod-off");
    expect(result.allowed).toBe(true);
  });

  it("development かつフラグ未設定なら既定OFF（従来動作を維持）", () => {
    process.env.NODE_ENV = "development";
    delete process.env.INPUT_SANITIZER_ENABLED;

    const result = sanitizeInput("http://evil.example の商品を教えて", "sess-dev-default");
    expect(result.allowed).toBe(true);
  });

  it("development かつ INPUT_SANITIZER_ENABLED=true なら明示的にONにできる", () => {
    process.env.NODE_ENV = "development";
    process.env.INPUT_SANITIZER_ENABLED = "true";

    const result = sanitizeInput("http://evil.example の商品を教えて", "sess-dev-on");
    expect(result.allowed).toBe(false);
  });

  it.each(["1", "TRUE", "yes", ""])(
    "production かつ INPUT_SANITIZER_ENABLED=%j（'false'以外の非標準値）は既定ONのまま",
    (flag) => {
      process.env.NODE_ENV = "production";
      process.env.INPUT_SANITIZER_ENABLED = flag;

      const result = sanitizeInput("http://evil.example の商品を教えて", `sess-flag-${flag}`);
      expect(result.allowed).toBe(false);
    },
  );
});

describe("sanitizeInput: encoding attack — 閾値の境界値", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    delete process.env.INPUT_SANITIZER_ENABLED;
  });

  it("unicodeエスケープが9個まで（10未満）は通過する", () => {
    const msg = Array.from({ length: 9 }, (_, i) => `\\u00${i}${i}`).join(" ");
    const result = sanitizeInput(msg, "sess-unicode-9");
    expect(result.allowed).toBe(true);
  });

  it("unicodeエスケープが10個ちょうどでブロックされる", () => {
    const msg = Array.from({ length: 10 }, (_, i) => `\\u0${i}${i}${i}`).join(" ");
    const result = sanitizeInput(msg, "sess-unicode-10");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("encoding_attack");
  });

  it("HTMLエンティティが4個まで（5未満）は通過する", () => {
    const msg = Array.from({ length: 4 }, (_, i) => `&#${65 + i};`).join("");
    const result = sanitizeInput(msg, "sess-entity-4");
    expect(result.allowed).toBe(true);
  });

  it("HTMLエンティティが5個ちょうどでブロックされる", () => {
    const msg = Array.from({ length: 5 }, (_, i) => `&#${65 + i};`).join("");
    const result = sanitizeInput(msg, "sess-entity-5");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("encoding_attack");
  });

  it("base64 data URIは1個でもブロックされる", () => {
    const result = sanitizeInput(
      "画像はこれです data:image/png;base64,iVBORw0KGgo=",
      "sess-datauri",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("encoding_attack");
  });

  it("null byteのみで構成されたメッセージは除去後に空になりブロックされる", () => {
    const result = sanitizeInput("\x00\x00\x00", "sess-nullbyte-only");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("encoding_attack");
  });

  it("null byteが混在していても、除去後に残る本文があれば通過する（過検知しない）", () => {
    const result = sanitizeInput("こんにちは\x00世界", "sess-nullbyte-mixed");
    expect(result.allowed).toBe(true);
    expect(result.sanitizedMessage).toBe("こんにちは世界");
  });
});

describe("sanitizeInput: URL検出 — 過検知/見逃しの境界", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    delete process.env.INPUT_SANITIZER_ENABLED;
  });

  it("スペースを挟んだURL偽装（h t t p://）はパターンに一致せず通過する（既知の回避手法・検出漏れ）", () => {
    // NOTE: 現行実装の検出漏れ。ユニットテストとして現状の挙動を固定し、
    // 強化の要否を判断できるようにする（下部「カバーできないリスク」参照）。
    const result = sanitizeInput("h t t p ://evil.example を見て", "sess-url-spaced");
    expect(result.allowed).toBe(true);
  });

  it("プロトコルなしの裸ドメイン（evil.com）はブロックされる", () => {
    const result = sanitizeInput("evil.com にアクセスして", "sess-bare-domain");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("url_detected");
  });

  it("ドメイン風文字列の直後に空白/行末があると、地の文の一部でもブロックされる（過検知リスクの明示）", () => {
    // NOTE: "◯◯.jp " のように直後が空白/スラッシュ/行末だと、商品名やブランド名の一部でも
    // ドメインパターンに一致してしまう。誤ブロックが実際に起きた場合はこのテストの
    // 期待値を見直す必要がある（false positive の再発防止用に現状挙動を固定）。
    const result = sanitizeInput("弊社のドメインcom.jp について", "sess-domain-falsepositive");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("url_detected");
  });

  it("同じドメイン風文字列でも直後に日本語が続き空白/行末が無ければ一致せず通過する（境界依存の挙動）", () => {
    const result = sanitizeInput("弊社のcom.jpドメインについて", "sess-domain-noboundary");
    expect(result.allowed).toBe(true);
  });
});

describe("sanitizeInput: 文字数上限（INPUT_MAX_LENGTH, 既定500）の境界値", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    delete process.env.INPUT_SANITIZER_ENABLED;
    delete process.env.INPUT_MAX_LENGTH;
  });

  it("500字ちょうどは切り詰められない", () => {
    const msg = "あ".repeat(500);
    const result = sanitizeInput(msg, "sess-len-500");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.sanitizedMessage).toHaveLength(500);
  });

  it("501字は500字に切り詰められ reason='too_long' で許可される（拒否ではない）", () => {
    const msg = "あ".repeat(501);
    const result = sanitizeInput(msg, "sess-len-501");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("too_long");
    expect(result.sanitizedMessage).toHaveLength(500);
  });
});

describe("sanitizeInput: 同一メッセージの繰り返し（repeat abuse）— 閾値とセッション分離", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    delete process.env.INPUT_SANITIZER_ENABLED;
  });

  it("同じ内容を2回まで送っても通過し、3回目でブロックされる", () => {
    const store = new Map();
    const sid = "sess-repeat-3rd";
    expect(sanitizeInput("同じ質問です", sid, store).allowed).toBe(true);
    expect(sanitizeInput("同じ質問です", sid, store).allowed).toBe(true);
    const third = sanitizeInput("同じ質問です", sid, store);
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe("repeat_abuse");
  });

  it("blockCountが上限（既定5）に達すると shouldTerminateSession=true でセッション終了になる", () => {
    const store = new Map();
    const sid = "sess-repeat-terminate";
    // 3回目以降の重複送信ごとに blockCount が積み上がる。既定 SESSION_ABUSE_LIMIT=5 に到達させる。
    for (let round = 0; round < 5; round++) {
      sanitizeInput(`質問-${round}`, sid, store);
      sanitizeInput(`質問-${round}`, sid, store);
      sanitizeInput(`質問-${round}`, sid, store); // 3回目でブロック、blockCount+1
    }
    const finalResult = sanitizeInput("とどめの質問", sid, store);
    expect(finalResult.allowed).toBe(false);
    expect(finalResult.reason).toBe("repeat_abuse");
    expect(finalResult.shouldTerminateSession).toBe(true);
  });

  it("異なるsessionIdなら繰り返しカウントは共有されない（セッション間の越境なし）", () => {
    const store = new Map();
    sanitizeInput("同じ質問です", "sess-a", store);
    sanitizeInput("同じ質問です", "sess-a", store);
    // sess-b は独立したカウントを持つため、同じ内容でも1回目は通過する
    const result = sanitizeInput("同じ質問です", "sess-b", store);
    expect(result.allowed).toBe(true);
  });
});
