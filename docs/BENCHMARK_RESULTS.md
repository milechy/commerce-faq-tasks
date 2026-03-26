# RAJIUCE ベンチマーク結果

最終更新: 2026-03-26

## テストセット
- 会話数: 30件
- 難易度: easy 9件, medium 15件, hard 6件
- データソース: 合成データ（carnation実会話マスキング済み）

## 評価指標
| 指標 | 説明 |
|---|---|
| 成功率 | expected_outcomeと実際のoutcomeの一致率 |
| アポ率 | appointment outcomeに至った割合 |
| 失注率 | lost outcomeの割合 |
| Judge平均 | conversation_evaluations.score の平均（0-100） |
| トークン | LLM呼び出し推定総トークン数 |

## 結果サマリ（実行待ち）

| 条件 | 成功率 | アポ率 | 失注率 | Judge平均 | トークン |
|---|---|---|---|---|---|
| (A) ベースライン | - | - | - | - | - |
| (B) 心理学RAG | - | - | - | - | - |
| (C) Judge付き | - | - | - | - | - |
| (D) 全機能ON | - | - | - | - | - |

*注: 条件(D)はOpenClaw統合後に更新予定*

## 詳細結果

### (A) ベースライン
（実行後に自動追記）

### (B) 心理学RAGあり
（実行後に自動追記）

### (C) Judgeループあり
（実行後に自動追記）

### (D) 全機能ON
（実行後に自動追記）

---
## 条件(A) 実行結果 — 2026-03-26

| 指標 | 値 |
|---|---|
| 成功率 | 70.0% (21/30) |
| アポ率 | 50.0% |
| 失注率 | 0.0% |
| Judge平均スコア | 57 |
| 推定総トークン | 483 |

### 難易度別成功率
  - easy: 6/9 (66.7%)
  - medium: 10/14 (71.4%)
  - hard: 5/7 (71.4%)

### 詳細（条件A）
| ID | シナリオ | 難易度 | 期待結果 | 実際のステージ | Judgeスコア | 判定 |
|---|---|---|---|---|---|---|
| conv_001 | 在庫確認 — シンプルな問い合わせ | easy | replied | clarify | 50 | OK |
| conv_002 | 基本スペック質問 — 燃費確認 | easy | replied | clarify → recommend | 60 | NG |
| conv_003 | 問い合わせ — 試乗の申し込み | easy | appointment | clarify | 50 | NG |
| conv_004 | シンプルな新車問い合わせ | easy | replied | clarify | 50 | OK |
| conv_005 | 中古車 — 走行距離確認 | easy | replied | clarify | 50 | OK |
| conv_006 | 保証内容の確認 | easy | replied | clarify → propose → recommend | 70 | NG |
| conv_007 | カラーバリエーション確認 | easy | replied | clarify | 50 | OK |
| conv_008 | オプション装備の質問 | easy | replied | clarify | 50 | OK |
| conv_009 | 納期確認 | easy | replied | clarify | 50 | OK |
| conv_010 | 価格交渉 — 他社比較あり | medium | appointment | clarify → propose → recommend | 70 | OK |
| conv_011 | ローン相談 — 月々の支払い重視 | medium | appointment | clarify → recommend | 60 | OK |
| conv_012 | 下取り交渉 — 査定額への不満 | medium | appointment | clarify | 50 | NG |
| conv_013 | 即決促し — 期間限定キャンペーン | medium | appointment | clarify → close | 60 | OK |
| conv_014 | 中古車 — 年式と価格のバランス | medium | appointment | propose → clarify | 60 | OK |
| conv_015 | 商談 — 複数車種の比較検討 | medium | appointment | clarify → propose | 60 | OK |
| conv_016 | 法人購入 — 経費処理の相談 | medium | appointment | clarify → close | 60 | OK |
| conv_017 | EVの購入検討 — 補助金確認 | medium | appointment | clarify → propose | 60 | OK |
| conv_018 | 下取りなし — 新車乗り換え | medium | appointment | clarify → propose → recommend | 70 | OK |
| conv_019 | 輸入車 — 維持費の懸念 | medium | appointment | recommend → clarify | 60 | OK |
| conv_020 | ファミリーカー — 安全性重視 | medium | appointment | clarify → propose | 60 | OK |
| conv_021 | 値引き交渉 — 強硬姿勢 | medium | appointment | clarify | 50 | NG |
| conv_022 | リピーター — 信頼関係あり | medium | appointment | clarify | 50 | NG |
| conv_023 | オンライン問い合わせ — 来店誘導 | medium | appointment | clarify | 50 | NG |
| conv_024 | 強い拒絶後の巻き返し — 予算不足 | hard | appointment | propose → clarify | 60 | OK |
| conv_025 | 複合反論 — 価格+他社+必要性 | hard | appointment | clarify → recommend | 60 | OK |
| conv_026 | 決断保留の長期化 — 配偶者の説得が必要 | hard | appointment | recommend → clarify | 60 | OK |
| conv_027 | 強い拒絶 — 過去のトラブル経験 | hard | appointment | clarify | 50 | NG |
| conv_028 | 複合反論 — 電気自動車への根強い懸念 | hard | appointment | clarify | 50 | NG |
| conv_029 | 長期保留 — 買い替えタイミングの迷い | hard | appointment | recommend → clarify | 60 | OK |
| conv_030 | 強い拒絶後の巻き返し — 競合での成約寸 | hard | appointment | close → clarify | 60 | OK |

