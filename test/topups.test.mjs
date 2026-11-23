/**
 * Пополнения в файле topups.json: слияние по id, курс на момент записи и
 * миграция старого localStorage-ключа.
 *
 * Host-часть (index.js) проверяется напрямую: чистые функции mergeTopUps /
 * normalizeTopUp / topUpId и файл через DSH_HOME во временном каталоге.
 * Client-часть исполняется в vm с поддельным localStorage и fetch-заглушкой,
 * которая запоминает вызовы маршрута merge.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import {
  mergeTopUps,
  normalizeTopUp,
  topUpId,
  TOPUPS_LIMIT,
  loadTopUps,
  saveTopUps,
} from '../index.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Минимальный React-стенд: хуки возвращают начальные значения. */
const fakeReact = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children },
  }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useReducer: (_reducer, initial) => [initial, () => {}],
  useRef: initial => ({ current: initial }),
  useEffect: () => {},
  useCallback: callback => callback,
  useMemo: factory => factory(),
}

/** Загрузить client.js в vm: localStorage с предзаполнением, fetch-заглушка с журналом. */
async function loadClient(options = {}) {
  const source = await readFile(join(ROOT, 'client.js'), 'utf8')
  const captured = {}
  const storage = new Map()
  for (const [key, value] of Object.entries(options.storage ?? {})) storage.set(key, value)
  const calls = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(loader) {
          captured.options = loader
        },
      },
      localStorage: {
        getItem: key => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key),
      },
    },
    console: { error: () => {}, warn: () => {}, log: () => {} },
    fetch: async (url, init) => {
      const call = { url: String(url), method: String(init?.method ?? 'GET'), body: init?.body ?? null }
      calls.push(call)
      if (typeof options.fetch === 'function') return options.fetch(String(url), init, call)
      throw new Error(`неожиданный fetch: ${url}`)
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(captured.options !== undefined, 'ModuleLoader.load вызван')
  const module = captured.options.factory(name => {
    if (name === 'react') return fakeReact
    throw new Error(`неожиданный модуль ${name}`)
  })
  const ctx = {
    effect: callback => {
      callback()
      return () => {}
    },
    locale: {
      register() {},
      bind() { return key => key },
    },
    slots: {
      inject(_name, callback) {
        try {
          return callback()
        } catch {
          return undefined
        }
      },
      register() { return () => {} },
    },
  }
  module.apply(ctx)
  return { module, storage, calls, test: module.__test }
}

/** Дать микротаскам vm и async-цепочкам завершиться. */
const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))

const mergeCall = calls => calls.find(call => call.url.includes('/api/expenses.topups.merge') && call.method === 'POST')

test('host: topUpId детерминирован, normalizeTopUp сохраняет курсы и отбрасывает мусор', () => {
  assert.equal(topUpId(1000, 'USD', 5), topUpId(1000, 'USD', 5))
  assert.notEqual(topUpId(1000, 'USD', 5), topUpId(1000, 'USD', 6))
  const record = normalizeTopUp({ at: 1000, currency: 'USD', amount: 5, rates: { rubPerUsd: 79, rubPerCny: 11, cnyPerUsd: 7.18 } })
  assert.equal(record.id, topUpId(1000, 'USD', 5))
  assert.deepEqual(record.rates, { rubPerUsd: 79, rubPerCny: 11, cnyPerUsd: 7.18, updatedAt: 0 })
  assert.equal(normalizeTopUp(null), null)
  assert.equal(normalizeTopUp({ at: 1, currency: 'USD', amount: 0 }), null)
  assert.equal(normalizeTopUp({ at: 0, currency: 'USD', amount: 1 }), null)
  assert.equal(normalizeTopUp({ at: 1, currency: '', amount: 1 }), null)
  // Битый набор курсов запись не губит: курсы просто не сохраняются.
  const noRates = normalizeTopUp({ at: 1, currency: 'CNY', amount: 2, rates: { rubPerUsd: -1 } })
  assert.equal(noRates.rates, undefined)
})

