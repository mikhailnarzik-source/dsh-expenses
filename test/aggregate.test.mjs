/**
 * Агрегация «одна строка на логическую сессию» и локальные сессии.
 *
 * Host-часть проверяется чистыми функциями (`lib/aggregate.mjs`,
 * `lib/session-facts.mjs`) и одним живым прогоном `readOverview` на временном
 * `DSH_HOME`. Client-часть исполняется в vm тем же способом, что и остальные
 * тесты панели.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import vm from 'node:vm'
import {
  MAX_LINEAGE_DEPTH,
  aggregateSessions,
  bestInstance,
  bestTitle,
  copyKeyOf,
  lineageKeyOf,
  normalizeTitle,
  pluralRu,
} from '../lib/aggregate.mjs'
import {
  createSessionFacts,
  normalizeSessionId,
  parseSessionModes,
  sessionModeOf,
  titleOfLogBytes,
} from '../lib/session-facts.mjs'
import { readOverview } from '../index.js'

const DAY = 24 * 60 * 60 * 1000
const ROOT = new URL('..', import.meta.url)

/** Одна запись архива; все поля, которые читает агрегатор. */
function row(id, overrides = {}) {
  return {
    id,
    title: '',
    titleSource: 'none',
    firstMessage: '',
    createdAt: 1_795_000_000_000,
    updatedAt: 1_795_000_000_000,
    input: 0,
    cacheHit: 0,
    output: 0,
    requests: 0,
    toolCalls: 0,
    costUsd: 0,
    todayInput: 0,
    todayCacheHit: 0,
    todayOutput: 0,
    todayRequests: 0,
    todayToolCalls: 0,
    todayCostUsd: 0,
    models: [],
    parentSession: '',
    subagent: false,
    error: false,
    ...overrides,
  }
}

/** Заголовок с названием из session/title. */
function titled(id, title, overrides = {}) {
  return row(id, { title, titleSource: 'session/title', ...overrides })
}

const byId = result => new Map(result.sessions.map(session => [session.id, session]))

test('агрегация A1: пять субагентов — одна строка, стоимость = сумма всех', () => {
  const records = [titled('root', 'Корень', { costUsd: 10, input: 100 })]
  for (let index = 1; index <= 5; index += 1) {
    records.push(titled(`sub-${index}`, `Субагент ${index}`, {
      parentSession: 'root',
      costUsd: index,
      input: index * 10,
      createdAt: row('x').createdAt + index,
    }))
  }
  const result = aggregateSessions(records, { liveIds: new Set(['root']) })
  assert.equal(result.sessions.length, 1, 'одна строка на логическую сессию')
  const session = result.sessions[0]
  assert.equal(session.id, 'root')
  assert.equal(session.costUsd, 10 + 1 + 2 + 3 + 4 + 5)
  assert.equal(session.input, 100 + 10 + 20 + 30 + 40 + 50)
  assert.equal(session.subagentCount, 5)
  assert.equal(session.subagents.length, 5)
  assert.equal(result.diagnostics.subagents, 5)
  assert.equal(result.sessions[0].subagent, false, 'субагент не показывается отдельной строкой')
})

test('агрегация A2: 25 копий — одна строка, стоимость не умножается', () => {
  const records = Array.from({ length: 25 }, (_, index) => titled(`copy-${index}`, 'Синхронизация', {
    costUsd: 1 + index / 100,
    createdAt: 1_795_000_000_000,
  }))
  const result = aggregateSessions(records, { archiveRecords: 25 })
  assert.equal(result.sessions.length, 1)
  const session = result.sessions[0]
  assert.equal(session.copies, 24, 'остальные — копии')
  assert.equal(session.costUsd, 1.24, 'берётся экземпляр с максимальной стоимостью')
  assert.equal(result.diagnostics.records, 25)
  assert.equal(result.diagnostics.copies, 24)
})

