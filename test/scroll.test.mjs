/**
 * Вертикальный скролл страницы плагина «Расходы» (main-панель расходов).
 *
 * Требование: если контент выше окна, страница не обрезается. Корень —
 * box-sizing:border-box; width:100%; min-height:0; max-height:100%;
 * overflow-y:auto; overscroll-behavior:contain; padding-bottom; у
 * flex-родителя — flex:1 1 auto. Фиксированной height в px нет. Вложенные
 * блоки с max-height прокручиваются внутри.
 *
 * client.js исполняется в vm с поддельным window.__ModuleLoader__, минимальным
 * React и заглушкой контекста плагина: разметка и CSS проверяются без браузера.
 * Живая геометрия (bottomReachable на окнах 700/800 px и ширинах
 * 1280/1024/768/480 px) проверена headless-прогоном при аудите task-47.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const SOURCE = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const PACKAGE = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

const PLUGIN = "dsh-expenses"
const PACKAGE_NAME = PACKAGE.name
const VERSION = "0.4.15"
const ROOT_SELECTOR = ".dsh-exp-page"
const ARCH = "inner"
const INNER_SELECTOR = ".dsh-exp-scroll"
const CONTENT_SELECTOR = ".dsh-exp-content"
const HAS_DETAIL = false
const HAS_WRAPPER = false
const TABLE_SCROLL_SELECTOR = ".dsh-exp-table-scroll"

/** Поддельный React: хуки возвращают начальные значения, разметка не меняется. */
function makeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) }
    },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useEffect() {},
    useLayoutEffect() {},
    useInsertionEffect() {},
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
    useReducer(_reducer, initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useContext() { return {} },
    useSyncExternalStore() { return undefined },
    createContext(value) { return { Provider: null, Consumer: null, defaultValue: value } },
    forwardRef(fn) { return fn },
    memo(fn) { return fn },
    Component: class { constructor(props) { this.props = props ?? {}; this.state = {} } setState() {} },
    PureComponent: class { constructor(props) { this.props = props ?? {}; this.state = {} } setState() {} },
    Fragment: 'Fragment',
    createRef() { return { current: null } },
    useId() { return 'id' },
    Children: {
      map(children, fn) { return [children].flat(Infinity).map(fn) },
      toArray(children) { return [children].flat(Infinity) },
    },
  }
}

