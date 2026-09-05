---
name: trap-shopify-inflow-source-vs-provisioning-source
description: tenants.inflow_source(タスク仕様が要求していた新規列)は作られず、既存tenants.provisioning_sourceに一本化された(PR #1228)
metadata:
  type: project
---

`tenants.provisioning_source`は既にDBに存在する列(`src/migrations/phase79_tenants_provisioning_source.sql`、
CHECK制約`'manual' | 'wordpress_plugin'`、`wpProvisionRoutes.ts`のINSERT・`actionExecutor.ts`の分岐・
`routes.ts`のSELECTで参照)。

Shopifyアプリ連携(GID 1218199958279099系)の当初タスク仕様は`tenants.inflow_source`という
**別の新規カラム**を要求していたが、並列タスク01(migration作成、GID 1218199856712585)の担当が
実装前確認でこの重複を発見。**PR #1228でCLAUDE.md禁止6(同じ関心事を2列に複製したまま片方だけ直さない)
に従い、新規列は作らず既存`provisioning_source`のCHECK制約に`'shopify_app'`を追加する形に解消済み**
(2026-09-05)。

**Why:** `docs/SHOPIFY_APP_REQUIREMENTS.md`§11.1は「provisioning_sourceは実装コード上まだ存在しない」と
記載していたが実コードと矛盾していた(要件定義自体の記述ミス)。migration作成タスクが先にgrepで
気づき、後追いでこのタスク(02: shopifyRepository.ts)の`markInflowSource`/`InflowSource`型を
`markProvisioningSource`/`ProvisioningSource`型へ差し替えて追随した(PR #1229)。

**How to apply:** 以後のShopify関連タスク(03以降、OAuth・Webhookルート実装等)で
「流入元」を書き込む/参照するときは**必ず`provisioning_source`列を使う**。`inflow_source`という
列名は存在しない。要件定義書(`docs/SHOPIFY_APP_REQUIREMENTS.md`)の該当箇所(§5.3・D6・D11)は
本メモ作成時点でまだ`inflow_source`表記のまま未修正の可能性があるため、ドキュメントの記述より
実コード(`provisioning_source`)を優先する。