test('агрегация A3: субагент без записи родителя входит в потерянного родителя', () => {
  const meta = new Map([['parent-lost', { title: 'Потерянный родитель', titleSource: 'session/title', local: true }]])
  const result = aggregateSessions([
    titled('sub-x', 'Субагент', { parentSession: 'parent-lost', costUsd: 5 }),
  ], { meta })
  assert.equal(result.sessions.length, 1)
  const session = result.sessions[0]
  assert.equal(session.id, 'parent-lost', 'строка — родитель по parentSession')
  assert.equal(session.title, 'Потерянный родитель')
  assert.equal(session.costUsd, 5)
  assert.equal(session.virtualParent, true)
  assert.equal(session.subagentCount, 1)
  assert.equal(session.local, true, 'режим потерянного родителя учитывается')
})

test('агрегация A4: сессия из карантина считается и названа из session/title', () => {
  const result = aggregateSessions([
    titled('dead-1', 'Удалённая сессия', { costUsd: 2, archived: true }),
    titled('dead-2', 'Удалённая с субагентом', { costUsd: 3, archived: true }),
    titled('dead-sub', 'Субагент удалённой', { parentSession: 'dead-2', costUsd: 1, archived: true, archivedAt: 1 }),
  ], { liveIds: new Set() })
  const sessions = byId(result)
  assert.equal(result.sessions.length, 2, 'удалённые свёрнуты в логические сессии')
  assert.equal(sessions.get('dead-1').archived, true)
  assert.equal(sessions.get('dead-1').title, 'Удалённая сессия')
  assert.equal(sessions.get('dead-2').costUsd, 4, 'субагент удалённой входит в родителя')
  assert.equal(sessions.get('dead-2').archived, true)
})

test('агрегация A5: вложенные субагенты двух уровней входят в корень', () => {
  const base = row('x').createdAt
  const result = aggregateSessions([
    titled('root', 'Корень', { costUsd: 1 }),
    titled('child', 'Ребёнок', { parentSession: 'root', costUsd: 2, createdAt: base + 1 }),
    titled('grand', 'Внук', { parentSession: 'child', costUsd: 4, createdAt: base + 2 }),
  ])
  assert.equal(result.sessions.length, 1)
  const session = result.sessions[0]
  assert.equal(session.costUsd, 7)
  assert.equal(session.subagentCount, 2)
  const depths = session.subagents.map(entry => entry.depth)
  assert.deepEqual(depths, [1, 2], 'уровни разбивки сохраняются')
})

test('агрегация A6: название из session/title, первое сообщение — только в подсказке', () => {
  const named = aggregateSessions([
    titled('named', 'Синхронизация сессий через GitHub', { firstMessage: 'Ты работаешь в E:\\DeepSeek Harness' }),
  ])
  assert.equal(named.sessions[0].title, 'Синхронизация сессий через GitHub')
  assert.equal(named.sessions[0].titleSource, 'session/title')

  const first = aggregateSessions([
    row('first', { title: 'Ты работаешь в E:\\DeepSeek Harness', titleSource: 'first-message', firstMessage: 'Ты работаешь в E:\\DeepSeek Harness' }),
  ])
  assert.equal(first.sessions[0].title, '', 'первое сообщение не подставляется как имя')
  assert.equal(first.sessions[0].titleSource, 'first-message')
  assert.equal(first.sessions[0].firstMessage, 'Ты работаешь в E:\\DeepSeek Harness')

  const none = aggregateSessions([row('none')])
  assert.equal(none.sessions[0].title, '')
  assert.equal(none.sessions[0].titleSource, 'none')
  assert.equal(none.diagnostics.titles.none, 1)
})

test('агрегация A7: разбивка по субагентам раскрывается, итог не меняется', () => {
  const records = [
    titled('root', 'Корень', { costUsd: 10 }),
    titled('sub-1', 'Первый', { parentSession: 'root', costUsd: 2 }),
    titled('sub-2', 'Второй', { parentSession: 'root', costUsd: 3 }),
  ]
  const withBreakdown = aggregateSessions(records).sessions[0]
  assert.equal(withBreakdown.costUsd, 15)
  assert.equal(withBreakdown.subagents.length, 2)
  const breakdownSum = withBreakdown.subagents.reduce((total, entry) => total + entry.costUsd, 0)
  assert.equal(breakdownSum, 5, 'сумма разбивки — стоимость субагентов')
  // Убрать разбивку из ответа нельзя: итог строки от неё не зависит.
  assert.equal(withBreakdown.costUsd, 10 + breakdownSum)
  assert.equal(withBreakdown.subagents[0].title, 'Первый')
})

