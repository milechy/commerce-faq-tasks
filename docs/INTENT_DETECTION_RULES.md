# Intent Detection Rules (Phase15)

SalesFlow は Propose / Recommend / Close の各ステージに対して、
外部 YAML ルールから Intent を検出します。

YAML の実体は:

`config/salesIntentRules.yaml`

で管理されます。
（以前の `src/agent/sales/salesIntentRules.yaml` というパスは Phase14 の仮置きです）

---

## 1. YAML ファイル構造

`config/salesIntentRules.yaml` はステージごとに Intent ルールを定義します。

```yaml
propose:
  - intent: trial_lesson_offer
    name: "料金 → 体験レッスン"
    weight: 1.0
    patterns:
      any:
        - "料金"
        - "値段"
        - "金額"
        - "費用"
        - "プラン"
        - "体験レッスン"
        - "体験"
        - "まずは試したい"
        - "お試し"
        - "一回体験"
      require:
        # 任意。ここに指定したキーワードのいずれかが含まれていないと、このルールは無効になる
        - "料金"
        - "値段"

recommend:
  - intent: recommend_course_based_on_level
    name: "レベルに応じたコース提案"
    patterns:
      any:
        - "初心者"
        - "初めて"
        - "久しぶり"
        - "ブランク"
      require: []

close:
  - intent: close_trial_to_regular
    name: "体験 → 本申込クロージング"
    patterns:
      any:
        - "申し込み"
        - "入会"
        - "お願いしたい"
      require: []
```

- トップレベルキー: `propose` / `recommend` / `close`
- 各ステージは Intent ルールの配列を持ちます
- フィールド定義:

```yaml
- intent: string # システム内部で使う intent 名（例: trial_lesson_offer）
  name: string # 人間が読むためのラベル（任意）
  weight: number # マッチスコアに掛ける重み（任意 / 省略時は 1.0）
  patterns:
    any: string[] # 1 つ以上ヒットするとスコア加算されるキーワード群
    require: string[] # 1 つもヒットしない場合、このルールは不採用（OR 条件）
```

---

## 2. マッチングロジック

`src/agent/orchestrator/sales/salesIntentDetector.ts` で
YAML ルールを読み込み、以下のルールで Intent を決定します。

1. **検出テキストを構築**

   - 現ターンのユーザーメッセージ
   - 直近の会話履歴（最大 5 件）の `content`
   - 上記を改行区切りで連結し、小文字化

2. **各ステージごとにルール評価**

   - `patterns.require` が定義されている場合、そのいずれか 1 つ以上が含まれていないと、そのルールは不採用
   - `patterns.any` に含まれるキーワードのヒット数を数える
   - スコア = `hitCount × (weight ?? 1.0)`
   - スコア > 0 のルールのうち、**最もスコアの高いもの**をそのステージの Intent 候補とする

3. **最終的な Intent**

   ```ts
   export type DetectedSalesIntents = {
     proposeIntent?: ProposeIntent;
     recommendIntent?: RecommendIntent;
     closeIntent?: CloseIntent;
     detectionText: string;
   };
   ```

   - ルールにマッチしなかったステージは `undefined` となる。
   - `detectionText` は「ユーザーメッセージ + 直近履歴」を連結した文字列で、デバッグやログ出力に利用される。
   - YAML 自体が読み込めない場合は、従来のハードコード版ルール (`detectSalesIntentsLegacy`) に自動フォールバックし、その結果を SalesFlow オーケストレーション（`salesOrchestrator.ts` / `salesStageMachine.ts` / テンプレ選択ロジック）が利用する。

---

## 3. 現状カテゴリ例

代表的な Intent カテゴリ（例）:

- **料金・体験レッスン系**
  - `trial_lesson_offer`
  - `propose_monthly_plan_basic`
  - `propose_monthly_plan_standard`
- **コース/レベル相談系**
  - `recommend_course_based_on_level`
  - `recommend_course_for_beginner`
- **継続 / 解約 / 休会系**
  - `close_trial_to_regular`
  - `close_handle_objection_price`
  - など

テンプレートは `intent × personaTags → templateId` でマッピングされ、
Notion の TuningTemplates DB から同期されます。

Intent Rules を変更することで、**SalesFlow の分岐ロジックを
コード変更なしでチューニングできる**のがゴールです。

---

## 4. 運用とテスト

- YAML ファイルの配置:
  - 本番 / 開発ともに `config/salesIntentRules.yaml` を正とする
  - `SCRIPTS/setup_project_structure.sh` で初期化することで、環境ごとの差分漏れを防ぐ
- 単体テスト:
  - `src/agent/orchestrator/sales/salesIntentDetector.test.ts` で YAML ルール / legacy フォールバック / detectionText 組み立てをカバー
- 変更フロー（推奨）:
  1. `config/salesIntentRules.yaml` を編集
  2. ローカルでテストを実行して意図どおりに Intent が検出されることを確認
  3. 実運用の SalesLog（Intent / テンプレ利用状況）と合わせて挙動を観測し、必要に応じてルールを再調整する
