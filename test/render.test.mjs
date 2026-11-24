import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DAY = 24 * 60 * 60 * 1000

/** Minimal React stand-in: hooks return their initial values and do nothing. */
const fakeReact = {
  createElement: (type, props, ...children) => ({
    type,
    props: {
      ...(props ?? {}),
      children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
    },
  }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useReducer: (_reducer, initial) => [initial, () => {}],
  useRef: initial => ({ current: initial }),
  useEffect: () => {},
  useCallback: callback => callback,
  useMemo: factory => factory(),
}

/** Render function components down to plain host elements. */
function render(node) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(render)
  if (typeof node === 'object' && typeof node.type === 'function') return render(node.type(node.props ?? {}))
  if (typeof node === 'object' && node.props !== undefined) {
    return { ...node, props: { ...node.props, children: render(node.props.children) } }
  }
  return node
}

/** Collect every string in a React element tree. */
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

/** Collect every React element (object with a type) in the tree. */
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

/** All elements whose className contains `name`. */
function withClass(tree, name) {
  return elements(tree).filter(node => typeof node.props?.className === 'string'
    && node.props.className.split(/\s+/).includes(name))
}

/** Load `client.js` the way the browser module loader does. */
async function loadClient() {
  const source = await readFile(join(ROOT, 'client.js'), 'utf8')
  const captured = {}
  const storage = new Map()
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(options) {
          captured.options = options
        },
      },
      localStorage: {
        getItem: key => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key),
      },
    },
    console: { error: () => {}, warn: () => {}, log: () => {} },
    fetch: async () => {
      throw new Error('fetch не должен вызываться при рендере')
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(captured.options !== undefined, 'ModuleLoader.load вызван')
  assert.equal(captured.options.id, 'dsh-expenses')

  const module = captured.options.factory(name => {
    if (name === 'react') return fakeReact
    throw new Error(`неожиданный модуль ${name}`)
  })
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual([...module.inject], ['slots', 'locale'])

  const registered = []
  const injected = []
  const locales = []
  const ctx = {
    effect: callback => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(namespace, language, dictionary) {
        locales.push({ namespace, language, dictionary })
      },
      bind() {
        return key => key
      },
    },
    slots: {
      inject(name, callback) {
        injected.push(name)
        return callback()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)
  assert.equal(typeof module.__test, 'object', 'наружу отданы чистые помощники для тестов')
  const t = key => module.__test.DICT[key] ?? key
  return { module, registered, injected, locales, t, test: module.__test }
}

/** One Session row fixture; every field the panel reads is present. */
function sessionRow(overrides = {}) {
  return {
    id: 's-1',
    title: 'Сессия',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    input: 100,
    cacheHit: 0,
    output: 50,
    requests: 2,
    toolCalls: 1,
    costUsd: 1,
    todayInput: 100,
    todayCacheHit: 0,
    todayOutput: 50,
    todayRequests: 2,
    todayToolCalls: 1,
    todayCostUsd: 1,
    models: [],
    subagent: false,
    error: false,
    ...overrides,
  }
}

test('client.js: панель регистрируется в тех же слотах', async () => {
  const { registered, injected } = await loadClient()
  assert.deepEqual(injected, ['main', 'shell.overlay', 'sidebar.panellist'])
  const names = registered.map(entry => entry.options.name)
  assert.deepEqual(names, ['main', 'shell.overlay', 'sidebar.panellist'])
  const main = registered.find(entry => entry.options.name === 'main')
  assert.equal(main.options.key, 'expenses')
  assert.equal(typeof main.component, 'function')
  const rail = registered.find(entry => entry.options.name === 'sidebar.panellist')
  assert.equal(rail.options.id, 'expenses')
  assert.equal(rail.options.label(), 'Расходы')
})

test('client.js: страница оформлена по единому стилю и адаптиву', async () => {
  const { registered, t } = await loadClient()
  const main = registered.find(entry => entry.options.name === 'main')
  const tree = render(main.component({}))
  assert.equal(tree.type, 'section')
  assert.equal(tree.props.className, 'dsh-exp-page')
  const all = elements(tree)

  const style = all.find(node => node.type === 'style')
  assert.ok(style, 'страница подключает свой стиль')
  const css = String(style.props.children)

  // Центрированный контейнер, иконка-квадрат и шапка.
  assert.match(css, /\.dsh-exp-content\{[^}]*max-width:960px/)
  assert.match(css, /\.dsh-exp-content\{[^}]*margin:0 auto/)
  assert.match(css, /\.dsh-exp-logo\{[^}]*width:52px/)
  assert.match(css, /\.dsh-exp-logo\{[^}]*height:52px/)
  assert.match(css, /\.dsh-exp-heading h1\{[^}]*font-size:20px/)
  assert.match(css, /\.dsh-exp-card,\.dsh-exp-pricing,\.dsh-exp-topups\{[^}]*border:1px solid var\(--dsw-alias-border-l2\)/)
  assert.match(css, /\.dsh-exp-card\{padding:16px/)
  assert.match(css, /:focus-visible/)
  assert.doesNotMatch(css, /#[0-9a-fA-F]{6}/, 'в стилях нет жёстких hex-цветов')

  // Кнопки: высота 36, радиус 10, мягкая primary-заливка без белого текста.
  const buttonRule = /\.dsh-exp-button\{([^}]*)\}/.exec(css)
  assert.ok(buttonRule, 'есть общее правило кнопок')
  assert.match(buttonRule[1], /height:36px/)
  assert.match(buttonRule[1], /border-radius:10px/)
  assert.match(buttonRule[1], /display:inline-flex/)
  assert.match(css, /\.dsh-exp-button-primary\{background:color-mix\(in srgb,var\(--dsw-alias-brand-primary\) 18%,transparent\)/)
  assert.match(css, /\.dsh-exp-button-secondary\{background:transparent/)
  assert.match(css, /\.dsh-exp-button-danger\{/)
  assert.doesNotMatch(css, /#fff\b/, 'white-текста на brand-фоне нет')

  // Сетки, выравнивание карточек и футер.
  assert.match(css, /\.dsh-exp-overview\{display:grid;[^}]*align-items:stretch/)
  assert.match(css, /minmax\(min\(100%,320px\),1fr\)/)
  assert.match(css, /\.dsh-exp-card-footer\{[^}]*margin-top:auto/)
  assert.match(css, /\.dsh-exp-table-scroll\{[^}]*overflow-x:auto/)
  assert.match(css, /@media \(max-width:900px\)/)
  assert.match(css, /@media \(max-width:640px\)/)
  assert.match(css, /\.dsh-exp-field\{[^}]*min-width:0/)

  // Шапка: иконка-квадрат 52 с 💰, заголовок, подзаголовок, статус-чип и «Обновить».
  const logo = all.find(node => node.props?.className === 'dsh-exp-logo')
  assert.ok(logo, 'иконка в шапке')
  assert.equal(texts(logo).join(''), '💰')
  const title = all.find(node => node.type === 'h1')
  assert.equal(texts(title).join(''), 'Расходы')
  const subtitle = all.find(node => node.props?.className === 'dsh-exp-sub')
  assert.match(texts(subtitle).join(''), /Токены, запросы/)
  const chip = all.find(node => typeof node.props?.className === 'string' && node.props.className.startsWith('dsh-exp-chip'))
  assert.ok(chip, 'статус-чип в шапке')
  assert.equal(chip.props.role, 'status')

  const refresh = all.find(node => node.type === 'button' && texts(node).join('') === 'Обновить')
  assert.ok(refresh, 'кнопка «Обновить»')
  assert.equal(typeof refresh.props.onClick, 'function', 'обновление подключено')
  assert.match(refresh.props.className, /dsh-exp-button-secondary/)
  assert.doesNotMatch(refresh.props.className, /dsh-exp-button-primary/, 'в шапке secondary-кнопки')

  // Пустое состояние таблицы и прокручиваемая область на месте.
  const page = all.find(node => node.props?.className === 'dsh-exp-scroll')
  assert.ok(page, 'прокручиваемая область')
  const state = all.find(node => node.props?.className === 'dsh-exp-state')
  assert.ok(state, 'пустое состояние загрузки')
  assert.equal(t('today'), 'Сегодня')
})

test('client.js: баланс и пополнения — один общий ряд, метрики и «Пополнить»', async () => {
  const { test: api, t } = await loadClient()
  const now = Date.now()
  const balance = {
    status: 'ready',
    updatedAt: now,
    data: {
      status: 'ready',
      wallets: [{ currency: 'USD', balance: '12.5' }],
      bonusWallets: [{ currency: 'USD', balance: '2' }],
      links: { topUpUrl: 'https://platform.deepseek.com/top_up' },
    },
  }
  const topUps = [
    { at: now, currency: 'USD', amount: 10 },
    { at: now - 1000, currency: 'USD', amount: 5 },
  ]
  const tree = render(api.components.BalanceSection({
    balance,
    topUps,
    todayCost: 1.5,
    weekCost: 3,
    averageCost: 0.25,
    rateText: '1 $ = 79,12 ₽',
    symbol: '$',
    t,
  }))
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'dsh-exp-overview')

  const cards = withClass(tree, 'dsh-exp-card')
  assert.equal(cards.length, 1, 'карточка баланса внутри общей сетки')
  assert.ok(withClass(tree, 'dsh-exp-topups').length === 1, 'рядом история пополнений')
  assert.equal(withClass(tree, 'dsh-exp-balance-card').length, 1)
  assert.equal(withClass(tree, 'dsh-exp-balance-metrics').length, 1)
  assert.equal(withClass(tree, 'dsh-exp-card-footer').length > 0, true, 'у карточки есть футер')

  const text = texts(tree).join(' ')
  assert.match(text, /Баланс/)
  assert.match(text, /Доллары/)
  assert.match(text, /Пополняемый:\s*\$12,50/)
  assert.match(text, /Бонусный:\s*\$2,00/)
  assert.match(text, /За 7 дней/)
  assert.match(text, /Средний расход/)
  assert.match(text, /1 \$ = 79,12 ₽/)

  const topUp = elements(tree).find(node => node.type === 'a' && texts(node).join('').includes('Пополнить'))
  assert.ok(topUp, 'кнопка «Пополнить» — ссылка на сайт DeepSeek')
  assert.equal(topUp.props.href, 'https://platform.deepseek.com/top_up')
  assert.match(topUp.props.className, /dsh-exp-button-primary/)

  // Без подключённого баланса кнопка остаётся, но неактивна и объясняет почему.
  const emptyTree = render(api.components.BalanceCard({
    balance: { status: 'signed-out', data: null, updatedAt: 0 },
    todayCost: null,
    weekCost: null,
    averageCost: null,
    rateText: 'Курс недоступен',
    symbol: '$',
    t,
  }))
  const emptyText = texts(emptyTree).join(' ')
  assert.match(emptyText, /Аккаунт DeepSeek не подключён/)
  assert.match(emptyText, /Пополнить/)
  const disabledTopUp = elements(emptyTree).find(node => node.type === 'button' && texts(node).join('') === 'Пополнить')
  assert.ok(disabledTopUp, 'кнопка «Пополнить» есть и без баланса')
  assert.equal(disabledTopUp.props.disabled, true)
})

test('client.js: история пополнений — 5 на страницу и пейджер только при >5', async () => {
  const { test: api, t } = await loadClient()
  const now = Date.now()
  const entries = Array.from({ length: 12 }, (_, index) => ({ at: now - index * 1000, currency: 'USD', amount: 1 }))
  const tree = render(api.components.TopUps({ entries, t }))
  assert.equal(withClass(tree, 'dsh-exp-topup').length, 5, 'на первой странице пять записей')
  assert.equal(withClass(tree, 'dsh-exp-pager').length, 1, 'у 12 записей есть пейджер')
  const pagerText = texts(withClass(tree, 'dsh-exp-pager')[0]).join(' ')
  assert.match(pagerText, /Стр\. 1 из 3/)

  const shortTree = render(api.components.TopUps({ entries: entries.slice(0, 3), t }))
  assert.equal(withClass(shortTree, 'dsh-exp-topup').length, 3)
  assert.equal(withClass(shortTree, 'dsh-exp-pager').length, 0, 'до пяти записей пейджера нет')

  const emptyTree = render(api.components.TopUps({ entries: [], t }))
  assert.match(texts(emptyTree).join(' '), /Пополнения, замеченные плагином/)
  assert.equal(withClass(emptyTree, 'dsh-exp-pager').length, 0)
})

test('client.js: пагинация сессий по 30 — страницы, границы и счётчики', async () => {
  const { test: api } = await loadClient()
  assert.equal(api.SESSION_PAGE_SIZE, 30)
  assert.equal(api.TOPUP_PAGE_SIZE, 5)

  const rows = Array.from({ length: 75 }, (_, index) => sessionRow({ id: `s-${index}` }))
  const first = api.paginate(rows, 1, api.SESSION_PAGE_SIZE)
  assert.equal(first.items.length, 30)
  assert.equal(first.pageCount, 3)
  assert.equal(first.from, 1)
  assert.equal(first.to, 30)

  const third = api.paginate(rows, 3, api.SESSION_PAGE_SIZE)
  assert.equal(third.items.length, 15)
  assert.equal(third.from, 61)
  assert.equal(third.to, 75)

  // Номер страницы зажимается в допустимый диапазон вместо пустого экрана.
  assert.equal(api.paginate(rows, 0, 30).page, 1)
  assert.equal(api.paginate(rows, 99, 30).page, 3)
  assert.equal(api.paginate([], 5, 30).page, 1)
  assert.equal(api.paginate([], 5, 30).pageCount, 1)
  assert.equal(api.paginate([], 5, 30).total, 0)
  assert.equal(api.clampPage(-3, 4), 1)
  assert.equal(api.clampPage(7, 4), 4)
})

test('client.js: пейджер рисует «Стр. X из Y» и кнопки ◀ ▶', async () => {
  const { test: api, t } = await loadClient()
  const tree = render(api.components.Pager({ t, page: 2, pageCount: 3, total: 75, range: '31–60 из 75', onPage: () => {} }))
  const text = texts(tree).join(' ')
  assert.match(text, /Стр\. 2 из 3/)
  assert.match(text, /31–60 из 75/)
  const buttons = elements(tree).filter(node => node.type === 'button')
  assert.deepEqual(buttons.map(node => texts(node).join('')), ['◀', '▶'])
  assert.equal(buttons[0].props.disabled, false)
  assert.equal(buttons[1].props.disabled, false)
  assert.equal(typeof buttons[1].props.onClick, 'function')

  const last = render(api.components.Pager({ t, page: 3, pageCount: 3, total: 75, onPage: () => {} }))
  const lastButtons = elements(last).filter(node => node.type === 'button')
  assert.equal(lastButtons[1].props.disabled, true, 'на последней странице «▶» выключена')
  const single = api.components.Pager({ t, page: 1, pageCount: 1, total: 0, onPage: () => {} })
  assert.equal(single, null, 'пустой истории пейджер не нужен')
})

test('client.js: фильтры сессий — период, диапазоны и поиск по названию/модели', async () => {
  const { test: api } = await loadClient()
  const now = Date.now()
  const today = api.startOfLocalDay(now)
  const rows = [
    sessionRow({ id: 'a', title: 'Alpha', createdAt: today + 60_000, input: 100, cacheHit: 0, output: 50, costUsd: 1, models: ['deepseek-v4-flash'] }),
    sessionRow({
      id: 'b',
      title: 'Beta',
      createdAt: today - 3 * DAY,
      input: 0,
      cacheHit: 0,
      output: 0,
      todayInput: 0,
      todayOutput: 0,
      todayRequests: 0,
      todayToolCalls: 0,
      costUsd: 5,
      models: ['deepseek-reasoner'],
      subagent: true,
    }),
    sessionRow({
      id: 'c',
      title: 'Gamma',
      createdAt: today - 40 * DAY,
      input: 1000,
      cacheHit: 1000,
      output: 1000,
      todayInput: 0,
      todayOutput: 0,
      todayRequests: 0,
      todayToolCalls: 0,
      costUsd: null,
      models: [],
    }),
  ]
  const base = { ...api.DEFAULT_FILTERS, ...{} }
  const ids = list => list.map(row => row.id)

  assert.deepEqual(ids(api.filterSessions(rows, api.DEFAULT_FILTERS, { now })), ['a', 'b', 'c'])
  assert.deepEqual(ids(api.filterSessions(rows, { ...base, period: 'today' }, { now })), ['a'])
  assert.deepEqual(ids(api.filterSessions(rows, { ...base, period: '7d' }, { now })), ['a', 'b'])
  assert.deepEqual(ids(api.filterSessions(rows, { ...base, period: '30d' }, { now })), ['a', 'b'])

  const iso = time => new Date(time).toISOString().slice(0, 10)
  const custom = api.filterSessions(rows, {
    ...base,
    period: 'custom',
    dateFrom: iso(today - 4 * DAY),
    dateTo: iso(today - 2 * DAY),
  }, { now })
  assert.deepEqual(ids(custom), ['b'], 'свои даты включают обе границы')

  assert.deepEqual(ids(api.filterSessions(rows, { ...base, costMin: '2', costMax: '10' }, { now })), ['b'])
  assert.deepEqual(ids(api.filterSessions(rows, { ...base, costMax: '2' }, { now })), ['a'], 'строка без цены выпадает')
  assert.deepEqual(ids(api.filterSessions(rows, { ...base, tokensMin: '1000' }, { now })), ['c'])
  assert.deepEqual(ids(api.filterSessions(rows, { ...base, tokensMax: '0' }, { now })), ['b'])
  assert.deepEqual(ids(api.filterSessions(rows, { ...base, mode: 'cloud' }, { now })), ['a', 'b', 'c'], 'облачных не отсекает: режим не задан')
  assert.deepEqual(ids(api.filterSessions(rows, { ...base, mode: 'local' }, { now })), [], 'локальных строк нет')
  assert.deepEqual(ids(api.filterSessions(rows.concat(sessionRow({ id: 'd', title: 'Local', local: true, mode: 'local' })), { ...base, mode: 'local' }, { now })), ['d'])
  assert.deepEqual(ids(api.filterSessions(rows, { ...base, onlyToday: true }, { now })), ['a'])

  assert.deepEqual(ids(api.filterSessions(rows, base, { now, query: 'alpha' })), ['a'], 'поиск по названию')
  assert.deepEqual(ids(api.filterSessions(rows, base, { now, query: 'REASONER' })), ['b'], 'поиск по модели без учёта регистра')
  assert.deepEqual(ids(api.filterSessions(rows, base, { now, query: 'нет такой' })), [])

  // Диапазон стоимости сравнивается уже в валюте показа, а не в долларах.
  const doubled = api.filterSessions(rows, { ...base, costMin: '9' }, { now, costOf: row => (row.costUsd === null ? null : row.costUsd * 2) })
  assert.deepEqual(ids(doubled), ['b'])
})

test('client.js: помощники фильтров — числа, даты и период', async () => {
  const { test: api } = await loadClient()
  assert.equal(api.parseFilterNumber('1,5'), 1.5)
  assert.equal(api.parseFilterNumber(' 2 '), 2)
  assert.equal(api.parseFilterNumber('2 000'), 2000)
  assert.equal(api.parseFilterNumber(''), null)
  assert.equal(api.parseFilterNumber('abc'), null)
  assert.equal(api.parseFilterNumber(null), null)

  const parsed = api.parseDateInput('2026-01-15')
  assert.ok(Number.isFinite(parsed))
  assert.equal(new Date(parsed).getFullYear(), 2026)
  assert.equal(new Date(parsed).getMonth(), 0)
  assert.equal(new Date(parsed).getDate(), 15)
  assert.equal(api.parseDateInput('2026-02-31'), null, 'несуществующая дата не принимается')
  assert.equal(api.parseDateInput('15.01.2026'), null)

  const now = Date.now()
  const range = api.periodRange({ period: 'custom', dateFrom: '2026-01-01', dateTo: '2026-01-31' }, now)
  assert.equal(new Date(range.from).getDate(), 1)
  assert.equal(new Date(range.to).getDate(), 31)
  assert.equal(api.periodRange({ period: 'all' }, now), null)
  assert.equal(api.periodRange({ period: 'custom', dateFrom: '', dateTo: '' }, now), null)
})

test('client.js: сортировка по дате, цене и токенам в обе стороны', async () => {
  const { test: api } = await loadClient()
  const rows = [
    sessionRow({ id: 'mid', createdAt: 2000, costUsd: 2, input: 10, output: 0 }),
    sessionRow({ id: 'new', createdAt: 3000, costUsd: 1, input: 100, output: 0 }),
    sessionRow({ id: 'old', createdAt: 1000, costUsd: 3, input: 1, output: 0 }),
    sessionRow({ id: 'free', createdAt: 1500, costUsd: null, input: 50, output: 0 }),
  ]
  const ids = list => list.map(row => row.id)
  assert.deepEqual(ids(api.sortRows(rows, 'date', 'asc')), ['old', 'free', 'mid', 'new'])
  assert.deepEqual(ids(api.sortRows(rows, 'date', 'desc')), ['new', 'mid', 'free', 'old'])
  assert.deepEqual(ids(api.sortRows(rows, 'cost', 'asc')), ['new', 'mid', 'old', 'free'], 'без цены — всегда внизу')
  assert.deepEqual(ids(api.sortRows(rows, 'cost', 'desc')), ['old', 'mid', 'new', 'free'])
  assert.deepEqual(ids(api.sortRows(rows, 'input', 'asc')), ['old', 'mid', 'free', 'new'])
  assert.deepEqual(ids(api.sortRows(rows, 'input', 'desc')), ['new', 'free', 'mid', 'old'])
})

test('client.js: строка сессии показывает модель в подсказке и стоимость', async () => {
  const { test: api, t } = await loadClient()
  const row = sessionRow({
    title: 'Разбор задачи',
    costUsd: 1.25,
    models: ['deepseek-v4-flash', 'deepseek-reasoner'],
    createdAt: Date.now(),
  })
  const tree = render(api.components.SessionRow({ row, cost: 1.25, symbol: '$', t }))
  const text = texts(tree).join(' ')
  assert.match(text, /Разбор задачи/)
  assert.match(text, /1,25 \$/)
  assert.match(String(tree.props.title), /Модель: deepseek-v4-flash, deepseek-reasoner/)

  const broken = render(api.components.SessionRow({ row: sessionRow({ error: true, costUsd: null }), cost: null, symbol: '$', t }))
  assert.equal(broken.props.title, 'Лог сессии недоступен')
})

test('client.js: страница держит баланс, итоги и таблицу в одном контейнере', async () => {
  const { registered } = await loadClient()
  const main = registered.find(entry => entry.options.name === 'main')
  const tree = render(main.component({}))
  const all = elements(tree)
  assert.equal(withClass(tree, 'dsh-exp-overview').length, 1, 'общий ряд баланса и пополнений')
  assert.equal(withClass(tree, 'dsh-exp-overview')[0].props.children.length, 2)
  // Без данных таблица не рисуется, но блок итогов и цен на месте.
  assert.ok(all.some(node => node.props?.className === 'dsh-exp-cards'))
  assert.ok(all.some(node => node.props?.className === 'dsh-exp-pricing'))
  assert.equal(withClass(tree, 'dsh-exp-table-scroll').length, 0)
})

test('client.js: строки фильтров и пейджера есть в словаре', async () => {
  const { locales, test: api } = await loadClient()
  const required = [
    'period', 'periodAll', 'periodToday', 'period7', 'period30', 'periodCustom',
    'dateFrom', 'dateTo', 'costFrom', 'costTo', 'tokensFrom', 'tokensTo',
    'page', 'prevPage', 'nextPage', 'week', 'averageSession', 'topUpUnavailable',
    'search', 'resetFilters', 'model', 'statusReady', 'statusLoading', 'statusError', 'refresh',
  ]
  for (const key of required) {
    assert.equal(typeof api.DICT[key], 'string', `в словаре есть ${key}`)
    assert.ok(api.DICT[key] !== '', `${key} не пустой`)
  }
  assert.match(api.DICT.search, /модел/i)
  assert.match(api.DICT.week, /7/)
  const ru = locales.filter(entry => entry.language === 'ru')
  assert.equal(ru.length, 1)
  assert.equal(ru[0].dictionary.period, 'Период')
})

test('client.js: без битых символов в исходнике', async () => {
  const source = await readFile(join(ROOT, 'client.js'), 'utf8')
  assert.ok(!source.includes('\uFFFD'), 'нет символа замены U+FFFD')
  assert.ok(!/Р[ЃЂ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—™љ›њќћџ]/.test(source), 'нет мохито-кодировки cp1251')
})
