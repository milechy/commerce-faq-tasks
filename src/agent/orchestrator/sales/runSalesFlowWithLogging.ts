import {
  type SalesLogPhase,
  type TemplateSource,
  buildSalesLogRecord,
  writeSalesLogViaGlobal,
} from "./salesLogWriter";
import type {
  SalesOrchestratorInput,
  SalesOrchestratorResult,
} from "./salesOrchestrator";
import { runSalesOrchestrator } from "./salesOrchestrator";

/**
 * SalesOrchestrator を実行し、必要であれば SalesLogWriter にも書き込むヘルパー。
 *
 * - Clarify のみ（テンプレ生成なし）の場合はログを書かない
 * - Propose / Recommend / Close でテンプレを使った場合のみログを書く
 */
export async function runSalesFlowWithLogging(
  tenantId: string,
  sessionId: string,
  input: SalesOrchestratorInput
): Promise<SalesOrchestratorResult> {
  const result = runSalesOrchestrator(input);

  // Sales ステージに進まなかった or テンプレを使っていない場合はログ不要
  if (!result.nextStage || !result.templateMeta) {
    return result;
  }

  // SalesLogPhase は clarify/propose/recommend/close のいずれか
  const phase = result.nextStage as SalesLogPhase;

  const template = result.templateMeta;

  // source から templateSource を決定（デフォルトは notion 扱い）
  const templateSource: TemplateSource =
    template.source === "fallback" ? "fallback" : "notion";

  // fallback のときは templateId を null 扱いにする（SPEC に合わせる）
  const templateId = templateSource === "fallback" ? null : template.id;

  // intent は template.intent を優先し、無ければ orchestrator input の intent を fallback に使う
  const intent =
    template.intent ??
    input.proposeIntent ??
    input.recommendIntent ??
    input.closeIntent ??
    "unknown";

  // personaTags は orchestrator input をそのまま使う
  const personaTags = input.personaTags;

  const record = buildSalesLogRecord({
    context: { tenantId, sessionId },
    phase,
    intent,
    personaTags,
    userMessage: input.detection.userMessage,
    templateSource,
    templateId,
    templateText: template.template,
  });

  await writeSalesLogViaGlobal(record);

  return result;
}