---
## 条件(A) 実行結果 — 2026-03-26

| 指標 | 値 |
|---|---|
| 成功率 | 70.0% (21/30) |
| アポ率 | 50.0% |
| 失注率 | 0.0% |
| Judge平均スコア | 57 |
| 推定総トークン | 483 |

### 難易度別成功率
  - easy: 6/9 (66.7%)
  - medium: 11/15 (73.3%)
  - hard: 4/6 (66.7%)

### 詳細（条件A）
| ID | シナリオ | 難易度 | 期待結果 | 実際のステージ | Judgeスコア | 判定 |
|---|---|---|---|---|---|---|
| conv_001 | 在庫確認 — シンプルな問い合わせ | easy | replied | clarify | 50 | OK |
| conv_002 | 基本スペック質問 — 燃費確認 | easy | replied | clarify → recommend | 60 | NG |
| conv_003 | 問い合わせ — 試乗の申し込み | easy | appointment | clarify | 50 | NG |
| conv_004 | シンプルな新車問い合わせ | easy | replied | clarify | 50 | OK |
| conv_005 | 中古車 — 走行距離確認 | easy | replied | clarify | 50 | OK |
| conv_006 | 保証内容の確認 | easy | replied | clarify → propose → recommend | 70 | NG |
| conv_007 | カラーバリエーション確認 | easy | replied | clarify | 50 | OK |
| conv_008 | オプション装備の質問 | easy | replied | clarify | 50 | OK |
| conv_009 | 納期確認 | easy | replied | clarify | 50 | OK |
| conv_010 | 価格交渉 — 他社比較あり | medium | appointment | clarify → propose → recommend | 70 | OK |
| conv_011 | ローン相談 — 月々の支払い重視 | medium | appointment | clarify → recommend | 60 | OK |
| conv_012 | 下取り交渉 — 査定額への不満 | medium | appointment | clarify | 50 | NG |
| conv_013 | 即決促し — 期間限定キャンペーン | medium | appointment | clarify → close | 60 | OK |
| conv_014 | 中古車 — 年式と価格のバランス | medium | appointment | propose → clarify | 60 | OK |
| conv_015 | 商談 — 複数車種の比較検討 | medium | appointment | clarify → propose | 60 | OK |
| conv_016 | 法人購入 — 経費処理の相談 | medium | appointment | clarify → close | 60 | OK |
| conv_017 | EVの購入検討 — 補助金確認 | medium | appointment | clarify → propose | 60 | OK |
| conv_018 | 下取りなし — 新車乗り換え | medium | appointment | clarify → propose → recommend | 70 | OK |
| conv_019 | 輸入車 — 維持費の懸念 | medium | appointment | recommend → clarify | 60 | OK |
| conv_020 | ファミリーカー — 安全性重視 | medium | appointment | clarify → propose | 60 | OK |
| conv_021 | 値引き交渉 — 強硬姿勢 | medium | appointment | clarify | 50 | NG |
| conv_022 | リピーター — 信頼関係あり | medium | appointment | clarify | 50 | NG |
| conv_023 | オンライン問い合わせ — 来店誘導 | medium | appointment | clarify | 50 | NG |
| conv_024 | 強い拒絶後の巻き返し — 予算不足 | medium | appointment | propose → clarify | 60 | OK |
| conv_025 | 複合反論 — 価格+他社+必要性 | hard | appointment | clarify → recommend | 60 | OK |
| conv_026 | 決断保留の長期化 — 配偶者の説得が必要 | hard | appointment | recommend → clarify | 60 | OK |
| conv_027 | 強い拒絶 — 過去のトラブル経験 | hard | appointment | clarify | 50 | NG |
| conv_028 | 複合反論 — 電気自動車への根強い懸念 | hard | appointment | clarify | 50 | NG |
| conv_029 | 長期保留 — 買い替えタイミングの迷い | hard | appointment | recommend → clarify | 60 | OK |
| conv_030 | 強い拒絶後の巻き返し — 競合での成約寸 | hard | appointment | close → clarify | 60 | OK |