test('агрегация: копии не складывают токены, contentHash связывает копии с разными именами', () => {
  const first = titled('copy-a', 'Старое имя', { costUsd: 1, input: 100, contentHash: 'hash-1' })
  const second = titled('copy-b', 'Новое имя', { costUsd: 7, input: 400, contentHash: 'hash-1' })
  const result = aggregateSessions([first, second])
  assert.equal(result.sessions.length, 1, 'contentHash — один и тот же лог')
  assert.equal(result.sessions[0].costUsd, 7)
  assert.equal(result.sessions[0].input, 400)
  assert.equal(copyKeyOf(first), copyKeyOf(second))
  assert.equal(lineageKeyOf(second), 'hash:hash-1')
})

test('агрегация: при равной стоимости побеждает живой экземпляр, без цены — известная', () => {
  const live = titled('live', 'Сессия', { costUsd: 3, input: 10 })
  const dead = titled('dead', 'Сессия', { costUsd: 3, input: 99, archived: true })
  assert.equal(bestInstance([dead, live]).id, 'live')
  assert.equal(bestInstance([row('free', { costUsd: null }), row('paid', { costUsd: 2 })]).id, 'paid')
  assert.equal(aggregateSessions([row('only-free', { costUsd: null })]).sessions[0].costUsd, null)
  assert.equal(bestTitle([row('a', { title: 'Первое', titleSource: 'first-message' }), titled('b', 'Настоящее')]).title, 'Настоящее')
})

test('агрегация: локальность наследуется субагентам, но не поднимается в родителя', () => {
  const result = aggregateSessions([
    titled('root', 'Корень', { costUsd: 1, local: true, mode: 'local' }),
    titled('child', 'Ребёнок', { parentSession: 'root', costUsd: 1, createdAt: row('x').createdAt + 1 }),
  ])
  assert.equal(result.sessions[0].local, true)
  assert.equal(result.sessions[0].mode, 'local')
  assert.equal(result.sessions[0].subagents[0].local, true, 'ребёнок локального родителя локальный')
  assert.equal(result.diagnostics.local, 1)

  const cloud = aggregateSessions([
    titled('root', 'Облачный корень', { costUsd: 1 }),
    titled('child', 'Локальный ребёнок', { parentSession: 'root', costUsd: 1, local: true, createdAt: row('x').createdAt + 1 }),
  ])
  assert.equal(cloud.sessions[0].local, false, 'локальный ребёнок не делает родителя локальным')
  assert.equal(cloud.sessions[0].subagents[0].local, true)
})

test('агрегация: глубина линии ограничена, циклы не вешают разбор', () => {
  const base = row('x').createdAt
  const chain = [titled('root', 'Уровень 0', { costUsd: 1 })]
  for (let index = 1; index <= MAX_LINEAGE_DEPTH + 2; index += 1) {
    chain.push(titled(`level-${index}`, `Уровень ${index}`, {
      parentSession: index === 1 ? 'root' : `level-${index - 1}`,
      costUsd: 1,
      createdAt: base + index,
    }))
  }
  const result = aggregateSessions(chain)
  assert.equal(result.diagnostics.records, chain.length, 'каждая запись учтена')
  assert.ok(result.sessions.length >= 1 && result.sessions.length <= MAX_LINEAGE_DEPTH + 1, 'глубина линии ограничена')
  // Циклическая ссылка: два узла ссылаются друг на друга — разбор завершается.
  const cyclic = aggregateSessions([
    titled('a', 'A', { parentSession: 'b' }),
    titled('b', 'B', { parentSession: 'a' }),
  ])
  assert.equal(cyclic.diagnostics.records, 2)
  assert.ok(cyclic.sessions.length >= 1, 'цикл не останавливает разбор')
})

