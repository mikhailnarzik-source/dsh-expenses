/**
 * Host half of the Expenses panel.
 *
 * The panel needs one number set per Session — prompt (input) tokens, completion
 * (output) tokens, model requests, tool calls, plus today's slice of each — and
 * the browser cannot read a stored Session log itself. This half folds every
 * Session's logical log through `sessionQuery` and serves the result as one
 * authenticated JSON overview on the Connection Fetch route, which is the same
 * seam the shipped `/api/session.export` download uses.
 *
 * The fold is a pure function of committed events so it can be exercised without
 * a live Harness. Fork-inherited events are skipped: their usage was billed in
 * the source Session, and counting the copy would double every forked cost.
 */

/** Absolute route registered on the browser-authenticated Fetch bridge. */
export const OVERVIEW_PATH = '/api/expenses.overview'

/** A cached Session row is reused for this long before its log is read again. */
export const CACHE_TTL_MS = 15000

/** Local start of the current day, the boundary of the "today" totals. */
export function startOfToday(now = Date.now()) {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** First visible text block of a message, collapsed to one short line. */
function firstText(content) {
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.replace(/\s+/gu, ' ').trim()
      if (text !== '') return text.length > 80 ? `${text.slice(0, 79)}…` : text
    }
  }
  return ''
}

/** Finiteness guard for provider-reported counters. */
function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/** The human page the prices come from, and its markdown twin that this Host parses. */
export const PRICING_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/'
export const PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing.md'

/** Prices change rarely; six hours keeps a panel open all day from re-reading the page. */
export const PRICING_CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** Retired model names the pricing footnote still bills at the Flash price. */
const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
}

/** Split one markdown table row into trimmed cells. */
function splitTableRow(line) {
  const inner = line.trim().replace(/^\|/u, '').replace(/\|$/u, '')
  return inner.split('|').map(cell => cell.trim())
}

/** Parse one `$0.003` price cell; anything else is unusable. */
function parsePriceCell(cell) {
  const match = /^\$?\s*([0-9]+(?:\.[0-9]+)?)\s*$/u.exec(cell)
  return match === null ? null : Number(match[1])
}

/**
 * Parse the official pricing markdown into per-model, per-period USD prices per 1M
 * tokens. The page flattens rowspan cells, so each price row repeats the label
 * columns before the period column and the model prices after it.
 * @param text - markdown body of the pricing page.
 * @returns the model table, or `null` when the layout is not the expected one.
 */
export function parsePricing(text) {
  if (typeof text !== 'string' || text === '') return null
  const lines = text.split('\n')
  let models = null
  let headerIndex = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim().startsWith('|')) continue
    const cells = splitTableRow(lines[index])
    if (cells[0] !== 'MODEL' && !cells[0].startsWith('MODEL ')) continue
    const ids = []
    for (const cell of cells) {
      const value = cell.replace(/\(\d+\)$/u, '').trim()
      if (/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(value)) ids.push(value)
    }
    if (ids.length > 0) {
      models = ids.map(id => ({ id, cacheHit: {}, cacheMiss: {}, output: {} }))
      headerIndex = index
    }
    break
  }
  if (models === null) return null
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim().startsWith('|')) continue
    const cells = splitTableRow(line)
    const periodIndex = cells.findIndex(cell => cell === 'PEAK' || cell === 'OFF-PEAK')
    if (periodIndex < 1) continue
    const period = cells[periodIndex] === 'PEAK' ? 'peak' : 'offPeak'
    const metric = cells.slice(0, periodIndex).join(' ').toLowerCase().replace(/[^a-z]+/gu, '')
    let field = null
    if (metric.includes('cachehit')) field = 'cacheHit'
    else if (metric.includes('cachemiss')) field = 'cacheMiss'
    else if (metric.includes('output')) field = 'output'
    if (field === null) continue
    const prices = cells.slice(periodIndex + 1).map(parsePriceCell)
    if (prices.length !== models.length || prices.some(price => price === null)) continue
    models.forEach((model, modelIndex) => {
      model[field][period] = prices[modelIndex]
    })
  }
  const complete = models.every(model => ['cacheHit', 'cacheMiss', 'output']
    .every(field => Number.isFinite(model[field].peak) && Number.isFinite(model[field].offPeak)))
  return complete ? models : null
}