---
## 条件(A) 実行結果 — 2026-03-26

| 指標 | 値 |
|---|---|
| 成功率 | 70.0% (21/30) |
| アポ率 | 50.0% |
| 失注率 | 0.0% |
| Judge平均スコア | 57 |
| 推定総トークン | 483 |

### 難易度別成功率
  - easy: 6/9 (66.7%)
  - medium: 11/15 (73.3%)
  - hard: 4/6 (66.7%)

### 詳細（条件A）
| ID | シナリオ | 難易度 | 期待結果 | 実際のステージ | Judgeスコア | 判定 |
|---|---|---|---|---|---|---|
| conv_001 | 在庫確認 — シンプルな問い合わせ | easy | replied | clarify | 50 | OK |
| conv_002 | 基本スペック質問 — 燃費確認 | easy | replied | clarify → recommend | 60 | NG |
| conv_003 | 問い合わせ — 試乗の申し込み | easy | appointment | clarify | 50 | NG |
| conv_004 | シンプルな新車問い合わせ | easy | replied | clarify | 50 | OK |
| conv_005 | 中古車 — 走行距離確認 | easy | replied | clarify | 50 | OK |
| conv_006 | 保証内容の確認 | easy | replied | clarify → propose → recommend | 70 | NG |
| conv_007 | カラーバリエーション確認 | easy | replied | clarify | 50 | OK |
| conv_008 | オプション装備の質問 | easy | replied | clarify | 50 | OK |
| conv_009 | 納期確認 | easy | replied | clarify | 50 | OK |
| conv_010 | 価格交渉 — 他社比較あり | medium | appointment | clarify → propose → recommend | 70 | OK |
| conv_011 | ローン相談 — 月々の支払い重視 | medium | appointment | clarify → recommend | 60 | OK |
| conv_012 | 下取り交渉 — 査定額への不満 | medium | appointment | clarify | 50 | NG |
| conv_013 | 即決促し — 期間限定キャンペーン | medium | appointment | clarify → close | 60 | OK |
| conv_014 | 中古車 — 年式と価格のバランス | medium | appointment | propose → clarify | 60 | OK |
| conv_015 | 商談 — 複数車種の比較検討 | medium | appointment | clarify → propose | 60 | OK |
| conv_016 | 法人購入 — 経費処理の相談 | medium | appointment | clarify → close | 60 | OK |
| conv_017 | EVの購入検討 — 補助金確認 | medium | appointment | clarify → propose | 60 | OK |
| conv_018 | 下取りなし — 新車乗り換え | medium | appointment | clarify → propose → recommend | 70 | OK |
| conv_019 | 輸入車 — 維持費の懸念 | medium | appointment | recommend → clarify | 60 | OK |
| conv_020 | ファミリーカー — 安全性重視 | medium | appointment | clarify → propose | 60 | OK |
| conv_021 | 値引き交渉 — 強硬姿勢 | medium | appointment | clarify | 50 | NG |
| conv_022 | リピーター — 信頼関係あり | medium | appointment | clarify | 50 | NG |
| conv_023 | オンライン問い合わせ — 来店誘導 | medium | appointment | clarify | 50 | NG |
| conv_024 | 強い拒絶後の巻き返し — 予算不足 | medium | appointment | propose → clarify | 60 | OK |
| conv_025 | 複合反論 — 価格+他社+必要性 | hard | appointment | clarify → recommend | 60 | OK |
| conv_026 | 決断保留の長期化 — 配偶者の説得が必要 | hard | appointment | recommend → clarify | 60 | OK |
| conv_027 | 強い拒絶 — 過去のトラブル経験 | hard | appointment | clarify | 50 | NG |
| conv_028 | 複合反論 — 電気自動車への根強い懸念 | hard | appointment | clarify | 50 | NG |
| conv_029 | 長期保留 — 買い替えタイミングの迷い | hard | appointment | recommend → clarify | 60 | OK |
| conv_030 | 強い拒絶後の巻き返し — 競合での成約寸 | hard | appointment | close → clarify | 60 | OK |

