# R2C Strategic Vision

## ビジョン
**"Conversation is the new conversion"**
すべての訪問者をコンテキストアウェアな対話でコンバージョンに導く、次世代AIセールスプラットフォーム。

---

## コアバリュープロポジション

### 1. Psychology-Driven Selling
- 心理学書籍RAGから販売原則をリアルタイム抽出
- 訪問者の行動・感情状態に応じた原則選択
- Judge評価ループによる継続的改善

### 2. Context-Aware Engagement
- 行動イベント（スクロール・時間・ページ遷移）からテンポラリースコアを算出
- 最適タイミングでプロアクティブ介入
- デバイス・言語・接続状況を考慮したパーソナライゼーション

### 3. Autonomous Optimization
- A/Bテスト × Judge評価 × コンバージョントラッキングの自動ループ
- 低スコアパターンを自動検出 → チューニングルール提案
- Knowledge Gap検出 → FAQ/書籍コンテンツ補充推奨

---

## 技術アーキテクチャ（現在）

```
訪問者
  ↓ Widget (Shadow DOM, 1行埋め込み)
  ↓ Behavior Events (scroll, time, page)
  ↓ Temp Score算出 → Proactive Trigger
  ↓ Context-Aware Agent
  ↓ Psychology RAG (書籍 + FAQ)
  ↓ Sales Flow (clarify → propose → recommend → close)
  ↓ Judge評価 (Gemini 2.5 Flash)
  ↓ 自動チューニング提案
```

---

## 将来ロードマップ

### Near-term（～3ヶ月）
- **Phase59**: マルチテナントA/Bテスト自動化
- **Phase60**: リアルタイム感情分析（カメラ/音声オプション）
- **Phase61**: CRM統合（Salesforce / HubSpot）

### Mid-term（3～12ヶ月）
- **Visitor Fingerprinting**: デバイス・行動パターンによる匿名訪問者識別
- **Predictive Scoring**: 機械学習によるコンバージョン確率予測
- **Multi-modal Avatar**: 感情表現豊かなアバター（表情同期）

### Long-term（1年以上）
- **Autonomous Campaign Manager**: AIが広告・コンテンツ・会話を一元最適化
- **Industry Vertical Packs**: EC / SaaS / 不動産 / 医療の業種別パック
- **Global Expansion**: 多言語対応（英語・中国語・韓国語）

---

## データ戦略

### 収集するシグナル（将来）
| シグナル | テーブル | カラム | フェーズ |
|---|---|---|---|
| デバイス種別 | behavioral_events | device_type | 将来 |
| ビューポート幅 | behavioral_events | viewport_width | 将来 |
| 接続種別 | behavioral_events | connection_type | 将来 |
| ユーザー言語 | behavioral_events | user_language | 将来 |
| 心理原則使用 | chat_messages | psychology_principle_used | 将来 |
| テンポラリースコア | chat_messages | visitor_temp_score | 将来 |
| 販売ステージ | chat_messages | sales_stage | 将来 |

### プライバシー原則
- PII収集禁止（氏名・メール・電話番号はサーバー側で不保存）
- 行動データは匿名化（訪問者IDはセッションスコープ）
- 書籍内容はRAG excerptとして最大200文字のみ露出

---

## コスト効率目標

| 項目 | 現在 | 目標（12ヶ月後） |
|---|---|---|
| 月次LLMコスト | $27-48 | $50-100（10x規模） |
| 120Bモデル使用率 | ≤10% | ≤5%（効率改善） |
| Judge評価レイテンシ | ~2s | <1s（キャッシュ） |
| RAG検索レイテンシ | ~500ms | <200ms（最適化） |

---

## 競合優位性

1. **書籍RAG**: 汎用LLMではなく、購入済み心理学書籍から販売手法を学習
2. **Judge-in-the-loop**: 応答品質を継続的に自己評価・改善（他社製品にない）
3. **プライバシーファースト**: 書籍内容・PII非露出、テナント完全分離
4. **1行埋め込み**: 技術スタック不問、Shadow DOM で既存UIに無干渉
5. **低コスト**: Groq高速推論 + Hetzner VPS で月$27-48（AWS比1/10以下）

---

*最終更新: 2026-04-06*
*対象Phase: Phase55-58完了時点での戦略整理*
