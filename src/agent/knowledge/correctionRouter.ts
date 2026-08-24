// src/agent/knowledge/correctionRouter.ts
// 「この回答は間違っている」という店主の指摘を、知識(事実)と指示ルール(方針)の
// どちらに着地させるかを決める純関数。DB・ネットワーク・LLM に触れない。
//
// なぜ独立したファイルか:
//   actionExecutor.ts の case 内に書くと境界条件のテストが書けない。
//   3層の役割分担(CLAUDE.md「指示ルールの不変ルール」)を守る要になるため、
//   分類ロジックだけを切り出して網羅的なテストを隣に置く。
//
// なぜ2箇所目を作らないか:
//   同じ指摘がチャット経由と旧UI経由で違う層に着地すると、
//   事実がルール層に溜まり「なぜこの回答になるのか」を誰も辿れなくなる。
//   着地層の判定はここが唯一の実装。
//
// 設計の前提(CLAUDE.md 禁止3):
//   フローの分岐を LLM の応答文の文字列一致で作らない。
//   この関数は決定的なシグナルだけで判定し、LLM を使う場合も
//   呼び出し側が構造化した結果を signals として渡す。
//
// 迷ったら知識(事実)に倒す(要件定義 v1.3 決定 D5):
//   ルール層に事実が溜まる方が回復不能。知識に入れた事実が方針だった場合は
//   後からルールを足せば済むが、逆は「知識は誤ったまま、ルールだけが増える」。

/** 着地先の層。approved_responses(文体)は本関数の対象外。 */
export type CorrectionLayer = "knowledge" | "rule";

export interface CorrectionInput {
  /** エンドユーザーの元の質問。 */
  question: string;
  /** AIが返した誤答。 */
  answer: string;
  /** 店主の指摘文。 */
  correction: string;
}

export interface CorrectionRoute {
  layer: CorrectionLayer;
  /** なぜその層にしたか。店主に見せる文ではなく、監査とテストのための根拠。 */
  reason: string;
  /** 判定に使ったシグナル。デバッグと「なぜこうなったか」の説明に使う。 */
  signals: { fact: string[]; policy: string[] };
  /**
   * rule 層に着地する場合、発火条件(trigger)を別途決める必要がある。
   * 空の trigger で保存すると「保存は成功し、永久に発火しない」最悪の失敗形になる
   * (要件定義 v1.3 の既知の破れ)。呼び出し側は必ず trigger を確定させること。
   */
  requiresTrigger: boolean;
}

// ── 事実のシグナル ────────────────────────────────────────────────
// 具体的な値(数量・期間・金額・時刻・日付)を含む指摘は事実の訂正とみなす。
const FACT_PATTERNS: Array<[RegExp, string]> = [
  [/\d+\s*(年|ヶ月|か月|カ月|ヵ月|month|year)/i, "期間"],
  [/\d+\s*(円|ドル|dollars?|yen|%|％)/i, "金額・割合"],
  [/\d+\s*(時|分|日|時間|営業日|weeks?|days?)/i, "時間・日数"],
  [/\d{1,2}\s*[:：]\s*\d{2}/, "時刻"],
  [/\d{4}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*日/, "日付"],
  [/(正しく|本当|実際)(は|には)/, "訂正の言い回し"],
  [/(ではなく|じゃなく|ではありません|違います|間違い|誤り)/, "否定による訂正"],
];

// ── 方針のシグナル ────────────────────────────────────────────────
// 「どう振る舞ってほしいか」を述べる指摘は方針とみなす。
const POLICY_PATTERNS: Array<[RegExp, string]> = [
  [/(もっと|もう少し|なるべく|できるだけ)/, "程度の指示"],
  [/(丁寧|フレンドリー|カジュアル|敬語|口調|トーン|言い方|言い回し)/, "口調の指示"],
  [/(避けて|触れないで|言わないで|出さないで|しないで|禁止)/, "禁止の指示"],
  [/(必ず|いつも|毎回|常に)\s*[^。]{0,20}(して|伝えて|案内|触れて|勧めて)/, "常時の振る舞い"],
  [/(聞かれたら|質問されたら|話が出たら|ときは|場合は)/, "条件つきの振る舞い"],
  [/(優先|先に|後で)\s*[^。]{0,10}(して|案内|紹介)/, "順序の指示"],
];

// 全角英数・半角カナ等を畳む。triggerMatching.ts が同じ理由で NFKC を使っており、
// 「２年」と「2年」で判定が割れないようにする(表記ゆれで不発、が最も気づきにくい)。
function normalize(s: string): string {
  return s.normalize("NFKC");
}

function collect(text: string, patterns: Array<[RegExp, string]>): string[] {
  const hits: string[] = [];
  for (const [re, label] of patterns) {
    if (re.test(text)) hits.push(label);
  }
  return hits;
}

/**
 * 指摘の着地層を決める。
 *
 * 判定は指摘文(correction)を主に見る。元の質問と誤答は、
 * 指摘が短い場合(「2年です」等)に文脈を補うためだけに使う。
 */
export function routeCorrection(input: CorrectionInput): CorrectionRoute {
  const correction = (input.correction ?? "").trim();

  // 空の指摘は判定材料が無い。D5 に従い知識へ倒す(呼び出し側が内容を確定させる)。
  if (correction === "") {
    return {
      layer: "knowledge",
      reason: "指摘の内容が空のため、事実の訂正として扱う（D5: 迷ったら知識）",
      signals: { fact: [], policy: [] },
      requiresTrigger: false,
    };
  }

  const normalized = normalize(correction);
  const fact = collect(normalized, FACT_PATTERNS);
  const policy = collect(normalized, POLICY_PATTERNS);

  // 方針のシグナルだけがある場合のみルール層へ。
  // 両方ある場合(「保証は2年なので、聞かれたらそう答えて」)は事実を含むため知識へ倒す。
  if (policy.length > 0 && fact.length === 0) {
    return {
      layer: "rule",
      reason: `振る舞いの指示のみで具体的な値を含まないため、方針として扱う（${policy.join("・")}）`,
      signals: { fact, policy },
      requiresTrigger: true,
    };
  }

  const reason =
    fact.length > 0 && policy.length > 0
      ? `具体的な値と振る舞いの指示が混在するため、事実を優先して知識へ（${fact.join("・")}）`
      : fact.length > 0
        ? `具体的な値を含むため、事実の訂正として扱う（${fact.join("・")}）`
        : "事実とも方針とも判断できないため、知識として扱う（D5: 迷ったら知識）";

  return { layer: "knowledge", reason, signals: { fact, policy }, requiresTrigger: false };
}
