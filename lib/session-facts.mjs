/**
 * Факты о сессиях для «Расходов»: название из `session/title`, родитель,
 * режим «локальная/облачная».
 *
 * Архив панели хранит только цифры. Название, связь `parentSession` и режим
 * синхронизации лежат в других местах, и читать их нужно без живой сессии:
 *
 * 1. `~/.dsh/storages/session_projcache/sessions/<id>.json` — свёрнутое значение
 *    `session/title`, самое дешёвое и точное;
 * 2. лог `session.v4.jsonl.zstd` (локальный стор, зеркало, карантин) — первое
 *    событие `session/title` из первых мегабайт;
 * 3. `session.json` рядом с копией в зеркале — первое сообщение, `parent` и
 *    `root`; работает и для удалённых из карантина `_deleted`;
 * 4. `~/.dsh/dsh-sync/session-modes.json` — только чтение: `sessions` (явный
 *    режим) и `workspaces` (умолчание пространства).
 *
 * Разбор кешируется по пути + `mtime` + размеру: панель спрашивает названия при
 * каждом обновлении, а логи перечитывать незачем.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { open } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { normalizeTitle } from './aggregate.mjs'

export const MODES_FILE = 'session-modes.json'
export const MODES_VERSION = 2
export const MODE_LOCAL = 'local'
export const MODE_CLOUD = 'cloud'
export const LOG_NAME = 'session.v4.jsonl.zstd'
export const SIDECAR_NAME = 'session.json'
export const QUARANTINE_DIR = '_deleted'
/** Первые мегабайты лога: событие `session/title` идёт в начале. */
export const TITLE_READ_BYTES = 2 * 1024 * 1024
/** Сколько распакованного объёма разбираем в поисках названия. */
const TITLE_DECOMPRESSED_LIMIT = 48 * 1024 * 1024
/** Кеш «названий из логов» по пути и mtime. */
const TITLE_CACHE_LIMIT = 500
/** Индекс каталогов пересканируется не чаще этого срока. */
export const INDEX_TTL_MS = 4000
const TITLE_EVENT = 'session/title'

/** Каталог DSH: `DSH_HOME`, иначе `~/.dsh`. */
export function dshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured === '' ? join(homedir(), '.dsh') : configured
}

/** Канонический вид идентификатора: DSH хранит его с префиксом `session-`. */
export function normalizeSessionId(sessionId) {
  const text = String(sessionId ?? '').trim()
  if (text === '') return ''
  return text.startsWith('session-') ? text : `session-${text}`
}