test('агрегация: диагностика — записи архива, логические сессии, локальные, копии', () => {
  const meta = new Map([['local-root', { local: true, mode: 'local' }]])
  const result = aggregateSessions([
    titled('root', 'Корень', { costUsd: 1 }),
    titled('sub', 'Субагент', { parentSession: 'root', costUsd: 1 }),
    titled('root-copy', 'Корень', { costUsd: 1, createdAt: row('x').createdAt }),
    titled('local-root', 'Локальная', { costUsd: 1, createdAt: row('x').createdAt + 1 }),
  ], { meta, archiveRecords: 110, liveIds: new Set(['root']) })
  assert.equal(result.diagnostics.archiveRecords, 110)
  assert.equal(result.diagnostics.records, 4)
  assert.equal(result.diagnostics.sessions, 2)
  assert.equal(result.diagnostics.local, 1)
  assert.equal(result.diagnostics.cloud, 1)
  assert.equal(result.diagnostics.subagentRecords, 1)
  assert.equal(result.diagnostics.copies, 1)
  // Счётчик «показано» совпадает с числом логических сессий, когда фильтров нет.
  assert.equal(result.sessions.length, result.diagnostics.sessions)
})

test('названия: нормализация, склонение копий и источники', () => {
  assert.equal(normalizeTitle('  Много   пробелов\nв названии '), 'Много пробелов в названии')
  assert.equal(pluralRu(1, ['копия', 'копии', 'копий']), 'копия')
  assert.equal(pluralRu(2, ['копия', 'копии', 'копий']), 'копии')
  assert.equal(pluralRu(5, ['копия', 'копии', 'копий']), 'копий')
  assert.equal(pluralRu(11, ['копия', 'копии', 'копий']), 'копий')
  assert.equal(pluralRu(21, ['копия', 'копии', 'копий']), 'копия')
})

test('факты: session-modes.json читается в форматах v1/v2/v3, битый — пустая карта', () => {
  const v1 = parseSessionModes(JSON.stringify({ sessions: { 'session-a': 'local' } }))
  assert.equal(v1.sessions['session-a'], 'local')
  const v2 = parseSessionModes(JSON.stringify({
    version: 2,
    sessions: { 'session-a': 'local', 'session-b': 'cloud' },
    workspaces: { 'ws-1': 'local' },
  }))
  assert.equal(v2.version, 2)
  assert.equal(v2.sessions['session-b'], 'cloud')
  const v3 = parseSessionModes(JSON.stringify({ version: 3, sessions: { 'ab': { mode: 'local' }, 'session-cd': { local: true } } }))
  assert.equal(v3.sessions['session-ab'], 'local', 'короткий id дополняется префиксом')
  assert.equal(v3.sessions['session-cd'], 'local')
  const broken = parseSessionModes('{битый json')
  assert.deepEqual(broken.sessions, {})
  const ids = [['abc', 'session-abc'], ['session-abc', 'session-abc']]
  for (const [input, expected] of ids) assert.equal(normalizeSessionId(input), expected)

  const modes = parseSessionModes(JSON.stringify({ version: 2, sessions: { 'session-x': 'local' }, workspaces: { 'ws-1': 'local' } }))
  assert.equal(sessionModeOf(modes, 'session-x'), 'local')
  assert.equal(sessionModeOf(modes, 'session-y'), 'cloud', 'нет файла/записи — облачная')
  assert.equal(sessionModeOf(modes, 'session-y', new Map([['session-y', 'ws-1']])), 'local', 'умолчание пространства')
})

test('факты: название из лога (multi-frame zstd и plain JSONL)', () => {
  const bytes = Buffer.concat([
    zstdCompressSync(Buffer.from('{"type":"session","version":4,"id":"x"}\n', 'utf8')),
    zstdCompressSync(Buffer.from('{"type":"session/title","data":{"title":"  Из   лога "}}\n', 'utf8')),
  ])
  assert.equal(titleOfLogBytes(bytes), 'Из лога')
  assert.equal(titleOfLogBytes(Buffer.from('{"type":"session/title","data":{"title":"Plain"}}\n', 'utf8')), 'Plain')
  assert.equal(titleOfLogBytes(Buffer.from('')), '')
})

