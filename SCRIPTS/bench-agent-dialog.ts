// SCRIPTS/bench-agent-dialog.ts
//
// /agent.dialog (LangGraph モード) の p50 / p95 レイテンシをざっくり計測する簡易ベンチ。
// 使い方:
//   npx ts-node SCRIPTS/bench-agent-dialog.ts
//
// 前提:
// - ローカルで `npm run start` しておき、port 3000 でサーバが起動していること
// - GROQ_API_KEY / GROQ_*_MODEL などは .env などで設定済みであること
//
// 計測項目:
// - HTTP レイテンシ (latencyMs): /agent.dialog のラウンドトリップ
// - meta.ragStats.total_ms (あれば)
// - LangGraph サマリログとは別に「エンドツーエンドの体感レイテンシ」を見る用途


type Percentiles = {
  p50: number
  p95: number
}

function calcPercentiles(values: number[]): Percentiles {
  if (!values.length) return { p50: 0, p95: 0 }

  const sorted = [...values].sort((a, b) => a - b)
  const p50Index = Math.floor(0.5 * (sorted.length - 1))
  const p95Index = Math.floor(0.95 * (sorted.length - 1))

  return {
    p50: sorted[p50Index],
    p95: sorted[p95Index],
  }
}

async function main() {
  const N = Number(process.env.BENCH_N ?? '50')
  const url = process.env.BENCH_DIALOG_URL ?? 'http://localhost:3000/agent.dialog'

  const latencies: number[] = []
  const ragTotals: number[] = []
  const ragSearches: number[] = []
  const ragReranks: number[] = []

  console.log(`N = ${N}`)
  console.log(`target = ${url}`)
  console.log('---')

  for (let i = 0; i < N; i++) {
    const startedAt = Date.now()
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: `bench-dialog-${Date.now()}-${i}`,
          message: '送料と支払い方法について教えてください',
          options: {
            language: 'ja',
            useLangGraph: true,
          },
        }),
      })

      const latency = Date.now() - startedAt
      latencies.push(latency)

      if (!res.ok) {
        console.error(`[#${i}] HTTP ${res.status}`)
        continue
      }

      const json: any = await res.json()
      const ragStats = json.meta?.ragStats

      if (ragStats) {
        if (typeof ragStats.total_ms === 'number') {
          ragTotals.push(ragStats.total_ms)
        }
        if (typeof ragStats.search_ms === 'number') {
          ragSearches.push(ragStats.search_ms)
        }
        if (typeof ragStats.rerank_ms === 'number') {
          ragReranks.push(ragStats.rerank_ms)
        }
      }

      if ((i + 1) % 10 === 0) {
        console.log(
          `progress: ${i + 1}/${N} (last latency=${latency}ms, last rag_total=${ragStats?.total_ms ?? 'n/a'}ms)`,
        )
      }
    } catch (err) {
      const latency = Date.now() - startedAt
      latencies.push(latency)
      console.error(`[#${i}] error:`, (err as Error).message)
    }
  }

  const lat = calcPercentiles(latencies)
  const ragTotal = calcPercentiles(ragTotals)
  const ragSearch = calcPercentiles(ragSearches)
  const ragRerank = calcPercentiles(ragReranks)

  console.log('===')
  console.log(`latency p50/p95: ${lat.p50} ${lat.p95}`)
  console.log(
    `rag_total_ms p50/p95: ${ragTotal.p50} ${ragTotal.p95} (N=${ragTotals.length})`,
  )
  console.log(
    `rag_search_ms p50/p95: ${ragSearch.p50} ${ragSearch.p95} (N=${ragSearches.length})`,
  )
  console.log(
    `rag_rerank_ms p50/p95: ${ragRerank.p50} ${ragRerank.p95} (N=${ragReranks.length})`,
  )
}

main().catch((err) => {
  console.error('fatal error:', err)
  process.exit(1)
})