/** Декодирование одного сегмента пути (`~XXXX`) — обратное к encodeSegment. */
export function decodeSegment(raw) {
  return String(raw ?? '').replace(/~([0-9A-Fa-f]{4})/gu, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/** Допустимый режим или undefined. */
function normalizeMode(value) {
  if (value === MODE_LOCAL) return MODE_LOCAL
  if (value === MODE_CLOUD) return MODE_CLOUD
  return undefined
}

/** Режим из значения записи: строка v2 или объект v3 (`{ mode }` / `{ local }`). */
function modeFromValue(value) {
  const direct = normalizeMode(value)
  if (direct !== undefined) return direct
  if (value === null || typeof value !== 'object') return undefined
  const mode = normalizeMode(value.mode)
  if (mode !== undefined) return mode
  if (value.local === true) return MODE_LOCAL
  if (value.local === false) return MODE_CLOUD
  return undefined
}

/**
 * Прочитать `session-modes.json` устойчиво к версиям 2 и 3.
 * Битый файл — пустая карта: режим не должен ломать бухгалтерию.
 */
export function parseSessionModes(text) {
  const empty = { version: MODES_VERSION, sessions: {}, workspaces: {} }
  if (typeof text !== 'string' || text.trim() === '') return empty
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return empty
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
  const sessions = {}
  const rawSessions = parsed.sessions ?? parsed.modes ?? parsed.items ?? {}
  if (Array.isArray(rawSessions)) {
    for (const item of rawSessions) {
      if (item === null || typeof item !== 'object') continue
      const id = normalizeSessionId(item.id ?? item.sessionId)
      const mode = modeFromValue(item)
      if (id !== '' && mode !== undefined) sessions[id] = mode
    }
  } else if (typeof rawSessions === 'object') {
    for (const [id, value] of Object.entries(rawSessions)) {
      const key = normalizeSessionId(id)
      const mode = modeFromValue(value)
      if (key !== '' && mode !== undefined) sessions[key] = mode
    }
  }
  const workspaces = {}
  for (const [id, value] of Object.entries(parsed.workspaces ?? {})) {
    const key = typeof id === 'string' ? id.trim() : ''
    const mode = modeFromValue(value)
    if (key !== '' && mode !== undefined) workspaces[key] = mode
  }
  return { version: Number(parsed.version) || MODES_VERSION, sessions, workspaces }
}

/**
 * Режим сессии: явная запись важнее умолчания рабочего пространства.
 * @param modes — результат parseSessionModes
 * @param sessionId — id сессии
 * @param workspaceById — Map id сессии → id рабочего пространства
 */
export function sessionModeOf(modes, sessionId, workspaceById) {
  const id = normalizeSessionId(sessionId)
  if (id === '') return MODE_CLOUD
  const explicit = modes?.sessions?.[id]
  if (explicit === MODE_LOCAL || explicit === MODE_CLOUD) return explicit
  const workspaceId = workspaceById instanceof Map ? workspaceById.get(id) : workspaceById?.[id]
  if (typeof workspaceId === 'string' && modes?.workspaces?.[workspaceId] === MODE_LOCAL) return MODE_LOCAL
  return MODE_CLOUD
}

function isZstdMagic(bytes, offset) {
  return bytes[offset] === 0x28 && bytes[offset + 1] === 0xb5 && bytes[offset + 2] === 0x2f && bytes[offset + 3] === 0xfd
}

/** Позиция следующего zstd-фрейма после `from` или -1. */
function nextFrameOffset(bytes, from) {
  for (let index = from; index + 4 <= bytes.length; index += 1) {
    if (isZstdMagic(bytes, index)) return index
  }
  return -1
}

/** Первое событие `session/title` из одной строки лога. */
function titleOfEventLine(line) {
  if (!line.includes(TITLE_EVENT)) return ''
  try {
    const event = JSON.parse(line)
    if (event?.type !== TITLE_EVENT) return ''
    return normalizeTitle(event?.data?.title)
  } catch {
    return ''
  }
}

/**
 * Название из первых байтов лога: читаем zstd-фреймы подряд и запоминаем
 * ПОСЛЕДНЕЕ событие `session/title` (DSH сначала пишет предварительное имя —
 * первое сообщение, затем настоящее). Обрезанный хвост просто пропускаем.
 */
export function titleOfLogBytes(bytes, options = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return ''
  const limit = Number.isFinite(options.maxBytes) ? options.maxBytes : TITLE_READ_BYTES
  const view = bytes.length > limit ? bytes.subarray(0, limit) : bytes
  if (!isZstdMagic(view, 0)) {
    let latest = ''
    for (const line of view.toString('utf8').split('\n')) {
      const title = titleOfEventLine(line)
      if (title !== '') latest = title
    }
    return latest
  }
  let offset = 0
  let decompressed = 0
  let latest = ''
  while (offset >= 0 && offset + 4 <= view.length) {
    const end = nextFrameOffset(view, offset + 4)
    const frameEnd = end === -1 ? view.length : end
    let text
    try {
      text = zstdDecompressSync(view.subarray(offset, frameEnd)).toString('utf8')
    } catch {
      return latest
    }
    decompressed += text.length
    if (decompressed > TITLE_DECOMPRESSED_LIMIT) return latest
    for (const line of text.split('\n')) {
      const title = titleOfEventLine(line)
      if (title !== '') latest = title
    }
    if (end === -1) break
    offset = end
  }
  return latest
}

/** Первые `maxBytes` файла: большие логи целиком не грузим. */
async function readPrefix(path, maxBytes = TITLE_READ_BYTES) {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    const size = Math.min(info.size, Math.max(0, maxBytes))
    const buffer = Buffer.alloc(size)
    if (size > 0) await handle.read(buffer, 0, size, 0)
    return { bytes: buffer, info }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Хвост файла: поздние переименования сессии могут быть далеко от начала. */
async function readSuffix(path, maxBytes = 512 * 1024) {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    const size = Math.min(info.size, Math.max(0, maxBytes))
    if (size <= 0) return { bytes: Buffer.alloc(0), info }
    const buffer = Buffer.alloc(size)
    await handle.read(buffer, 0, size, info.size - size)
    return { bytes: buffer, info }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Прочитать диапазон файла [start, end). */
async function readRange(path, start, end) {
  const handle = await open(path, 'r')
  try {
    const length = Math.max(0, end - start)
    if (length === 0) return Buffer.alloc(0)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    return buffer
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Последнее название из файла: окна от конца (1, 4, 16, 64 МБ…), пока не
 * найдётся событие `session/title`. Поздние переименования не теряются,
 * а весь большой лог не читается.
 */
async function lastTitleFromTail(path, size) {
  let window = 1024 * 1024
  while (true) {
    const start = Math.max(0, size - window)
    const bytes = await readRange(path, start, size)
    let from = -1
    for (let index = 0; index + 4 <= bytes.length; index += 1) {
      if (isZstdMagic(bytes, index)) { from = index; break }
    }
    const view = from === -1 ? bytes : bytes.subarray(from)
    const title = titleOfLogBytes(view)
    if (title !== '') return title
    if (start === 0) return ''
    window *= 4
  }
}

/** Читать JSON-файл, вернув undefined при любой ошибке. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Пути, которые просматривает индекс. */
export function sessionRoots(home) {
  return {
    store: join(home, 'sessions'),
    mirror: join(home, 'dsh-sync', 'repo', 'sessions'),
    deleted: join(home, 'dsh-sync', 'deleted'),
    projcache: join(home, 'storages', 'session_projcache', 'sessions'),
    modes: join(home, 'dsh-sync', MODES_FILE),
    workspace: join(home, 'storages', 'workspace.json'),
  }
}

async function listDirs(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory())
  } catch {
    return []
  }
}

/**
 * Индекс «id сессии → где лежат её файлы». Только имена каталогов: сами логи
 * читаются лениво и с кешем.
 */
async function buildIndex(home) {
  const roots = sessionRoots(home)
  const index = new Map()
  const entryOf = (id) => {
    if (!index.has(id)) index.set(id, { logs: [], sides: [], projcache: '' })
    return index.get(id)
  }
  // Локальный стор: sessions/<bucket>/<id>/session.v4.jsonl.zstd
  for (const bucket of await listDirs(roots.store)) {
    for (const session of await listDirs(join(roots.store, bucket.name))) {
      const id = decodeSegment(session.name)
      const log = join(roots.store, bucket.name, session.name, LOG_NAME)
      if (existsSync(log)) entryOf(id).logs.push(log)
    }
  }
  // Зеркало: sessions/<project>/<id>/ и карантин sessions/<project>/_deleted/<id>/
  for (const project of await listDirs(roots.mirror)) {
    const projectDir = join(roots.mirror, project.name)
    for (const item of await listDirs(projectDir)) {
      if (item.name === QUARANTINE_DIR) {
        for (const dead of await listDirs(join(projectDir, QUARANTINE_DIR))) {
          const id = decodeSegment(dead.name)
          const dir = join(projectDir, QUARANTINE_DIR, dead.name)
          entryOf(id).sides.push(dir)
          if (existsSync(join(dir, LOG_NAME))) entryOf(id).logs.push(join(dir, LOG_NAME))
        }
        continue
      }
      const id = decodeSegment(item.name)
      const dir = join(projectDir, item.name)
      entryOf(id).sides.push(dir)
      if (existsSync(join(dir, LOG_NAME))) entryOf(id).logs.push(join(dir, LOG_NAME))
    }
  }
  // Корзина синхронизации: deleted/<timestamp>/<id>/session.v4.jsonl.zstd
  for (const stamp of await listDirs(roots.deleted)) {
    for (const dead of await listDirs(join(roots.deleted, stamp.name))) {
      const id = decodeSegment(dead.name)
      const log = join(roots.deleted, stamp.name, dead.name, LOG_NAME)
      if (existsSync(log)) entryOf(id).logs.push(log)
    }
  }
  // Проекция сессии: storages/session_projcache/sessions/<id>.json
  try {
    const files = await readdir(roots.projcache)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const id = decodeSegment(file.slice(0, -'.json'.length))
      entryOf(id).projcache = join(roots.projcache, file)
    }
  } catch {
    // Проекции может не быть — это не ошибка.
  }
  return index
}

/**
 * Собрать факты о сессиях.
 *
 * @param options.home каталог DSH (по умолчанию `DSH_HOME` или `~/.dsh`)
 * @param options.now функция времени — для тестов TTL
 * @returns {{ describe: Function, invalidate: Function, indexSize: Function }}
 */
export function createSessionFacts(options = {}) {
  const home = typeof options.home === 'string' && options.home !== '' ? options.home : dshHome()
  const roots = sessionRoots(home)
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const sidecars = new Map()
  const projTitles = new Map()
  const logTitles = new Map()
  let index = null
  let indexedAt = 0
  let workspaceMap = null
  let workspaceAt = 0

  /** Сбросить всё, что запомнено: тесты и «Обновить» после переноса каталога. */
  function invalidate() {
    sidecars.clear()
    projTitles.clear()
    logTitles.clear()
    index = null
    indexedAt = 0
    workspaceMap = null
    workspaceAt = 0
  }

  async function ensureIndex() {
    const moment = now()
    if (index !== null && moment - indexedAt < INDEX_TTL_MS) return index
    index = await buildIndex(home)
    indexedAt = moment
    return index
  }

  function putBounded(cache, key, value) {
    if (cache.size >= TITLE_CACHE_LIMIT && !cache.has(key)) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(key, value)
  }

  /** `session.json` зеркала: название первого сообщения, parent/root. */
  async function readSidecar(dir) {
    const file = join(dir, SIDECAR_NAME)
    let info
    try {
      info = await stat(file)
    } catch {
      return undefined
    }
    const cached = sidecars.get(file)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value
    const parsed = await readJson(file)
    const value = parsed !== null && typeof parsed === 'object'
      ? {
          title: normalizeTitle(parsed.title),
          parent: typeof parsed.parent === 'string' ? parsed.parent.trim() : '',
          root: typeof parsed.root === 'string' ? parsed.root.trim() : '',
          children: Array.isArray(parsed.children) ? parsed.children.filter(child => typeof child === 'string') : [],
        }
      : undefined
    putBounded(sidecars, file, { mtimeMs: info.mtimeMs, size: info.size, value })
    return value
  }

  /** Свёрнутое `session/title` из проекции сессии. */
  async function readProjcacheTitle(file) {
    let info
    try {
      info = await stat(file)
    } catch {
      return ''
    }
    const cached = projTitles.get(file)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.title
    const parsed = await readJson(file)
    const title = normalizeTitle(parsed?.record?.rows?.title?.val)
    putBounded(projTitles, file, { mtimeMs: info.mtimeMs, size: info.size, title })
    return title
  }

  /** Название из лога с кешем по пути и mtime. */
  async function readLogTitle(file) {
    let info
    try {
      info = await stat(file)
    } catch {
      return ''
    }
    const cached = logTitles.get(file)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.title
    let title = ''
    try {
      const prefix = await readPrefix(file)
      title = titleOfLogBytes(prefix.bytes)
      // Позднее переименование может быть далеко от начала — ищем последнее.
      if (info.size > TITLE_READ_BYTES) {
        const tailTitle = await lastTitleFromTail(file, info.size)
        if (tailTitle !== '') title = tailTitle
      }
    } catch {
      title = ''
    }
    putBounded(logTitles, file, { mtimeMs: info.mtimeMs, size: info.size, title })
    return title
  }

  /** Режимы синхронизации: файл читается каждый раз, он маленький. */
  async function loadModes() {
    let text = ''
    try {
      text = await readFile(roots.modes, 'utf8')
    } catch {
      text = ''
    }
    const modes = parseSessionModes(text)
    const moment = now()
    if (workspaceMap === null || moment - workspaceAt > INDEX_TTL_MS) {
      const parsed = await readJson(roots.workspace)
      const map = new Map()
      const table = parsed?.tables?.workspaces
      if (table !== null && typeof table === 'object') {
        for (const [workspaceId, record] of Object.entries(table)) {
          for (const sessionId of Array.isArray(record?.sessionIds) ? record.sessionIds : []) {
            const key = normalizeSessionId(sessionId)
            if (key !== '' && !map.has(key)) map.set(key, workspaceId)
          }
        }
      }
      workspaceMap = map
      workspaceAt = moment
    }
    return { modes, workspaceById: workspaceMap }
  }

  /**
   * Факты по списку записей.
   * @param records — записи архива/каталога (поля id, title, firstMessage, parentSession)
   * @param hints.snapshotTitles — Map id → название из `readTitleSnapshots` (session/title)
   * @returns Map id → { title, titleSource, firstMessage, parentSession, lineageRoot, local, mode }
   */
  async function describe(records, hints = {}) {
    const snapshotTitles = hints.snapshotTitles instanceof Map ? hints.snapshotTitles : new Map()
    const list = (Array.isArray(records) ? records : []).filter(record => record !== null && typeof record === 'object')
    const indexNow = await ensureIndex()
    const { modes, workspaceById } = await loadModes()
    const recordById = new Map(list.map(record => [record.id, record]))

    // Родитель может отсутствовать в списке записей: его метаданные нужны,
    // чтобы субагент вошёл в строку потерянного родителя.
    const sidecarById = new Map()
    const wanted = new Set()
    for (const record of list) {
      const id = String(record.id ?? '').trim()
      if (id === '') continue
      wanted.add(id)
      const entry = indexNow.get(id)
      if (entry !== undefined) {
        for (const dir of entry.sides) {
          const sidecar = await readSidecar(dir)
          if (sidecar !== undefined) {
            sidecarById.set(id, sidecar)
            break
          }
        }
      }
      const parent = record.parentSession || sidecarById.get(id)?.parent || ''
      if (parent !== '') wanted.add(parent)
    }

    const meta = new Map()
    for (const id of wanted) {
      const record = recordById.get(id) ?? { id }
      const entry = indexNow.get(id) ?? { logs: [], sides: [], projcache: '' }
      const sidecar = sidecarById.get(id)
      let title = ''
      let titleSource = 'none'
      // 1. Живой каталог DSH уже знает название.
      const snapshot = normalizeTitle(snapshotTitles.get(id))
      if (snapshot !== '') {
        title = snapshot
        titleSource = 'session/title'
      }
      // 2. Проекция сессии — свёрнутое session/title.
      if (title === '' && entry.projcache !== '') {
        const projected = await readProjcacheTitle(entry.projcache)
        if (projected !== '') {
          title = projected
          titleSource = 'session/title'
        }
      }
      // 3. Лог: первое событие session/title (включая карантин).
      if (title === '') {
        for (const log of entry.logs) {
          const fromLog = await readLogTitle(log)
          if (fromLog !== '') {
            title = fromLog
            titleSource = 'session/title'
            break
          }
        }
      }
      // 4. session.json зеркала — первое сообщение, не имя сессии.
      if (title === '' && sidecar !== undefined && sidecar.title !== '') {
        title = sidecar.title
        titleSource = 'first-message'
      }
      // 5. Старая запись архива: своё название и источник, если он записан.
      if (title === '' && normalizeTitle(record.title) !== '') {
        title = normalizeTitle(record.title)
        titleSource = record.titleSource === 'session/title' ? 'session/title' : 'first-message'
      }
      if (title === '') titleSource = 'none'
      const firstMessage = normalizeTitle(record.firstMessage)
        || (sidecar !== undefined ? sidecar.title : '')
        || (titleSource === 'first-message' ? title : '')
      const parentSession = record.parentSession || sidecar?.parent || ''
      const lineageRoot = sidecar !== undefined && sidecar.root !== '' && sidecar.root !== id ? sidecar.root : ''
      const mode = sessionModeOf(modes, id, workspaceById)
      meta.set(id, {
        title: titleSource === 'session/title' ? title : '',
        titleSource,
        firstMessage,
        parentSession,
        lineageRoot,
        local: mode === MODE_LOCAL,
        mode,
      })
    }
    return meta
  }

  return {
    describe,
    invalidate,
    indexSize: () => (index === null ? 0 : index.size),
    home,
    roots,
  }
}