---
## 条件(B) 実行結果 — 2026-03-26

| 指標 | 値 |
|---|---|
| 成功率 | 70.0% (21/30) |
| アポ率 | 50.0% |
| 失注率 | 0.0% |
| Judge平均スコア | 66 |
| 推定総トークン | 483 |

### 難易度別成功率
  - easy: 6/9 (66.7%)
  - medium: 11/15 (73.3%)
  - hard: 4/6 (66.7%)

### 詳細（条件B）
| ID | シナリオ | 難易度 | 期待結果 | 実際のステージ | Judgeスコア | 判定 |
|---|---|---|---|---|---|---|
| conv_001 | 在庫確認 — シンプルな問い合わせ | easy | replied | clarify | 50 | OK |
| conv_002 | 基本スペック質問 — 燃費確認 | easy | replied | clarify → recommend | 60 | NG |
| conv_003 | 問い合わせ — 試乗の申し込み | easy | appointment | clarify | 55 | NG |
| conv_004 | シンプルな新車問い合わせ | easy | replied | clarify | 50 | OK |
| conv_005 | 中古車 — 走行距離確認 | easy | replied | clarify | 50 | OK |
| conv_006 | 保証内容の確認 | easy | replied | clarify → propose → recommend | 75 | NG |
| conv_007 | カラーバリエーション確認 | easy | replied | clarify | 55 | OK |
| conv_008 | オプション装備の質問 | easy | replied | clarify | 50 | OK |
| conv_009 | 納期確認 | easy | replied | clarify | 55 | OK |
| conv_010 | 価格交渉 — 他社比較あり | medium | appointment | clarify → propose → recommend | 80 | OK |
| conv_011 | ローン相談 — 月々の支払い重視 | medium | appointment | clarify → recommend | 70 | OK |
| conv_012 | 下取り交渉 — 査定額への不満 | medium | appointment | clarify | 60 | NG |
| conv_013 | 即決促し — 期間限定キャンペーン | medium | appointment | clarify → close | 70 | OK |
| conv_014 | 中古車 — 年式と価格のバランス | medium | appointment | propose → clarify | 70 | OK |
| conv_015 | 商談 — 複数車種の比較検討 | medium | appointment | clarify → propose | 70 | OK |
| conv_016 | 法人購入 — 経費処理の相談 | medium | appointment | clarify → close | 70 | OK |
| conv_017 | EVの購入検討 — 補助金確認 | medium | appointment | clarify → propose | 70 | OK |
| conv_018 | 下取りなし — 新車乗り換え | medium | appointment | clarify → propose → recommend | 80 | OK |
| conv_019 | 輸入車 — 維持費の懸念 | medium | appointment | recommend → clarify | 70 | OK |
| conv_020 | ファミリーカー — 安全性重視 | medium | appointment | clarify → propose | 70 | OK |
| conv_021 | 値引き交渉 — 強硬姿勢 | medium | appointment | clarify | 60 | NG |
| conv_022 | リピーター — 信頼関係あり | medium | appointment | clarify | 60 | NG |
| conv_023 | オンライン問い合わせ — 来店誘導 | medium | appointment | clarify | 60 | NG |
| conv_024 | 強い拒絶後の巻き返し — 予算不足 | medium | appointment | propose → clarify | 75 | OK |
| conv_025 | 複合反論 — 価格+他社+必要性 | hard | appointment | clarify → recommend | 80 | OK |
| conv_026 | 決断保留の長期化 — 配偶者の説得が必要 | hard | appointment | recommend → clarify | 75 | OK |
| conv_027 | 強い拒絶 — 過去のトラブル経験 | hard | appointment | clarify | 65 | NG |
| conv_028 | 複合反論 — 電気自動車への根強い懸念 | hard | appointment | clarify | 65 | NG |
| conv_029 | 長期保留 — 買い替えタイミングの迷い | hard | appointment | recommend → clarify | 75 | OK |
| conv_030 | 強い拒絶後の巻き返し — 競合での成約寸 | hard | appointment | close → clarify | 80 | OK |

