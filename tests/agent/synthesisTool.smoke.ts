// tests/agent/synthesisTool.smoke.ts

import assert from 'node:assert/strict'
import { synthesizeAnswer } from '../../src/agent/tools/synthesisTool'
import type { RerankItem } from '../../src/agent/types'

function makeItem(id: number, text: string): RerankItem {
  return {
    id: String(id),
    text,
    score: 0.5,
    source: 'test',
  }
}

function test_noItems_fallback() {
  const query = '返品 送料'
  const result = synthesizeAnswer({ query, items: [], maxChars: 300 })

  assert.ok(
    result.answer.length > 0,
    '[noItems] answer should not be empty',
  )

  // 想定しているメッセージ断片をざっくりチェック
  assert.ok(
    result.answer.includes('見つかりません') ||
      result.answer.includes('もう一度お試しください'),
    '[noItems] fallback message should mention not found / retry',
  )
}

function test_multipleItems_included() {
  const query = '返品 送料'
  const items: RerankItem[] = [
    makeItem(1, '返品 送料 サンプル A'),
    makeItem(2, '返品 送料 サンプル B'),
    makeItem(3, '返品 送料 サンプル C'),
  ]

  const result = synthesizeAnswer({
    query,
    items,
    maxChars: 500,
  })

  assert.ok(
    result.answer.includes('返品 送料 サンプル A'),
    '[multipleItems] answer should include first item text',
  )
  assert.ok(
    result.answer.includes('返品 送料 サンプル B'),
    '[multipleItems] answer should include second item text',
  )

  // 箇条書きのマーカーが入っているはず
  assert.ok(
    result.answer.includes('・'),
    '[multipleItems] answer should contain bullet marker "・"',
  )
}

function test_truncation_maxChars() {
  const query = '長文のテスト'
  const longText = 'X'.repeat(1000)

  const items: RerankItem[] = [makeItem(1, longText)]

  const maxChars = 120
  const result = synthesizeAnswer({
    query,
    items,
    maxChars,
  })

  assert.ok(
    result.answer.length <= maxChars,
    `[truncation] answer length should be <= maxChars (got ${result.answer.length}, max ${maxChars})`,
  )

  // 末尾が「…」で終わることを期待（実装に合わせている）
  assert.ok(
    result.answer.endsWith('…') || result.answer.length < maxChars,
    '[truncation] when truncated, answer should end with "…" (or be shorter than maxChars)',
  )
}

function main() {
  const tests: { name: string; fn: () => void }[] = [
    { name: 'noItems_fallback', fn: test_noItems_fallback },
    { name: 'multipleItems_included', fn: test_multipleItems_included },
    { name: 'truncation_maxChars', fn: test_truncation_maxChars },
  ]

  let failed = 0

  for (const t of tests) {
    try {
      t.fn()
      console.log(`✅ ${t.name}`)
    } catch (err) {
      failed++
      console.error(`❌ ${t.name}`)
      console.error(String(err))
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} synthesisTool test(s) failed`)
    process.exit(1)
  } else {
    console.log('\nAll synthesisTool tests passed 🎉')
  }
}

main()