test('факты: каталоги логов, зеркало, карантин, проекции и режимы', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-expenses-facts-'))
  const writeLog = async (dir, header, events) => {
    await mkdir(dir, { recursive: true })
    const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))]
    for (const event of events) frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')))
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
  }
  try {
    // Локальный стор: название из session/title.
    await writeLog(join(home, 'sessions', '--root--', 'session-live'), { type: 'session', version: 4, id: 'session-live', createdAt: 1 }, [
      { type: 'session/title', seq: 1, data: { title: 'Живая сессия' } },
    ])
    // Зеркало + карантин: parent/root из session.json, название из лога.
    const deadDir = join(home, 'dsh-sync', 'repo', 'sessions', 'harness', '_deleted', 'session-dead')
    await mkdir(deadDir, { recursive: true })
    await writeFile(join(deadDir, 'session.json'), JSON.stringify({
      id: 'session-dead',
      title: 'Первое сообщение удалённой',
      parent: 'session-live',
      root: 'session-live',
      children: [],
    }))
    await writeLog(deadDir, { type: 'session', version: 4, id: 'session-dead', createdAt: 2 }, [
      { type: 'session/title', seq: 1, data: { title: 'Удалённая сессия' } },
    ])
    // Проекция: свёрнутое session/title.
    await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await writeFile(join(home, 'storages', 'session_projcache', 'sessions', 'session-proj.json'), JSON.stringify({
      record: { rows: { title: { val: 'Проекция сессии' } } },
    }))
    // Режимы: явный local + умолчание рабочего пространства.
    await mkdir(join(home, 'dsh-sync'), { recursive: true })
    await writeFile(join(home, 'dsh-sync', 'session-modes.json'), JSON.stringify({
      version: 2,
      sessions: { 'session-proj': 'local', 'session-live': 'cloud' },
      workspaces: { 'ws-1': 'local' },
    }))
    await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
      tables: { workspaces: { 'ws-1': { path: 'E:\\X', sessionIds: ['session-ws'] } } },
    }))

    let clock = 1_000
    const facts = createSessionFacts({ home, now: () => clock })
    const records = [
      { id: 'session-live', title: '', firstMessage: 'первое' },
      { id: 'session-dead', title: 'старое', titleSource: 'first-message', firstMessage: '' },
      { id: 'session-proj', title: '', firstMessage: '' },
      { id: 'session-ws', title: '', firstMessage: '' },
      { id: 'session-missing', title: 'Старое имя', titleSource: 'session/title', firstMessage: '' },
    ]
    const meta = await facts.describe(records, { snapshotTitles: new Map([['session-live', 'Снимок DSH']]) })
    assert.equal(meta.get('session-live').title, 'Снимок DSH', 'живой снимок важнее лога')
    assert.equal(meta.get('session-dead').title, 'Удалённая сессия', 'карантин: название из лога')
    assert.equal(meta.get('session-dead').titleSource, 'session/title')
    assert.equal(meta.get('session-dead').parentSession, 'session-live', 'родитель из session.json')
    assert.equal(meta.get('session-dead').lineageRoot, 'session-live')
    assert.equal(meta.get('session-dead').firstMessage, 'Первое сообщение удалённой', 'первое сообщение — в подсказку')
    assert.equal(meta.get('session-proj').title, 'Проекция сессии')
    assert.equal(meta.get('session-proj').local, true)
    assert.equal(meta.get('session-ws').local, true, 'умолчание рабочего пространства')
    assert.equal(meta.get('session-missing').title, 'Старое имя', 'старая запись архива не теряет имя')
    assert.equal(facts.indexSize(), 3, 'индекс нашёл три каталога сессий')

    // Кеш по mtime: правка проекции видна после перечитывания, каталог — по TTL.
    await writeFile(join(home, 'storages', 'session_projcache', 'sessions', 'session-proj.json'), JSON.stringify({
      record: { rows: { title: { val: 'Проекция переименована' } } },
    }))
    clock = 1_000 + 10_000
    const refreshed = await facts.describe([{ id: 'session-proj', title: '', firstMessage: '' }])
    assert.equal(refreshed.get('session-proj').title, 'Проекция переименована')

    // Восстановление каталога из карантина находится без перезапуска.
    facts.invalidate()
    clock = 1_000 + 20_000
    await writeLog(join(home, 'sessions', '--root--', 'session-restored'), { type: 'session', version: 4, id: 'session-restored', createdAt: 3 }, [
      { type: 'session/title', seq: 1, data: { title: 'Восстановленная' } },
    ])
    const restored = await facts.describe([{ id: 'session-restored', title: '', firstMessage: '' }])
    assert.equal(restored.get('session-restored').title, 'Восстановленная')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('host: readOverview сводит живое и архивное, пишет название и родителя в архив', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-expenses-overview-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'dsh-expenses'), { recursive: true })
    await writeFile(join(home, 'dsh-expenses', 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: {
        'session-root': row('session-root', { title: '', costUsd: 5, parentSession: '' }),
        'session-sub': row('session-sub', { title: '', costUsd: 2, parentSession: 'session-root' }),
        'session-dead': row('session-dead', { title: 'Удалённая', titleSource: 'session/title', costUsd: 1, archived: true }),
      },
    }))
    const liveHeader = { id: 'session-live', createdAt: Date.now(), origin: 'subagent', parentSession: 'session-root' }
    const sessionQuery = {
      async listSessions() {
        return [{ header: liveHeader, live: true }]
      },
      async readTitleSnapshots(ids) {
        return ids.map(id => (id === 'session-live'
          ? { sessionId: id, status: 'fulfilled', value: { title: { title: 'Живой субагент' } } }
          : { sessionId: id, status: 'rejected' }))
      },
      async readSession() {
        return { events: [], inheritedEventCount: 0 }
      },
    }
    const facts = {
      async describe() {
        return new Map([
          ['session-root', { title: 'Корень', titleSource: 'session/title', parentSession: '', firstMessage: 'первое' }],
          ['session-live', { title: 'Живой субагент', titleSource: 'session/title', parentSession: 'session-root', firstMessage: '' }],
          ['session-dead', { title: 'Удалённая', titleSource: 'session/title', parentSession: '', firstMessage: '' }],
        ])
      },
      invalidate() {},
    }
    const ctx = { get: () => sessionQuery }
    const overview = await readOverview(ctx, { facts, cache: new Map() })
    assert.equal(overview.sessions.length, 2, 'одна строка на логическую сессию')
    const sessions = byId(overview)
    const root = sessions.get('session-root')
    assert.equal(root.title, 'Корень')
    assert.equal(root.subagentCount, 2, 'живой и архивный субагенты вошли в родителя')
    assert.equal(root.costUsd, 7)
    assert.equal(root.local, false)
    assert.equal(sessions.get('session-dead').archived, true)
    assert.equal(overview.diagnostics.archiveRecords, 4, 'архив: три записи и новая живая сессия')
    assert.equal(overview.diagnostics.sessions, 2)
    assert.equal(overview.diagnostics.local, 0)

    // Архив получил название и родителя: удалённая сессия не потеряет связь.
    const saved = JSON.parse(await readFile(join(home, 'dsh-expenses', 'sessions.json'), 'utf8'))
    assert.equal(saved.sessions['session-root'].title, 'Корень')
    assert.equal(saved.sessions['session-sub'].parentSession, 'session-root')
    assert.equal(saved.sessions['session-dead'].archived, undefined, 'флаг «удалена» не закрепляется в архиве')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* Client-часть: бейджи, фильтр режима, разбивка и диагностика.        */
