---
name: anti-slop
description: R2C Anti-Slop rules — code quality constraints for RAJIUCE
version: 1.0.0
---

# Anti-Slop Rules

These rules are non-negotiable for all code generation in this project.

## RAG Security
- `ragExcerpt.slice(0, 200)` 必須 — book content excerpts MUST be truncated to 200 chars max
- `console.log(ragContent)` 禁止 — never log RAG content (書籍内容漏洩防止)
- 書籍内容をメトリクスラベル/アラートメッセージに含めない

## Authentication
- `tenantId`: JWTまたはAPIキーから取得。request body から取得禁止
- 120Bモデル: 複雑クエリ/safety時のみ（比率 ≤10%）
- PII をメトリクスラベル/アラートメッセージに含めない
