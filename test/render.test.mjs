import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

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
  return { module, registered, injected, locales }
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

test('client.js: страница оформлена по единому стилю', async () => {
  const { registered } = await loadClient()
  const main = registered.find(entry => entry.options.name === 'main')
  const tree = render(main.component({}))
  assert.equal(tree.type, 'section')
  assert.equal(tree.props.className, 'dsh-exp-page')
  const all = elements(tree)

  const style = all.find(node => node.type === 'style')
  assert.ok(style, 'страница подключает свой стиль')
  const css = String(style.props.children)
  assert.match(css, /\.dsh-exp-content\{max-width:960px/)
  assert.match(css, /padding:24px 28px 40px/)
  assert.match(css, /\.dsh-exp-logo\{[^}]*width:52px/)
  assert.match(css, /\.dsh-exp-logo\{[^}]*height:52px/)
  assert.match(css, /\.dsh-exp-heading h1\{font-size:20px/)
  assert.match(css, /\.dsh-exp-card,\.dsh-exp-pricing,\.dsh-exp-topups\{border:1px solid var\(--dsw-alias-border-l2\);border-radius:14px;background:var\(--dsw-alias-bg-layer-1\)\}/)
  assert.match(css, /\.dsh-exp-card\{padding:16px\}/)
  assert.match(css, /\.dsh-exp-button\{height:36px;[^}]*border-radius:10px/)
  assert.match(css, /\.dsh-exp-search input\{height:34px;border-radius:9px/)
  assert.match(css, /:focus-visible/)
  assert.match(css, /@media \(max-width:760px\)/)
  assert.doesNotMatch(css, /#[0-9a-fA-F]{6}/, 'в стилях нет жёстких hex-цветов')

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
  assert.match(css, /\.dsh-exp-chip::before/)

  const refresh = all.find(node => node.type === 'button' && texts(node).join('') === 'Обновить')
  assert.ok(refresh, 'кнопка «Обновить»')
  assert.equal(typeof refresh.props.onClick, 'function', 'обновление подключено')
  assert.match(refresh.props.className, /dsh-exp-button-secondary/)

  // Карточки-секции и их заголовки.
  const cards = all.filter(node => typeof node.props?.className === 'string'
    && /(^|\s)dsh-exp-(card|pricing|topups)(\s|$)/.test(node.props.className))
  assert.ok(cards.length >= 3, `карточек на странице: ${cards.length}`)
  assert.ok(all.some(node => node.props?.className === 'dsh-exp-card-title'), 'заголовки карточек')

  // Пустое состояние таблицы и обработчики полей на месте.
  const page = all.find(node => node.props?.className === 'dsh-exp-scroll')
  assert.ok(page, 'прокручиваемая область')
  const state = all.find(node => node.props?.className === 'dsh-exp-state')
  assert.ok(state, 'пустое состояние загрузки')
})

test('client.js: строки статуса есть в словаре', async () => {
  const { locales } = await loadClient()
  const ru = locales.filter(entry => entry.language === 'ru')
  assert.equal(ru.length, 1)
  for (const key of ['statusReady', 'statusLoading', 'statusError', 'refresh']) {
    assert.equal(typeof ru[0].dictionary[key], 'string', `в словаре есть ${key}`)
  }
})

test('client.js: без битых символов в исходнике', async () => {
  const source = await readFile(join(ROOT, 'client.js'), 'utf8')
  assert.ok(!source.includes('\uFFFD'), 'нет символа замены U+FFFD')
  assert.ok(!/Р[ЃЂ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—™љ›њќћџ]/.test(source), 'нет мохито-кодировки cp1251')
})