/**
 * Whether Platform bills a request at the peak rate: 01:00-04:00 and 06:00-10:00 UTC,
 * Monday through Friday. Chinese public holidays are not modelled, so a holiday
 * weekday is priced as a working day.
 * @param time - event epoch milliseconds.
 */
export function isPeakUtc(time) {
  const date = new Date(Number(time))
  if (!Number.isFinite(date.getTime())) return false
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600)
}

/** Resolve one model name to its price row, accepting the documented legacy aliases. */
export function priceForModel(models, model) {
  if (!Array.isArray(models) || models.length === 0) return null
  const id = typeof model === 'string' ? model.trim().toLowerCase() : ''
  if (id !== '') {
    const exact = models.find(entry => entry.id.toLowerCase() === id)
    if (exact !== undefined) return exact
    const alias = MODEL_ALIASES[id]
    if (alias !== undefined) {
      const mapped = models.find(entry => entry.id === alias)
      if (mapped !== undefined) return mapped
    }
  }
  // An unknown model still gets a best-effort estimate from the first listed row.
  return models[0]
}

/**
 * Price one assistant message in USD from its usage split.
 * `inputTokens` counts cache-miss prompt tokens and `cacheReadTokens` the cache hits,
 * so the two are billed at different rates.
 * @param usage - the message's provider usage.
 * @param models - the parsed price table.
 * @param model - the model that answered.
 * @param time - the message epoch milliseconds, which selects peak or off-peak.
 * @returns USD cost, or `null` without a price table.
 */
export function costUsdForUsage(usage, models, model, time) {
  const prices = priceForModel(models, model)
  if (prices === null) return null
  if (usage === null || typeof usage !== 'object') return null
  const period = isPeakUtc(time) ? 'peak' : 'offPeak'
  return (count(usage.cacheReadTokens) * prices.cacheHit[period]
    + count(usage.inputTokens) * prices.cacheMiss[period]
    + count(usage.outputTokens) * prices.output[period]) / 1000000
}

/** Headers that keep public documentation and FX endpoints from refusing a server-side client. */
const PUBLIC_REQUEST_HEADERS = {
  accept: 'text/markdown, text/plain, text/html;q=0.9, application/json;q=0.8',
  'accept-language': 'en',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}

/**
 * Read the official prices once, trying the markdown page, then the HTML page,
 * and finally the composed web-fetch service when the direct request is refused.
 * @param options.fetch - fetch implementation (tests inject one).
 * @param options.fetchText - optional fallback that returns the page text (the web-fetch service).
 * @param options.timeoutMs - request deadline.
 */