test('host: merge по id — добавлено, обновлено, пропущено с причиной', () => {
  const base = [{ id: topUpId(1000, 'USD', 5), at: 1000, currency: 'USD', amount: 5 }]

  // Новая запись добавляется и встаёт первой (новейшие сверху).
  let result = mergeTopUps(base, [{ at: 2000, currency: 'USD', amount: 10 }])
  assert.equal(result.added, 1)
  assert.equal(result.updated, 0)
  assert.equal(result.skipped, 0)
  assert.equal(result.entries.length, 2)
  assert.equal(result.entries[0].at, 2000)

  // Точный повтор: пропущено с причиной, дубликат не появляется.
  result = mergeTopUps(result.entries, [{ at: 2000, currency: 'USD', amount: 10 }])
  assert.equal(result.added, 0)
  assert.equal(result.skipped, 1)
  assert.equal(result.reasons[0].reason, 'unchanged')
  assert.equal(result.entries.length, 2)

  // Тот же id с курсом на момент записи: запись обновляется.
  result = mergeTopUps(result.entries, [{ at: 2000, currency: 'USD', amount: 10, rates: { rubPerUsd: 79, rubPerCny: 11, cnyPerUsd: 7.1, updatedAt: 5 } }])
  assert.equal(result.updated, 1)
  assert.equal(result.added, 0)
  assert.equal(result.entries[0].rates.rubPerUsd, 79)

  // Входящая запись без курса сохранённый курс не затирает.
  result = mergeTopUps(result.entries, [{ at: 2000, currency: 'USD', amount: 10 }])
  assert.equal(result.skipped, 1)
  assert.equal(result.reasons[0].reason, 'unchanged')
  assert.equal(result.entries[0].rates.rubPerUsd, 79)
})

test('host: непригодные записи пропускаются с причиной invalid', () => {
  const result = mergeTopUps([], [
    { at: 0, currency: 'USD', amount: 1 },
    { at: 1, currency: '', amount: 1 },
    { at: 1, currency: 'USD', amount: -1 },
    { at: 1, currency: 'USD', amount: 'abc' },
    'мусор',
  ])
  assert.equal(result.added, 0)
  assert.equal(result.updated, 0)
  assert.equal(result.skipped, 5)
  assert.ok(result.reasons.every(reason => reason.reason === 'invalid'))
  assert.equal(result.entries.length, 0)
})

test('host: история пополнений ограничена лимитом', () => {
  const many = Array.from({ length: TOPUPS_LIMIT + 10 }, (_, index) => ({ at: index + 1, currency: 'USD', amount: 1 }))
  const result = mergeTopUps([], many)
  assert.equal(result.entries.length, TOPUPS_LIMIT)
  assert.equal(result.entries[0].at, TOPUPS_LIMIT + 10, 'остались новейшие')
})

test('host: файл topups.json — запись и чтение с курсом на момент записи', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-expenses-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.deepEqual(await loadTopUps(), [], 'нет файла — пустая история')
    const merged = mergeTopUps([], [{ at: 5000, currency: 'USD', amount: 20, rates: { rubPerUsd: 80, rubPerCny: 11.3, cnyPerUsd: 7.08, updatedAt: 42 } }])
    await saveTopUps(merged.entries)
    const loaded = await loadTopUps()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].id, topUpId(5000, 'USD', 20))
    assert.equal(loaded[0].amount, 20)
    assert.deepEqual(loaded[0].rates, { rubPerUsd: 80, rubPerCny: 11.3, cnyPerUsd: 7.08, updatedAt: 42 })
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('клиент: миграция переносит старый ключ localStorage в файл и очищает его', async () => {
  const legacy = [
    { at: 1000, currency: 'USD', amount: 5 },
    { at: 999, currency: 'CNY', amount: 2 },
    { at: 998, currency: 'USD', amount: -3 }, // непригодная — отбрасывается
  ]
  const { storage, calls, test: api } = await loadClient({
    storage: { 'dsh-expenses:topups': JSON.stringify(legacy) },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, added: 2, updated: 0, skipped: 0, reasons: [], total: 2 }) }),
  })
  await tick()
  const merge = mergeCall(calls)
  assert.ok(merge, 'клиент отправил старые записи на маршрут merge')
  const body = JSON.parse(merge.body)
  assert.equal(body.entries.length, 2, 'непригодная запись отброшена')
  assert.equal(body.entries[0].id, topUpId(1000, 'USD', 5))
  assert.equal(body.entries[0].currency, 'USD')
  assert.equal(body.entries[0].amount, 5)
  assert.equal(body.entries[0].rates, undefined, 'миграция не приписывает сегодняшний курс старым записям')
  assert.equal(storage.has('dsh-expenses:topups'), false, 'старый ключ очищен после успешной отправки')
  assert.equal(typeof api.migrateLegacyTopUps, 'function')
})

