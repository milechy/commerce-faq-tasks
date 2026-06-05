---
name: implementation
description: R2C 実装規律 — Research-First + Karpathy 4原則（R2C語彙版）
version: 1.0.0
---

# Implementation Discipline

## Research-Before-Coding（推測禁止）
- 実装前に `file / grep / git log` で現状を確認する — 推測で変更しない
- memory・anatomy.md 記載のファイル名/パス/endpoint は古い可能性あり → 必ず実機照合してから起票・実装

## Simplicity First（過剰実装禁止）
- タスク要件を超えた実装追加禁止: 未要求のヘルパー・抽象化・設定ファイルを足さない
- 「将来使うかも」は理由にならない — 3行の重複は早すぎる抽象化より良い
- error handling・fallback・validation は system boundary（ユーザー入力/外部API）にのみ書く

## Surgical Changes（関係ない行を触らない）
- 変更はタスクに直接関係する行のみ。orthogonal な修正は別 PR に
- 既存の dead code は指摘するだけ — 削除は別タスク・別 PR
- リファクタは明示的に要求されない限り行わない

## Goal-Driven（完了基準で止まる）
- 実装前に DoD（Gate 通過 / テスト pass）を確認する
- DoD を満たしたら止まる — 追加改善・周辺整理は別タスク起票