/* ------------------------------------------------------------------ */

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

function render(node) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(render)
  if (typeof node === 'object' && typeof node.type === 'function') return render(node.type(node.props ?? {}))
  if (typeof node === 'object' && node.props !== undefined) {
    return { ...node, props: { ...node.props, children: render(node.props.children) } }
  }
  return node
}

function texts(node, found = []) {
  if (node === null || node === undefined) return found
  if (typeof node === 'string' || typeof node === 'number') {
    found.push(String(node))
    return found
  }
  if (Array.isArray(node)) {
    for (const item of node) texts(item, found)
    return found
  }
  if (typeof node === 'object' && node.props !== undefined) texts(node.props.children, found)
  return found
}

function elements(node, found = []) {
  if (node === null || node === undefined) return found
  if (Array.isArray(node)) {
    for (const item of node) elements(item, found)
    return found
  }
  if (typeof node === 'object' && node.type !== undefined) {
    found.push(node)
    elements(node.props?.children, found)
  }
  return found
}

function withClass(tree, name) {
  return elements(tree).filter(node => typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(name))
}

async function loadClient() {
  const source = await readFile(new URL('client.js', ROOT), 'utf8')
  const captured = {}
  const storage = new Map()
  const sandbox = {
    window: {
      __ModuleLoader__: { load(options) { captured.options = options } },
      localStorage: {
        getItem: key => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key),
      },
    },
    console: { error: () => {}, warn: () => {}, log: () => {} },
    fetch: async () => { throw new Error('fetch не должен вызываться при рендере') },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  const module = captured.options.factory(name => {
    if (name === 'react') return fakeReact
    throw new Error(`неожиданный модуль ${name}`)
  })
  const ctx = {
    effect: callback => {
      callback()
      return () => {}
    },
    locale: { register() {}, bind() { return key => key } },
    slots: { inject(_name, callback) { return callback() }, register() { return () => {} } },
  }
  module.apply(ctx)
  const t = key => module.__test.DICT[key] ?? key
  return { module, source, t, test: module.__test }
}