export async function readPricing(options = {}) {
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10000
  const reasons = []
  for (const url of [PRICING_URL, PRICING_SOURCE]) {
    try {
      const response = await fetchImpl(url, {
        headers: PUBLIC_REQUEST_HEADERS,
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(timeoutMs)
          : undefined,
      })
      if (!response.ok) {
        reasons.push(`${url}: HTTP ${response.status}`)
        continue
      }
      const models = parsePricing(await response.text())
      if (models !== null) return { status: 'ready', models, fetchedAt: Date.now(), source: url }
      reasons.push(`${url}: unexpected markup`)
    } catch (error) {
      reasons.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (typeof options.fetchText === 'function') {
    try {
      const models = parsePricing(await options.fetchText(PRICING_URL))
      if (models !== null) return { status: 'ready', models, fetchedAt: Date.now(), source: `web:${PRICING_URL}` }
      reasons.push('web fetch: unexpected markup')
    } catch (error) {
      reasons.push(`web fetch: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { status: 'failed', reason: reasons.join('; ') }
}

/**
 * Fold one Session log into the figures the panel shows.
 * @param events - committed events in seq order.
 * @param inheritedEventCount - length of the fork-inherited prefix to skip.
 * @param todayStart - inclusive epoch-ms boundary of "today".
 * @param models - parsed official model prices, or `null` when they are unavailable.
 * @returns totals for the whole log and for its today slice.
 */
export function summarizeEvents(events, inheritedEventCount, todayStart, models = null) {
  const summary = {
    input: 0,
    cacheHit: 0,
    output: 0,
    requests: 0,
    toolCalls: 0,
    costUsd: 0,
    pricedEvents: 0,
    unpricedEvents: 0,
    todayInput: 0,
    todayCacheHit: 0,
    todayOutput: 0,
    todayRequests: 0,
    todayToolCalls: 0,
    todayCostUsd: 0,
    updatedAt: 0,
    firstUserText: '',
  }
  const inherited = Number(inheritedEventCount) || 0
  if (!Array.isArray(events)) return summary
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const seq = Number(event.seq)
    if (Number.isFinite(seq) && seq < inherited) continue
    const time = Number(event.time)
    if (Number.isFinite(time) && time > summary.updatedAt) summary.updatedAt = time
    const isToday = Number.isFinite(time) && time >= todayStart
    switch (event.type) {
      case 'assistant/message': {
        summary.requests += 1
        if (isToday) summary.todayRequests += 1
        const usage = event.data === null || typeof event.data !== 'object' ? undefined : event.data.usage
        if (usage !== null && typeof usage === 'object') {
          const input = count(usage.inputTokens)
          const cacheHit = count(usage.cacheReadTokens)
          const output = count(usage.outputTokens)
          summary.input += input
          summary.cacheHit += cacheHit
          summary.output += output
          if (isToday) {
            summary.todayInput += input
            summary.todayCacheHit += cacheHit
            summary.todayOutput += output
          }
          if (models !== null) {
            const message = event.data.message
            const model = message !== null && typeof message === 'object' && message.source !== null && typeof message.source === 'object'
              ? message.source.model
              : undefined
            const cost = costUsdForUsage(usage, models, model, time)
            if (cost === null) {
              summary.unpricedEvents += 1
            } else {
              summary.costUsd += cost
              summary.pricedEvents += 1
              if (isToday) summary.todayCostUsd += cost
            }
          }
        }
        break
      }
      case 'tool/call': {
        summary.toolCalls += 1
        if (isToday) summary.todayToolCalls += 1
        break
      }
      case 'user/message': {
        if (summary.firstUserText === '') {
          const data = event.data
          summary.firstUserText = data !== null && typeof data === 'object' ? firstText(data.content) : ''
        }
        break
      }
      default:
        break
    }
  }
  return summary
}

/** One row with every figure zeroed — a Session whose log could not be read. */
function emptyRow(header, title) {
  return {
    id: header.id,
    title,
    createdAt: Number(header.createdAt) || 0,
    updatedAt: 0,
    input: 0,
    cacheHit: 0,
    output: 0,
    requests: 0,
    toolCalls: 0,
    costUsd: null,
    todayInput: 0,
    todayCacheHit: 0,
    todayOutput: 0,
    todayRequests: 0,
    todayToolCalls: 0,
    todayCostUsd: null,
    subagent: header.origin === 'subagent',
    error: true,
  }
}

/**
 * Read the titles of many Sessions in one corpus pass; failures stay local.
 * @returns a map from Session id to its latest log-backed title.
 */
async function readTitles(sessionQuery, ids) {
  const titles = new Map()
  if (ids.length === 0) return titles
  try {
    const observations = await sessionQuery.readTitleSnapshots(ids)
    for (const observation of observations) {
      if (observation === null || typeof observation !== 'object') continue
      if (observation.status !== 'fulfilled') continue
      const title = observation.value === null || typeof observation.value !== 'object' ? undefined : observation.value.title
      if (title === null || typeof title !== 'object' || typeof title.title !== 'string') continue
      const text = title.title.trim()
      if (text !== '') titles.set(observation.sessionId, text)
    }
  } catch {
    // Titles are decorative: a catalog read failure must not hide the figures.
  }
  return titles
}

/** How many Session logs are read at once; keeps a large corpus from peaking in memory. */
export const READ_CONCURRENCY = 4

/**
 * Map over items with a bounded number of overlapping asynchronous reads.
 * @param items - input values.
 * @param limit - maximum concurrent workers.
 * @param worker - async mapper; results keep the input order.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  }
  const workers = new Array(Math.min(limit, items.length)).fill(undefined).map(run)
  await Promise.all(workers)
  return results
}

/**
 * Build the complete overview: one row per Session in the corpus plus totals.
 * @param ctx - the plugin context carrying `sessionQuery` and the optional Session store.
 * @param options.fresh - ignore cached rows and re-read every log.
 * @param options.cache - per-plugin row cache keyed by Session id.
 * @param options.pricing - parsed official model prices, or `null` when unavailable.
 */
export async function readOverview(ctx, options = {}) {
  const fresh = options.fresh === true
  const cache = options.cache instanceof Map ? options.cache : new Map()
  const models = Array.isArray(options.pricing) ? options.pricing : null
  const pricingKey = models === null ? 'none' : JSON.stringify(models)
  const sessionQuery = ctx.get === undefined ? ctx.sessionQuery : ctx.get('sessionQuery') ?? ctx.sessionQuery
  if (sessionQuery === undefined) {
    return {
      generatedAt: Date.now(),
      todayStart: startOfToday(),
      totals: { today: { input: 0, cacheHit: 0, output: 0, requests: 0, toolCalls: 0, costUsd: null }, all: { input: 0, cacheHit: 0, output: 0, requests: 0, toolCalls: 0, costUsd: null } },
      sessions: [],
      error: 'Session query is not available in this composition.',
    }
  }
  const store = ctx.get === undefined ? undefined : ctx.get('sessions')
  const todayStart = startOfToday()
  const records = await sessionQuery.listSessions()
  const titles = await readTitles(sessionQuery, records.map(record => record.header.id))
  const seen = new Set()
  const rows = await mapLimit(records, READ_CONCURRENCY, async (record) => {
    const header = record.header
    const id = header.id
    seen.add(id)
    const title = titles.get(id) || ''
    const cached = cache.get(id)
    const now = Date.now()
    if (!fresh && cached !== undefined && cached.pricingKey === pricingKey && now - cached.at < CACHE_TTL_MS) {
      return { ...cached.row, title: title || cached.row.title }
    }
    try {
      if (record.live === true && store !== undefined) {
        const live = store.get(id)
        if (live !== undefined) {
          try {
            await store.flush(live)
          } catch {
            // A checkpoint barrier failure must not hide the figures already on disk.
          }
        }
      }
      const snapshot = await sessionQuery.readSession(id)
      const summary = summarizeEvents(snapshot.events, snapshot.inheritedEventCount, todayStart, models)
      const row = {
        id,
        title: title || summary.firstUserText,
        createdAt: Number(header.createdAt) || 0,
        updatedAt: summary.updatedAt,
        input: summary.input,
        cacheHit: summary.cacheHit,
        output: summary.output,
        requests: summary.requests,
        toolCalls: summary.toolCalls,
        costUsd: models === null ? null : summary.costUsd,
        todayInput: summary.todayInput,
        todayCacheHit: summary.todayCacheHit,
        todayOutput: summary.todayOutput,
        todayRequests: summary.todayRequests,
        todayToolCalls: summary.todayToolCalls,
        todayCostUsd: models === null ? null : summary.todayCostUsd,
        subagent: header.origin === 'subagent',
        error: false,
      }
      cache.set(id, { at: now, pricingKey, row })
      return row
    } catch {
      const row = emptyRow(header, title)
      cache.set(id, { at: now, pricingKey, row })
      return row
    }
  })
  for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id)
  const totals = {
    today: { input: 0, cacheHit: 0, output: 0, requests: 0, toolCalls: 0, costUsd: 0 },
    all: { input: 0, cacheHit: 0, output: 0, requests: 0, toolCalls: 0, costUsd: 0 },
  }
  for (const row of rows) {
    totals.today.input += row.todayInput
    totals.today.cacheHit += row.todayCacheHit
    totals.today.output += row.todayOutput
    totals.today.requests += row.todayRequests
    totals.today.toolCalls += row.todayToolCalls
    totals.today.costUsd += row.todayCostUsd ?? 0
    totals.all.input += row.input
    totals.all.cacheHit += row.cacheHit
    totals.all.output += row.output
    totals.all.requests += row.requests
    totals.all.toolCalls += row.toolCalls
    totals.all.costUsd += row.costUsd ?? 0
  }
  return {
    generatedAt: Date.now(),
    todayStart,
    totals: models === null
      ? {
          today: { ...totals.today, costUsd: null },
          all: { ...totals.all, costUsd: null },
        }
      : totals,
    sessions: rows,
  }
}

/** JSON response with the no-store policy a live read deserves. */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Absolute route for the signed-in account balance. */
export const BALANCE_PATH = '/api/expenses.balance'

/** A platform balance read is reused for this long unless the caller asks for a fresh one. */
export const BALANCE_CACHE_TTL_MS = 20000

/** One projected wallet: the currency and the exact decimal string Platform returned. */
function projectWallets(wallets) {
  if (!Array.isArray(wallets)) return []
  const projected = []
  for (const wallet of wallets) {
    if (wallet === null || typeof wallet !== 'object') continue
    if (wallet.currency !== 'USD' && wallet.currency !== 'CNY') continue
    if (typeof wallet.balance !== 'string') continue
    projected.push({ currency: wallet.currency, balance: wallet.balance })
  }
  return projected
}

/**
 * Build the per-call account metadata the account provider expects.
 * @param params - the request query; `locale`, `tz` (seconds east of UTC) and `version` are optional.
 */
export function accountClientMetadata(params) {
  const locale = typeof params.get === 'function' ? params.get('locale') ?? '' : ''
  const rawTimezone = typeof params.get === 'function' ? params.get('tz') : null
  const timezone = rawTimezone === null || rawTimezone === '' ? Number.NaN : Number(rawTimezone)
  const version = (typeof params.get === 'function' ? params.get('version') : '') || '0.0.0'
  return {
    version,
    locale: locale === '' ? 'en' : locale,
    timezoneOffsetSeconds: Number.isFinite(timezone) ? timezone : -new Date().getTimezoneOffset() * 60,
  }
}

/**
 * Read the signed-in account's recharge and bonus wallets plus the platform links.
 * Never throws: a missing service, a signed-out account and a platform failure are
 * distinct statuses the panel renders differently.
 * @param ctx - the plugin context; the account service is optional.
 * @param meta - account client metadata for this call.
 */
export async function readBalance(ctx, meta) {
  const account = ctx.get === undefined ? ctx.deepseekAccount : ctx.get('deepseekAccount')
  if (account === undefined) return { status: 'unavailable', reason: 'account-service-missing' }
  let details
  try {
    details = await account.getBalance(meta)
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
  if (details === null) return { status: 'signed-out' }
  if (details.status !== 'ready') return { status: 'failed', reason: 'balance-unavailable' }
  let links
  try {
    const state = await account.getState()
    if (state !== null && typeof state === 'object' && state.links !== null && typeof state.links === 'object') {
      links = {
        topUpUrl: typeof state.links.topUpUrl === 'string' ? state.links.topUpUrl : undefined,
        usageUrl: typeof state.links.usageUrl === 'string' ? state.links.usageUrl : undefined,
      }
    }
  } catch {
    // Links are conveniences; the wallets above are the answer.
  }
  return {
    status: 'ready',
    wallets: projectWallets(details.value),
    bonusWallets: projectWallets(details.bonusWallets),
    ...(links === undefined ? {} : { links }),
  }
}

/** Absolute route for the approximate currency rates. */
export const RATES_PATH = '/api/expenses.rates'

/** Exchange rates move once a day; ten minutes keeps the panel live without hammering the source. */
export const RATES_CACHE_TTL_MS = 10 * 60 * 1000

/** Providers tried in order; both answer `{ rates: { RUB, CNY, ... }, time_last_update_unix }`. */
export const RATE_SOURCES = [
  'https://open.er-api.com/v6/latest/USD',
  'https://api.exchangerate-api.com/v4/latest/USD',
]

/** Round a rate to the precision a "примерный курс" line needs. */
function rate(value, digits = 6) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Project one provider payload to the three cross rates the panel shows.
 * RUB is the pivot because the price the user types may be in any of the three currencies.
 * @param payload - provider JSON.
 * @param fetchedAt - local moment of the successful read.
 * @param source - provider URL that answered.
 * @returns the rate set, or `null` when a needed currency is missing or unusable.
 */
export function projectRates(payload, fetchedAt, source) {
  if (payload === null || typeof payload !== 'object') return null
  const rates = payload.rates
  if (rates === null || typeof rates !== 'object') return null
  const rubPerUsd = Number(rates.RUB)
  const cnyPerUsd = Number(rates.CNY)
  if (!Number.isFinite(rubPerUsd) || !Number.isFinite(cnyPerUsd) || rubPerUsd <= 0 || cnyPerUsd <= 0) return null
  const updatedAt = Number(payload.time_last_update_unix) > 0
    ? Number(payload.time_last_update_unix) * 1000
    : fetchedAt
  return {
    status: 'ready',
    base: 'USD',
    source,
    updatedAt,
    fetchedAt,
    rubPerUsd: rate(rubPerUsd),
    rubPerCny: rate(rubPerUsd / cnyPerUsd),
    cnyPerUsd: rate(cnyPerUsd),
  }
}

/**
 * Read the current approximate rates, trying each provider until one answers.
 * @param options.fetch - fetch implementation (tests inject one).
 * @param options.timeoutMs - per-provider deadline.
 */
export async function readRates(options = {}) {
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000
  const reasons = []
  for (const source of RATE_SOURCES) {
    try {
      const response = await fetchImpl(source, {
        headers: PUBLIC_REQUEST_HEADERS,
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(timeoutMs)
          : undefined,
      })
      if (!response.ok) {
        reasons.push(`${source}: HTTP ${response.status}`)
        continue
      }
      const projected = projectRates(await response.json(), Date.now(), source)
      if (projected !== null) return projected
      reasons.push(`${source}: unexpected payload`)
    } catch (error) {
      reasons.push(`${source}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { status: 'failed', reason: reasons.join('; ') }
}

/** How long an overview request waits for the price page before answering with the last table. */
export const PRICING_WAIT_MS = 4000

/**
 * Bound the price read so a slow documentation site cannot stall the whole panel.
 * The read keeps running in the background and fills the cache for the next request.
 * @param promise - the in-flight pricing read.
 * @param cache - the plugin's pricing cache, used as the fallback table.
 */
export function waitForPricing(promise, cache) {
  const fallback = () => ({
    models: cache.value === undefined ? undefined : cache.value.models,
    fetchedAt: cache.value === undefined ? 0 : cache.value.fetchedAt,
    source: cache.value === undefined ? undefined : cache.value.source,
    changed: false,
    stale: cache.value !== undefined,
    error: 'pricing-timeout',
  })
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback()), PRICING_WAIT_MS)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(fallback()) },
    )
  })
}