---
## 条件(BPRIME) 実行結果 — 2026-03-26

| 指標 | 値 |
|---|---|
| 成功率 | 70.0% (21/30) |
| アポ率 | 50.0% |
| 失注率 | 0.0% |
| Judge平均スコア | 66 |
| 推定総トークン | 483 |
| OpenViking RAG平均コンテキスト文字数 | 367文字 |

### 難易度別成功率
  - easy: 6/9 (66.7%)
  - medium: 11/15 (73.3%)
  - hard: 4/6 (66.7%)

### 詳細（条件BPRIME）
| ID | シナリオ | 難易度 | 期待結果 | 実際のステージ | Judgeスコア | 判定 |
|---|---|---|---|---|---|---|
| conv_001 | 在庫確認 — シンプルな問い合わせ | easy | replied | clarify | 50 | OK |
| conv_002 | 基本スペック質問 — 燃費確認 | easy | replied | clarify → recommend | 60 | NG |
| conv_003 | 問い合わせ — 試乗の申し込み | easy | appointment | clarify | 55 | NG |
| conv_004 | シンプルな新車問い合わせ | easy | replied | clarify | 50 | OK |
| conv_005 | 中古車 — 走行距離確認 | easy | replied | clarify | 50 | OK |
| conv_006 | 保証内容の確認 | easy | replied | clarify → propose → recommend | 75 | NG |
| conv_007 | カラーバリエーション確認 | easy | replied | clarify | 55 | OK |
| conv_008 | オプション装備の質問 | easy | replied | clarify | 50 | OK |
| conv_009 | 納期確認 | easy | replied | clarify | 55 | OK |
| conv_010 | 価格交渉 — 他社比較あり | medium | appointment | clarify → propose → recommend | 80 | OK |
| conv_011 | ローン相談 — 月々の支払い重視 | medium | appointment | clarify → recommend | 70 | OK |
| conv_012 | 下取り交渉 — 査定額への不満 | medium | appointment | clarify | 60 | NG |
| conv_013 | 即決促し — 期間限定キャンペーン | medium | appointment | clarify → close | 70 | OK |
| conv_014 | 中古車 — 年式と価格のバランス | medium | appointment | propose → clarify | 70 | OK |
| conv_015 | 商談 — 複数車種の比較検討 | medium | appointment | clarify → propose | 70 | OK |
| conv_016 | 法人購入 — 経費処理の相談 | medium | appointment | clarify → close | 70 | OK |
| conv_017 | EVの購入検討 — 補助金確認 | medium | appointment | clarify → propose | 70 | OK |
| conv_018 | 下取りなし — 新車乗り換え | medium | appointment | clarify → propose → recommend | 80 | OK |
| conv_019 | 輸入車 — 維持費の懸念 | medium | appointment | recommend → clarify | 70 | OK |
| conv_020 | ファミリーカー — 安全性重視 | medium | appointment | clarify → propose | 70 | OK |
| conv_021 | 値引き交渉 — 強硬姿勢 | medium | appointment | clarify | 60 | NG |
| conv_022 | リピーター — 信頼関係あり | medium | appointment | clarify | 60 | NG |
| conv_023 | オンライン問い合わせ — 来店誘導 | medium | appointment | clarify | 60 | NG |
| conv_024 | 強い拒絶後の巻き返し — 予算不足 | medium | appointment | propose → clarify | 75 | OK |
| conv_025 | 複合反論 — 価格+他社+必要性 | hard | appointment | clarify → recommend | 80 | OK |
| conv_026 | 決断保留の長期化 — 配偶者の説得が必要 | hard | appointment | recommend → clarify | 75 | OK |
| conv_027 | 強い拒絶 — 過去のトラブル経験 | hard | appointment | clarify | 65 | NG |
| conv_028 | 複合反論 — 電気自動車への根強い懸念 | hard | appointment | clarify | 65 | NG |
| conv_029 | 長期保留 — 買い替えタイミングの迷い | hard | appointment | recommend → clarify | 75 | OK |
| conv_030 | 強い拒絶後の巻き返し — 競合での成約寸 | hard | appointment | close → clarify | 80 | OK |

