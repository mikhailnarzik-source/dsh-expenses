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
    /** Build identity reported to the platform on balance requests. */
    const CLIENT_VERSION = '0.3.1'
    const CURRENCY_KEY = 'dsh-expenses:currency'
    const CURRENCIES = ['₽', '$', '¥']
    /** Currency symbol ↔ ISO code, the vocabulary the rate line and the price conversion use. */
    const CURRENCY_CODES = { '₽': 'RUB', '$': 'USD', '¥': 'CNY' }
    const CURRENCY_SYMBOLS = { RUB: '₽', USD: '$', CNY: '¥' }
    /** Official model prices page, linked from the pricing block. */
    const PRICING_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/'
    /** Last observed recharge wallets, used to notice top-ups between polls. */
    const WALLETS_KEY = 'dsh-expenses:balance-wallets'
    /** Top-ups observed by this panel, newest first. */
    const TOPUPS_KEY = 'dsh-expenses:topups'
    const TOPUPS_LIMIT = 20
    const TOPUPS_SHOWN = 5
    /** Live refresh cadence while the panel is open, and after it was first opened. */
    const BALANCE_REFRESH_MS = 20000
    const BALANCE_BACKGROUND_MS = 60000
    /** Table sort and filter preferences, remembered per browser like the currency. */
    const TABLE_SORT_KEY = 'dsh-expenses:table-sort'
    const TABLE_FILTERS_KEY = 'dsh-expenses:table-filters'

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
      loadFailed: 'Не удалось загрузить данные.',
      retry: 'Повторить',
      subagent: 'субагент',
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
      topUpsHint: 'Фиксируются по росту пополняемого баланса с момента установки плагина; если пополнение совпало с расходом, сумма может быть неточной.',
      topUpAction: 'Пополнить',
      total: 'Итого',
      rateLabel: 'Курс',
      rateLoading: 'Получаю курс…',
      rateFailed: 'Курс недоступен',
      rateUpdatedPrefix: 'курс обновлён в',
      rateStale: 'курс мог устареть',
      search: 'Поиск по названию сессии',
      searchClear: 'Сбросить поиск',
      onlyToday: 'Только сегодня',
      hideSubagents: 'Без субагентов',
      shown: 'Показано',
      of: 'из',
      shownCost: 'Стоимость выбранных',
      noMatches: 'По этому фильтру сессий нет.',
      resetFilters: 'Сбросить фильтры',
      sortBy: 'Сортировать',
      ascending: 'по возрастанию',
      descending: 'по убыванию',
    }

    const CSS = `
.dsh-exp-page{box-sizing:border-box;display:flex;width:100%;min-width:0;height:100%;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);background:radial-gradient(900px 260px at 12% -90px,color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent),transparent 72%),radial-gradient(760px 220px at 88% -110px,color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent),transparent 72%),var(--dsw-alias-bg-base);font-size:14px;line-height:1.6}
.dsh-exp-scroll{position:relative;flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}
.dsh-exp-content{max-width:1000px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 56px}
.dsh-exp-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;padding-top:28px;margin-bottom:22px}
.dsh-exp-heading-main{display:flex;align-items:center;gap:14px;min-width:0}
.dsh-exp-logo{display:flex;flex:none;align-items:center;justify-content:center;width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,var(--dsw-alias-brand-primary),color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,#8b5cf6));color:var(--dsw-alias-label-primary-inverted);box-shadow:0 4px 12px color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent)}
.dsh-exp-heading h1{margin:0;font-size:22px;font-weight:600;line-height:30px;letter-spacing:-.01em}
.dsh-exp-sub{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsh-exp-actions{display:flex;flex:none;align-items:center;gap:12px}
.dsh-exp-updated{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-exp-button{appearance:none;height:32px;padding:0 14px;border:.5px solid transparent;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);font:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer;box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.dsh-exp-button:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsh-exp-button:disabled{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);box-shadow:none;cursor:default}
.dsh-exp-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:16px}
.dsh-exp-card,.dsh-exp-pricing,.dsh-exp-topups{position:relative;box-sizing:border-box;min-width:0;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgba(15,23,42,.04)}
.dsh-exp-card::before,.dsh-exp-pricing::before,.dsh-exp-topups::before{content:'';position:absolute;inset:0 0 auto;height:2px;background:var(--exp-accent,transparent);opacity:.85}
.dsh-exp-card{padding:16px 18px}
.dsh-exp-cards .dsh-exp-card:nth-child(1){--exp-accent:var(--dsw-alias-brand-primary);background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 5%,var(--dsw-alias-bg-layer-1)) 0,var(--dsw-alias-bg-layer-1) 62%)}
.dsh-exp-cards .dsh-exp-card:nth-child(2){--exp-accent:var(--dsw-alias-state-business-primary);background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 5%,var(--dsw-alias-bg-layer-1)) 0,var(--dsw-alias-bg-layer-1) 62%)}
.dsh-exp-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.dsh-exp-card-title{color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px}
.dsh-exp-cost{font-size:22px;font-weight:600;line-height:30px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-exp-cost-empty{color:var(--dsw-alias-label-tertiary);font-size:22px;font-weight:500;line-height:30px}
.dsh-exp-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:14px}
.dsh-exp-metric{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-exp-metric-label{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;text-overflow:ellipsis}
.dsh-exp-metric-label::before{content:'';display:inline-block;width:6px;height:6px;margin-right:7px;border-radius:50%;vertical-align:1px;background:var(--dsw-alias-label-caption)}
.dsh-exp-metric:nth-child(1) .dsh-exp-metric-label::before{background:var(--dsw-alias-brand-primary)}
.dsh-exp-metric:nth-child(2) .dsh-exp-metric-label::before{background:var(--dsw-alias-state-success-primary)}
.dsh-exp-metric:nth-child(3) .dsh-exp-metric-label::before{background:var(--dsw-alias-state-warn-primary)}
.dsh-exp-metric:nth-child(4) .dsh-exp-metric-label::before{background:var(--dsw-alias-state-business-primary)}
.dsh-exp-metric-value{font-size:14px;font-weight:500;line-height:22px;font-variant-numeric:tabular-nums}
.dsh-exp-pricing{--exp-accent:var(--dsw-alias-state-warn-primary);display:flex;flex-direction:column;padding:16px 18px;margin-bottom:24px}
.dsh-exp-pricing-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
.dsh-exp-pricing-actions{display:flex;align-items:center;gap:10px}
.dsh-exp-pricing-status{margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-exp-pricing-models{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.dsh-exp-pricing-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 16px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-exp-pricing-model{padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;font-weight:600;line-height:18px}
.dsh-exp-pricing-price{white-space:nowrap}
.dsh-exp-pricing-price b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}
.dsh-exp-price-hit b{color:var(--dsw-alias-state-success-primary)}
.dsh-exp-price-miss b{color:var(--dsw-alias-state-warn-primary)}
.dsh-exp-price-out b{color:var(--dsw-alias-brand-primary)}
.dsh-exp-select{height:32px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.dsh-exp-select:hover{border-color:var(--dsw-alias-border-l3)}
.dsh-exp-select:focus-visible,.dsh-exp-button:focus-visible,.dsh-exp-link:focus-visible,.dsh-exp-sort:focus-visible,.dsh-exp-search-clear:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);outline-offset:1px}
.dsh-exp-rate{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px;width:100%;margin-top:12px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-exp-rate-label{color:var(--dsw-alias-label-tertiary)}
.dsh-exp-rate-values{font-variant-numeric:tabular-nums}
.dsh-exp-rate-updated{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-exp-table-wrap{overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgba(15,23,42,.04)}
.dsh-exp-table-scroll{overflow-x:auto}
.dsh-exp-table{width:100%;min-width:700px;border-collapse:collapse;table-layout:fixed;font-size:13px;font-variant-numeric:tabular-nums}
.dsh-exp-table th{padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;text-align:left;white-space:nowrap}
.dsh-exp-table th[aria-sort="ascending"],.dsh-exp-table th[aria-sort="descending"]{color:var(--dsw-alias-label-primary)}
.dsh-exp-table td{padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);vertical-align:middle}
.dsh-exp-table tbody tr:last-child td{border-bottom:none}
.dsh-exp-table tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 4%,transparent)}
.dsh-exp-num{text-align:right;white-space:nowrap}
.dsh-exp-session{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-exp-session-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dsh-exp-badge{flex:none;padding:0 7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,var(--dsw-alias-bg-layer-1));color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 75%,var(--dsw-alias-label-primary));font-size:11px;line-height:18px;white-space:nowrap}
.dsh-exp-date{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-exp-cost-cell{white-space:nowrap;font-weight:600;color:color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,var(--dsw-alias-label-primary))}
.dsh-exp-dash{color:var(--dsw-alias-label-tertiary)}
.dsh-exp-state{padding:32px 16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;text-align:center}
.dsh-exp-state-actions{display:flex;justify-content:center;margin-top:12px}
.dsh-exp-warning{padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}
.dsh-exp-stale{color:var(--dsw-alias-state-warn-primary)}
.dsh-exp-alert{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px;padding:32px 16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsh-exp-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.dsh-exp-balance{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:12px;margin-bottom:16px}
.dsh-exp-wallets{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;align-content:start}
.dsh-exp-wallets .dsh-exp-card[data-currency="USD"]{--exp-accent:var(--dsw-alias-state-success-primary);background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-success-primary) 5%,var(--dsw-alias-bg-layer-1)) 0,var(--dsw-alias-bg-layer-1) 62%)}
.dsh-exp-wallets .dsh-exp-card[data-currency="CNY"]{--exp-accent:var(--dsw-alias-state-warn-primary);background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-warn-primary) 5%,var(--dsw-alias-bg-layer-1)) 0,var(--dsw-alias-bg-layer-1) 62%)}
.dsh-exp-wallet-total{margin-top:10px;font-size:24px;font-weight:600;line-height:32px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-exp-wallet-code{padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:18px;letter-spacing:.06em;white-space:nowrap}
.dsh-exp-wallet-lines{display:flex;flex-wrap:wrap;gap:2px 14px;margin-top:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-exp-wallet-line b{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}
.dsh-exp-wallet-updated{grid-column:1/-1;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dsh-exp-wallet-state{margin:8px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsh-exp-topups{--exp-accent:var(--dsw-alias-state-success-primary);padding:16px 18px}
.dsh-exp-topups-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsh-exp-link{color:var(--dsw-alias-link);font-size:13px;line-height:20px;white-space:nowrap;text-decoration:none;border-radius:4px}
.dsh-exp-link:hover{text-decoration:underline}
.dsh-exp-topup-list{display:flex;flex-direction:column;margin:10px 0 0;padding:0;list-style:none}
.dsh-exp-topup{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:13px;line-height:20px}
.dsh-exp-topup:last-child{border-bottom:none;padding-bottom:0}
.dsh-exp-topup-time{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-exp-topup-amount{color:var(--dsw-alias-state-success-primary);font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-exp-note{margin:10px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-exp-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dsh-exp-search{position:relative;display:flex;flex:1 1 220px;align-items:center;min-width:150px;max-width:340px;color:var(--dsw-alias-label-tertiary)}
.dsh-exp-search-icon{position:absolute;left:10px;display:flex;pointer-events:none}
.dsh-exp-search input{box-sizing:border-box;width:100%;height:32px;padding:0 30px 0 32px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;transition:border-color .15s,box-shadow .15s;-webkit-appearance:none;appearance:none}
.dsh-exp-search input::-webkit-search-cancel-button{display:none}
.dsh-exp-search input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dsh-exp-search input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.dsh-exp-search-clear{position:absolute;right:3px;display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:16px;line-height:1;cursor:pointer}
.dsh-exp-search-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-exp-toggle{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer;user-select:none}
.dsh-exp-toggle:hover{color:var(--dsw-alias-label-primary)}
.dsh-exp-toggle input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsh-exp-count{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-exp-count b{color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-exp-sort{display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:none;color:inherit;font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.dsh-exp-sort:hover{color:var(--dsw-alias-label-primary)}
.dsh-exp-sort-ind{color:var(--dsw-alias-brand-primary);font-size:10px;line-height:1}
.dsh-exp-table th.dsh-exp-num .dsh-exp-sort{justify-content:flex-end;width:100%}
.dsh-exp-no-matches{padding:24px 16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;text-align:center}
.dsh-exp-no-matches .dsh-exp-button{margin-top:10px}
@media (max-width:900px){.dsh-exp-balance{grid-template-columns:minmax(0,1fr)}.dsh-exp-table th,.dsh-exp-table td{padding-right:8px;padding-left:8px}}
@media (max-width:760px){.dsh-exp-cards{grid-template-columns:1fr}.dsh-exp-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
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

    /** The top-up log, newest first. */
    function readTopUps() {
      const parsed = readJson(TOPUPS_KEY)
      if (!Array.isArray(parsed)) return []
      return parsed
        .filter(entry => entry !== null
          && typeof entry === 'object'
          && Number.isFinite(Number(entry.at))
          && typeof entry.currency === 'string'
          && Number.isFinite(Number(entry.amount))
          && Number(entry.amount) > 0)
        .map(entry => ({ at: Number(entry.at), currency: entry.currency, amount: Number(entry.amount) }))
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
      if (detected.length > 0) writeJson(TOPUPS_KEY, [...detected, ...readTopUps()].slice(0, TOPUPS_LIMIT))
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

    /** The remembered table toggles; both start off so the first view shows every Session. */
    function readTableFilters() {
      const parsed = readJson(TABLE_FILTERS_KEY)
      if (parsed === null || typeof parsed !== 'object') return { onlyToday: false, hideSubagents: false }
      return { onlyToday: parsed.onlyToday === true, hideSubagents: parsed.hideSubagents === true }
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
      const inputTotal = (Number(row.input) || 0) + (Number(row.cacheHit) || 0)
      return h('tr', { title: unavailable ? t('unavailable') : title },
        h('td', null,
          h('div', { className: 'dsh-exp-session' },
            h('span', { className: 'dsh-exp-session-title' }, title),
            row.subagent === true ? h('span', { className: 'dsh-exp-badge' }, t('subagent')) : null)),
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

    function WalletCard(props) {
      const t = props.t
      return h('section', { className: 'dsh-exp-card', 'data-currency': props.currency },
        h('div', { className: 'dsh-exp-card-head' },
          h('span', { className: 'dsh-exp-card-title' }, props.title),
          h('span', { className: 'dsh-exp-wallet-code' }, props.currency)),
        h('div', { className: 'dsh-exp-wallet-total' }, formatCurrency(props.total, props.currency)),
        h('div', { className: 'dsh-exp-wallet-lines' },
          h('span', { className: 'dsh-exp-wallet-line' },
            `${t('rechargeable')}: `,
            h('b', null, formatCurrency(props.rechargeable, props.currency))),
          h('span', { className: 'dsh-exp-wallet-line' },
            `${t('bonus')}: `,
            h('b', null, formatCurrency(props.bonus, props.currency)))))
    }

    function TopUps(props) {
      const t = props.t
      const entries = props.entries.slice(0, TOPUPS_SHOWN)
      return h('section', { className: 'dsh-exp-topups' },
        h('div', { className: 'dsh-exp-topups-head' },
          h('span', { className: 'dsh-exp-card-title' }, t('topUps')),
          typeof props.topUpUrl === 'string' && props.topUpUrl !== ''
            ? h('a', {
                className: 'dsh-exp-link',
                href: props.topUpUrl,
                target: '_blank',
                rel: 'noreferrer noopener',
              }, `${t('topUpAction')} ↗`)
            : null),
        entries.length === 0
          ? h('p', { className: 'dsh-exp-note' }, t('topUpsEmpty'))
          : h('ul', { className: 'dsh-exp-topup-list' }, entries.map((entry, index) => h('li', {
              key: `${entry.at}-${entry.currency}-${index}`,
              className: 'dsh-exp-topup',
            },
              h('span', { className: 'dsh-exp-topup-time' }, formatDateTime(entry.at)),
              h('span', { className: 'dsh-exp-topup-amount' }, `+ ${formatCurrency(entry.amount, entry.currency)}`)))),
        h('p', { className: 'dsh-exp-note' }, t('topUpsHint')))
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
        h('p', { className: 'dsh-exp-note' }, t('pricingNote')),
        h(RateLine, { rates: props.rates, t }))
    }

    function BalanceSection(props) {
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
      const cards = []
      for (const currency of currencies) {
        const wallet = wallets.find(item => item.currency === currency)
        const normal = wallet === undefined ? 0 : Number(wallet.balance)
        const bonus = bonusByCurrency.has(currency) ? bonusByCurrency.get(currency) : 0
        cards.push(h(WalletCard, {
          key: currency,
          currency,
          title: currency === 'USD' ? t('balanceUsd') : currency === 'CNY' ? t('balanceCny') : currency,
          rechargeable: Number.isFinite(normal) ? normal : 0,
          bonus: Number.isFinite(bonus) ? bonus : 0,
          total: (Number.isFinite(normal) ? normal : 0) + (Number.isFinite(bonus) ? bonus : 0),
          t,
        }))
      }
      if (ready && balance.updatedAt > 0) {
        cards.push(h('div', { key: 'updated', className: 'dsh-exp-wallet-updated' },
          `${t('balanceUpdatedPrefix')} ${timeFormat.format(new Date(balance.updatedAt))}`))
      }
      return h('div', { className: 'dsh-exp-balance' },
        h('div', { className: 'dsh-exp-wallets' },
          message === null
            ? cards
            : h('section', { className: 'dsh-exp-card' },
                h('div', { className: 'dsh-exp-card-head' },
                  h('span', { className: 'dsh-exp-card-title' }, t('balance'))),
                h('p', { className: 'dsh-exp-wallet-state' }, message))),
        h(TopUps, {
          entries: props.topUps,
          t,
          topUpUrl: ready && data.links !== null && typeof data.links === 'object' ? data.links.topUpUrl : undefined,
        }))
    }

    function ExpensesPage() {
      const t = translate
      const [snapshot, setSnapshot] = React.useState({ data: null, status: 'loading', error: null, updatedAt: 0 })
      const [balance, setBalance] = React.useState({ status: 'loading', data: null, error: null, updatedAt: 0 })
      const [rates, setRates] = React.useState({ status: 'loading', data: null, error: null, fetchedAt: 0 })
      const [topUps, setTopUps] = React.useState(readTopUps)
      const [currency, setCurrency] = React.useState(() => {
        const stored = readStored(CURRENCY_KEY)
        return CURRENCIES.includes(stored) ? stored : CURRENCIES[0]
      })
      const [busy, setBusy] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [sort, setSort] = React.useState(readTableSort)
      const [filters, setFilters] = React.useState(readTableFilters)
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
        setTopUps(readTopUps())
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
      const needle = query.trim().toLowerCase()
      const visibleRows = sortRows(
        rows.filter(row => {
          if (filters.hideSubagents === true && row.subagent === true) return false
          if (filters.onlyToday === true && !activeToday(row)) return false
          return needle === '' || String(row.title ?? '').toLowerCase().includes(needle)
        }),
        sort.key,
        sort.direction,
      )
      let shownCostUsd = 0
      let shownCostKnown = visibleRows.length > 0
      for (const row of visibleRows) {
        if (row.costUsd === null || row.costUsd === undefined) {
          shownCostKnown = false
          break
        }
        shownCostUsd += Number(row.costUsd) || 0
      }
      const shownCost = shownCostKnown ? toDisplay(shownCostUsd) : null

      /** Remember the new sort; the first click on a column picks its natural direction. */
      const toggleSort = (key) => {
        const direction = sort.key === key
          ? (sort.direction === 'asc' ? 'desc' : 'asc')
          : (key === 'session' ? 'asc' : 'desc')
        const next = { key, direction }
        setSort(next)
        writeJson(TABLE_SORT_KEY, next)
      }

      /** Flip one table toggle and persist both, so the view survives a reload. */
      const setFilter = (key, value) => {
        const next = { ...filters, [key]: value }
        setFilters(next)
        writeJson(TABLE_FILTERS_KEY, next)
      }

      /** Drop the query and both toggles; the column sort stays as the user set it. */
      const resetFilters = () => {
        const next = { onlyToday: false, hideSubagents: false }
        setQuery('')
        setFilters(next)
        writeJson(TABLE_FILTERS_KEY, next)
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
                h('span', { className: 'dsh-exp-logo' }, h(ExpensesIcon, { size: 20 })),
                h('div', null,
                  h('h1', null, t('title')),
                  h('p', { className: 'dsh-exp-sub' }, t('subtitle')))),
              h('div', { className: 'dsh-exp-actions' },
                snapshot.updatedAt > 0
                  ? h('span', { className: 'dsh-exp-updated' }, `${t('updatedPrefix')} ${timeFormat.format(new Date(snapshot.updatedAt))}`)
                  : null,
                h('button', {
                  type: 'button',
                  className: 'dsh-exp-button',
                  disabled: busy,
                  onClick: () => {
                    void load(true)
                    void loadBalance(true)
                    void loadRates(true)
                  },
                }, busy ? t('refreshing') : t('refresh')))),
            h(BalanceSection, { balance, topUps, t }),
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
                        onChange: event => setQuery(event.target.value),
                      }),
                      query === ''
                        ? null
                        : h('button', {
                            type: 'button',
                            className: 'dsh-exp-search-clear',
                            title: t('searchClear'),
                            'aria-label': t('searchClear'),
                            onClick: () => setQuery(''),
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
                      h('b', null, formatTokens(visibleRows.length)),
                      ` ${t('of')} ${formatTokens(rows.length)}`,
                      shownCost === null ? null : ` · ${t('shownCost')}: ${formatMoney(shownCost, displaySymbol)}`))
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
                    h('button', { type: 'button', className: 'dsh-exp-button', disabled: busy, onClick: () => load(true) }, t('retry')))
                : null,
              snapshot.status === 'ready' && rows.length === 0
                ? h('div', { className: 'dsh-exp-state' }, t('noSessions'))
                : null,
              rows.length > 0 && visibleRows.length === 0
                ? h('div', { className: 'dsh-exp-no-matches' },
                    h('div', null, t('noMatches')),
                    h('button', { type: 'button', className: 'dsh-exp-button', onClick: resetFilters }, t('resetFilters')))
                : null,
              visibleRows.length > 0
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
                      h('tbody', null, visibleRows.map(row => h(SessionRow, {
                        key: row.id,
                        row,
                        cost: toDisplay(row.costUsd),
                        symbol: displaySymbol,
                        t,
                      })))))
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
      apply(ctx) {
        bound = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, 'ru', DICT), 'expenses: ru dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'en', DICT), 'expenses: en dictionary')
        ctx.effect(() => () => stopBackgroundBalancePoller(), 'expenses: balance poller')
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, ExpensesPage))
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
