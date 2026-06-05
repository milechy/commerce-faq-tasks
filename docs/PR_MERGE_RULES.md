# PR マージ自動化ルール

## 背景

2026-04-19 に PR #110-#117 の 8 本を一括マージする際、手動操作の長さと conflict 解消で一日が大きく削られた。
同様の手動作業を避けるため、以下の運用ルールを遵守する。

## 運用ルール

**PR 作成時は必ず auto-merge を有効化する:**

```bash
gh pr create --title "..." --body "..." && \
gh pr merge $(gh pr view --json number -q .number) --auto --squash --delete-branch
```

または既存 PR 番号を使って:
```bash
gh pr merge <PR番号> --auto --squash --delete-branch
```

## auto-merge の動作条件

以下が全て揃った時点で自動マージされる:
- CI (pnpm verify / build) が green
- 必要なレビュー承認済み（プロジェクト設定による）
- conflict なし

## conflict が発生した場合

- auto-merge は停止、PR 画面で「Merge conflict」警告が表示される
- hkobayashi または CLI が手動で conflict を解消
- 解消後に再度 auto-merge が有効化される

## マージ方式の統一

- **squash and merge** を標準とする（linear history 維持）
- rebase merge / merge commit は使わない（履歴複雑化回避）

## CL（変更リスト）小型化原則

Codex レビューのラウンド数削減と安全な auto-merge のために、PR は小さく保つ:

- **1 PR = 1 論理変更**。複数フィーチャーを1 PR に混ぜない
- `src/` 変更 + `SCRIPTS/` 変更は分離を検討（Tier が変わる場合は必須）
- migration SQL + アプリコードは同一 PR で可（atomic deploy 前提）
- テスト追加 + 実装は同一 PR に含める（Gate 通過の前提）

大きな PR は Codex ラウンド数が増え、auto-merge の確認コストも上がる。
スコープが膨らんだと感じたら、その場で分割を検討すること。

## 関連タスク

- Phase1（本ルール策定）: Asana 1214121039752589
- Phase2（SCRIPTS/merge-ready-prs.sh 作成）: Asana 1214121039752589（別タスク化済み）
- Phase3（Claude Code CLI /merge エージェント）: 将来タスク、未起票

---

更新: 2026-05-19 (CLAUDE.md から分離)
