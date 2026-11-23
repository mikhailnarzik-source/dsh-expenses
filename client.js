/**
 * Browser half of the Expenses panel.
 *
 * Registers one global panel ("Расходы") in the left rail and its central page.
 * The page reads the Host's JSON overview once per open; the Host prices every
 * model message from the official DeepSeek price table, and the panel converts
 * those USD costs into the chosen currency with the live rate.
 */
window.__ModuleLoader__.load({
  id: 'dsh-expenses',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Panel identity: the rail entry id and the `main` slot key are the same. */
    const PANEL_ID = 'expenses'
    const NS = 'expenses'
    /** Host route registered by the plugin's Node half. */
    const OVERVIEW_ROUTE = '/api/expenses.overview'
    /** Host route for the signed-in account's wallets. */
    const BALANCE_ROUTE = '/api/expenses.balance'
    /** Host route for the approximate currency rates. */
    const RATES_ROUTE = '/api/expenses.rates'
    /** Host routes for the plugin self-update checks and installation. */
    const UPDATE_STATUS_ROUTE = '/api/expenses.update'
    const UPDATE_CHECK_ROUTE = '/api/expenses.update.check'
    const UPDATE_APPLY_ROUTE = '/api/expenses.update.apply'
    /** A dismissed offer is remembered per available version. */
    const UPDATE_DISMISS_KEY = 'dsh-expenses:update-dismissed'
    /** Build identity reported to the platform on balance requests. */
    const CLIENT_VERSION = '0.4.13'
    const CURRENCY_KEY = 'dsh-expenses:currency'
    const CURRENCIES = ['₽', '$', '¥']
    /** Currency symbol ↔ ISO code, the vocabulary the rate line and the price conversion use. */
    const CURRENCY_CODES = { '₽': 'RUB', '$': 'USD', '¥': 'CNY' }
    const CURRENCY_SYMBOLS = { RUB: '₽', USD: '$', CNY: '¥' }
    /** Official model prices page, linked from the pricing block. */
    const PRICING_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/'
    /** Last observed recharge wallets, used to notice top-ups between polls. */
    const WALLETS_KEY = 'dsh-expenses:balance-wallets'
    /** Host routes for the file-backed top-up history: merge new records, list them. */
    const TOPUPS_ROUTE = '/api/expenses.topups'
    const TOPUPS_MERGE_ROUTE = '/api/expenses.topups.merge'
    /** Legacy localStorage key: migrated into the file once, then cleared. */
    const TOPUPS_KEY = 'dsh-expenses:topups'
    const TOPUPS_LIMIT = 60
    const TOPUPS_SHOWN = 5
    /** Live refresh cadence while the panel is open, and after it was first opened. */
    const BALANCE_REFRESH_MS = 20000
    const BALANCE_BACKGROUND_MS = 60000
    /** Table sort and filter preferences, remembered per browser like the currency. */
    const TABLE_SORT_KEY = 'dsh-expenses:table-sort'
    const TABLE_FILTERS_KEY = 'dsh-expenses:table-filters'
    /** Sessions per page and top-ups per page in the two histories. */
    const SESSION_PAGE_SIZE = 30
    const TOPUP_PAGE_SIZE = 5
    /** The period presets in the session-filter row, plus the free date range. */
    const PERIODS = ['all', 'today', '7d', '30d', 'custom']
    const DAY_MS = 24 * 60 * 60 * 1000
    /** The neutral filter state: both toggles off, the whole history, no ranges. */
    const DEFAULT_FILTERS = Object.freeze({
      onlyToday: false,
      hideSubagents: false,
      period: 'all',
      dateFrom: '',
      dateTo: '',
      costMin: '',
      costMax: '',
      tokensMin: '',
      tokensMax: '',
    })

    /** Every visible string. Registered for `ru` and `en` so the panel stays Russian. */
    const DICT = {
      panel: 'Расходы',
      title: 'Расходы',
      subtitle: 'Токены, запросы и примерная стоимость по всем сессиям',
      refresh: 'Обновить',
      refreshing: 'Обновляю…',
      updatedPrefix: 'Обновлено в',
      today: 'Сегодня',
      allTime: 'За всё время',
      input: 'Вход',
      output: 'Выход',
      requests: 'Запросы',
      toolCalls: 'Инструменты',
      cost: 'Стоимость',
      session: 'Сессия',
      date: 'Дата',
      noSessions: 'Сессий пока нет.',
      loading: 'Загрузка…',
      statusReady: 'Данные актуальны',
      statusLoading: 'Обновляю данные',
      statusError: 'Ошибка загрузки',
      loadFailed: 'Не удалось загрузить данные.',
      retry: 'Повторить',
      subagent: 'субагент', archived: 'удалена', archivedHint: 'Удалённые сессии остаются в истории: их стоимость входит в итоги.',
      untitled: 'Без названия',
      currency: 'Валюта',
      pricingTitle: 'Цены DeepSeek за 1 млн токенов',
      pricingLoading: 'Получаю цены с сайта…',
      pricingFailed: 'Не удалось прочитать цены с сайта.',
      pricingSource: 'Источник',
      pricingReadPrefix: 'цены прочитаны с сайта в',
      pricingUnchanged: 'без изменений',
      pricingChanged: 'цены обновились',
      pricingStale: 'цены могли устареть',
      pricingPeriodPeak: 'сейчас пик (×2)',
      pricingPeriodOffPeak: 'сейчас вне пик, в пик ×2',
      pricingCacheHit: 'кэш-хит',
      pricingCacheMiss: 'кэш-мисс',
      pricingOutput: 'выход',
      pricingNote: 'Стоимость считается по официальным ценам DeepSeek: кэш-хит и кэш-мисс входа плюс выход, с учётом пиковых часов (праздники КНР не учитываются). Валюта — по текущему курсу.',
      cacheTitle: 'из них из кэша',
      unavailable: 'Лог сессии недоступен',
      balance: 'Баланс',
      balanceUsd: 'Доллары',
      balanceCny: 'Юани',
      balanceLoading: 'Получаю баланс…',
      balanceUpdatedPrefix: 'Баланс обновлён в',
      balanceSignedOut: 'Аккаунт DeepSeek не подключён. Войдите в «Настройки → Аккаунт», чтобы видеть баланс в долларах и юанях.',
      balanceFailed: 'Не удалось получить баланс.',
      balanceUnavailable: 'Сервис аккаунта недоступен в этой сборке.',
      rechargeable: 'Пополняемый',
      bonus: 'Бонусный',
      topUps: 'Последние пополнения',
      topUpsEmpty: 'Пополнения, замеченные плагином, появятся здесь.',
      topUpsHint: 'Фиксируются по росту пополняемого баланса с момента установки плагина; если пополнение совпало с расходом, сумма может быть неточной.', topUpsTotal: 'Всего пополнено',
      records: 'записей',
      topUpAction: 'Пополнить',
      topUpUnavailable: 'Ссылка на пополнение недоступна: баланс не подключён',
      balanceFooterHint: 'Откроется сайт пополнения DeepSeek',
      week: 'За 7 дней',
      weekHint: 'Стоимость сессий, созданных за последние 7 дней',
      averageSession: 'Средний расход',
      averageHint: 'Средняя стоимость сессии за всё время',
      total: 'Итого',
      rateLabel: 'Курс',
      rateLoading: 'Получаю курс…',
      rateFailed: 'Курс недоступен',
      rateUpdatedPrefix: 'курс обновлён в',
      rateStale: 'курс мог устареть',
      search: 'Поиск по названию или модели',
      searchClear: 'Сбросить поиск',
      onlyToday: 'Только сегодня',
      hideSubagents: 'Без субагентов',
      period: 'Период',
      periodAll: 'Всё время',
      periodToday: 'Сегодня',
      period7: '7 дней',
      period30: '30 дней',
      periodCustom: 'Свои даты',
      dateFrom: 'Дата с',
      dateTo: 'Дата по',
      costFrom: 'Стоимость от',
      costTo: 'Стоимость до',
      tokensFrom: 'Токены от',
      tokensTo: 'Токены до',
      model: 'Модель',
      page: 'Стр.',
      prevPage: 'Предыдущая страница',
      nextPage: 'Следующая страница',
      shown: 'Показано',
      of: 'из',
      shownCost: 'Стоимость выбранных',
      rowsRange: 'строки',
      noMatches: 'По этому фильтру сессий нет.',
      resetFilters: 'Сбросить фильтры',
      sortBy: 'Сортировать',
      ascending: 'по возрастанию',
      descending: 'по убыванию',
      version: 'Версия',
      checkUpdates: 'Проверить обновления',
      checkingUpdates: 'Проверяю…',
      updateAvailable: 'Доступно обновление',
      updateCurrent: 'Установлена последняя версия.',
      updateFailed: 'Не удалось проверить обновления',
      installUpdate: 'Установить',
      installingUpdate: 'Устанавливаю…',
      later: 'Позже',
      reloadPage: 'Перезагрузить',
      updateInstalled: 'Обновление установлено.',
      restartHint: 'Перезапустите DSH или обновите страницу, чтобы загрузить новую версию.',
      updateDirty: 'Есть локальные изменения — обновление остановлено.',
      updateNotes: 'Что нового',
      newCommits: 'новых коммитов',
      behindPrefix: 'позади на',
      updateClose: 'Скрыть предложение',
    }

    const CSS = `
.dsh-exp-page{box-sizing:border-box;display:flex;width:100%;min-width:0;height:100%;max-height:100%;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);background:radial-gradient(900px 260px at 12% -90px,color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent),transparent 72%),radial-gradient(760px 220px at 88% -110px,color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent),transparent 72%),var(--dsw-alias-bg-base);font-size:14px;line-height:1.6}
.dsh-exp-scroll{position:relative;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.dsh-exp-content{box-sizing:border-box;width:100%;max-width:960px;min-width:0;margin:0 auto;padding:24px 28px 40px}
.dsh-exp-heading{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:16px;min-width:0}
.dsh-exp-heading-main{display:flex;align-items:center;gap:14px;min-width:0}
.dsh-exp-heading-text{min-width:0}
.dsh-exp-logo{display:flex;flex:none;align-items:center;justify-content:center;width:52px;height:52px;border-radius:14px;background:linear-gradient(135deg,var(--dsw-alias-brand-primary),color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-state-business-primary)));color:var(--dsw-alias-label-primary-inverted);box-shadow:0 6px 16px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent);font-size:26px;line-height:1}
.dsh-exp-heading h1{margin:0;font-size:20px;font-weight:600;line-height:26px;letter-spacing:-.01em;overflow-wrap:anywhere}
.dsh-exp-sub{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px;overflow-wrap:anywhere}
.dsh-exp-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;min-width:0}
.dsh-exp-updated,.dsh-exp-version{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}
/* Кнопки: единая система из .tools/plugin-design-spec-v2.md. */
.dsh-exp-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:36px;padding:0 14px;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;font-weight:600;line-height:1;white-space:nowrap;text-decoration:none;cursor:pointer;appearance:none;-webkit-appearance:none;transition:background-color .12s ease,border-color .12s ease,color .12s ease}
.dsh-exp-button:disabled{opacity:.55;cursor:default}
.dsh-exp-button-primary{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);color:var(--dsw-alias-brand-primary)}
.dsh-exp-button-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent)}
.dsh-exp-button-secondary{background:transparent;border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary)}
.dsh-exp-button-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-exp-button-danger{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 50%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsh-exp-button-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 26%,transparent)}
.dsh-exp-button-small{height:32px;padding:0 12px}
.dsh-exp-actions .dsh-exp-button{height:32px;padding:0 12px}
.dsh-exp-button:focus-visible,.dsh-exp-select:focus-visible,.dsh-exp-input:focus-visible,.dsh-exp-search input:focus-visible,.dsh-exp-sort:focus-visible,.dsh-exp-link:focus-visible,.dsh-exp-search-clear:focus-visible,.dsh-exp-toggle input:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);outline-offset:1px}
/* Сетки: общий ряд карточек, дети не распирают ячейку. */
.dsh-exp-overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:12px;margin-bottom:16px;align-items:stretch;min-width:0}
.dsh-exp-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:12px;margin-bottom:16px;align-items:stretch;min-width:0}
.dsh-exp-card,.dsh-exp-pricing,.dsh-exp-topups{position:relative;box-sizing:border-box;display:flex;flex-direction:column;min-width:0;height:100%;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}
.dsh-exp-card::before,.dsh-exp-pricing::before,.dsh-exp-topups::before{content:'';position:absolute;inset:0 0 auto;height:2px;background:var(--exp-accent,transparent);opacity:.85}
.dsh-exp-card{padding:16px;gap:12px}
.dsh-exp-cards .dsh-exp-card:nth-child(1){--exp-accent:var(--dsw-alias-brand-primary)}
.dsh-exp-cards .dsh-exp-card:nth-child(2){--exp-accent:var(--dsw-alias-state-business-primary)}
.dsh-exp-card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;min-width:0}
.dsh-exp-card-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px;overflow-wrap:anywhere}
.dsh-exp-cost{font-size:22px;font-weight:600;line-height:30px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-exp-cost-empty{color:var(--dsw-alias-label-tertiary);font-size:22px;font-weight:500;line-height:30px}
.dsh-exp-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:auto}
.dsh-exp-metric{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-exp-metric-label{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;text-overflow:ellipsis}
.dsh-exp-metric-label::before{content:'';display:inline-block;width:6px;height:6px;margin-right:7px;border-radius:50%;vertical-align:1px;background:var(--dsw-alias-label-caption)}
.dsh-exp-metric:nth-child(1) .dsh-exp-metric-label::before{background:var(--dsw-alias-brand-primary)}
.dsh-exp-metric:nth-child(2) .dsh-exp-metric-label::before{background:var(--dsw-alias-state-success-primary)}
.dsh-exp-metric:nth-child(3) .dsh-exp-metric-label::before{background:var(--dsw-alias-state-warn-primary)}
.dsh-exp-metric:nth-child(4) .dsh-exp-metric-label::before{background:var(--dsw-alias-state-business-primary)}
.dsh-exp-metric-value{font-size:14px;font-weight:500;line-height:22px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dsh-exp-card-footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:4px;min-width:0}
.dsh-exp-card-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
/* Цены и курс. */
.dsh-exp-pricing{--exp-accent:var(--dsw-alias-state-warn-primary);padding:16px;margin-bottom:16px;gap:0}
.dsh-exp-pricing-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;min-width:0}
.dsh-exp-pricing-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;min-width:0}
.dsh-exp-pricing-status{margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-exp-pricing-models{display:flex;flex-direction:column;gap:6px;margin-top:10px;min-width:0}
.dsh-exp-pricing-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 16px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-width:0}
.dsh-exp-pricing-model{padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;font-weight:600;line-height:18px;overflow-wrap:anywhere}
.dsh-exp-pricing-price{white-space:nowrap}
.dsh-exp-pricing-price b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}
.dsh-exp-price-hit b{color:var(--dsw-alias-state-success-primary)}
.dsh-exp-price-miss b{color:var(--dsw-alias-state-warn-primary)}
.dsh-exp-price-out b{color:var(--dsw-alias-brand-primary)}
.dsh-exp-rate{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px;width:100%;margin-top:12px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-width:0}
.dsh-exp-rate-label{color:var(--dsw-alias-label-tertiary)}
.dsh-exp-rate-values{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dsh-exp-rate-updated{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
/* Баланс и пополнения: один общий ряд. */
.dsh-exp-balance-card{--exp-accent:var(--dsw-alias-brand-primary)}
.dsh-exp-balance-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 12px;min-width:0}
.dsh-exp-wallet-updated{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dsh-exp-wallets{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:10px;min-width:0}
.dsh-exp-wallet{display:flex;flex-direction:column;gap:2px;min-width:0;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}
.dsh-exp-wallet-label{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 8px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-exp-wallet-code{padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:18px;letter-spacing:.06em;white-space:nowrap}
.dsh-exp-wallet-total{font-size:22px;font-weight:600;line-height:30px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-exp-wallet-lines{display:flex;flex-wrap:wrap;gap:2px 14px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;min-width:0}
.dsh-exp-wallet-lines b{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}
.dsh-exp-wallet-state{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dsh-exp-balance-metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;margin-top:0}
.dsh-exp-topups{--exp-accent:var(--dsw-alias-state-success-primary);padding:16px;gap:0}
.dsh-exp-topups-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 12px;min-width:0}
.dsh-exp-topup-list{display:flex;flex:1;flex-direction:column;margin:8px 0 0;padding:0;list-style:none;min-width:0}
.dsh-exp-topup{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0;padding:7px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:13px;line-height:20px}
.dsh-exp-topup:last-child{border-bottom:none}
.dsh-exp-topup-time{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-exp-topup-amount{color:var(--dsw-alias-state-success-primary);font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-exp-topups-empty{display:flex;flex:1;align-items:center;justify-content:center;margin:8px 0 0;text-align:center}
.dsh-exp-topups-hint{margin-top:auto;padding-top:10px}
/* Пагинация. */
.dsh-exp-pager{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;min-width:0}
.dsh-exp-pager-label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dsh-exp-pager-buttons{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-left:auto}
.dsh-exp-pager .dsh-exp-button{min-width:34px;padding:0 10px}
.dsh-exp-topups .dsh-exp-pager{margin:0 0 0 auto}
.dsh-exp-topups .dsh-exp-card-footer{margin-top:10px}
/* Поля, панель фильтров и таблица. */
.dsh-exp-table-wrap{display:flex;flex-direction:column;min-width:0;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}
.dsh-exp-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);min-width:0}
.dsh-exp-filters{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px 12px;padding:0 12px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2);min-width:0}
.dsh-exp-search{position:relative;display:flex;flex:1 1 220px;align-items:center;min-width:0;max-width:100%;color:var(--dsw-alias-label-tertiary)}
.dsh-exp-search-icon{position:absolute;left:10px;display:flex;pointer-events:none}
.dsh-exp-search input{box-sizing:border-box;width:100%;min-width:0;height:34px;padding:0 30px 0 32px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;transition:border-color .15s,box-shadow .15s;-webkit-appearance:none;appearance:none}
.dsh-exp-search input::-webkit-search-cancel-button{display:none}
.dsh-exp-search input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dsh-exp-search input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.dsh-exp-search-clear{position:absolute;right:3px;display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:16px;line-height:1;cursor:pointer}
.dsh-exp-search-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-exp-toggle{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;cursor:pointer;user-select:none;min-width:0}
.dsh-exp-toggle:hover{color:var(--dsw-alias-label-primary)}
.dsh-exp-toggle input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsh-exp-count{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dsh-exp-count b{color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-exp-field{display:flex;flex-direction:column;gap:4px;flex:1 1 104px;min-width:0;max-width:150px}
.dsh-exp-field-label{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap;text-overflow:ellipsis}
.dsh-exp-input,.dsh-exp-select{box-sizing:border-box;width:100%;min-width:0;height:34px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px}
.dsh-exp-select{padding-right:6px;cursor:pointer}
.dsh-exp-input:hover,.dsh-exp-select:hover{border-color:var(--dsw-alias-border-l3)}
.dsh-exp-input:focus,.dsh-exp-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.dsh-exp-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dsh-exp-filters .dsh-exp-button{margin-left:auto}
.dsh-exp-table-scroll{width:100%;max-width:100%;overflow-x:auto;overflow-y:hidden}
.dsh-exp-table{width:100%;min-width:700px;border-collapse:collapse;table-layout:fixed;font-size:13px;font-variant-numeric:tabular-nums}
.dsh-exp-table th{padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;text-align:left;white-space:nowrap}
.dsh-exp-table th[aria-sort="ascending"],.dsh-exp-table th[aria-sort="descending"]{color:var(--dsw-alias-label-primary)}
.dsh-exp-table td{padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);vertical-align:middle;min-width:0}
.dsh-exp-table tbody tr:last-child td{border-bottom:none}
.dsh-exp-table tbody tr:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 4%,transparent)}
.dsh-exp-num{text-align:right;white-space:nowrap}
.dsh-exp-session{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-exp-session-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dsh-exp-badge{flex:none;padding:0 7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,var(--dsw-alias-bg-layer-1));color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 75%,var(--dsw-alias-label-primary));font-size:11px;line-height:18px;white-space:nowrap}
.dsh-exp-date{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-exp-cost-cell{white-space:nowrap;font-weight:600;color:color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,var(--dsw-alias-label-primary))}
.dsh-exp-dash{color:var(--dsw-alias-label-tertiary)}
.dsh-exp-table-footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-top:.5px solid var(--dsw-alias-border-l1);min-width:0}
.dsh-exp-table-footer .dsh-exp-pager{flex:1 1 100%;margin:0}
.dsh-exp-sort{display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:none;color:inherit;font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.dsh-exp-sort:hover{color:var(--dsw-alias-label-primary)}
.dsh-exp-sort-ind{color:var(--dsw-alias-brand-primary);font-size:10px;line-height:1}
.dsh-exp-table th.dsh-exp-num .dsh-exp-sort{justify-content:flex-end;width:100%}
.dsh-exp-no-matches{padding:24px 16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;text-align:center}
.dsh-exp-no-matches .dsh-exp-button{margin-top:10px}
.dsh-exp-state{padding:32px 16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;text-align:center;overflow-wrap:anywhere}
.dsh-exp-alert{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px;padding:32px 16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;min-width:0}
.dsh-exp-warning{padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-exp-stale{color:var(--dsw-alias-state-warn-primary)}
.dsh-exp-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.dsh-exp-link{color:var(--dsw-alias-link);font-size:13px;line-height:20px;white-space:nowrap;text-decoration:none;border-radius:4px}
.dsh-exp-link:hover{text-decoration:underline}
.dsh-exp-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;white-space:nowrap}
.dsh-exp-chip::before{content:'';flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}
.dsh-exp-chip.is-ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsh-exp-chip.is-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-primary)}
.dsh-exp-chip.is-bad{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}
/* Баннер и плашка обновления. */
.dsh-exp-update-banner{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;box-sizing:border-box;padding:12px 16px;margin-bottom:16px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 38%,var(--dsw-alias-border-l2));border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-layer-1));min-width:0}
.dsh-exp-update-banner-main{flex:1 1 200px;min-width:0}
.dsh-exp-update-banner-title{font-size:13px;font-weight:600;line-height:20px;overflow-wrap:anywhere}
.dsh-exp-update-banner-text{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-exp-update-notes{margin:6px 0 0;padding-left:18px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-exp-update-banner-actions{display:flex;flex-wrap:wrap;gap:8px;margin-left:auto}
.dsh-exp-update-banner-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,var(--dsw-alias-bg-layer-1))}
.dsh-exp-update-toast{position:fixed;bottom:22px;right:22px;z-index:2147483000;box-sizing:border-box;width:min(380px,calc(100vw - 44px));padding:14px 16px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l2));border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 14px 38px rgba(15,23,42,.18);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;pointer-events:auto}
.dsh-exp-update-toast-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.dsh-exp-update-toast-title{font-size:13px;font-weight:600;line-height:20px}
.dsh-exp-update-toast-versions{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dsh-exp-update-toast-text{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-exp-update-toast-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.dsh-exp-update-close{flex:none;display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:16px;line-height:1;cursor:pointer}
.dsh-exp-update-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-exp-update-current{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
/* Адаптив: 900 — одна колонка обзора, 640 — компактные отступы. */
@media (max-width:900px){.dsh-exp-overview{grid-template-columns:minmax(0,1fr)}.dsh-exp-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:640px){.dsh-exp-content{padding:16px 16px 32px}.dsh-exp-heading{gap:10px}.dsh-exp-actions{width:100%;justify-content:flex-start}.dsh-exp-actions .dsh-exp-button{flex:1 1 auto}.dsh-exp-card,.dsh-exp-pricing,.dsh-exp-topups{padding:14px}.dsh-exp-search{flex:1 1 100%}.dsh-exp-count{margin-left:0;flex:1 1 100%}.dsh-exp-field{flex:1 1 45%;max-width:none}.dsh-exp-filters .dsh-exp-button{margin-left:0;flex:1 1 100%}.dsh-exp-table{min-width:640px}.dsh-exp-table th,.dsh-exp-table td{padding:8px}.dsh-exp-balance-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
    `

    /** Read one stored preference without letting a browser restriction crash the panel. */
    function readStored(key) {
      try {
        const value = window.localStorage.getItem(key)
        return value === null ? '' : value
      } catch {
        return ''
      }
    }

    /** Persist one preference; a denied write changes nothing visible. */
    function store(key, value) {
      try {
        if (value === '') window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, value)
      } catch {
        // Private-mode storage is optional: the field still works for this view.
      }
    }

    const integerFormat = new Intl.NumberFormat('ru-RU')
    const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

    /** Group-separated token count. */
    function formatTokens(value) {
      return integerFormat.format(Math.round(Number(value) || 0))
    }

    /** A money amount rounded for reading, never for arithmetic. */
    function formatMoney(value, symbol) {
      const digits = value > 0 && value < 1 ? 4 : 2
      const text = new Intl.NumberFormat('ru-RU', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(value)
      return `${text} ${symbol}`
    }

    /** Convert a USD figure (cost or per-million price) into the display currency. */
    function toDisplayCurrency(amountUsd, code, rateData) {
      if (amountUsd === null || amountUsd === undefined) return null
      const amount = Number(amountUsd)
      if (!Number.isFinite(amount)) return null
      if (code === 'USD') return amount
      if (rateData === null) return null
      return convertPrice(amount, 'USD', code, rateData)
    }

    /** Whether Platform is billing at the peak rate right now (01:00-04:00, 06:00-10:00 UTC, weekdays). */
    function isPeakNow(time = Date.now()) {
      const date = new Date(time)
      const day = date.getUTCDay()
      if (day === 0 || day === 6) return false
      const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
      return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600)
    }

    /** Short error text safe to show in the panel. */
    function messageOf(error) {
      if (error === null || error === undefined) return 'unknown error'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    /** Read the host's cached update snapshot; the host owns the network work. */
    async function readUpdateStatus() {
      const response = await fetch(UPDATE_STATUS_ROUTE, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      if (data === null || typeof data !== 'object') throw new Error('unexpected response')
      return data
    }

    /** Ask the host to check or install, and read its answer. */
    async function postUpdate(route, payload) {
      const response = await fetch(route, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok) {
        throw new Error(data !== null && typeof data === 'object' && typeof data.error === 'string' ? data.error : `HTTP ${response.status}`)
      }
      return data
    }

    /** Poll the host's update snapshot while this component is mounted. */
    function useUpdateState(pollMs) {
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null })
      const refresh = React.useCallback(async () => {
        try {
          const data = await readUpdateStatus()
          setState({ status: 'ready', data, error: null })
          return data
        } catch (error) {
          setState(current => ({ status: current.data === null ? 'error' : 'ready', data: current.data, error: messageOf(error) }))
          return null
        }
      }, [])
      React.useEffect(() => {
        void refresh()
        const timer = setInterval(() => {
          void refresh()
        }, pollMs)
        return () => clearInterval(timer)
      }, [refresh, pollMs])
      return [state, refresh]
    }

    /** `money` formats one wallet decimal for reading; the stored strings keep full precision. */
    const moneyFormat = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const rateFormat = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

    /** The symbol used in front of one wallet amount. */
    function currencySymbol(currency) {
      if (currency === 'USD') return '$'
      if (currency === 'CNY') return '¥'
      return `${currency} `
    }

    /** `$12,34` / `¥45,67`; an unreadable balance shows a dash instead of NaN. */
    function formatCurrency(value, currency) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      return `${currencySymbol(currency)}${moneyFormat.format(number)}`
    }

    /** One local timestamp for a detected top-up. */
    function formatDateTime(time) {
      const date = new Date(time)
      return Number.isNaN(date.getTime()) ? '—' : dateTimeFormat.format(date)
    }

    /** Read one JSON preference; a missing or malformed value reads as `null`. */
    function readJson(key) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null) return null
        return JSON.parse(raw)
      } catch {
        return null
      }
    }

    /** Persist one JSON preference; a denied write changes nothing visible. */
    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // Storage is optional: live values still render for this view.
      }
    }

    /** Deterministic merge id of one top-up record — the same formula the Host uses. */
    function topUpId(at, currency, amount) {
      return `topup:${Number(at)}:${currency}:${amount}`
    }

    /** Validate one top-up record for the merge route; unusable records are dropped. */
    function normalizeTopUp(entry) {
      if (entry === null || typeof entry !== 'object') return null
      const at = Number(entry.at)
      const currency = typeof entry.currency === 'string' ? entry.currency : ''
      const amount = Number(entry.amount)
      if (!Number.isFinite(at) || at <= 0) return null
      if (!/^[A-Za-z]{2,8}$/u.test(currency)) return null
      if (!Number.isFinite(amount) || amount <= 0) return null
      return { id: topUpId(at, currency, amount), at, currency, amount }
    }

    /** Legacy top-up list from localStorage — only the first-run migration reads it. */
    function readLegacyTopUps() {
      const parsed = readJson(TOPUPS_KEY)
      if (!Array.isArray(parsed)) return []
      return parsed
        .filter(entry => entry !== null
          && typeof entry === 'object'
          && Number.isFinite(Number(entry.at))
          && Number(entry.at) > 0
          && typeof entry.currency === 'string'
          && entry.currency !== ''
          && Number.isFinite(Number(entry.amount))
          && Number(entry.amount) > 0)
        .map(entry => ({
          id: topUpId(Number(entry.at), entry.currency, Number(entry.amount)),
          at: Number(entry.at),
          currency: entry.currency,
          amount: Number(entry.amount),
        }))
        .slice(0, TOPUPS_LIMIT)
    }

    /** The recharge-wallet balances seen by the previous successful poll. */
    function readWalletSnapshot() {
      const parsed = readJson(WALLETS_KEY)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const wallets = new Map()
      for (const currency of ['USD', 'CNY']) {
        const value = Number(parsed[currency])
        if (Number.isFinite(value)) wallets.set(currency, value)
      }
      return wallets.size === 0 ? null : wallets
    }

    /**
     * Compare one live balance reading with the previous one and append a top-up
     * entry for every recharge wallet that grew. The first reading only seeds the
     * baseline, so an empty history is expected until the balance first increases.
     */
    function recordBalanceRead(data) {
      if (data === null || typeof data !== 'object' || data.status !== 'ready') return
      const wallets = Array.isArray(data.wallets) ? data.wallets : []
      const next = new Map()
      for (const wallet of wallets) {
        if (wallet === null || typeof wallet !== 'object') continue
        const value = Number(wallet.balance)
        if (typeof wallet.currency === 'string' && Number.isFinite(value)) next.set(wallet.currency, value)
      }
      if (next.size === 0) return
      const previous = readWalletSnapshot()
      const detected = []
      if (previous !== null) {
        for (const [currency, value] of next) {
          const before = previous.get(currency)
          if (before === undefined || !Number.isFinite(before)) continue
          if (value > before + 0.000001) detected.push({ at: Date.now(), currency, amount: value - before })
        }
      }
      if (detected.length > 0) void submitDetectedTopUps(detected)
      const snapshot = {}
      for (const [currency, value] of next) snapshot[currency] = value
      writeJson(WALLETS_KEY, snapshot)
    }

    /** The balance request URL; account metadata rides the query so the Host can derive its headers. */
    function balanceQuery(fresh) {
      const params = new URLSearchParams({
        locale: (typeof document !== 'undefined' && document.documentElement.lang) || 'ru',
        tz: String(-new Date().getTimezoneOffset() * 60),
        version: CLIENT_VERSION,
      })
      if (fresh) params.set('fresh', '1')
      return `${BALANCE_ROUTE}?${params.toString()}`
    }

    /** Single-flight guard so a panel poll and the background poll never double-record one top-up. */
    let balanceInFlight
    let balanceTimer

    /**
     * Read the wallets once, record any detected top-up, and report the outcome.
     * @param fresh - bypass the Host's short cache.
     */
    function pollBalance(fresh) {
      if (balanceInFlight !== undefined) return balanceInFlight
      balanceInFlight = (async () => {
        try {
          const response = await fetch(balanceQuery(fresh), { credentials: 'same-origin', cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (data === null || typeof data !== 'object' || typeof data.status !== 'string') throw new Error('unexpected response')
          recordBalanceRead(data)
          return { status: data.status, data, error: null, updatedAt: Date.now() }
        } catch (error) {
          return { status: 'error', data: null, error: messageOf(error), updatedAt: 0 }
        } finally {
          balanceInFlight = undefined
        }
      })()
      return balanceInFlight
    }

    /** Keep watching for top-ups after the panel was first opened, so the history is not gap-toothed. */
    function startBackgroundBalancePoller() {
      if (balanceTimer !== undefined) return
      balanceTimer = setInterval(() => {
        void pollBalance(false)
      }, BALANCE_BACKGROUND_MS)
    }

    /** Stop the background poll; the plugin owns exactly one. */
    function stopBackgroundBalancePoller() {
      if (balanceTimer === undefined) return
      clearInterval(balanceTimer)
      balanceTimer = undefined
    }

    /** Последний успешный набор курсов: прикладывается к записи пополнения. */
    let lastRates = null

    /** Миниатюра курсов для записи: «курс на момент записи», не «сегодняшний». */
    function ratesSnapshot(rates) {
      if (rates === null || typeof rates !== 'object') return null
      const rubPerUsd = Number(rates.rubPerUsd)
      const rubPerCny = Number(rates.rubPerCny)
      const cnyPerUsd = Number(rates.cnyPerUsd)
      if (!Number.isFinite(rubPerUsd) || rubPerUsd <= 0
        || !Number.isFinite(rubPerCny) || rubPerCny <= 0
        || !Number.isFinite(cnyPerUsd) || cnyPerUsd <= 0) return null
      const updatedAt = Number(rates.updatedAt)
      return {
        rubPerUsd,
        rubPerCny,
        cnyPerUsd,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      }
    }

    /** POST one batch of top-up records to the Host merge route. */
    function postTopUps(entries) {
      return fetch(TOPUPS_MERGE_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries }),
      }).then(async (response) => {
        const data = await response.json().catch(() => null)
        if (!response.ok) {
          throw new Error(data !== null && typeof data === 'object' && typeof data.error === 'string' ? data.error : `HTTP ${response.status}`)
        }
        return data
      })
    }

    /**
     * Отправить зафиксированные пополнения в файл на Host. Курсы прикладываются,
     * только если они уже известны — это курс на момент записи.
     */
    function submitDetectedTopUps(rawEntries) {
      const entries = (Array.isArray(rawEntries) ? rawEntries : [])
        .map(normalizeTopUp)
        .filter(entry => entry !== null)
      if (entries.length === 0) return Promise.resolve(null)
      const snapshot = ratesSnapshot(lastRates)
      const payload = snapshot === null ? entries : entries.map(entry => ({ ...entry, rates: snapshot }))
      return postTopUps(payload).catch(() => null)
    }

    /** Прочитать историю пополнений из файла на Host. */
    async function fetchTopUps() {
      const response = await fetch(TOPUPS_ROUTE, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      if (data === null || typeof data !== 'object' || !Array.isArray(data.entries)) throw new Error('unexpected response')
      return data.entries
    }

    /**
     * Первый запуск после обновления: пополнения из старого localStorage-ключа
     * отправляются в файл на Host, затем ключ очищается. Один раз за загрузку;
     * если отправка не удалась, ключ остаётся и миграция повторится.
     */
    let migrationStarted = false
    async function migrateLegacyTopUps() {
      if (migrationStarted) return
      migrationStarted = true
      const entries = readLegacyTopUps()
      if (entries.length === 0) return
      const result = await postTopUps(entries).catch(() => null)
      if (result !== null && result !== undefined && result.ok === true) {
        try {
          window.localStorage.removeItem(TOPUPS_KEY)
        } catch {
          // Очистка необязательна: при следующем запуске миграция повторится.
        }
      }
    }

    let ratesInFlight

    /** Read the approximate rates once; concurrent callers share the request. */
    function pollRates(fresh) {
      if (ratesInFlight !== undefined) return ratesInFlight
      ratesInFlight = (async () => {
        try {
          const response = await fetch(fresh ? `${RATES_ROUTE}?fresh=1` : RATES_ROUTE, {
            credentials: 'same-origin',
            cache: 'no-store',
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (data === null || typeof data !== 'object' || typeof data.status !== 'string') throw new Error('unexpected response')
          if (data.status === 'ready') lastRates = data
          return {
            status: data.status,
            data: data.status === 'ready' ? data : null,
            error: data.status === 'ready' ? null : (typeof data.reason === 'string' ? data.reason : 'rates-unavailable'),
            fetchedAt: Date.now(),
          }
        } catch (error) {
          return { status: 'error', data: null, error: messageOf(error), fetchedAt: 0 }
        } finally {
          ratesInFlight = undefined
        }
      })()
      return ratesInFlight
    }

    /** RUB per one unit of `code`, the pivot every conversion goes through. */
    function rubPerUnit(rates, code) {
      if (code === 'RUB') return 1
      if (code === 'USD') return Number(rates.rubPerUsd)
      if (code === 'CNY') return Number(rates.rubPerCny)
      return Number.NaN
    }

    /** Convert one amount between the three currencies, or `null` when a rate is missing. */
    function convertPrice(amount, fromCode, toCode, rates) {
      const from = rubPerUnit(rates, fromCode)
      const to = rubPerUnit(rates, toCode)
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= 0) return null
      return (amount * from) / to
    }

    /** Every sortable Session-table column, in header order. */
    const SORT_KEYS = ['session', 'date', 'input', 'output', 'requests', 'toolCalls', 'cost']

    /** The remembered sort choice, defaulting to newest Sessions first. */
    function readTableSort() {
      const parsed = readJson(TABLE_SORT_KEY)
      if (parsed === null || typeof parsed !== 'object') return { key: 'date', direction: 'desc' }
      return {
        key: SORT_KEYS.includes(parsed.key) ? parsed.key : 'date',
        direction: parsed.direction === 'asc' ? 'asc' : 'desc',
      }
    }

    /** The remembered filters: both toggles, the period and every numeric range. */
    function readTableFilters() {
      const parsed = readJson(TABLE_FILTERS_KEY)
      const next = { ...DEFAULT_FILTERS }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return next
      next.onlyToday = parsed.onlyToday === true
      next.hideSubagents = parsed.hideSubagents === true
      if (PERIODS.includes(parsed.period)) next.period = parsed.period
      for (const key of ['dateFrom', 'dateTo']) {
        if (typeof parsed[key] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed[key])) next[key] = parsed[key]
      }
      for (const key of ['costMin', 'costMax', 'tokensMin', 'tokensMax']) {
        if (typeof parsed[key] === 'string' || typeof parsed[key] === 'number') next[key] = String(parsed[key])
      }
      return next
    }

    /** Parse one typed range bound: empty means "no bound", a comma decimal point is accepted. */
    function parseFilterNumber(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null
      if (typeof value !== 'string') return null
      const text = value.trim().replace(/[\s\u00a0]/g, '').replace(',', '.')
      if (text === '') return null
      const number = Number(text)
      return Number.isFinite(number) ? number : null
    }

    /** Epoch ms of the local start of the day `time` falls in. */
    function startOfLocalDay(time) {
      const date = new Date(Number(time) || 0)
      date.setHours(0, 0, 0, 0)
      return date.getTime()
    }

    /** Parse one `YYYY-MM-DD` date input as a local day; `null` when the text is not a date. */
    function parseDateInput(text) {
      if (typeof text !== 'string') return null
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
      if (match === null) return null
      const year = Number(match[1])
      const month = Number(match[2])
      const day = Number(match[3])
      const date = new Date(year, month - 1, day)
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
      return date.getTime()
    }

    /**
     * The inclusive epoch-ms window of the chosen period; `null` means "no period filter".
     * Custom dates are inclusive: the "до" day counts up to its local midnight.
     */
    function periodRange(filters, now) {
      const period = PERIODS.includes(filters?.period) ? filters.period : 'all'
      if (period === 'all') return null
      const today = startOfLocalDay(now)
      if (period === 'today') return { from: today, to: today + DAY_MS - 1 }
      if (period === '7d') return { from: today - 6 * DAY_MS, to: today + DAY_MS - 1 }
      if (period === '30d') return { from: today - 29 * DAY_MS, to: today + DAY_MS - 1 }
      const rawFrom = parseDateInput(filters?.dateFrom)
      const rawTo = parseDateInput(filters?.dateTo)
      if (rawFrom === null && rawTo === null) return null
      const from = rawFrom === null ? Number.NEGATIVE_INFINITY : rawFrom
      const to = rawTo === null ? Number.POSITIVE_INFINITY : rawTo + DAY_MS - 1
      return { from, to }
    }

    /** Every model name a Session answered with, newest host rows carry up to 12 of them. */
    function rowModels(row) {
      if (Array.isArray(row?.models)) return row.models.filter(model => typeof model === 'string' && model !== '')
      if (typeof row?.model === 'string' && row.model !== '') return [row.model]
      return []
    }

    /** Total tokens of one Session: input (cache miss + cache hit) plus output. */
    function sessionTokens(row) {
      return (Number(row?.input) || 0) + (Number(row?.cacheHit) || 0) + (Number(row?.output) || 0)
    }

    /** The case-insensitive haystack the search field matches: Session title plus its models. */
    function searchText(row) {
      return [String(row?.title ?? ''), rowModels(row).join(' ')].join(' ').toLowerCase()
    }

    /**
     * Apply the session-history filters to rows the client already holds.
     * `options.costOf` converts one row cost into the display currency, `options.now` pins "today".
     */
    function filterSessions(rows, filters, options = {}) {
      const list = Array.isArray(rows) ? rows : []
      const active = filters === null || typeof filters !== 'object' ? DEFAULT_FILTERS : filters
      const now = Number.isFinite(options.now) ? options.now : Date.now()
      const needle = String(options.query ?? '').trim().toLowerCase()
      const costOf = typeof options.costOf === 'function' ? options.costOf : row => row?.costUsd
      const range = periodRange(active, now)
      const costMin = parseFilterNumber(active.costMin)
      const costMax = parseFilterNumber(active.costMax)
      const tokensMin = parseFilterNumber(active.tokensMin)
      const tokensMax = parseFilterNumber(active.tokensMax)
      return list.filter(row => {
        if (row === null || typeof row !== 'object') return false
        if (active.hideSubagents === true && row.subagent === true) return false
        if (active.onlyToday === true && !activeToday(row)) return false
        const created = Number(row.createdAt) || 0
        if (range !== null && (created < range.from || created > range.to)) return false
        if (needle !== '' && !searchText(row).includes(needle)) return false
        if (costMin !== null || costMax !== null) {
          const raw = costOf(row)
          const value = raw === null || raw === undefined ? Number.NaN : Number(raw)
          if (!Number.isFinite(value)) return false
          if (costMin !== null && value < costMin) return false
          if (costMax !== null && value > costMax) return false
        }
        if (tokensMin !== null || tokensMax !== null) {
          const tokens = sessionTokens(row)
          if (tokensMin !== null && tokens < tokensMin) return false
          if (tokensMax !== null && tokens > tokensMax) return false
        }
        return true
      })
    }

    /** Clamp a 1-based page number into `1..pageCount`. */
    function clampPage(page, pageCount) {
      const count = Math.max(1, Math.floor(Number(pageCount) || 1))
      const value = Math.floor(Number(page) || 1)
      return Math.min(Math.max(1, value), count)
    }

    /** One page of `items` with all the numbers the pager and the counter show. */
    function paginate(items, page, size) {
      const list = Array.isArray(items) ? items : []
      const perPage = Math.max(1, Math.floor(Number(size) || 1))
      const pageCount = Math.max(1, Math.ceil(list.length / perPage))
      const current = clampPage(page, pageCount)
      const start = (current - 1) * perPage
      const slice = list.slice(start, start + perPage)
      return {
        items: slice,
        page: current,
        pageCount,
        total: list.length,
        from: slice.length === 0 ? 0 : start + 1,
        to: start + slice.length,
      }
    }

    /** The comparable value of one row for one column; `null` means "no price to compare". */
    function sortValue(row, key) {
      switch (key) {
        case 'session':
          return String(row.title ?? '').toLowerCase()
        case 'date':
          return Number(row.createdAt) || 0
        case 'input':
          return (Number(row.input) || 0) + (Number(row.cacheHit) || 0)
        case 'output':
          return Number(row.output) || 0
        case 'requests':
          return Number(row.requests) || 0
        case 'toolCalls':
          return Number(row.toolCalls) || 0
        case 'cost':
          return row.costUsd === null || row.costUsd === undefined ? null : Number(row.costUsd)
        default:
          return 0
      }
    }

    /**
     * Sort Session rows by one column, keeping the input order for equal values.
     * A row without a known price always sinks to the bottom, whichever direction is chosen.
     */
    function sortRows(rows, key, direction) {
      const factor = direction === 'asc' ? 1 : -1
      return rows
        .map((row, index) => ({ row, index }))
        .sort((left, right) => {
          const a = sortValue(left.row, key)
          const b = sortValue(right.row, key)
          if (a === null && b === null) return left.index - right.index
          if (a === null) return 1
          if (b === null) return -1
          const compared = typeof a === 'string' ? a.localeCompare(b, 'ru') : a - b
          return compared === 0 ? left.index - right.index : compared * factor
        })
        .map(entry => entry.row)
    }

    /** Whether a Session burned anything today, the meaning of the "today" toggle. */
    function activeToday(row) {
      return (Number(row.todayRequests) || 0) > 0
        || (Number(row.todayToolCalls) || 0) > 0
        || (Number(row.todayInput) || 0) > 0
        || (Number(row.todayCacheHit) || 0) > 0
        || (Number(row.todayOutput) || 0) > 0
    }

    /** One small labelled figure inside a card. */
    function Metric(props) {
      const title = typeof props.title === 'string' ? props.title : props.label
      return h('div', { className: 'dsh-exp-metric', ...(typeof title === 'string' ? { title } : {}) },
        h('span', { className: 'dsh-exp-metric-label' }, props.label),
        h('span', { className: 'dsh-exp-metric-value' }, props.value))
    }

    function TotalCard(props) {
      const totals = props.totals
      const cost = props.cost
      const inputTotal = (Number(totals.input) || 0) + (Number(totals.cacheHit) || 0)
      return h('section', { className: 'dsh-exp-card' },
        h('div', { className: 'dsh-exp-card-head' },
          h('span', { className: 'dsh-exp-card-title' }, props.title),
          cost === null || cost === undefined
            ? h('span', { className: 'dsh-exp-cost-empty' }, '—')
            : h('span', { className: 'dsh-exp-cost' }, formatMoney(cost, props.symbol))),
        h('div', { className: 'dsh-exp-metrics' },
          h(Metric, {
            label: props.t('input'),
            value: formatTokens(inputTotal),
            title: `${props.t('cacheTitle')}: ${formatTokens(totals.cacheHit)}`,
          }),
          h(Metric, { label: props.t('output'), value: formatTokens(totals.output) }),
          h(Metric, { label: props.t('requests'), value: formatTokens(totals.requests) }),
          h(Metric, { label: props.t('toolCalls'), value: formatTokens(totals.toolCalls) })))
    }

    function SessionRow(props) {
      const row = props.row
      const t = props.t
      const symbol = props.symbol
      const cost = props.cost
      const dash = h('span', { className: 'dsh-exp-dash' }, '—')
      const unavailable = row.error === true
      const numbers = (value) => (unavailable ? dash : formatTokens(value))
      const title = row.title || t('untitled')
      const models = rowModels(row)
      const modelText = models.length === 0 ? '' : `${t('model')}: ${models.join(', ')}`
      const inputTotal = (Number(row.input) || 0) + (Number(row.cacheHit) || 0)
      const rowTitle = unavailable
        ? t('unavailable')
        : [title, modelText].filter(part => part !== '').join(' · ')
      return h('tr', { title: rowTitle },
        h('td', null,
          h('div', { className: 'dsh-exp-session' },
            h('span', { className: 'dsh-exp-session-title' }, title),
            row.subagent === true ? h('span', { className: 'dsh-exp-badge' }, t('subagent')) : null,
            row.archived === true ? h('span', { className: 'dsh-exp-badge', title: t('archivedHint') }, t('archived')) : null)),
        h('td', { className: 'dsh-exp-date' }, row.createdAt ? dateFormat.format(new Date(row.createdAt)) : '—'),
        h('td', {
          className: 'dsh-exp-num',
          title: `${t('cacheTitle')}: ${formatTokens(row.cacheHit)}`,
        }, numbers(inputTotal)),
        h('td', { className: 'dsh-exp-num' }, numbers(row.output)),
        h('td', { className: 'dsh-exp-num' }, numbers(row.requests)),
        h('td', { className: 'dsh-exp-num' }, numbers(row.toolCalls)),
        h('td', { className: 'dsh-exp-num dsh-exp-cost-cell' }, unavailable || cost === null || cost === undefined ? dash : formatMoney(cost, symbol)))
    }

    /** ◀ ▶ pager with a "Стр. X из Y" label; both histories use this one row. */
    function Pager(props) {
      const t = props.t
      const pageCount = Math.max(1, Math.floor(Number(props.pageCount) || 1))
      const page = clampPage(props.page, pageCount)
      const total = Number(props.total) || 0
      if (total <= 0) return null
      const go = typeof props.onPage === 'function' ? props.onPage : () => {}
      const range = typeof props.range === 'string' && props.range !== '' ? ` · ${props.range}` : ''
      return h('div', { className: 'dsh-exp-pager' },
        h('span', { className: 'dsh-exp-pager-label' }, `${t('page')} ${page} ${t('of')} ${pageCount}${range}`),
        h('div', { className: 'dsh-exp-pager-buttons' },
          h('button', {
            type: 'button',
            className: 'dsh-exp-button dsh-exp-button-secondary dsh-exp-button-small',
            title: t('prevPage'),
            'aria-label': t('prevPage'),
            disabled: page <= 1,
            onClick: () => go(page - 1),
          }, '◀'),
          h('button', {
            type: 'button',
            className: 'dsh-exp-button dsh-exp-button-secondary dsh-exp-button-small',
            title: t('nextPage'),
            'aria-label': t('nextPage'),
            disabled: page >= pageCount,
            onClick: () => go(page + 1),
          }, '▶')))
    }

    /** The observed top-up history: five per page once there is more than one page. */
    function TopUps(props) {
      const t = props.t
      const entries = Array.isArray(props.entries) ? props.entries : []
      const [page, setPage] = React.useState(1)
      const paged = paginate(entries, page, TOPUP_PAGE_SIZE)
      const totals = new Map()
      for (const entry of entries) {
        const currency = String(entry?.currency ?? '')
        const amount = Number(entry?.amount)
        if (!Number.isFinite(amount) || currency === '') continue
        totals.set(currency, (totals.get(currency) ?? 0) + amount)
      }
      const totalText = [...totals.entries()].map(([currency, amount]) => formatCurrency(amount, currency)).join(' · ')
      return h('section', { className: 'dsh-exp-topups' },
        h('div', { className: 'dsh-exp-topups-head' },
          h('span', { className: 'dsh-exp-card-title' }, t('topUps')),
          entries.length === 0 ? null : h('span', { className: 'dsh-exp-count', title: `${t('records')}: ${formatTokens(entries.length)}` }, `${formatTokens(entries.length)} ${t('records')}`)),
        entries.length === 0
          ? h('p', { className: 'dsh-exp-card-note dsh-exp-topups-empty' }, t('topUpsEmpty'))
          : h('ul', { className: 'dsh-exp-topup-list' }, paged.items.map((entry, index) =>
              h('li', { key: `${entry.at}-${entry.currency}-${index}`, className: 'dsh-exp-topup' },
                h('span', { className: 'dsh-exp-topup-time' }, formatDateTime(entry.at)),
                h('span', { className: 'dsh-exp-topup-amount' }, `+ ${formatCurrency(entry.amount, entry.currency)}`)))),
        entries.length === 0
          ? null
          : h('div', { className: 'dsh-exp-card-footer' },
              totalText === '' ? null : h('span', { className: 'dsh-exp-card-note' }, `${t('topUpsTotal')}: ${totalText}`),
              paged.pageCount > 1
                ? h(Pager, { t, page: paged.page, pageCount: paged.pageCount, total: paged.total, onPage: setPage })
                : null),
        h('p', { className: 'dsh-exp-card-note dsh-exp-topups-hint' }, t('topUpsHint')))
    }

    function RateLine(props) {
      const t = props.t
      const rates = props.rates
      const data = rates.data
      const ready = rates.status === 'ready'
        && data !== null
        && typeof data === 'object'
        && Number.isFinite(Number(data.rubPerUsd))
        && Number.isFinite(Number(data.rubPerCny))
        && Number.isFinite(Number(data.cnyPerUsd))
      let text
      if (ready) {
        text = `1 $ = ${rateFormat.format(Number(data.rubPerUsd))} ₽`
          + ` · 1 ¥ = ${rateFormat.format(Number(data.rubPerCny))} ₽`
          + ` · 1 $ = ${rateFormat.format(Number(data.cnyPerUsd))} ¥`
      } else if (rates.status === 'loading') {
        text = t('rateLoading')
      } else {
        text = t('rateFailed')
      }
      const updated = ready && Number(data.fetchedAt) > 0
        ? (data.stale === true
            ? t('rateStale')
            : `${t('rateUpdatedPrefix')} ${timeFormat.format(new Date(Number(data.fetchedAt)))}`)
        : null
      return h('div', { className: 'dsh-exp-rate' },
        h('span', { className: 'dsh-exp-rate-label' }, t('rateLabel')),
        h('span', { className: 'dsh-exp-rate-values' }, text),
        updated === null ? null : h('span', { className: 'dsh-exp-rate-updated' }, updated))
    }

    function PricingBlock(props) {
      const t = props.t
      const pricing = props.pricing
      const models = pricing !== null && pricing !== undefined && Array.isArray(pricing.models) ? pricing.models : []
      const period = isPeakNow() ? 'peak' : 'offPeak'
      const value = (usd) => {
        const converted = toDisplayCurrency(usd, props.displayCode, props.rateData)
        return converted === null ? '—' : formatMoney(converted, props.displaySymbol)
      }
      let status
      if (pricing === null || pricing === undefined) {
        status = t('pricingLoading')
      } else if (pricing.status !== 'ready' || models.length === 0) {
        status = t('pricingFailed')
      } else {
        const read = Number(pricing.fetchedAt) > 0
          ? `${t('pricingReadPrefix')} ${timeFormat.format(new Date(Number(pricing.fetchedAt)))}`
          : ''
        const state = pricing.stale === true
          ? t('pricingStale')
          : pricing.changed === true ? t('pricingChanged') : t('pricingUnchanged')
        status = [read, state].filter(part => part !== '').join(' · ')
      }
      const periodLabel = t(period === 'peak' ? 'pricingPeriodPeak' : 'pricingPeriodOffPeak')
      return h('section', { className: 'dsh-exp-pricing' },
        h('div', { className: 'dsh-exp-pricing-head' },
          h('span', { className: 'dsh-exp-card-title' }, t('pricingTitle')),
          h('div', { className: 'dsh-exp-pricing-actions' },
            h('select', {
              className: 'dsh-exp-select',
              value: props.currency,
              'aria-label': t('currency'),
              onChange: (event) => props.onCurrency(event.target.value),
            }, CURRENCIES.map(item => h('option', { key: item, value: item }, item))),
            h('a', {
              className: 'dsh-exp-link',
              href: PRICING_SOURCE,
              target: '_blank',
              rel: 'noreferrer noopener',
            }, `${t('pricingSource')} ↗`))),
        h('div', { className: 'dsh-exp-pricing-status' }, `${status} · ${periodLabel}`),
        models.length === 0
          ? null
          : h('div', { className: 'dsh-exp-pricing-models' }, models.map(model => h('div', {
              key: model.id,
              className: 'dsh-exp-pricing-row',
            },
              h('span', { className: 'dsh-exp-pricing-model' }, model.id),
              h('span', { className: 'dsh-exp-pricing-price dsh-exp-price-hit' }, `${t('pricingCacheHit')} `, h('b', null, value(model.cacheHit ? model.cacheHit[period] : undefined))),
              h('span', { className: 'dsh-exp-pricing-price dsh-exp-price-miss' }, `${t('pricingCacheMiss')} `, h('b', null, value(model.cacheMiss ? model.cacheMiss[period] : undefined))),
              h('span', { className: 'dsh-exp-pricing-price dsh-exp-price-out' }, `${t('pricingOutput')} `, h('b', null, value(model.output ? model.output[period] : undefined)))))),
        h('p', { className: 'dsh-exp-card-note' }, t('pricingNote')),
        h(RateLine, { rates: props.rates, t }))
    }

    /** The balance card: wallets, the four overview metrics and the top-up action share one frame. */
    function BalanceCard(props) {
      const t = props.t
      const balance = props.balance
      const data = balance.data
      const ready = balance.status === 'ready' && data !== null && typeof data === 'object'
      const wallets = ready && Array.isArray(data.wallets) ? data.wallets : []
      const bonusWallets = ready && Array.isArray(data.bonusWallets) ? data.bonusWallets : []
      const bonusByCurrency = new Map()
      for (const wallet of bonusWallets) {
        if (wallet !== null && typeof wallet === 'object' && typeof wallet.currency === 'string') {
          bonusByCurrency.set(wallet.currency, Number(wallet.balance))
        }
      }
      const currencies = ['USD', 'CNY'].filter(currency => wallets.some(wallet => wallet.currency === currency)
        || bonusByCurrency.has(currency))
      let message = null
      if (!ready) {
        if (balance.status === 'loading') message = t('balanceLoading')
        else if (balance.status === 'signed-out') message = t('balanceSignedOut')
        else if (balance.status === 'unavailable') message = t('balanceUnavailable')
        else message = t('balanceFailed')
      } else if (currencies.length === 0) {
        message = t('balanceFailed')
      }
      const topUpUrl = ready && data.links !== null && typeof data.links === 'object'
        && typeof data.links.topUpUrl === 'string' && data.links.topUpUrl !== ''
        ? data.links.topUpUrl
        : ''
      return h('section', { className: 'dsh-exp-card dsh-exp-balance-card' },
        h('div', { className: 'dsh-exp-balance-head' },
          h('span', { className: 'dsh-exp-card-title' }, t('balance')),
          ready && balance.updatedAt > 0
            ? h('span', { className: 'dsh-exp-wallet-updated' },
                `${t('balanceUpdatedPrefix')} ${timeFormat.format(new Date(balance.updatedAt))}`)
            : null),
        message === null
          ? h('div', { className: 'dsh-exp-wallets' }, currencies.map(currency => {
              const wallet = wallets.find(item => item.currency === currency)
              const normal = wallet === undefined ? 0 : Number(wallet.balance)
              const bonus = bonusByCurrency.has(currency) ? bonusByCurrency.get(currency) : 0
              const rechargeable = Number.isFinite(normal) ? normal : 0
              const bonusValue = Number.isFinite(bonus) ? bonus : 0
              return h('div', { key: currency, className: 'dsh-exp-wallet', 'data-currency': currency },
                h('div', { className: 'dsh-exp-wallet-label' },
                  h('span', null, currency === 'USD' ? t('balanceUsd') : currency === 'CNY' ? t('balanceCny') : currency),
                  h('span', { className: 'dsh-exp-wallet-code' }, currency)),
                h('div', { className: 'dsh-exp-wallet-total' }, formatCurrency(rechargeable + bonusValue, currency)),
                h('div', { className: 'dsh-exp-wallet-lines' },
                  h('span', null, `${t('rechargeable')}: `, h('b', null, formatCurrency(rechargeable, currency))),
                  h('span', null, `${t('bonus')}: `, h('b', null, formatCurrency(bonusValue, currency)))))
            }))
          : h('p', { className: 'dsh-exp-wallet-state' }, message),
        h('div', { className: 'dsh-exp-metrics dsh-exp-balance-metrics' },
          h(Metric, {
            label: t('today'),
            value: props.todayCost === null || props.todayCost === undefined ? '—' : formatMoney(props.todayCost, props.symbol),
            title: t('today'),
          }),
          h(Metric, {
            label: t('week'),
            value: props.weekCost === null || props.weekCost === undefined ? '—' : formatMoney(props.weekCost, props.symbol),
            title: t('weekHint'),
          }),
          h(Metric, {
            label: t('averageSession'),
            value: props.averageCost === null || props.averageCost === undefined ? '—' : formatMoney(props.averageCost, props.symbol),
            title: t('averageHint'),
          }),
          h(Metric, { label: t('rateLabel'), value: props.rateText })),
        h('div', { className: 'dsh-exp-card-footer' },
          topUpUrl !== ''
            ? h('a', {
                className: 'dsh-exp-button dsh-exp-button-primary',
                href: topUpUrl,
                target: '_blank',
                rel: 'noreferrer noopener',
              }, `${t('topUpAction')} ↗`)
            : h('button', {
                type: 'button',
                className: 'dsh-exp-button dsh-exp-button-primary',
                disabled: true,
                title: t('topUpUnavailable'),
                'aria-label': t('topUpUnavailable'),
              }, t('topUpAction')),
          h('span', { className: 'dsh-exp-card-note' }, t('balanceFooterHint'))))
    }

    /** One row: the balance card and the top-up history, equal height, no separate window. */
    function BalanceSection(props) {
      return h('div', { className: 'dsh-exp-overview' },
        h(BalanceCard, {
          balance: props.balance,
          todayCost: props.todayCost,
          weekCost: props.weekCost,
          averageCost: props.averageCost,
          rateText: props.rateText,
          symbol: props.symbol,
          t: props.t,
        }),
        h(TopUps, { entries: props.topUps, t: props.t }))
    }

    /** In-panel update row: available version, progress and a restart hint. */
    function UpdateBanner(props) {
      const t = props.t
      const data = props.data
      const result = props.result
      const available = data !== null && data !== undefined && data.available === true
      const failed = result !== null && result !== undefined && result.ok !== true
      const installed = result !== null && result !== undefined && result.ok === true && result.restartRequired === true
      const current = result !== null && result !== undefined && result.ok === true && result.restartRequired !== true
      const note = typeof props.note === 'string' ? props.note : ''
      if (!available && !failed && !installed && !current && note === '') return null
      let title = ''
      let text = ''
      if (failed) {
        title = t('updateFailed')
        text = messageOf(result.error)
      } else if (installed) {
        title = t('updateInstalled')
        text = t('restartHint')
      } else if (current) {
        title = t('updateCurrent')
        text = ''
      } else if (available) {
        title = `${t('updateAvailable')} ${data.latestVersion}`
        text = `${t('version')} ${data.installedVersion} → ${data.latestVersion}`
        if (Number(data.behind) > 0) text += ` · ${t('behindPrefix')} ${formatTokens(data.behind)}`
        if (data.dirty === true) text += ` · ${t('updateDirty')}`
      } else {
        text = note
      }
      const notes = available && Array.isArray(data.notes) ? data.notes.slice(0, 3) : []
      return h('section', { className: `dsh-exp-update-banner${failed ? ' dsh-exp-update-banner-error' : ''}` },
        h('div', { className: 'dsh-exp-update-banner-main' },
          h('div', { className: 'dsh-exp-update-banner-title' }, title),
          h('div', { className: 'dsh-exp-update-banner-text' }, text),
          notes.length === 0
            ? null
            : h('ul', { className: 'dsh-exp-update-notes' }, notes.map((line, index) => h('li', { key: index }, line)))),
        h('div', { className: 'dsh-exp-update-banner-actions' },
          installed
            ? h('button', { type: 'button', className: 'dsh-exp-button dsh-exp-button-primary', onClick: props.onReload }, t('reloadPage'))
            : null,
          available && !installed && !current
            ? h('button', {
                type: 'button',
                className: 'dsh-exp-button dsh-exp-button-primary',
                disabled: props.busy === true,
                onClick: props.onInstall,
              }, props.busy === true ? t('installingUpdate') : t('installUpdate'))
            : null))
    }

    /** The startup offer: a fixed card in the app overlay, before the panel is opened. */
    function UpdateOverlay() {
      const t = translate
      const [state] = useUpdateState(120000)
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const [dismissed, setDismissed] = React.useState(() => readStored(UPDATE_DISMISS_KEY))
      const data = state.data
      const latest = data !== null && data !== undefined && typeof data.latestVersion === 'string' ? data.latestVersion : ''
      const available = data !== null && data !== undefined && data.available === true
      const installed = result !== null && result !== undefined && result.ok === true && result.restartRequired === true
      const current = result !== null && result !== undefined && result.ok === true && result.restartRequired !== true
      if (current) return null
      if (installed !== true && !available) return null
      if (installed !== true && latest !== '' && dismissed === latest) return null
      const dismiss = () => {
        if (latest !== '') {
          store(UPDATE_DISMISS_KEY, latest)
          setDismissed(latest)
        }
      }
      const install = async () => {
        setBusy(true)
        try {
          setResult(await postUpdate(UPDATE_APPLY_ROUTE, { confirm: true }))
        } catch (error) {
          setResult({ ok: false, error: messageOf(error) })
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'dsh-exp-update-toast', role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'dsh-exp-update-toast-head' },
          h('div', null,
            h('div', { className: 'dsh-exp-update-toast-title' }, installed ? t('updateInstalled') : t('updateAvailable')),
            h('div', { className: 'dsh-exp-update-toast-versions' }, `${data.installedVersion} → ${data.latestVersion}`)),
          h('button', {
            type: 'button',
            className: 'dsh-exp-update-close',
            title: t('updateClose'),
            'aria-label': t('updateClose'),
            onClick: dismiss,
          }, '×')),
        installed
          ? h('p', { className: 'dsh-exp-update-toast-text' }, t('restartHint'))
          : null,
        h('div', { className: 'dsh-exp-update-toast-actions' },
          installed
            ? h('button', { type: 'button', className: 'dsh-exp-button dsh-exp-button-primary', onClick: () => window.location.reload() }, t('reloadPage'))
            : h('button', { type: 'button', className: 'dsh-exp-button dsh-exp-button-primary', disabled: busy, onClick: install }, busy ? t('installingUpdate') : t('installUpdate')),
          installed
            ? null
            : h('button', { type: 'button', className: 'dsh-exp-button dsh-exp-button-secondary', onClick: dismiss }, t('later'))),
        result !== null && result !== undefined && result.ok !== true
          ? h('p', { className: 'dsh-exp-update-toast-text' }, messageOf(result.error))
          : null)
    }

    function ExpensesPage() {
      const t = translate
      const [snapshot, setSnapshot] = React.useState({ data: null, status: 'loading', error: null, updatedAt: 0 })
      const [balance, setBalance] = React.useState({ status: 'loading', data: null, error: null, updatedAt: 0 })
      const [rates, setRates] = React.useState({ status: 'loading', data: null, error: null, fetchedAt: 0 })
      const [topUps, setTopUps] = React.useState(() => [])
      const [currency, setCurrency] = React.useState(() => {
        const stored = readStored(CURRENCY_KEY)
        return CURRENCIES.includes(stored) ? stored : CURRENCIES[0]
      })
      const [busy, setBusy] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [page, setPage] = React.useState(1)
      const [sort, setSort] = React.useState(readTableSort)
      const [filters, setFilters] = React.useState(readTableFilters)
      const [update, refreshUpdate] = useUpdateState(60000)
      const [updateBusy, setUpdateBusy] = React.useState(false)
      const [updateResult, setUpdateResult] = React.useState(null)
      const [updateNote, setUpdateNote] = React.useState('')
      const mounted = React.useRef(true)

      React.useEffect(() => () => {
        mounted.current = false
      }, [])

      const load = React.useCallback(async (fresh) => {
        setBusy(true)
        try {
          const url = fresh ? `${OVERVIEW_ROUTE}?fresh=1` : OVERVIEW_ROUTE
          const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (data === null || typeof data !== 'object' || !Array.isArray(data.sessions)) {
            throw new Error(data !== null && typeof data === 'object' && typeof data.error === 'string' ? data.error : 'unexpected response')
          }
          if (!mounted.current) return
          setSnapshot({ data, status: 'ready', error: null, updatedAt: Date.now() })
        } catch (error) {
          if (!mounted.current) return
          setSnapshot(current => ({
            data: current.data,
            status: current.data === null ? 'error' : 'ready',
            error: messageOf(error),
            updatedAt: current.updatedAt,
          }))
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [])

      const loadBalance = React.useCallback(async (fresh) => {
        const result = await pollBalance(fresh)
        if (!mounted.current) return
        try {
          const list = await fetchTopUps()
          if (mounted.current) setTopUps(list)
        } catch {
          // История пополнений остаётся как была; следующий опрос повторит чтение.
        }
        setBalance({ status: result.status, data: result.data, error: result.error, updatedAt: result.updatedAt })
      }, [])

      const loadRates = React.useCallback(async (fresh) => {
        const result = await pollRates(fresh)
        if (!mounted.current) return
        setRates(result)
      }, [])

      React.useEffect(() => {
        load(true)
        void loadBalance(true)
        void loadRates(false)
        startBackgroundBalancePoller()
        const onVisible = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void loadBalance(false)
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        const timer = setInterval(() => {
          void loadBalance(false)
        }, BALANCE_REFRESH_MS)
        return () => {
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [load, loadBalance, loadRates])

      const data = snapshot.data
      const symbol = CURRENCIES.includes(currency) ? currency : CURRENCIES[0]
      const rateData = rates.status === 'ready' && rates.data !== null && typeof rates.data === 'object' ? rates.data : null
      const requestedCode = CURRENCY_CODES[symbol] ?? 'RUB'
      const displayCode = rateData !== null || requestedCode === 'USD' ? requestedCode : 'USD'
      const displaySymbol = CURRENCY_SYMBOLS[displayCode]
      const toDisplay = (usd) => toDisplayCurrency(usd, displayCode, rateData)
      const totals = data === null
        ? {
            today: { input: 0, cacheHit: 0, output: 0, requests: 0, toolCalls: 0, costUsd: null },
            all: { input: 0, cacheHit: 0, output: 0, requests: 0, toolCalls: 0, costUsd: null },
          }
        : data.totals
      const rows = data === null ? [] : data.sessions

      // The history filters and paging work on the rows the client has already loaded.
      const filteredRows = filterSessions(rows, filters, { query, costOf: (row) => toDisplay(row.costUsd) })
      const sortedRows = sortRows(filteredRows, sort.key, sort.direction)
      const sessionPage = paginate(sortedRows, page, SESSION_PAGE_SIZE)
      const pageRows = sessionPage.items

      let shownCostUsd = 0
      let shownCostKnown = filteredRows.length > 0
      for (const row of filteredRows) {
        if (row.costUsd === null || row.costUsd === undefined) {
          shownCostKnown = false
          break
        }
        shownCostUsd += Number(row.costUsd) || 0
      }
      const shownCost = shownCostKnown ? toDisplay(shownCostUsd) : null

      // Extra balance-card metrics: today's spend, the last seven days by Session date and the average.
      const weekStart = startOfLocalDay(Date.now()) - 6 * DAY_MS
      let weekCostUsd = 0
      let pricedSessions = 0
      for (const row of rows) {
        if (row.costUsd !== null && row.costUsd !== undefined) {
          pricedSessions += 1
          if ((Number(row.createdAt) || 0) >= weekStart) weekCostUsd += Number(row.costUsd) || 0
        }
      }
      const todayCost = toDisplay(totals.today.costUsd)
      const pricingKnown = totals.all.costUsd !== null && totals.all.costUsd !== undefined
      const weekCost = rows.length === 0 || !pricingKnown ? null : toDisplay(weekCostUsd)
      const averageCostUsd = pricedSessions > 0 && pricingKnown
        ? Number(totals.all.costUsd) / pricedSessions
        : null
      const averageCost = averageCostUsd === null ? null : toDisplay(averageCostUsd)
      const rateText = rateData !== null && Number.isFinite(Number(rateData.rubPerUsd))
        ? `1 $ = ${rateFormat.format(Number(rateData.rubPerUsd))} ₽`
        : t('rateFailed')

      /** Remember the new sort; the first click on a column picks its natural direction. */
      const toggleSort = (key) => {
        const direction = sort.key === key
          ? (sort.direction === 'asc' ? 'desc' : 'asc')
          : (key === 'session' ? 'asc' : 'desc')
        const next = { key, direction }
        setSort(next)
        writeJson(TABLE_SORT_KEY, next)
      }

      /** Flip one filter and persist the whole set; any change returns to the first page. */
      const setFilter = (key, value) => {
        const next = { ...filters, [key]: value }
        setFilters(next)
        writeJson(TABLE_FILTERS_KEY, next)
        setPage(1)
      }

      /** The search field shares the filter state: it also rewinds to the first page. */
      const setSearch = (value) => {
        setQuery(value)
        setPage(1)
      }

      /** Drop every filter and the query; the column sort stays as the user set it. */
      const resetFilters = () => {
        const next = { ...DEFAULT_FILTERS }
        setQuery('')
        setFilters(next)
        writeJson(TABLE_FILTERS_KEY, next)
        setPage(1)
      }

      const periodOptions = [
        ['all', t('periodAll')],
        ['today', t('periodToday')],
        ['7d', t('period7')],
        ['30d', t('period30')],
        ['custom', t('periodCustom')],
      ]

      /** One labelled range field; the numeric and date variants share the styling. */
      const filterField = (key, label, props) => h('label', { className: 'dsh-exp-field' },
        h('span', { className: 'dsh-exp-field-label' }, label),
        h('input', { className: 'dsh-exp-input', value: filters[key], 'aria-label': label, onChange: event => setFilter(key, event.target.value), ...props }))

      /** Ask the host for a fresh GitHub check and show the outcome next to the button. */
      const checkUpdates = async () => {
        setUpdateBusy(true)
        setUpdateNote('')
        setUpdateResult(null)
        try {
          const next = await postUpdate(UPDATE_CHECK_ROUTE, {})
          await refreshUpdate()
          if (next === null || typeof next !== 'object' || next.available !== true) setUpdateNote(t('updateCurrent'))
        } catch (error) {
          setUpdateNote(`${t('updateFailed')}: ${messageOf(error)}`)
        } finally {
          setUpdateBusy(false)
        }
      }

      /** Install the available update; the host pulls or runs pnpm. */
      const installUpdate = async () => {
        setUpdateBusy(true)
        setUpdateResult(null)
        setUpdateNote('')
        try {
          const answer = await postUpdate(UPDATE_APPLY_ROUTE, { confirm: true })
          setUpdateResult(answer)
          if (answer !== null && answer !== undefined && answer.ok === true && answer.restartRequired !== true) setUpdateNote(t('updateCurrent'))
          await refreshUpdate()
        } catch (error) {
          setUpdateResult({ ok: false, error: messageOf(error) })
        } finally {
          setUpdateBusy(false)
        }
      }

      /** One sortable column header, marked with its direction when it is the active column. */
      const column = (key, label, numeric) => h('th', {
        scope: 'col',
        ...(numeric === true ? { className: 'dsh-exp-num' } : {}),
        'aria-sort': sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none',
      },
        h('button', {
          type: 'button',
          className: 'dsh-exp-sort',
          title: `${t('sortBy')}: ${label}${sort.key === key ? ` · ${sort.direction === 'asc' ? t('ascending') : t('descending')}` : ''}`,
          onClick: () => toggleSort(key),
        }, label, sort.key === key
          ? h('span', { className: 'dsh-exp-sort-ind', 'aria-hidden': true }, sort.direction === 'asc' ? '▲' : '▼')
          : null))

      return h('section', { className: 'dsh-exp-page', 'aria-label': t('title') },
        h('style', null, CSS),
        h('div', { className: 'dsh-exp-scroll' },
          h('div', { className: 'dsh-exp-content' },
            h('div', { className: 'dsh-exp-heading' },
              h('div', { className: 'dsh-exp-heading-main' },
                h('span', { className: 'dsh-exp-logo', 'aria-hidden': true }, '💰'),
                h('div', { className: 'dsh-exp-heading-text' },
                  h('h1', null, t('title')),
                  h('p', { className: 'dsh-exp-sub' }, t('subtitle')))),
              h('div', { className: 'dsh-exp-actions' },
                h('span', {
                  className: snapshot.status === 'ready'
                    ? 'dsh-exp-chip is-ok'
                    : snapshot.status === 'error'
                      ? 'dsh-exp-chip is-bad'
                      : 'dsh-exp-chip is-warn',
                  role: 'status',
                }, snapshot.status === 'ready'
                  ? t('statusReady')
                  : snapshot.status === 'error'
                    ? t('statusError')
                    : t('statusLoading')),
                update.data !== null && update.data !== undefined && typeof update.data.installedVersion === 'string' && update.data.installedVersion !== ''
                  ? h('span', { className: 'dsh-exp-version' }, `${t('version')} ${update.data.installedVersion}`)
                  : null,
                snapshot.updatedAt > 0
                  ? h('span', { className: 'dsh-exp-updated' }, `${t('updatedPrefix')} ${timeFormat.format(new Date(snapshot.updatedAt))}`)
                  : null,
                h('button', {
                  type: 'button',
                  className: 'dsh-exp-button dsh-exp-button-secondary',
                  disabled: updateBusy,
                  onClick: checkUpdates,
                }, updateBusy ? t('checkingUpdates') : t('checkUpdates')),
                h('button', {
                  type: 'button',
                  className: 'dsh-exp-button dsh-exp-button-secondary',
                  disabled: busy,
                  onClick: () => {
                    void load(true)
                    void loadBalance(true)
                    void loadRates(true)
                  },
                }, busy ? t('refreshing') : t('refresh')))),
            h(UpdateBanner, {
              data: update.data,
              result: updateResult,
              busy: updateBusy,
              note: updateNote,
              t,
              onInstall: installUpdate,
              onReload: () => window.location.reload(),
            }),
            h(BalanceSection, {
              balance,
              topUps,
              todayCost,
              weekCost,
              averageCost,
              rateText,
              symbol: displaySymbol,
              t,
            }),
            h('div', { className: 'dsh-exp-cards' },
              h(TotalCard, { title: t('today'), totals: totals.today, cost: toDisplay(totals.today.costUsd), symbol: displaySymbol, t }),
              h(TotalCard, { title: t('allTime'), totals: totals.all, cost: toDisplay(totals.all.costUsd), symbol: displaySymbol, t })),
            h(PricingBlock, {
              pricing: data === null ? null : data.pricing,
              rates,
              rateData,
              displayCode,
              displaySymbol,
              currency: symbol,
              onCurrency: (next) => {
                const value = CURRENCIES.includes(next) ? next : CURRENCIES[0]
                setCurrency(value)
                store(CURRENCY_KEY, value)
              },
              t,
            }),
            h('div', { className: 'dsh-exp-table-wrap' },
              rows.length > 0
                ? h('div', { className: 'dsh-exp-toolbar' },
                    h('div', { className: 'dsh-exp-search' },
                      h('span', { className: 'dsh-exp-search-icon', 'aria-hidden': true },
                        h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', focusable: false },
                          h('circle', { cx: 7, cy: 7, r: 4.5, stroke: 'currentColor', strokeWidth: 1.4 }),
                          h('path', { d: 'M10.5 10.5 13.5 13.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))),
                      h('input', {
                        type: 'search',
                        value: query,
                        placeholder: t('search'),
                        'aria-label': t('search'),
                        onChange: event => setSearch(event.target.value),
                      }),
                      query === ''
                        ? null
                        : h('button', {
                            type: 'button',
                            className: 'dsh-exp-search-clear',
                            title: t('searchClear'),
                            'aria-label': t('searchClear'),
                            onClick: () => setSearch(''),
                          }, '×')),
                    h('label', { className: 'dsh-exp-toggle' },
                      h('input', {
                        type: 'checkbox',
                        checked: filters.onlyToday,
                        onChange: event => setFilter('onlyToday', event.target.checked),
                      }),
                      t('onlyToday')),
                    h('label', { className: 'dsh-exp-toggle' },
                      h('input', {
                        type: 'checkbox',
                        checked: filters.hideSubagents,
                        onChange: event => setFilter('hideSubagents', event.target.checked),
                      }),
                      t('hideSubagents')),
                    h('span', { className: 'dsh-exp-count' },
                      `${t('shown')} `,
                      h('b', null, formatTokens(filteredRows.length)),
                      ` ${t('of')} ${formatTokens(rows.length)}`,
                      shownCost === null ? null : ` · ${t('shownCost')}: ${formatMoney(shownCost, displaySymbol)}`))
                : null,
              rows.length > 0
                ? h('div', { className: 'dsh-exp-filters' },
                    h('label', { className: 'dsh-exp-field' },
                      h('span', { className: 'dsh-exp-field-label' }, t('period')),
                      h('select', {
                        className: 'dsh-exp-select',
                        value: filters.period,
                        'aria-label': t('period'),
                        onChange: event => setFilter('period', event.target.value),
                      }, periodOptions.map(([value, label]) => h('option', { key: value, value }, label)))),
                    filters.period === 'custom' ? filterField('dateFrom', t('dateFrom'), { type: 'date' }) : null,
                    filters.period === 'custom' ? filterField('dateTo', t('dateTo'), { type: 'date' }) : null,
                    filterField('costMin', t('costFrom'), { type: 'number', min: '0', step: 'any', inputMode: 'decimal', placeholder: '0' }),
                    filterField('costMax', t('costTo'), { type: 'number', min: '0', step: 'any', inputMode: 'decimal', placeholder: '0' }),
                    filterField('tokensMin', t('tokensFrom'), { type: 'number', min: '0', step: '1', inputMode: 'numeric', placeholder: '0' }),
                    filterField('tokensMax', t('tokensTo'), { type: 'number', min: '0', step: '1', inputMode: 'numeric', placeholder: '0' }),
                    h('button', {
                      type: 'button',
                      className: 'dsh-exp-button dsh-exp-button-secondary dsh-exp-button-small',
                      onClick: resetFilters,
                    }, t('resetFilters')))
                : null,
              snapshot.error !== null && snapshot.data !== null
                ? h('div', { className: 'dsh-exp-warning' }, `${t('loadFailed')} ${snapshot.error}`)
                : null,
              snapshot.status === 'loading'
                ? h('div', { className: 'dsh-exp-state' }, t('loading'))
                : null,
              snapshot.status === 'error'
                ? h('div', { className: 'dsh-exp-alert' },
                    h('span', null, `${t('loadFailed')} ${snapshot.error}`),
                    h('button', {
                      type: 'button',
                      className: 'dsh-exp-button dsh-exp-button-primary',
                      disabled: busy,
                      onClick: () => load(true),
                    }, t('retry')))
                : null,
              snapshot.status === 'ready' && rows.length === 0
                ? h('div', { className: 'dsh-exp-state' }, t('noSessions'))
                : null,
              rows.length > 0 && filteredRows.length === 0
                ? h('div', { className: 'dsh-exp-no-matches' },
                    h('div', null, t('noMatches')),
                    h('button', { type: 'button', className: 'dsh-exp-button dsh-exp-button-secondary', onClick: resetFilters }, t('resetFilters')))
                : null,
              filteredRows.length > 0
                ? h('div', { className: 'dsh-exp-table-scroll' },
                    h('table', { className: 'dsh-exp-table' },
                      h('colgroup', null,
                        h('col', { style: { width: '32%' } }),
                        h('col', { style: { width: '10%' } }),
                        h('col', { style: { width: '12%' } }),
                        h('col', { style: { width: '11%' } }),
                        h('col', { style: { width: '9%' } }),
                        h('col', { style: { width: '14%' } }),
                        h('col', { style: { width: '12%' } })),
                      h('thead', null,
                        h('tr', null,
                          column('session', t('session'), false),
                          column('date', t('date'), false),
                          column('input', t('input'), true),
                          column('output', t('output'), true),
                          column('requests', t('requests'), true),
                          column('toolCalls', t('toolCalls'), true),
                          column('cost', t('cost'), true))),
                      h('tbody', null, pageRows.map(row => h(SessionRow, {
                        key: row.id,
                        row,
                        cost: toDisplay(row.costUsd),
                        symbol: displaySymbol,
                        t,
                      })))))
                : null,
              filteredRows.length > 0
                ? h('div', { className: 'dsh-exp-table-footer' },
                    h(Pager, {
                      t,
                      page: sessionPage.page,
                      pageCount: sessionPage.pageCount,
                      total: sessionPage.total,
                      range: `${sessionPage.from}–${sessionPage.to} ${t('of')} ${sessionPage.total}`,
                      onPage: setPage,
                    }))
                : null))))
    }

    function ExpensesIcon(props) {
      const size = Number(props && props.size) || 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        focusable: false,
      },
      h('path', {
        d: 'M3.75 2.75h8.5v10.5l-1.42-.95-1.42.95-1.41-.95-1.42.95-1.41-.95-1.42.95z',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M6.25 5.75h3.5M6.25 8.25h3.5',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
      }))
    }

    /** Locale lookup with a literal fallback, so a missing dictionary never prints a key. */
    let bound
    function translate(key) {
      if (bound !== undefined) {
        try {
          const value = bound(key)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        } catch {
          // Fall through to the literal Russian dictionary.
        }
      }
      return DICT[key] ?? key
    }

    return {
      inject: ['slots', 'locale'],
      /** Pure helpers and components exposed for the render/pagination/filter tests. */
      __test: {
        DICT,
        CSS,
        SESSION_PAGE_SIZE,
        TOPUP_PAGE_SIZE,
        DEFAULT_FILTERS,
        paginate,
        clampPage,
        filterSessions,
        sortRows,
        sessionTokens,
        periodRange,
        parseFilterNumber,
        parseDateInput,
        startOfLocalDay,
        rowModels,
        searchText,
        formatCurrency,
        topUpId,
        normalizeTopUp,
        ratesSnapshot,
        pollRates,
        fetchTopUps,
        submitDetectedTopUps,
        migrateLegacyTopUps,
        components: {
          Metric,
          TotalCard,
          SessionRow,
          Pager,
          TopUps,
          BalanceCard,
          BalanceSection,
          PricingBlock,
          ExpensesPage,
        },
      },
      apply(ctx) {
        bound = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, 'ru', DICT), 'expenses: ru dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'en', DICT), 'expenses: en dictionary')
        ctx.effect(() => () => stopBackgroundBalancePoller(), 'expenses: balance poller')
        ctx.effect(() => {
          void migrateLegacyTopUps()
          return () => {}
        }, 'expenses: topups migration')
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, ExpensesPage))
        try {
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'expenses.update',
            order: 45,
          }, UpdateOverlay))
        } catch {
          // An older host without the shell overlay keeps the in-panel update row.
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 5,
          label: () => translate('panel'),
        }, ExpensesIcon))
      },
    }
  },
})