/** Host plugin body: own the authenticated Fetch routes for the panel's data. */
export function apply(ctx) {
  const cache = new Map()
  const balanceCache = { at: 0, value: undefined }
  const ratesCache = { at: 0, value: undefined }
  const pricingCache = { at: 0, value: undefined, modelsJson: null }

  /** The composed web-fetch service, when this profile mounts one, as a pricing fallback. */
  const webFetchText = async (url) => {
    const web = ctx.get === undefined ? undefined : ctx.get('web')
    if (web === undefined || web === null || typeof web.fetch !== 'function') {
      throw new Error('web fetch service is not available')
    }
    const result = await web.fetch({ url })
    const body = result !== null && typeof result === 'object' ? result.body : undefined
    const content = body !== null && typeof body === 'object' ? body.content : undefined
    if (typeof content !== 'string' || content === '') {
      throw new Error(`web fetch answered ${result !== null && typeof result === 'object' ? result.statusCode : 'nothing'}`)
    }
    return content
  }

  /**
   * The official model prices, refreshed on a fresh request and reused otherwise.
   * @returns the table (or `undefined` when none was ever read), whether this read
   * changed it, and whether the last read attempt failed.
   */
  const currentPricing = async (fresh) => {
    if (!fresh && pricingCache.value !== undefined && Date.now() - pricingCache.at < PRICING_CACHE_TTL_MS) {
      return { models: pricingCache.value.models, fetchedAt: pricingCache.value.fetchedAt, source: pricingCache.value.source, changed: false, stale: false }
    }
    const read = await readPricing({ fetchText: webFetchText })
    if (read.status === 'ready') {
      const modelsJson = JSON.stringify(read.models)
      const changed = pricingCache.modelsJson !== null && pricingCache.modelsJson !== modelsJson
      pricingCache.at = Date.now()
      pricingCache.modelsJson = modelsJson
      pricingCache.value = { models: read.models, fetchedAt: read.fetchedAt, source: read.source }
      return { models: read.models, fetchedAt: read.fetchedAt, source: read.source, changed, stale: false }
    }
    if (pricingCache.value !== undefined) {
      return { models: pricingCache.value.models, fetchedAt: pricingCache.value.fetchedAt, source: pricingCache.value.source, changed: false, stale: true, error: read.reason }
    }
    return { models: undefined, fetchedAt: 0, source: undefined, changed: false, stale: false, error: read.reason }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: OVERVIEW_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const fresh = new URL(request.url).searchParams.get('fresh') === '1'
      try {
        const pricing = await waitForPricing(currentPricing(fresh), pricingCache)
        const overview = await readOverview(ctx, { fresh, cache, pricing: pricing.models ?? null })
        return jsonResponse({
          ...overview,
          pricing: {
            status: pricing.models === undefined ? 'failed' : 'ready',
            ...(pricing.models === undefined ? {} : { models: pricing.models }),
            fetchedAt: pricing.fetchedAt,
            source: pricing.source ?? PRICING_SOURCE,
            changed: pricing.changed,
            stale: pricing.stale,
            ...(pricing.error === undefined ? {} : { reason: pricing.error }),
          },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return jsonResponse({ error: message }, 500)
      }
    },
  }), 'expenses: overview route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: BALANCE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const fresh = url.searchParams.get('fresh') === '1'
      if (!fresh && balanceCache.value !== undefined && Date.now() - balanceCache.at < BALANCE_CACHE_TTL_MS) {
        return jsonResponse(balanceCache.value)
      }
      try {
        const value = await readBalance(ctx, accountClientMetadata(url.searchParams))
        balanceCache.at = Date.now()
        balanceCache.value = value
        return jsonResponse(value)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return jsonResponse({ status: 'failed', reason: message }, 500)
      }
    },
  }), 'expenses: balance route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: RATES_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const fresh = new URL(request.url).searchParams.get('fresh') === '1'
      if (!fresh && ratesCache.value !== undefined && Date.now() - ratesCache.at < RATES_CACHE_TTL_MS) {
        return jsonResponse(ratesCache.value)
      }
      try {
        const value = await readRates()
        if (value.status === 'ready') {
          ratesCache.at = Date.now()
          ratesCache.value = value
          return jsonResponse(value)
        }
        if (ratesCache.value !== undefined) return jsonResponse({ ...ratesCache.value, stale: true })
        return jsonResponse(value)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (ratesCache.value !== undefined) return jsonResponse({ ...ratesCache.value, stale: true })
        return jsonResponse({ status: 'failed', reason: message }, 500)
      }
    },
  }), 'expenses: rates route')
}

export const name = 'expenses'
export const inject = ['connection', 'sessionQuery']
