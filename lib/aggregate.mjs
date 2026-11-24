/**
 * Логические сессии «Расходов»: одна строка на сессию, а не на каждый процесс.
 *
 * Архив хранит по записи на каждую сессию DSH — включая субагентов и копии,
 * появившиеся после восстановления/импорта. Панель должна показывать столько
 * строк, сколько было логических сессий:
 *
 * 1. явная связь `parentSession` — субагент всегда входит в родителя;
 * 2. копии одной линии (`createdAt` + нормализованное название) **не складываются**:
 *    берётся экземпляр с максимальной стоимостью;
 * 3. `contentHash`, когда он есть, связывает точные копии;
 * 4. удалённые сессии (карантин) считаются как обычные: их записи лежат в архиве.
 *
 * Модуль чистый: никакого файлового доступа, поэтому правила проверяются тестами
 * без стенда DSH. Источники названий и режимов «локальная/облачная» подставляет
 * вызывающий (`meta`).
 */

/** Максимальная глубина цепочки родителей: защита от битых и циклических ссылок. */
export const MAX_LINEAGE_DEPTH = 3

/** Допустимые источники названия — ровно те, что показывает панель. */
export const TITLE_SOURCE_SESSION = 'session/title'
export const TITLE_SOURCE_FIRST_MESSAGE = 'first-message'
export const TITLE_SOURCE_NONE = 'none'

/** Длина названия, после которой оно обрезается. */
export const MAX_TITLE_LENGTH = 160

/** Схлопнуть пробелы и обрезать название; не-строка — пустая строка. */
export function normalizeTitle(value) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/gu, ' ').trim()
  return text.length > MAX_TITLE_LENGTH ? text.slice(0, MAX_TITLE_LENGTH - 1) + '…' : text
}

/**
 * Ключ сравнения названий: регистр и пунктуация не мешают копиям сходиться.
 * Название — только признак копии; линия всё равно строится по родителю/хешу.
 */
