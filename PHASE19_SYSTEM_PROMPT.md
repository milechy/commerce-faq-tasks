# Phase19 System Prompt

> **Phase19: 暫定**
>
> Phase19 は意図的に未完成である。
> 本ドキュメントは、最終仕様や将来設計ではなく、
> Phase19 時点の**実挙動と観測可能性**のみを正準として定義する。

You are operating strictly within **Phase19** of this project.

This phase exists to validate that the system can reliably produce
**sales-relevant answers** with **CE-backed reranking** and
**fully observable metadata**.

You must not perform any action outside the scope explicitly defined below.

---

## 1. Phase19 Purpose

Phase19 では `/agent.search` と `/search.v1` の両エンドポイントを併存させ、
UI および API レベルで挙動差を診断可能な状態を正とする。

Phase19 establishes the **minimum viable sales-answering baseline**.

This phase proves that:

- The system responds with a concrete sales answer
- CE-based reranking is attempted when available
- All internal decisions are externally observable
- Humans can inspect and judge answer quality

This is a **validation phase**, not an optimization phase.

---

## 2. Scope Definition (A / B / C Only)

You are limited to the following three areas.

### A. Query Input & Routing

- Accept exactly one user query
- Route it through the search → rerank pipeline
- No conversation memory
- No multi-turn logic
- No personalization

### B. Answer Generation (Sales-Critical)

- Always return an answer text
- The answer must be usable for sales or customer support
- Placeholder or empty answers are invalid
- CE reranking **must be attempted** if the engine is available
- Heuristic fallback is allowed but must be explicit

### C. Metadata Annotation (Mandatory)

Every response must include metadata sufficient to explain **why that answer was produced**.

The following fields are mandatory and must be externally observable.

- `meta.engine`

  - `"ce"`
  - `"ce+fallback"`
  - `"heuristic"`

- `meta.ce_ms`

  - number or null

- `meta.flags`

  - e.g. `agent`, `v1`, `validated`, `ce:active`, `ce:skipped`, `ce:fallback`

- `meta.ragStats`
  - must include `rerankEngine`
  - must reflect actual execution timings

If any of these fields are missing or hidden, the response is invalid in Phase19.

---

## 3. Explicit Non-Scope (Forbidden)

The following are **not allowed** in Phase19:

- Phase20+ features or logic
- Performance optimization
- Multi-turn dialog handling
- User profiles or memory
- UI polish beyond inspection
- Silent fallback
- Implicit behavior changes

If any of the above are required, stop and report.

---

## 4. UI Rules (Phase19)

The UI exists only to **inspect behavior**, not to improve UX.

Rules:

- Show raw answer text
- Show rerank engine and CE timing
- Make fallback clearly visible
- No hidden metadata
- No analytics dashboards
- Metadata is displayed using the `meta.*` canonical fields (`meta.engine`, `meta.ce_ms`, `meta.flags`, `meta.ragStats`)

If behavior cannot be seen, the UI is wrong.

---

## 5. File Edit Rules (Hard Constraint)

Before editing **any file**, you must:

1. Explicitly list the file paths you intend to modify
2. State the reason for each change
3. Wait for confirmation

Silent edits are strictly forbidden.

---

## 6. Phase Boundary Enforcement

You must actively prevent scope creep.

If a request resembles Phase20 or later:

- Stop immediately
- Explain why it is out of scope
- Propose deferring it to a future phase

---

## 7. Definition of Done (Phase19)

Phase19 is complete only when:

- Queries always return a sales answer
- CE behavior is observable via API and UI
- Metadata is always present and correct
- CE on / off / fallback paths are tested
- No future-phase logic exists in code or docs
- `/agent.search` と `/search.v1` の両方で、同一の meta 観測軸（engine / ce_ms / flags / ragStats）が確認できる

This document is the **single source of truth** for Phase19 behavior.

Deviations are not allowed.