/** Строка логической сессии с бейджами и разбивкой. */
function uiRow(overrides = {}) {
  return {
    id: 'session-row',
    title: 'Синхронизация сессий',
    titleSource: 'session/title',
    firstMessage: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    input: 100,
    cacheHit: 0,
    output: 50,
    requests: 2,
    toolCalls: 1,
    costUsd: 15,
    todayInput: 0,
    todayCacheHit: 0,
    todayOutput: 0,
    todayRequests: 0,
    todayToolCalls: 0,
    todayCostUsd: 0,
    models: [],
    local: false,
    copies: 0,
    subagentCount: 0,
    subagents: [],
    archived: false,
    error: false,
    ...overrides,
  }
}

test('клиент: «Без субагентов» убрано, вместо него «Показать разбивку по субагентам»', async () => {
  const { source, t, test: api } = await loadClient()
  assert.equal(api.DICT.hideSubagents, undefined, 'старого фильтра нет в словаре')
  assert.equal(t('showBreakdown'), 'Показать разбивку по субагентам')
  assert.equal(source.includes('hideSubagents'), false, 'кода старого фильтра не осталось')
  assert.equal(source.includes('Без субагентов'), false, 'старая подпись не осталась в исходнике')
  assert.equal(api.DEFAULT_FILTERS.mode, 'all')
  assert.deepEqual(Array.from(api.MODES), ['all', 'cloud', 'local'])
})

test('клиент: режимы в фильтре — все, облачные, локальные', async () => {
  const { test: api } = await loadClient()
  const rows = [
    uiRow({ id: 'cloud', title: 'Облачная', local: false }),
    uiRow({ id: 'local', title: 'Локальная', local: true, mode: 'local' }),
  ]
  const ids = list => list.map(item => item.id)
  assert.deepEqual(ids(api.filterSessions(rows, { ...api.DEFAULT_FILTERS, mode: 'all' })), ['cloud', 'local'])
  assert.deepEqual(ids(api.filterSessions(rows, { ...api.DEFAULT_FILTERS, mode: 'cloud' })), ['cloud'])
  assert.deepEqual(ids(api.filterSessions(rows, { ...api.DEFAULT_FILTERS, mode: 'local' })), ['local'])
})

test('клиент: строка показывает «локальная», «+N копий» и «субагентов: N»', async () => {
  const { t, test: api } = await loadClient()
  const row = uiRow({
    local: true,
    mode: 'local',
    archived: true,
    copies: 2,
    subagentCount: 3,
    subagents: [
      { id: 'a', title: 'Первый', depth: 1, costUsd: 2, local: true, copies: 0, subagents: 0 },
      { id: 'b', title: 'Второй', depth: 1, costUsd: 1, local: false, copies: 1, subagents: 0 },
      { id: 'c', title: 'Внук', depth: 2, costUsd: 0.5, local: false, copies: 0, subagents: 0 },
    ],
  })
  const tree = render(api.components.SessionRow({ row, cost: 15, symbol: '$', costOf: value => value, onToggleBreakdown: () => {}, t }))
  const text = texts(tree).join(' ')
  assert.match(text, /Синхронизация сессий/)
  assert.match(text, /локальная/, 'бейдж локальной сессии')
  assert.match(text, /удалена/, 'удалённая и локальная — разные бейджи')
  assert.match(text, /\+2 копии/)
  assert.match(text, /субагентов: 3/)
  const button = elements(tree).find(node => node.type === 'button' && texts(node).join('') === 'субагентов: 3')
  assert.ok(button, 'счётчик субагентов — кнопка раскрытия')
  assert.equal(button.props['aria-expanded'], 'false')
  assert.equal(typeof button.props.onClick, 'function')
  assert.match(String(tree.props.title), /Локальная сессия/, 'подсказка объясняет локальную сессию')
  assert.match(String(tree.props.title), /Удалённые сессии остаются/)
  assert.match(text, /15,00 \$/)
})

