// src/agent/dialog/dialogAgent.ts
    const prevStage =
      (previousSalesMeta as any)?.phase as SalesLogPhase | undefined
    const stageTransitionReason =
      prevStage && prevStage !== phase ? 'auto_progress_by_intent' : 'stay_in_stage'

    await globalSalesLogWriter.write({
      tenantId: DEFAULT_TENANT_ID,
      sessionId: effectiveSessionId,
      phase,
      prevStage,
      nextStage: phase,
      stageTransitionReason,
      intent: intentSlug,
      personaTags,
      userMessage: message,
      templateSource,
      templateId,
      templateText: salesResult.prompt,
    })
