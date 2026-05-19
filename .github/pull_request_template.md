# PR チェックリスト

## 基本情報

- **Asana タスク GID**: <!-- 1234567890123456 -->
- **Phase / タスク名**: <!-- Phase70-X: 説明 -->
- **Tier**: <!-- S / A / B -->

---

## 24h 自走由来チェック

> 24h 自走モード (Phase70-A) で CLI が自動生成した PR の場合のみ記入。  
> 人間が作成した PR はスキップ可。

- [ ] この PR は **24h 自走 CLI が生成**した（`label: 24h-loop` 付与済み）
- [ ] **Tier B** または **Tier A + `24h-eligible` タグ** のタスクが起点
- [ ] 夜間禁止操作 10 項目（`docs/24H_AUTONOMOUS_PLAYBOOK.md §2`）に違反していない
- [ ] VPS 接続・DB migration 自動適用・`.env` 編集を含まない
- [ ] `morning-digest.sh` のリスク判定: <!-- 🟢 low / 🟡 medium / 🔴 high -->

---

## Gate 確認

- [ ] **Gate 1** `pnpm verify` → 0 errors / 0 warnings / all tests pass
- [ ] **Gate 2** `bash SCRIPTS/security-scan.sh` → High/Critical = 0
- [ ] **Gate 2.5** `/codex:review --base main` → P0/P1 なし（docs/CSS/test のみは skip 可）

---

## 変更概要

<!-- 何を変えたか 1〜3 行で -->

---

## 影響範囲

- [ ] API スキーマ変更なし（後方互換）
- [ ] DB migration あり → VPS 手動適用が別途必要（`docs/DEPLOY_CHECKLIST.md` 参照）
- [ ] `.env` / secrets 変更なし

---

## テスト確認

```bash
pnpm verify
# または
pnpm test
```

- [ ] ローカルでテスト実行済み

---

## 既存 docs との重複回避

<!-- この PR でドキュメントを変更した場合、既存 docs との重複をどう回避したか記載 -->

---

## レビュワーへのメモ

<!-- 見てほしいポイント、設計意図、既知の制約など -->