test('клиент: при неудачной отправке миграция ключ не очищает', async () => {
  const { storage, calls } = await loadClient({
    storage: { 'dsh-expenses:topups': JSON.stringify([{ at: 1000, currency: 'USD', amount: 5 }]) },
    fetch: async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'test' }) }),
  })
  await tick()
  assert.ok(mergeCall(calls), 'попытка отправки была')
  assert.equal(storage.has('dsh-expenses:topups'), true, 'ключ остаётся, чтобы миграция повторилась')
})

test('клиент: фиксирует курс на момент записи и не пишет topups в localStorage', async () => {
  const { storage, calls, test: api } = await loadClient({
    fetch: async (url) => {
      if (String(url).includes('/api/expenses.rates')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ready', rubPerUsd: 79.5, rubPerCny: 11.2, cnyPerUsd: 7.1, updatedAt: 111, fetchedAt: 222, source: 'test' }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, added: 1, updated: 0, skipped: 0, reasons: [], total: 1 }) }
    },
  })
  const rates = await api.pollRates(false)
  assert.equal(rates.status, 'ready')
  await api.submitDetectedTopUps([{ at: 2000, currency: 'USD', amount: 10 }])
  const merge = mergeCall(calls)
  assert.ok(merge, 'пополнение ушло на маршрут merge')
  const body = JSON.parse(merge.body)
  assert.equal(body.entries.length, 1)
  assert.equal(body.entries[0].id, topUpId(2000, 'USD', 10))
  assert.deepEqual(body.entries[0].rates, { rubPerUsd: 79.5, rubPerCny: 11.2, cnyPerUsd: 7.1, updatedAt: 111 }, 'курс — на момент записи')
  assert.equal(storage.has('dsh-expenses:topups'), false, 'новые пополнения в localStorage не пишутся')
})

test('клиент: без известных курсов запись уходит без поля rates', async () => {
  const { calls, test: api } = await loadClient({
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, added: 1, updated: 0, skipped: 0, reasons: [], total: 1 }) }),
  })
  await api.submitDetectedTopUps([{ at: 3000, currency: 'CNY', amount: 1.5 }])
  const merge = mergeCall(calls)
  assert.ok(merge)
  const body = JSON.parse(merge.body)
  assert.equal(body.entries[0].rates, undefined)
})

test('клиент: fetchTopUps читает список с Host и отдаёт entries', async () => {
  const entries = [{ id: topUpId(4000, 'USD', 7), at: 4000, currency: 'USD', amount: 7 }]
  const { calls, test: api } = await loadClient({
    fetch: async (url) => {
      if (String(url).includes('/api/expenses.topups')) {
        return { ok: true, status: 200, json: async () => ({ entries, total: 1 }) }
      }
      throw new Error(`неожиданный fetch: ${url}`)
    },
  })
  const list = await api.fetchTopUps()
  assert.deepEqual(list, entries)
  assert.ok(calls.some(call => call.url.includes('/api/expenses.topups') && call.method === 'GET'))
})
