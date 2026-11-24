import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import { titleOfLogBytes } from '../lib/session-facts.mjs'

function frame(titles) {
  return zstdCompressSync(Buffer.from(titles.map((title) => JSON.stringify({ type: 'session/title', data: { title } })).join('\n') + '\n'))
}

test('название сессии: последнее событие session/title важнее первого', () => {
  const bytes = frame(['Ты — профессиональны', 'Анализ платформы Pyrus'])
  assert.equal(titleOfLogBytes(bytes), 'Анализ платформы Pyrus')
})