export function titleKey(value) {
  const text = normalizeTitle(value).toLocaleLowerCase('ru-RU')
  if (text === '') return ''
  return text.replace(/[.,;:!?«»"'`()\[\]{}…—–-]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120)
}

/** Есть ли у записи явный родитель (субагент). */
export function parentOfRecord(record) {
  if (record === null || typeof record !== 'object') return ''
  const parent = typeof record.parentSession === 'string' ? record.parentSession.trim() : ''
  if (parent === '' || parent === record.id) return ''
  return parent
}

/** Приоритет источника названия: `session/title` важнее первого сообщения. */
export function titleSourceRank(source) {
  if (source === TITLE_SOURCE_SESSION) return 2
  if (source === TITLE_SOURCE_FIRST_MESSAGE) return 1
  return 0
}

/** Счётчик «1 копия / 2 копии / 5 копий». */
export function pluralRu(value, forms) {
  const number = Math.abs(Math.trunc(Number(value) || 0))
  const tail = number % 100
  if (tail >= 11 && tail <= 14) return forms[2]
  const last = number % 10
  if (last === 1) return forms[0]
  if (last >= 2 && last <= 4) return forms[1]
  return forms[2]
}

/** Число или 0 для суммирования. */
function num(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/** Стоимость для сравнения: `null` (цены нет) всегда ниже известной. */
function costRank(value) {
  if (value === null || value === undefined) return Number.NEGATIVE_INFINITY
  const number = Number(value)
  return Number.isFinite(number) ? number : Number.NEGATIVE_INFINITY
}

/**
 * «Самый полный» экземпляр узла: максимальная стоимость, при равенстве — живой,
 * затем более свежий, затем меньший id (детерминизм на двух устройствах).
 */
export function bestInstance(records) {
  const list = (Array.isArray(records) ? records : []).filter(record => record !== null && typeof record === 'object')
  if (list.length === 0) return null
  return [...list].sort((left, right) => {
    const byCost = costRank(right.costUsd) - costRank(left.costUsd)
    if (byCost !== 0) return byCost
    const liveLeft = left.archived === true ? 1 : 0
    const liveRight = right.archived === true ? 1 : 0
    if (liveLeft !== liveRight) return liveLeft - liveRight
    const byUpdated = num(right.updatedAt) - num(left.updatedAt)
    if (byUpdated !== 0) return byUpdated
    return String(left.id ?? '').localeCompare(String(right.id ?? ''))
  })[0]
}

/** Название лучшего экземпляра: чем выше источник, тем важнее; пустое — не имя. */
export function bestTitle(records) {
  let chosen = { title: '', titleSource: TITLE_SOURCE_NONE, rank: -1 }
  for (const record of Array.isArray(records) ? records : []) {
    if (record === null || typeof record !== 'object') continue
    const title = normalizeTitle(record.title)
    if (title === '') continue
    const source = record.titleSource === TITLE_SOURCE_SESSION || record.titleSource === TITLE_SOURCE_FIRST_MESSAGE
      ? record.titleSource
      : TITLE_SOURCE_NONE
    const rank = titleSourceRank(source)
    if (rank <= chosen.rank) continue
    chosen = { title, titleSource: source, rank }
  }
  // Первое сообщение — не имя: в панели такая строка будет «Без названия».
  if (chosen.titleSource !== TITLE_SOURCE_SESSION) {
    return { title: '', titleSource: chosen.titleSource === TITLE_SOURCE_FIRST_MESSAGE ? TITLE_SOURCE_FIRST_MESSAGE : TITLE_SOURCE_NONE }
  }
  return { title: chosen.title, titleSource: TITLE_SOURCE_SESSION }
}

/** Первое сообщение для подсказки: не-строка или пустое — ''. */
export function firstMessageOf(records) {
  for (const record of Array.isArray(records) ? records : []) {
    if (record === null || typeof record !== 'object') continue
    const text = normalizeTitle(record.firstMessage)
    if (text !== '') return text
  }
  return ''
}

/**
 * Ключ линии записи-корня. Копии без явного родителя сходятся по contentHash или
 * по `createdAt` + название. Название в ключ родительских записей не входит:
 * оно меняется при переименовании копии.
 */
export function copyKeyOf(record) {
  if (record === null || typeof record !== 'object') return ''
  const hash = typeof record.contentHash === 'string' ? record.contentHash.trim() : ''
  if (hash !== '') return `hash:${hash}`
  const createdAt = num(record.createdAt)
  if (createdAt > 0) return `ct:${createdAt}:${titleKey(record.title)}`
  return `id:${String(record.id ?? '')}`
}

/** Ключ линии записи: копии корня сходятся по copyKeyOf, остальные — по корню. */
export function lineageKeyOf(record) {
  if (record === null || typeof record !== 'object') return ''
  const parent = parentOfRecord(record)
  if (parent !== '') return `root:${parent}`
  return copyKeyOf(record)
}

/**
 * Корень линии: идём вверх по `parentSession` не глубже `maxDepth`.
 * Возвращает id корня и глубину записи (0 — корень, 1 — субагент первого уровня).
 */
export function resolveRoot(parentById, sessionId, maxDepth = MAX_LINEAGE_DEPTH) {
  let current = String(sessionId ?? '')
  let depth = 0
  const seen = new Set(current === '' ? [] : [current])
  while (depth < maxDepth) {
    const parent = typeof parentById?.get === 'function' ? parentById.get(current) : undefined
    if (typeof parent !== 'string' || parent === '' || seen.has(parent)) break
    seen.add(parent)
    current = parent
    depth += 1
  }
  return { root: current, depth }
}

/** Итог узла: сумма по всем числовым полям, стоимость — только если она известна. */
function emptyTotals() {
  return {
    input: 0,
    cacheHit: 0,
    output: 0,
    requests: 0,
    toolCalls: 0,
    todayInput: 0,
    todayCacheHit: 0,
    todayOutput: 0,
    todayRequests: 0,
    todayToolCalls: 0,
    costUsd: null,
    todayCostUsd: null,
    updatedAt: 0,
    models: [],
    local: false,
    archived: true,
    records: [],
    nodes: 0,
  }
}

/** Добавить поля одной записи к итогу узла. */
function addRecordFields(total, record) {
  total.input += num(record.input)
  total.cacheHit += num(record.cacheHit)
  total.output += num(record.output)
  total.requests += num(record.requests)
  total.toolCalls += num(record.toolCalls)
  total.todayInput += num(record.todayInput)
  total.todayCacheHit += num(record.todayCacheHit)
  total.todayOutput += num(record.todayOutput)
  total.todayRequests += num(record.todayRequests)
  total.todayToolCalls += num(record.todayToolCalls)
  const cost = record.costUsd
  if (cost !== null && cost !== undefined && Number.isFinite(Number(cost))) {
    total.costUsd = (total.costUsd ?? 0) + Number(cost)
  }
  const todayCost = record.todayCostUsd
  if (todayCost !== null && todayCost !== undefined && Number.isFinite(Number(todayCost))) {
    total.todayCostUsd = (total.todayCostUsd ?? 0) + Number(todayCost)
  }
  total.updatedAt = Math.max(total.updatedAt, num(record.updatedAt))
  for (const model of Array.isArray(record.models) ? record.models : []) {
    if (typeof model === 'string' && model !== '' && total.models.length < 12 && !total.models.includes(model)) total.models.push(model)
  }
}

/** Источник режима: явный local у записи/метаданных. */
function isLocalRecord(record, meta) {
  if (record !== null && record.local === true) return true
  if (record !== null && record.mode === 'local') return true
  return meta.local === true
}

/**
 * Схлопнуть записи в логические сессии.
 *
 * @param records — записи архива и живого каталога; поля: id, title,
 *   titleSource, firstMessage, createdAt, updatedAt, parentSession, contentHash,
 *   archived, local/mode, input/cacheHit/output/requests/toolCalls/costUsd,
 *   today*-поля, models.
 * @param options.meta — Map id → { title?, titleSource?, firstMessage?, parentSession?,
 *   lineageRoot?, local?, mode? } — данные из лога/зеркала/карантина.
 * @param options.liveIds — Set id живых сессий (отличает «удалена» от живой строки).
 * @returns {{ sessions: Array<object>, diagnostics: object }}
 */
export function aggregateSessions(records, options = {}) {
  const meta = options.meta instanceof Map ? options.meta : new Map()
  const liveIds = options.liveIds instanceof Set ? options.liveIds : null
  const list = []
  const seenIds = new Set()
  for (const record of Array.isArray(records) ? records : []) {
    if (record === null || typeof record !== 'object') continue
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (id === '' || seenIds.has(id)) continue
    seenIds.add(id)
    const entry = meta.get(id)
    const parent = parentOfRecord(record) || (typeof entry?.parentSession === 'string' ? entry.parentSession.trim() : '')
    const lineageRoot = typeof entry?.lineageRoot === 'string' ? entry.lineageRoot.trim() : ''
    list.push({
      ...record,
      id,
      title: normalizeTitle(entry?.title ?? record.title),
      titleSource: entry?.titleSource ?? record.titleSource,
      firstMessage: normalizeTitle(entry?.firstMessage ?? record.firstMessage),
      parentSession: parent,
      lineageRoot,
      local: isLocalRecord(record, entry ?? {}),
    })
  }

  // Связи родитель → ребёнок: явный parentSession главнее, lineageRoot из
  // зеркала подстраховывает записи без заголовка.
  const parentById = new Map()
  for (const record of list) {
    if (record.parentSession !== '') parentById.set(record.id, record.parentSession)
    else if (record.lineageRoot !== '' && record.lineageRoot !== record.id) parentById.set(record.id, record.lineageRoot)
  }

  // Группы линий. Копии корня сходятся по copyKeyOf (contentHash / createdAt +
  // название), поэтому субагенты копий попадают в ту же строку, что оригинал.
  const recordById = new Map(list.map(record => [record.id, record]))
  const rootOfRecord = new Map()
  const groupKeyByRoot = new Map()
  const groupKeyOfRoot = (rootId) => {
    const known = groupKeyByRoot.get(rootId)
    if (known !== undefined) return known
    const rootRecord = recordById.get(rootId)
    const key = rootRecord === undefined ? `missing:${rootId}` : copyKeyOf(rootRecord)
    groupKeyByRoot.set(rootId, key)
    return key
  }
  const groups = new Map()
  const infoById = new Map()
  for (const record of list) {
    const { root, depth } = resolveRoot(parentById, record.id)
    rootOfRecord.set(record.id, root)
    const info = { root, depth, key: groupKeyOfRoot(root) }
    infoById.set(record.id, info)
    if (!groups.has(info.key)) groups.set(info.key, [])
    groups.get(info.key).push(record)
  }

  const sessions = []
  for (const [key, groupRecords] of groups) {
    const virtualRoot = key.startsWith('missing:') ? key.slice('missing:'.length) : ''
    const rootRecords = virtualRoot !== ''
      ? []
      : groupRecords.filter(record => record.parentSession === '' && rootOfRecord.get(record.id) === record.id)
    // Канонический id строки: у линии с сохранившимся корнем — лучший экземпляр
    // копий, у потерянного родителя — его id из parentSession.
    const canonical = virtualRoot !== ''
      ? virtualRoot
      : (bestInstance(rootRecords)?.id ?? groupRecords[0].id)
    const rootNodeId = canonical
    // Узлы группы: корень + по узлу на каждого субагента; копии — экземпляры узла.
    const ordered = [...groupRecords].sort((left, right) => {
      const depthLeft = infoById.get(left.id)?.depth ?? 0
      const depthRight = infoById.get(right.id)?.depth ?? 0
      return depthLeft - depthRight || String(left.id).localeCompare(String(right.id))
    })
    const nodeByRecord = new Map()
    const nodes = new Map()
    const ensureNode = (nodeId, parentNodeId, depth) => {
      if (!nodes.has(nodeId)) nodes.set(nodeId, { id: nodeId, parentNodeId, children: [], records: [], depth })
      return nodes.get(nodeId)
    }
    ensureNode(rootNodeId, '', 0)
    for (const record of ordered) {
      const info = infoById.get(record.id) ?? { depth: 0 }
      const parent = record.parentSession
      if (parent === '') {
        // Копия той же логической сессии — второй экземпляр узла корня.
        nodeByRecord.set(record.id, rootNodeId)
        ensureNode(rootNodeId, '', 0).records.push(record)
        continue
      }
      if (record.id === rootNodeId) {
        // Родитель за пределами ограничения глубины: запись — корень своей линии.
        nodeByRecord.set(record.id, rootNodeId)
        ensureNode(rootNodeId, '', 0).records.push(record)
        continue
      }
      // Ближайший предок, у которого есть свой узел в группе.
      let current = parent
      let parentNodeId = rootNodeId
      const seenChain = new Set()
      while (current !== '' && !seenChain.has(current)) {
        seenChain.add(current)
        const known = nodeByRecord.get(current)
        if (known !== undefined) {
          parentNodeId = known
          break
        }
        if (current === rootNodeId) break
        const next = parentById.get(current)
        if (next === undefined) break
        current = next
      }
      const parentNode = nodes.get(parentNodeId) ?? ensureNode(rootNodeId, '', 0)
      const nodeId = `n:${parentNodeId}:${num(record.createdAt)}:${titleKey(record.title)}`
      const node = ensureNode(nodeId, parentNodeId, (parentNode.depth ?? 0) + 1)
      node.records.push(record)
      nodeByRecord.set(record.id, nodeId)
    }
    for (const node of nodes.values()) {
      if (node.parentNodeId === '') continue
      const parentNode = nodes.get(node.parentNodeId)
      if (parentNode !== undefined) parentNode.children.push(node.id)
    }

    // Итоги снизу вверх: экземпляр с максимальной стоимостью + все субагенты.
    const totalsById = new Map()
    const compute = (nodeId, guard = new Set()) => {
      if (totalsById.has(nodeId)) return totalsById.get(nodeId)
      const node = nodes.get(nodeId)
      if (node === undefined || guard.has(nodeId)) return emptyTotals()
      guard.add(nodeId)
      const total = emptyTotals()
      const instance = bestInstance(node.records)
      if (instance !== null) {
        addRecordFields(total, instance)
        total.local = node.records.some(record => record.local === true)
        total.archived = node.records.every(record => record.archived === true)
      } else {
        total.costUsd = null
        total.todayCostUsd = null
        total.archived = true
        const parentMeta = meta.get(nodeId)
        total.local = parentMeta?.local === true || parentMeta?.mode === 'local'
      }
      total.records = node.records
      total.nodes = 1
      for (const childId of node.children) {
        const childTotal = compute(childId, guard)
        total.input += childTotal.input
        total.cacheHit += childTotal.cacheHit
        total.output += childTotal.output
        total.requests += childTotal.requests
        total.toolCalls += childTotal.toolCalls
        total.todayInput += childTotal.todayInput
        total.todayCacheHit += childTotal.todayCacheHit
        total.todayOutput += childTotal.todayOutput
        total.todayRequests += childTotal.todayRequests
        total.todayToolCalls += childTotal.todayToolCalls
        if (childTotal.costUsd !== null) total.costUsd = (total.costUsd ?? 0) + childTotal.costUsd
        if (childTotal.todayCostUsd !== null) total.todayCostUsd = (total.todayCostUsd ?? 0) + childTotal.todayCostUsd
        total.updatedAt = Math.max(total.updatedAt, childTotal.updatedAt)
        for (const model of childTotal.models) {
          if (total.models.length < 12 && !total.models.includes(model)) total.models.push(model)
        }
        total.nodes += childTotal.nodes
        if (childTotal.local === true) total.local = true
        if (childTotal.archived !== true) total.archived = false
      }
      totalsById.set(nodeId, total)
      guard.delete(nodeId)
      return total
    }

    const rootNode = nodes.get(rootNodeId) ?? ensureNode(rootNodeId, '', 0)
    const totals = compute(rootNodeId)
    const metaOf = (id) => (meta instanceof Map ? meta.get(id) : undefined)
    /** Название из метаданных (лог/зеркало) — подстраховка для потерянного родителя. */
    const metaTitleOf = (id) => {
      const entry = metaOf(id)
      const title = normalizeTitle(entry?.title)
      if (title !== '' && entry?.titleSource === TITLE_SOURCE_SESSION) return { title, titleSource: TITLE_SOURCE_SESSION }
      return {
        title: '',
        titleSource: entry?.titleSource === TITLE_SOURCE_FIRST_MESSAGE ? TITLE_SOURCE_FIRST_MESSAGE : TITLE_SOURCE_NONE,
      }
    }
    // «Локальная» наследуется вниз: субагент локального родителя тоже локальный.
    const localById = new Map()
    const fillLocal = (nodeId, inherited) => {
      const node = nodes.get(nodeId)
      const own = inherited || (node?.records ?? []).some(record => record.local === true)
      localById.set(nodeId, own)
      for (const childId of node?.children ?? []) fillLocal(childId, own)
    }
    const metaLocal = (id) => metaOf(id)?.local === true || metaOf(id)?.mode === 'local'
    fillLocal(rootNodeId, metaLocal(rootNodeId))
    const rowLocal = localById.get(rootNodeId) === true

    // Разбивка по субагентам: все потомки корня по порядку обхода.
    const breakdown = []
    const walk = (nodeId, depth) => {
      const node = nodes.get(nodeId)
      if (node === undefined) return
      for (const childId of node.children) {
        const child = nodes.get(childId)
        const childTotals = compute(childId)
        const instance = bestInstance(child.records)
        const ownTitle = bestTitle(child.records)
        const titleInfo = ownTitle.titleSource === TITLE_SOURCE_NONE ? metaTitleOf(childId) : ownTitle
        breakdown.push({
          id: childId,
          title: titleInfo.title,
          titleSource: titleInfo.titleSource,
          firstMessage: firstMessageOf(child.records) || normalizeTitle(metaOf(childId)?.firstMessage),
          depth,
          input: childTotals.input,
          cacheHit: childTotals.cacheHit,
          output: childTotals.output,
          requests: childTotals.requests,
          toolCalls: childTotals.toolCalls,
          costUsd: childTotals.costUsd,
          todayCostUsd: childTotals.todayCostUsd,
          local: localById.get(childId) === true,
          archived: childTotals.archived === true,
          copies: Math.max(0, child.records.length - 1),
          subagents: childTotals.nodes - 1,
          error: instance !== null && instance.error === true,
        })
        walk(childId, depth + 1)
      }
    }
    walk(rootNodeId, 1)

    const titleInfo = rootNode.records.length > 0 ? bestTitle(rootNode.records) : metaTitleOf(rootNodeId)
    const rootTitle = titleInfo.titleSource === TITLE_SOURCE_NONE ? metaTitleOf(rootNodeId) : titleInfo
    const rootInstance = bestInstance(rootNode.records)
    const createdSource = rootNode.records.length > 0 ? rootNode.records : groupRecords
    const createdTimes = createdSource.map(record => num(record.createdAt)).filter(value => value > 0)
    const liveInstance = rootNode.records.some(record => record.archived !== true)
    const error = rootInstance !== null && rootInstance.error === true && breakdown.length === 0
    sessions.push({
      id: canonical,
      title: rootTitle.title,
      titleSource: rootTitle.titleSource,
      firstMessage: firstMessageOf(rootNode.records) || firstMessageOf(groupRecords) || normalizeTitle(metaOf(rootNodeId)?.firstMessage),
      createdAt: createdTimes.length === 0 ? 0 : Math.min(...createdTimes),
      updatedAt: totals.updatedAt,
      models: totals.models,
      input: totals.input,
      cacheHit: totals.cacheHit,
      output: totals.output,
      requests: totals.requests,
      toolCalls: totals.toolCalls,
      costUsd: totals.costUsd,
      todayInput: totals.todayInput,
      todayCacheHit: totals.todayCacheHit,
      todayOutput: totals.todayOutput,
      todayRequests: totals.todayRequests,
      todayToolCalls: totals.todayToolCalls,
      todayCostUsd: totals.todayCostUsd,
      subagent: false,
      subagentCount: breakdown.length,
      subagents: breakdown,
      copies: Math.max(0, rootNode.records.length - 1),
      local: rowLocal,
      mode: rowLocal ? 'local' : 'cloud',
      localSubagents: breakdown.filter(entry => entry.local === true).length,
      archived: liveIds !== null
        ? !rootNode.records.some(record => liveIds.has(record.id))
        : !liveInstance,
      virtualParent: virtualRoot !== '',
      lineageKey: key,
      parentSession: parentById.get(canonical) ?? '',
      error,
    })
  }

  // Стабильный порядок: новые сверху, дальше по id — до сортировки клиентом.
  sessions.sort((left, right) => right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id)))

  const diagnostics = {
    records: list.length,
    archiveRecords: num(options.archiveRecords) || list.length,
    sessions: sessions.length,
    local: sessions.filter(session => session.local === true).length,
    cloud: sessions.filter(session => session.local !== true).length,
    subagentRecords: list.filter(record => record.parentSession !== '').length,
    subagents: sessions.reduce((total, session) => total + session.subagentCount, 0),
    copies: sessions.reduce((total, session) => total + session.copies, 0),
    titles: {
      sessionTitle: list.filter(record => record.titleSource === TITLE_SOURCE_SESSION).length,
      firstMessage: list.filter(record => record.titleSource === TITLE_SOURCE_FIRST_MESSAGE).length,
      none: list.filter(record => record.titleSource !== TITLE_SOURCE_SESSION && record.titleSource !== TITLE_SOURCE_FIRST_MESSAGE).length,
    },
  }
  return { sessions, diagnostics }
}
