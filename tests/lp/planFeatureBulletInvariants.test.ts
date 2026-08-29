// tests/lp/planFeatureBulletInvariants.test.ts
//
// public/lp/index.html の料金表(プラン別箇条書き)と
// src/lib/billing/planFeatures.ts の FEATURE_MIN_PLAN を突合するテスト。
//
// 背景: PR #1058 で「詳しい分析レポート」の掲載プランを Growth → Standard へ
// 移したのは人手作業だった。LPの箇条書きと FEATURE_MIN_PLAN が一致していることを
// 強制する仕組みが無いため、今後ゲートを動かすたびに同じズレ(表記だけ先に進む/
// 実装だけ先に進む)が起き得る。
//
// 設計方針(tests/billing/planRankInvariants.test.ts と同じ手法を踏襲):
// FEATURE_MIN_PLAN は非exportのモジュール内constなので、import はできない。
// 代わりに実ファイルのソーステキストを直接読み込み、オブジェクトリテラルを
// 正規表現で抽出してパースする(admin-uiとの整合を見る既存テストと同じ作法)。
//
// 対応表(LPの人間向け文言 → GatedFeatureキー)はこのファイル内に置く。
// - LPの箇条書きは「ゲートの表示名」であり、GatedFeatureはコードの内部キー。
//   両者を繋ぐ対応関係そのものが新しい真実の源泉になるため、他ファイルに
//   切り出すよりテストの意図が一目で分かるここに置く方が良いと判断した
//   (このテスト以外から参照されないデータであり、共有の必要がない)。
// - LPの全箇条書きを網羅する必要はない。「専任サポート」「稼働率保証」
//   「カスタム開発対応」等、ゲート(GatedFeature)に対応しない項目は対象外。
// - voice_clone・pre_dispatch は FEATURE_MIN_PLAN には存在するが、料金表の
//   箇条書きに一字一句対応する文言が無い(内部フラグ・文脈依存の説明のみ)ため、
//   誤対応を避けてここでは対象外とする。
//
// 検証の考え方(LPの累積表記に注意):
// 料金表は「Standardの全機能」のように前段プランの機能を積み上げて表示するため、
// 例えば「成果（購入・予約）の計測」はGrowthのカードにのみ書かれ、Enterpriseの
// カードには(積み上げ表記のため)繰り返し書かれない。つまり、ある文言が
// 「初めて登場するプラン」がそのままLPが主張する最低プランである。
// これを機械的に求めるため、各プランのカード本文を切り出し、
//   1) 対応表の文言が「ちょうど1枚のカード」にのみ出現すること
//      (0枚 = LPから消えた/文言が変わった、2枚以上 = プランを跨いで重複しており
//      「どのプランに書いてあるか」を一意に決められない、いずれも即エラー)
//   2) その1枚のカードのプラン と FEATURE_MIN_PLAN[feature] が一致すること
// を assert する。FEATURE_MIN_PLAN 側の値をこの対応表に埋め込まない(=期待値を
// 両側で決め打ちしない)ことで、「LPをGrowthに書いたのにコードはstandard」
// のような食い違いを型チェックを通ったまま静かに緑にしない。

import fs from "fs";
import path from "path";

const LP_SRC = fs.readFileSync(
  path.resolve(__dirname, "../../public/lp/index.html"),
  "utf8",
);
const PLAN_FEATURES_SRC = fs.readFileSync(
  path.resolve(__dirname, "../../src/lib/billing/planFeatures.ts"),
  "utf8",
);

// tests/billing/planRankInvariants.test.ts と同じ抽出方式
// (`NAME: Record<...> = { ...obj literal... };` をJSONライクにパースする)。
function extractRecordLiteral(src: string, name: string): Record<string, string> {
  const re = new RegExp(`${name}\\s*:\\s*Record<[^>]+>\\s*=\\s*(\\{[\\s\\S]*?\\n\\});`);
  const match = src.match(re);
  if (!match) {
    throw new Error(`${name} のオブジェクトリテラルが見つからない: 抽出用正規表現の更新が必要`);
  }
  const jsonish = match[1]
    .replace(/\/\/.*$/gm, "")
    .replace(/(\w+)\s*:/g, '"$1":')
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(jsonish);
}

// 料金表(#pricing セクション)のプラン毎カードを切り出すための境界マーカー。
// public/lp/index.html 側に既にある `<!-- Free(広告表示) -->` 等のHTMLコメントを
// そのままアンカーとして使う(このコメント自体が変わったら「カード境界を機械的に
// 区別できない」ことになるため、その場合はこのテストがマーカー未検出で落ちる)。
const PLAN_CARD_MARKERS: ReadonlyArray<{ plan: string; marker: string }> = [
  { plan: "free_ad", marker: "<!-- Free(広告表示) -->" },
  { plan: "starter", marker: "<!-- Starter -->" },
  { plan: "standard", marker: "<!-- Standard -->" },
  { plan: "growth", marker: "<!-- Growth (featured) -->" },
  { plan: "enterprise", marker: "<!-- Enterprise -->" },
];
// 料金表セクション全体の終端(Enterpriseカードの直後にある注記段落の開始位置)。
// これが無いと最後のカード(Enterprise)の切り出し範囲が無限に伸び、
// セクション外の注記文言(例: 907行目付近の「R2Cエージェントによる各種設定代行」)を
// 誤って拾ってしまう。
const PRICING_SECTION_END_MARKER =
  '<p style="text-align:center; font-size:13px; color:var(--muted); margin-top:24px;';