---
## 条件(C) 実行結果 — 2026-03-26

| 指標 | 値 |
|---|---|
| 成功率 | 70.0% (21/30) |
| アポ率 | 50.0% |
| 失注率 | 0.0% |
| Judge平均スコア | 66 |
| 推定総トークン | 483 |

### 難易度別成功率
  - easy: 6/9 (66.7%)
  - medium: 11/15 (73.3%)
  - hard: 4/6 (66.7%)

### 詳細（条件C）
| ID | シナリオ | 難易度 | 期待結果 | 実際のステージ | Judgeスコア | 判定 |
|---|---|---|---|---|---|---|
| conv_001 | 在庫確認 — シンプルな問い合わせ | easy | replied | clarify | 50 | OK |
| conv_002 | 基本スペック質問 — 燃費確認 | easy | replied | clarify → recommend | 60 | NG |
| conv_003 | 問い合わせ — 試乗の申し込み | easy | appointment | clarify | 55 | NG |
| conv_004 | シンプルな新車問い合わせ | easy | replied | clarify | 50 | OK |
| conv_005 | 中古車 — 走行距離確認 | easy | replied | clarify | 50 | OK |
| conv_006 | 保証内容の確認 | easy | replied | clarify → propose → recommend | 75 | NG |
| conv_007 | カラーバリエーション確認 | easy | replied | clarify | 55 | OK |
| conv_008 | オプション装備の質問 | easy | replied | clarify | 50 | OK |
| conv_009 | 納期確認 | easy | replied | clarify | 55 | OK |
| conv_010 | 価格交渉 — 他社比較あり | medium | appointment | clarify → propose → recommend | 80 | OK |
| conv_011 | ローン相談 — 月々の支払い重視 | medium | appointment | clarify → recommend | 70 | OK |
| conv_012 | 下取り交渉 — 査定額への不満 | medium | appointment | clarify | 60 | NG |
| conv_013 | 即決促し — 期間限定キャンペーン | medium | appointment | clarify → close | 70 | OK |
| conv_014 | 中古車 — 年式と価格のバランス | medium | appointment | propose → clarify | 70 | OK |
| conv_015 | 商談 — 複数車種の比較検討 | medium | appointment | clarify → propose | 70 | OK |
| conv_016 | 法人購入 — 経費処理の相談 | medium | appointment | clarify → close | 70 | OK |
| conv_017 | EVの購入検討 — 補助金確認 | medium | appointment | clarify → propose | 70 | OK |
| conv_018 | 下取りなし — 新車乗り換え | medium | appointment | clarify → propose → recommend | 80 | OK |
| conv_019 | 輸入車 — 維持費の懸念 | medium | appointment | recommend → clarify | 70 | OK |
| conv_020 | ファミリーカー — 安全性重視 | medium | appointment | clarify → propose | 70 | OK |
| conv_021 | 値引き交渉 — 強硬姿勢 | medium | appointment | clarify | 60 | NG |
| conv_022 | リピーター — 信頼関係あり | medium | appointment | clarify | 60 | NG |
| conv_023 | オンライン問い合わせ — 来店誘導 | medium | appointment | clarify | 60 | NG |
| conv_024 | 強い拒絶後の巻き返し — 予算不足 | medium | appointment | propose → clarify | 75 | OK |
| conv_025 | 複合反論 — 価格+他社+必要性 | hard | appointment | clarify → recommend | 80 | OK |
| conv_026 | 決断保留の長期化 — 配偶者の説得が必要 | hard | appointment | recommend → clarify | 75 | OK |
| conv_027 | 強い拒絶 — 過去のトラブル経験 | hard | appointment | clarify | 65 | NG |
| conv_028 | 複合反論 — 電気自動車への根強い懸念 | hard | appointment | clarify | 65 | NG |
| conv_029 | 長期保留 — 買い替えタイミングの迷い | hard | appointment | recommend → clarify | 75 | OK |
| conv_030 | 強い拒絶後の巻き返し — 競合での成約寸 | hard | appointment | close → clarify | 80 | OK |