/** Загрузить client.js и применить его к заглушке контекста плагина. */
function boot() {
  let registration
  const store = new Map()
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
  const navigatorStub = {
    clipboard: { writeText: async () => {} },
    language: 'ru-RU',
    platform: 'Win32',
    userAgentData: { platform: 'Windows' },
    credentials: { get: async () => null },
  }
  const documentStub = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillStyle: '' }) }),
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
    documentElement: {},
    body: {},
    head: { appendChild() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const windowStub = {
    __ModuleLoader__: { load: (options) => { registration = options } },
    localStorage,
    navigator: navigatorStub,
    document: documentStub,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
    fetch: async () => ({ ok: false, json: async () => ({}), text: async () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    location: { href: 'http://localhost/', search: '' },
  }
  const sandbox = {
    window: windowStub,
    localStorage,
    navigator: navigatorStub,
    document: documentStub,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    queueMicrotask() {},
    AbortController,
    URL,
    TextEncoder,
    TextDecoder,
    fetch: windowStub.fetch,
    location: windowStub.location,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
    Event: class { constructor(type) { this.type = type } },
    MutationObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })
  assert.ok(registration !== undefined, 'client.js не вызвал window.__ModuleLoader__.load')
  const module = registration.factory((name) => {
    if (name === 'react') return makeReact()
    if (name === 'react-dom') return { createPortal: (node) => node, flushSync: (fn) => fn && fn() }
    if (name === 'react/jsx-runtime') {
      return {
        jsx: (type, props) => ({ type, props: props ?? {}, children: [] }),
        jsxs: (type, props) => ({ type, props: props ?? {}, children: [] }),
        Fragment: 'Fragment',
      }
    }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return new Proxy({}, { get: () => () => null })
    throw new Error('неожиданный require: ' + name)
  })
  const slots = []
  const effect = (callback) => {
    try {
      const dispose = typeof callback === 'function' ? callback() : undefined
      if (typeof dispose === 'function') return dispose
    } catch {}
    return () => {}
  }
  module.apply({
    effect,
    on() { return () => {} },
    emit() {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    locale: {
      register() {},
      bind() { return (key) => 't:' + key },
      getSnapshot: () => ({ active: 'ru' }),
      subscribe: () => () => {},
    },
    i18n: { register() {}, bind() { return (key) => 't:' + key } },
    slots: {
      inject(_name, callback) { try { callback() } catch {} },
      register(options, component) { slots.push({ options, component }); return () => {} },
    },
    connection: { on() { return () => {} }, get: async () => ({}), request: async () => ({}) },
    settings: { get: () => ({}) },
    sessions: {},
    remote: {},
  })
  return slots
}

/** Развернуть функциональные компоненты в узлы { type, props, children }. */
function expand(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((item) => expand(item, depth))
  if (typeof node.type === 'function') {
    assert.ok(depth < 100, 'слишком глубокая вложенность компонентов')
    return expand(node.type(node.props ?? {}), depth + 1)
  }
  const raw = node.props?.children ?? node.children
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw.flat(Infinity) : [raw]
  return { type: node.type, props: node.props ?? {}, children: list.map((child) => expand(child, depth + 1)) }
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function findAll(node, predicate) {
  const found = []
  walk(node, (element) => { if (predicate(element)) found.push(element) })
  return found
}

function collectCss(tree) {
  return findAll(tree, (element) => element.type === 'style')
    .map((element) => element.children.join(''))
    .join('\n')
}

function renderSlot(slots, name, props = {}) {
  const slot = slots.find((item) => item.options?.name === name)
  assert.ok(slot, 'слот ' + name + ' не зарегистрирован')
  return expand(slot.component(props))
}

function rootElement(tree) {
  const list = Array.isArray(tree) ? tree.filter(Boolean) : [tree].filter(Boolean)
  assert.ok(list.length > 0, 'страница ничего не отрисовала')
  return list[0]
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Тела всех CSS-правил с точным селектором. */
function ruleBodies(css, selector) {
  const pattern = new RegExp(escapeRegExp(selector) + '\\s*\\{', 'g')
  const bodies = []
  let match
  while ((match = pattern.exec(css)) !== null) {
    const start = match.index + match[0].length
    const end = css.indexOf('}', start)
    if (end === -1) break
    bodies.push(css.slice(start, end))
    pattern.lastIndex = end
  }
  return bodies
}

function cssHasRule(css, selector, parts, label) {
  const bodies = ruleBodies(css, selector)
  assert.ok(bodies.length > 0, label + ': нет CSS-правила для ' + selector)
  const dump = bodies.join(';')
  for (const part of parts) {
    assert.ok(dump.includes(part), label + ': в CSS ' + selector + ' нет «' + part + '»')
  }
}

/** Нижний отступ из inline-стиля или shorthand padding. */
function paddingBottomOf(style) {
  if (typeof style.paddingBottom === 'number') return style.paddingBottom
  const parts = String(style.padding ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 0
  const bottom = parts.length >= 3 ? parts[2] : parts[0]
  const value = Number.parseFloat(bottom)
  return Number.isFinite(value) ? value : 0
}

/** Нижний отступ из CSS-правила: padding / padding-bottom. */
function cssBottomPadding(body) {
  const explicit = /padding-bottom:\s*([\d.]+)px/.exec(body)
  if (explicit !== null) return Number.parseFloat(explicit[1])
  const shorthand = /(?:^|[;{])\s*padding:\s*([^;}]+)/.exec(body)
  if (shorthand === null) return 0
  const parts = shorthand[1].trim().split(/\s+(?![^(]*\))/).filter(Boolean)
  if (parts.length === 0) return 0
  const bottom = parts.length >= 3 ? parts[2] : parts[0]
  const value = Number.parseFloat(bottom)
  return Number.isFinite(value) ? value : 0
}

function assertScrollRoot(style, label) {
  assert.equal(style.boxSizing, 'border-box', label + ': box-sizing:border-box')
  assert.equal(style.width, '100%', label + ': width:100%')
  assert.equal(style.minHeight, 0, label + ': min-height:0')
  assert.equal(style.maxHeight, '100%', label + ': max-height:100%')
  assert.equal(style.overflowY, 'auto', label + ': overflow-y:auto')
  assert.equal(style.overscrollBehavior, 'contain', label + ': overscroll-behavior:contain')
  assert.equal(style.flex, '1 1 auto', label + ': flex:1 1 auto у flex-родителя')
  assert.ok(paddingBottomOf(style) >= 20, label + ': нижний отступ не меньше 20 px, получено ' + paddingBottomOf(style))
  assert.ok(style.height === undefined || !/^[\d.]+px$/.test(String(style.height)), label + ': нет фиксированной height в px')
  assert.ok(!String(style.height ?? '').includes('100vh'), label + ': нет height:100vh')
}

test('main-панель: корень ограничивает высоту и прокручивается (Расходы)', () => {
  const tree = renderSlot(boot(), 'main')
  const root = rootElement(tree)
  const style = root.props.style ?? {}
  const css = collectCss(tree)
  if (HAS_WRAPPER) {
    // main-панель = прокручиваемая оболочка, внутри — страница с отступами.
    assert.equal(style.flex, '1 1 auto', 'main wrapper: flex:1 1 auto')
    assert.equal(style.width, '100%', 'main wrapper: width:100%')
    assert.equal(style.minHeight, 0, 'main wrapper: min-height:0')
    assert.equal(style.maxHeight, '100%', 'main wrapper: max-height:100%')
    assert.equal(style.overflowY, 'auto', 'main wrapper: overflow-y:auto')
    assert.equal(style.overscrollBehavior, 'contain', 'main wrapper: overscroll-behavior:contain')
    assert.ok(style.height === undefined || !/^[\d.]+px$/.test(String(style.height)), 'main wrapper: нет фиксированной height в px')
    cssHasRule(css, ROOT_SELECTOR, ['min-height:0', 'max-height:100%', 'overflow-y:auto', 'overscroll-behavior:contain'], 'main page CSS')
  } else if (ARCH === 'root') {
    assertScrollRoot(style, 'main')
    cssHasRule(css, ROOT_SELECTOR, [
      'box-sizing:border-box',
      'width:100%',
      'min-height:0',
      'max-height:100%',
      'overflow-y:auto',
      'overscroll-behavior:contain',
    ], 'main CSS')
  } else {
    // Высота ограничена корнем, прокрутка — во вложенном контейнере.
    cssHasRule(css, ROOT_SELECTOR, ['box-sizing:border-box', 'width:100%', 'height:100%', 'min-height:0'], 'main root CSS')
    cssHasRule(css, ROOT_SELECTOR, ['overflow:hidden'], 'main root CSS')
    cssHasRule(css, INNER_SELECTOR, ['flex:1', 'min-height:0', 'overflow:auto', 'overscroll-behavior:contain'], 'inner CSS')
    const contentBodies = ruleBodies(css, CONTENT_SELECTOR)
    assert.ok(contentBodies.length > 0, 'main: нет CSS-правила контента ' + CONTENT_SELECTOR)
    const contentPadding = Math.max(...contentBodies.map((body) => cssBottomPadding(body)))
    assert.ok(contentPadding >= 24, 'main: нижний отступ контента не меньше 24 px, получено ' + contentPadding)
  }
})

test('секция plugins.detail.section плагином не регистрируется', () => {
  const names = boot().map((slot) => slot.options?.name)
  assert.ok(!names.includes('plugins.detail.section'), 'неожиданная секция plugins.detail.section')
})



test('широкая таблица прокручивается по горизонтали внутри', () => {
  const tree = renderSlot(boot(), 'main')
  const css = collectCss(tree)
  cssHasRule(css, TABLE_SCROLL_SELECTOR, ['overflow-x:auto'], 'таблица')
})

test('вложенные блоки с max-height прокручиваются внутри, а не обрезаются (Расходы)', () => {
  const tree = renderSlot(boot(), 'main')
  const css = collectCss(tree)
  // у плагина нет собственных списков с max-height: ограничение не требуется
  // Любой inline max-height обязан иметь собственный overflow: иначе контент обрежется.
  for (const element of findAll(tree, (item) => (item.props?.style ?? {}).maxHeight !== undefined)) {
    const style = element.props.style
    const scrollable = style.overflowY === 'auto' || style.overflowY === 'scroll'
      || style.overflow === 'auto' || style.overflow === 'scroll'
      || element.type === 'textarea'
    assert.ok(scrollable, 'элемент с max-height должен прокручиваться сам: ' + JSON.stringify(style).slice(0, 160))
  }
})

test('версия плагина поднята на +0.0.1', () => {
  assert.match(PACKAGE.version, /^\d+\.\d+\.\d+$/)
  assert.equal(PACKAGE.version, VERSION)
})
