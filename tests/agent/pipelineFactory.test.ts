

// tests/agent/pipelineFactory.test.ts
// Phase9: SalesPipeline の業種別テンプレ / kind 解決まわりのスモークテスト

import assert from "assert";
import {
  getSalesPipelineConfig,
  resolveSalesPipelineKind,
  getIndustryPipelineByKind,
} from "../../src/agent/orchestrator/sales/pipelines/pipelineFactory";

async function testGetSalesPipelineConfig() {
  const generic = getSalesPipelineConfig("generic");
  assert.strictEqual(generic.kind, "generic", "generic config kind should be 'generic'");

  const saas = getSalesPipelineConfig("saas");
  assert.strictEqual(saas.kind, "saas", "saas config kind should be 'saas'");

  const ec = getSalesPipelineConfig("ec");
  assert.strictEqual(ec.kind, "ec", "ec config kind should be 'ec'");

  const reservation = getSalesPipelineConfig("reservation");
  assert.strictEqual(
    reservation.kind,
    "reservation",
    "reservation config kind should be 'reservation'",
  );

  const fallback = getSalesPipelineConfig(undefined as any);
  assert.strictEqual(
    fallback.kind,
    "generic",
    "fallback config kind should be 'generic' when kind is undefined",
  );
}

async function testResolveSalesPipelineKind() {
  // explicitKind があればそれを優先
  const explicit = resolveSalesPipelineKind({ explicitKind: "saas", tenantId: "t-1" });
  assert.strictEqual(explicit, "saas", "explicitKind should be preferred over tenant-based inference");

  // explicitKind が無い場合は tenantId から推定（Phase9 現時点では常に generic）
  const inferred = resolveSalesPipelineKind({ tenantId: "tenant-xyz" });
  assert.strictEqual(
    inferred,
    "generic",
    "inferred kind from tenantId should currently default to 'generic'",
  );
}

async function testGetIndustryPipelineByKind() {
  const saas = getIndustryPipelineByKind("saas");
  assert.ok(saas, "saas pipeline should not be null");
  assert.strictEqual(saas?.kind, "saas", "saas pipeline kind should be 'saas'");

  const ec = getIndustryPipelineByKind("ec");
  assert.ok(ec, "ec pipeline should not be null");
  assert.strictEqual(ec?.kind, "ec", "ec pipeline kind should be 'ec'");

  const reservation = getIndustryPipelineByKind("reservation");
  assert.ok(reservation, "reservation pipeline should not be null");
  assert.strictEqual(
    reservation?.kind,
    "reservation",
    "reservation pipeline kind should be 'reservation'",
  );

  const generic = getIndustryPipelineByKind("generic");
  assert.strictEqual(generic, null, "generic pipeline should not have an industry-specific template");
}

async function main() {
  console.log("Running pipelineFactory tests...");

  await testGetSalesPipelineConfig();
  await testResolveSalesPipelineKind();
  await testGetIndustryPipelineByKind();

  console.log("pipelineFactory tests passed 🎉");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});