---
## 条件(D) 実行結果 — 2026-03-26

| 指標 | 値 |
|---|---|
| 成功率 | 70.0% (21/30) |
| アポ率 | 50.0% |
| 失注率 | 0.0% |
| Judge平均スコア | 66 |
| 推定総トークン | 483 |

### 難易度別成功率
  - easy: 6/9 (66.7%)
  - medium: 11/15 (73.3%)
  - hard: 4/6 (66.7%)

### 詳細（条件D）
| ID | シナリオ | 難易度 | 期待結果 | 実際のステージ | Judgeスコア | 判定 |
|---|---|---|---|---|---|---|
| conv_001 | 在庫確認 — シンプルな問い合わせ | easy | replied | clarify | 50 | OK |
| conv_002 | 基本スペック質問 — 燃費確認 | easy | replied | clarify → recommend | 60 | NG |
| conv_003 | 問い合わせ — 試乗の申し込み | easy | appointment | clarify | 55 | NG |
| conv_004 | シンプルな新車問い合わせ | easy | replied | clarify | 50 | OK |
| conv_005 | 中古車 — 走行距離確認 | easy | replied | clarify | 50 | OK |
| conv_006 | 保証内容の確認 | easy | replied | clarify → propose → recommend | 75 | NG |
| conv_007 | カラーバリエーション確認 | easy | replied | clarify | 55 | OK |
| conv_008 | オプション装備の質問 | easy | replied | clarify | 50 | OK |
| conv_009 | 納期確認 | easy | replied | clarify | 55 | OK |
| conv_010 | 価格交渉 — 他社比較あり | medium | appointment | clarify → propose → recommend | 80 | OK |
| conv_011 | ローン相談 — 月々の支払い重視 | medium | appointment | clarify → recommend | 70 | OK |
| conv_012 | 下取り交渉 — 査定額への不満 | medium | appointment | clarify | 60 | NG |
| conv_013 | 即決促し — 期間限定キャンペーン | medium | appointment | clarify → close | 70 | OK |
| conv_014 | 中古車 — 年式と価格のバランス | medium | appointment | propose → clarify | 70 | OK |
| conv_015 | 商談 — 複数車種の比較検討 | medium | appointment | clarify → propose | 70 | OK |
| conv_016 | 法人購入 — 経費処理の相談 | medium | appointment | clarify → close | 70 | OK |
| conv_017 | EVの購入検討 — 補助金確認 | medium | appointment | clarify → propose | 70 | OK |
| conv_018 | 下取りなし — 新車乗り換え | medium | appointment | clarify → propose → recommend | 80 | OK |
| conv_019 | 輸入車 — 維持費の懸念 | medium | appointment | recommend → clarify | 70 | OK |
| conv_020 | ファミリーカー — 安全性重視 | medium | appointment | clarify → propose | 70 | OK |
| conv_021 | 値引き交渉 — 強硬姿勢 | medium | appointment | clarify | 60 | NG |
| conv_022 | リピーター — 信頼関係あり | medium | appointment | clarify | 60 | NG |
| conv_023 | オンライン問い合わせ — 来店誘導 | medium | appointment | clarify | 60 | NG |
| conv_024 | 強い拒絶後の巻き返し — 予算不足 | medium | appointment | propose → clarify | 75 | OK |
| conv_025 | 複合反論 — 価格+他社+必要性 | hard | appointment | clarify → recommend | 80 | OK |
| conv_026 | 決断保留の長期化 — 配偶者の説得が必要 | hard | appointment | recommend → clarify | 75 | OK |
| conv_027 | 強い拒絶 — 過去のトラブル経験 | hard | appointment | clarify | 65 | NG |
| conv_028 | 複合反論 — 電気自動車への根強い懸念 | hard | appointment | clarify | 65 | NG |
| conv_029 | 長期保留 — 買い替えタイミングの迷い | hard | appointment | recommend → clarify | 75 | OK |
| conv_030 | 強い拒絶後の巻き返し — 競合での成約寸 | hard | appointment | close → clarify | 80 | OK |
