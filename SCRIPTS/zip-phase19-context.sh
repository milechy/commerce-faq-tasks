#!/usr/bin/env bash
set -euo pipefail

# Phase19 context zip: "Phase19で触る範囲 + 必須文脈" に絞る（広すぎる glob を禁止）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT}/.context"
OUT_ZIP="${OUT_DIR}/phase19-context.zip"
TMP_DIR="${OUT_DIR}/phase19-context"

mkdir -p "${OUT_DIR}"
rm -rf "${TMP_DIR}"
mkdir -p "${TMP_DIR}"

cd "${ROOT}"

copy() {
  local path="$1"
  if [ -e "${path}" ]; then
    mkdir -p "${TMP_DIR}/$(dirname "${path}")"
    cp -a "${path}" "${TMP_DIR}/${path}"
  fi
}

copy_glob() {
  local pattern="$1"
  shopt -s nullglob
  for f in ${pattern}; do
    copy "${f}"
  done
  shopt -u nullglob
}

# =========================
# A) Phase19 定義（必須）
# =========================
copy "PHASE19.md"
copy "PHASE19_UI_SPEC.md"
copy "PRODUCT_DEFINITION.md"
copy "PHASE_ROADMAP.md"
copy "REQUIREMENTS.md"
copy "ARCHITECTURE.md"
copy "DEV_ARCHITECTURE.md"
copy "ENVIRONMENT.md"
copy "NOTION_SYNC.md"
copy "NOTION_DATA_MODEL.md"
copy "PSYCHOLOGY_CORE.md"
copy "TASKS.md"
copy "README.md"
copy "README_PROJECT.md"
copy "PHASE17_SUMMARY.md"
copy "PHASE18_SUMMARY.md"

# =========================
# D) Docs（参照用：中核だけ）
# =========================
copy "docs/search-pipeline.md"
copy "docs/tenant.md"
copy "docs/NOTION_OVERVIEW.md"
copy "docs/NOTION_DB_SCHEMA.md"
copy "docs/NOTION_PIPELINE.md"
copy "docs/NOTION_SALES_FLOW.md"
copy "docs/SALESFLOW_DESIGN.md"
copy "docs/SALESFLOW_RUNTIME.md"
copy "docs/LOGGING_SCHEMA.md"
copy "docs/P95_METRICS.md"
copy "docs/ADMIN-UI.md"
copy "docs/ADMIN-FAQ-API.md"
copy "docs/api-agent.md"
copy "docs/api-admin.md"
copy "docs/auth.md"
copy "docs/db-schema.md"

# =========================
# B) Phase19で触る UI / API / Search（必須）
# =========================
copy "public/ui/index.html"

copy "src/index.ts"
copy "src/agent/http/agentSearchRoute.ts"

copy "src/search/rerank.ts"
copy "src/search/ceEngine.ts"
copy "src/search/pgvectorSearch.ts"
copy "src/search/hybrid.ts"   # 存在すれば入る

# =========================
# C) Phase19 回帰テスト（必須）
# =========================
copy "src/search/rerank.ce.test.ts"
copy "src/search/ceApi.test.ts"
copy "src/search/ceEngine.test.ts"

copy "jest.config.cjs"
copy "package.json"
copy "pnpm-lock.yaml"
copy "tsconfig.json"

# =========================
# E) 運用ツール（推奨）
# =========================
copy "tools/zip-md.sh"
copy "SCRIPTS/create_phase17_context_zip.ts"
copy "SCRIPTS/create_phase18_context_zip.ts"
copy_glob "SCRIPTS/*.ts"

# 自分自身も含める（再現性）
copy "SCRIPTS/zip-phase19-context.sh"

# Repo metadata（最小）
copy_glob ".github/**/*.md"
copy_glob ".github/workflows/*.yml"
copy_glob ".github/workflows/*.yaml"

# --- manifest ---
MANIFEST="${TMP_DIR}/MANIFEST.txt"
{
  echo "phase19-context generated at: $(date -Iseconds)"
  echo "git rev: $(git rev-parse HEAD 2>/dev/null || true)"
  echo ""
  echo "Included files:"
  (cd "${TMP_DIR}" && find . -type f | sort)
} > "${MANIFEST}"

# --- zip ---
rm -f "${OUT_ZIP}"
(cd "${TMP_DIR}" && zip -r "${OUT_ZIP}" . >/dev/null)

echo "OK: ${OUT_ZIP}"
echo "Size:"
ls -lh "${OUT_ZIP}"
echo ""
echo "Verify:"
echo "unzip -l ${OUT_ZIP} | head -n 120"