/** プラン名 → そのプランのカード本文(次マーカーまたはセクション終端まで)。 */
function extractPlanCardSections(src: string): Record<string, string> {
  const positions = PLAN_CARD_MARKERS.map(({ plan, marker }) => {
    const idx = src.indexOf(marker);
    if (idx === -1) {
      throw new Error(
        `料金表のマーカーが見つからない: "${marker}" (LP構造が変わった場合はこのテストのマーカーも更新すること)`,
      );
    }
    return { plan, start: idx };
  });
  const endIdx = src.indexOf(PRICING_SECTION_END_MARKER);
  if (endIdx === -1) {
    throw new Error("料金表セクションの終端マーカーが見つからない");
  }

  const sections: Record<string, string> = {};
  positions.forEach(({ plan, start }, i) => {
    const end = i + 1 < positions.length ? positions[i + 1].start : endIdx;
    sections[plan] = src.slice(start, end);
  });
  return sections;
}

// LPの箇条書き文言 → GatedFeatureキー の対応表。
// 「対応するGatedFeatureが存在する箇条書きのみ」を載せる(冒頭コメント参照)。
const FEATURE_BULLETS: ReadonlyArray<{ feature: string; lpText: string }> = [
  { feature: "avatar", lpText: "AIアバター（既定アバター・顔・声）" },
  { feature: "analytics", lpText: "詳しい分析レポート" },
  { feature: "avatar_customize", lpText: "アバターのカスタム作成（自社の顔・声）" },
  { feature: "conversion", lpText: "成果（購入・予約）の計測" },
  { feature: "premium_avatar", lpText: "プレミアムアバター生成（従量オプション）" },
  { feature: "hide_branding", lpText: "「Powered by R2C」バッジの非表示" },
  { feature: "deep_research", lpText: "ディープリサーチ" },
  { feature: "sai_task", lpText: "R2Cエージェントによる設定代行" },
];

describe("LP料金表(public/lp/index.html)とFEATURE_MIN_PLANの整合性", () => {
  const planCards = extractPlanCardSections(LP_SRC);
  const featureMinPlan = extractRecordLiteral(PLAN_FEATURES_SRC, "FEATURE_MIN_PLAN");

  it.each(FEATURE_BULLETS)(
    "「$lpText」が初めて登場するプランとFEATURE_MIN_PLAN.$featureが一致する",
    ({ feature, lpText }) => {
      // LPの累積表記(Standardの全機能、のように前段を積み上げる)により、
      // この文言は「最低プランのカードにのみ」出現するはず。0枚/2枚以上は
      // いずれも「LPからどのプランの機能か一意に読み取れない」状態なので、
      // ここで検出してテストを落とす(片方向だけの比較にしない)。
      const plansContainingText = Object.entries(planCards)
        .filter(([, cardHtml]) => cardHtml.includes(lpText))
        .map(([plan]) => plan);

      if (plansContainingText.length !== 1) {
        throw new Error(
          `"${lpText}" が ${plansContainingText.length}枚のカードに出現した(期待:1枚)。` +
            `出現先: [${plansContainingText.join(", ")}]。文言が変わったか、複数プランに重複記載されている。`,
        );
      }

      const [lpMinPlan] = plansContainingText;
      // LP上「初めて登場したプラン」とコードのFEATURE_MIN_PLANが一致しない場合、
      // ここでの失敗メッセージ自体が「LPが${lpMinPlan}に置いているのにFEATURE_MIN_PLANは
      // ${featureMinPlan[feature]}」というズレの内容そのものになる。
      expect(featureMinPlan[feature]).toBe(lpMinPlan);
    },
  );

  it("対応表に載せた文言が、それぞれ想定より下位のプランのカードには一切出現しない", () => {
    // it.each 内の「ちょうど1枚」判定に加え、想定プラン未満のカードに
    // 部分的に出現していないかも明示的に確認する(累積表記の取り違え防止の二重check)。
    const planOrder = PLAN_CARD_MARKERS.map((m) => m.plan);

    for (const { feature, lpText } of FEATURE_BULLETS) {
      const minPlan = featureMinPlan[feature];
      const minPlanIndex = planOrder.indexOf(minPlan);
      if (minPlanIndex < 0) {
        throw new Error(`未知のプラン: ${minPlan} (feature=${feature})`);
      }

      const lowerPlans = planOrder.slice(0, minPlanIndex);
      for (const lowerPlan of lowerPlans) {
        if (planCards[lowerPlan].includes(lpText)) {
          throw new Error(
            `"${lpText}"は${feature}(min=${minPlan})の対象より下位の${lowerPlan}カードに出現している`,
          );
        }
      }
    }
  });
});