test('клиент: разбивка по субагентам раскрывается, итог строки не меняется', async () => {
  const { t, test: api } = await loadClient()
  const row = uiRow({
    costUsd: 15,
    subagentCount: 2,
    subagents: [
      { id: 'sub-1', title: 'Первый субагент', depth: 1, costUsd: 2, local: true, copies: 0, subagents: 0 },
      { id: 'sub-2', title: 'Второй субагент', depth: 1, costUsd: 3, local: false, copies: 2, subagents: 0 },
    ],
  })
  const collapsed = render(api.components.SessionRow({ row, cost: 15, symbol: '$', costOf: value => value, t }))
  assert.equal(withClass(collapsed, 'dsh-exp-breakdown').length, 0, 'по умолчанию разбивка свёрнута')
  assert.equal(texts(collapsed).join(' ').includes('Первый субагент'), false)

  const expanded = render(api.components.SessionRow({
    row,
    cost: 15,
    symbol: '$',
    costOf: value => value,
    breakdownExpanded: true,
    onToggleBreakdown: () => {},
    t,
  }))
  const rows = withClass(expanded, 'dsh-exp-breakdown-row')
  assert.equal(rows.length, 2, 'обе строки разбивки')
  const text = texts(expanded).join(' ')
  assert.match(text, /Первый субагент/)
  assert.match(text, /Второй субагент/)
  assert.match(text, /\+2 копии/)
  assert.match(text, /2,00 \$/)
  assert.match(text, /3,00 \$/)
  // Итог строки не зависит от раскрытия.
  const costOfRow = withClass(expanded, 'dsh-exp-cost-cell')
  assert.match(texts(costOfRow[0]).join(''), /15,00 \$/)
})

test('клиент: без названия — «Без названия», первое сообщение только в подсказке', async () => {
  const { t, test: api } = await loadClient()
  const row = uiRow({ title: '', titleSource: 'first-message', firstMessage: 'Ты работаешь в E:\\DeepSeek Harness' })
  const tree = render(api.components.SessionRow({ row, cost: 15, symbol: '$', t }))
  assert.match(texts(tree).join(' '), /Без названия/)
  assert.match(String(tree.props.title), /Первое сообщение: Ты работаешь/)
  assert.equal(texts(tree).join(' ').includes('Ты работаешь в E:\\DeepSeek'), false, 'первое сообщение не в колонке имени')
})

test('клиент: диагностика — архив, логические сессии, показано, локальные', async () => {
  const { t, test: api } = await loadClient()
  const diagnostics = {
    records: 110,
    archiveRecords: 110,
    sessions: 42,
    local: 2,
    cloud: 40,
    subagentRecords: 59,
    subagents: 59,
    copies: 12,
    titles: { sessionTitle: 40, firstMessage: 2, none: 0 },
  }
  const text = api.diagnosticsText(diagnostics, diagnostics.sessions, t)
  assert.match(text, /Записей в архиве: 110/)
  assert.match(text, /Сессий: 42/)
  assert.match(text, /показано: 42/, 'при пустых фильтрах показано = сессий')
  assert.match(text, /локальных: 2/)
  assert.equal(api.diagnosticsText(null, 0, t), '')
  // Когда фильтр сузил список, «показано» меньше числа сессий.
  const filtered = api.diagnosticsText(diagnostics, 7, t)
  assert.match(filtered, /показано: 7/)
})
