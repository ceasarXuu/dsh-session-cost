// Session API Cost — browser half.
//
// Replaces the shipped `usage` cell of `conversation.composer.dock` with the
// same official reading plus one inserted segment:
//   `122K tok · ¥0.003 · 缓存命中 98%`
// Token total, cache-hit percent, exact counts and the click-open dialog are
// faithful ports of `@deepseek-ai/dsh-client-ui-chat`
// (`src/client/chat/StatsPills.tsx`, `token-format.ts`, `stat-dialog.ts`), so
// every official figure is byte-identical to the shipped pill. Only the money
// segment is plugin data: it arrives already folded and priced from the Host
// half's `sessionCost` projection (`useProjection('sessionCost')`).
//
// Harness client packages are intentionally not required (plugin practices:
// copy markup/CSS/behavior instead); only `react`/`react-dom` from the
// platform module table are used.
window.__ModuleLoader__.load({
  id: '@ceasarxuu/dsh-session-cost',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } = React

    /** Own locale namespace: reusing a shipped namespace (chat/common) throws. */
    const NS = 'sessionCost'

    /**
     * Host projection values only move when a Session event drives the unit, so
     * a globally changed price-check status (or a re-registered unit after an
     * auto price revision) can trail on idle Sessions. The Session service's
     * explicit baseline refresh reconciles a Session without waiting for its
     * next event; the pill and the notice re-read periodically to pick that up.
     */
    const PROJECTION_REFRESH_MS = 300_000
    let clientSessionsService = null

    async function refreshSessionProjections(sessionId) {
      try {
        const service = clientSessionsService
        if (service === null || sessionId === undefined || sessionId === null) return
        if (typeof service.refreshProjections !== 'function') return
        await service.refreshProjections(sessionId)
      } catch (_refreshFailed) {
        /* the next tick retries */
      }
    }

    /* ------------------------------------------------------------------ */
    /* 1. Official formatters (exact ports of ui-chat token-format.ts)     */
    /* ------------------------------------------------------------------ */

    function formatTokens(value, t) {
      const scaled = candidate => candidate >= 100
        ? String(Math.round(candidate))
        : String(Math.round(candidate * 10) / 10)
      if (value < 1000) return String(value)
      if (value < 1000000) return t('number.thousand', { value: scaled(value / 1000) })
      return t('number.million', { value: scaled(value / 1000000) })
    }

    function formatExactTokens(value, t) {
      const digits = String(value)
      const groups = []
      for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end))
      return groups.join(t('number.groupSeparator'))
    }

    function roundedPercentUnits(cacheReadTokens, denominator, decimalPlaces) {
      const unitsPerPercent = decimalPlaces === 0 ? 1 : 10
      const scale = unitsPerPercent * 100
      const doubledScale = scale * 2
      const denominatorQuotient = Math.floor(denominator / doubledScale)
      const denominatorRemainder = denominator % doubledScale
      let lower = 0
      let upper = scale
      while (lower < upper) {
        const candidate = Math.floor((lower + upper + 1) / 2)
        const factor = candidate * 2 - 1
        const threshold = factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / doubledScale)
        if (cacheReadTokens >= threshold) lower = candidate
        else upper = candidate - 1
      }
      return lower
    }

    function displayPercentUnits(units, decimalPlaces) {
      if (decimalPlaces === 0) return String(units)
      const whole = Math.floor(units / 10)
      const tenths = units % 10
      return tenths === 0 ? String(whole) : `${whole}.${tenths}`
    }

    /** Official cache-hit display: a partial hit never rounds up to 100. */
    function formatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces = 0) {
      if (promptTokens === 0) return null
      const missedInputTokens = promptTokens - cacheReadTokens
      if (missedInputTokens === 0) return '100'
      const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces)
      const fullHitUnits = decimalPlaces === 0 ? 100 : 1000
      if (roundedUnits < fullHitUnits) return displayPercentUnits(roundedUnits, decimalPlaces)
      let distinguishingPlaces = 1
      let scaledDoubleGap = missedInputTokens * 200
      const denominatorTens = Math.floor(promptTokens / 10)
      while (scaledDoubleGap <= denominatorTens) {
        scaledDoubleGap *= 10
        distinguishingPlaces += 1
      }
      const denominatorOnes = promptTokens % 10
      let roundedLoss = 5
      for (let loss = 1; loss < 5; loss += 1) {
        const factor = loss * 2 + 1
        const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
        if (scaledDoubleGap <= threshold) {
          roundedLoss = loss
          break
        }
      }
      return `99.${'9'.repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`
    }

    const billedInputTokens = usage =>
      usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens

    const cacheHitPercent = usage =>
      formatCacheHitPercent(usage.cacheReadTokens, billedInputTokens(usage))

    /* ------------------------------------------------------------------ */
    /* 2. Cost formatting — the projection carries exact integer nano-units */
    /*    (`costNano`: 1 CNY = 1e9), so no float drift reaches the display. */
    /* ------------------------------------------------------------------ */

    function currencySymbol(currency) {
      if (currency === 'CNY') return '¥'
      if (currency === 'USD') return '$'
      return typeof currency === 'string' && currency.length > 0 ? `${currency} ` : '¥'
    }

    function trimmedFixed(value, digits) {
      return value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')
    }

    /** Compact money reading for the pill: ¥0.003, ¥1.23, <¥0.001. */
    function formatCost(costNano, currency) {
      const symbol = currencySymbol(currency)
      if (!(costNano > 0)) return `${symbol}0`
      const value = costNano / 1e9
      if (value < 0.001) return `<${symbol}0.001`
      if (value < 1) return `${symbol}${value.toFixed(3)}`
      return `${symbol}${value.toFixed(2)}`
    }

    /** Exact money reading for the dialog: every nano-unit that exists. */
    function formatExactCost(costNano, currency) {
      const symbol = currencySymbol(currency)
      const value = costNano / 1e9
      if (value === 0) return `${symbol}0`
      if (value < 0.000001) return `<${symbol}0.000001`
      return `${symbol}${trimmedFixed(value, 6)}`
    }

    /* ------------------------------------------------------------------ */
    /* 2b. Price-table provenance — the host auto-checks the official page  */
    /*     at most once per interval and records the outcome.              */
    /* ------------------------------------------------------------------ */

    /** Wire `checkStatus` values from the host view (0 never, 1 ok, 2 failed). */
    const CHECK_FAILED = 2

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /** Local `YYYY-MM-DD HH:mm`; the host timestamps are epoch milliseconds. */
    function formatDateTime(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
      const date = new Date(timestamp)
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
        + ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    function checkFailedOf(cost) {
      return cost !== undefined && cost !== null && cost.checkStatus === CHECK_FAILED
    }

    /* ------------------------------------------------------------------ */
    /* 3. Dialog placement/dismissal — ports of ui-chat stat-dialog.ts and  */
    /*    ui-primitives useAnchoredPosition (plugins may not require them). */
    /* ------------------------------------------------------------------ */

    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }
    const PANEL_MARGIN = 12
    const PANEL_GAP = 8

    function overlayTopMargin(min) {
      const root = document.documentElement
      const clearance = Number.parseFloat(getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance'))
      if (Number.isNaN(clearance)) return min
      return Math.max(min, (root.hasAttribute('data-fullscreen') ? 0 : clearance) + 20)
    }

    function useAnchoredPosition({ open, anchorRef, panelRef, side = 'bottom', align = 'start', gap, margin }) {
      const [position, setPosition] = useState(null)
      useLayoutEffect(() => {
        if (!open) {
          setPosition(null)
          return
        }
        const place = () => {
          const rect = anchorRef.current?.getBoundingClientRect()
          if (rect === undefined) return
          const panel = panelRef.current
          const width = panel?.offsetWidth ?? 0
          const height = panel?.offsetHeight ?? 0
          let left = align === 'end' ? rect.right - width : rect.left
          let top = side === 'top' ? rect.top - gap - height : rect.bottom + gap
          if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin)
          if (height > 0) top = Math.min(Math.max(top, overlayTopMargin(margin)), window.innerHeight - height - margin)
          setPosition({ left, top })
        }
        place()
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        const panel = panelRef.current
        let observer = null
        if (typeof ResizeObserver !== 'undefined' && panel !== null) {
          observer = new ResizeObserver(place)
          observer.observe(panel)
        }
        return () => {
          observer?.disconnect()
          window.removeEventListener('scroll', place, true)
          window.removeEventListener('resize', place)
        }
      }, [open, anchorRef, panelRef, side, align, gap, margin])
      return position
    }

    function useDismissOnOutsidePointer(rootRef, open, setOpen, portalRef) {
      useEffect(() => {
        if (!open) return
        const closeOutside = (event) => {
          if (event.target instanceof Node
            && rootRef.current?.contains(event.target) !== true
            && portalRef?.current?.contains(event.target) !== true) {
            setOpen(false)
          }
        }
        document.addEventListener('pointerdown', closeOutside)
        return () => { document.removeEventListener('pointerdown', closeOutside) }
      }, [rootRef, open, setOpen, portalRef])
    }

    function useStatDialog() {
      const [open, setOpen] = useState(false)
      const rootRef = useRef(null)
      const panelRef = useRef(null)
      const pos = useAnchoredPosition({
        open,
        anchorRef: rootRef,
        panelRef,
        side: 'top',
        gap: PANEL_GAP,
        margin: PANEL_MARGIN,
      })
      useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
      useEffect(() => {
        if (!open) return
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false) }
        const onClick = (event) => {
          if (event.target instanceof Node
            && rootRef.current?.contains(event.target) !== true
            && panelRef.current?.contains(event.target) !== true) {
            setOpen(false)
          }
        }
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('click', onClick, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('click', onClick, true)
        }
      }, [open, setOpen])
      return { open, setOpen, rootRef, panelRef, pos }
    }

    /* ------------------------------------------------------------------ */
    /* 4. Icon — IconDatabaseOutlineRegular (ui-primitives), 16px artwork  */
    /*    scaled to 14px by the CSS, regular stroke-width 1.               */
    /* ------------------------------------------------------------------ */

    function DatabaseIcon() {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': true,
        strokeWidth: 1,
      },
      h('path', {
        d: 'M13.1967 5.1869C13.7232 4.77378 14.0003 4.30517 14.0001 3.82819C14.0003 3.3512 13.7232 2.88259 13.1967 2.46947C12.6702 2.05635 11.9128 1.71328 11.0006 1.47475C10.0885 1.23621 9.05371 1.11062 8.00039 1.1106C6.94707 1.11057 5.9123 1.23612 5.00009 1.47461C4.08742 1.71301 3.32948 2.05604 2.80249 2.46919C2.2755 2.88235 1.99805 3.35106 1.99805 3.82819C1.99805 4.30531 2.2755 4.77402 2.80249 5.18718C3.32948 5.60033 4.08742 5.94336 5.00009 6.18176C5.9123 6.42025 6.94707 6.5458 8.00039 6.54578C9.05371 6.54575 10.0885 6.42016 11.0006 6.18163C11.9128 5.94309 12.6702 5.60002 13.1967 5.1869Z',
        stroke: 'currentColor',
      }),
      h('path', { d: 'M2 3.80371V11.7848', stroke: 'currentColor' }),
      h('path', { d: 'M14 3.80371V11.7848', stroke: 'currentColor' }),
      h('path', {
        d: 'M2 7.81396C2 8.60524 2.63214 9.36411 3.75736 9.92363C4.88258 10.4832 6.4087 10.7975 8 10.7975C9.5913 10.7975 11.1174 10.4832 12.2426 9.92363C13.3679 9.36411 14 8.60524 14 7.81396',
        stroke: 'currentColor',
      }),
      h('path', {
        d: 'M2 11.7847C2 12.6081 2.63214 13.3977 3.75736 13.98C4.88258 14.5622 6.4087 14.8893 8 14.8893C9.5913 14.8893 11.1174 14.5622 12.2426 13.98C13.3679 13.3977 14 12.6081 14 11.7847',
        stroke: 'currentColor',
      }))
    }

    /* ------------------------------------------------------------------ */
    /* 5. Markup — the shipped `joined`/`PlainPill`/`DialogPill` shapes.    */
    /* ------------------------------------------------------------------ */

    function Separator() {
      return h('span', { className: 'scp-sep', 'aria-hidden': true }, '·')
    }

    function joined(first, second, third) {
      const parts = [first, second, third].filter(part => part !== null && part !== undefined)
      if (parts.length === 0) return null
      const nodes = []
      parts.forEach((part, index) => {
        if (index > 0) nodes.push(h(Separator, { key: `sep-${index}` }))
        nodes.push(h('span', { key: `part-${index}` }, part))
      })
      return nodes
    }

    function PlainPill({ stat, icon, label, ariaLabel }) {
      return h('span', { className: 'scp-anchor', 'data-composer-stat': stat, 'aria-label': ariaLabel },
        h('span', { className: 'scp-pill' }, icon, h('span', { className: 'scp-label' }, label)))
    }

    function DialogPill({ stat, icon, label, ariaLabel, title, titleValue, children }) {
      const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()
      return h('span', { ref: rootRef, className: 'scp-anchor', 'data-composer-stat': stat },
        h('button', {
          type: 'button',
          className: 'scp-pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': ariaLabel,
          onClick: () => { setOpen(!open) },
        },
        icon,
        h('span', { className: 'scp-label' }, label)),
        open && ReactDOM.createPortal(
          h('div', {
            ref: panelRef,
            className: 'scp-panel',
            role: 'dialog',
            'aria-label': title,
            style: pos ?? MEASURE_STYLE,
          },
          h('div', { className: 'scp-title' },
            h('span', { className: 'scp-titleLabel' }, icon, title),
            titleValue !== undefined && h('span', { className: 'scp-titleValue' }, titleValue)),
          h('div', { className: 'scp-titleRule', 'aria-hidden': true }),
          children),
          document.body),
      )
    }

    function exactCount(value, t) {
      return t('message.turnUsage.count', { count: formatExactTokens(value, t) })
    }

    /* ------------------------------------------------------------------ */
    /* 6. The replacement pill.                                            */
    /* ------------------------------------------------------------------ */

    /**
     * Props: the session standard kit plus `t` from the declared locale seat.
     * Official `tokenUsage` gives tokens/cache-hit; the plugin's own
     * `sessionCost` projection gives the money segment.
     */
    function UsageCostPill({ useProjection, sessionId, t }) {
      const usage = useProjection('tokenUsage')
      const cost = useProjection('sessionCost')
      const mode = usePerformanceUsageMode()
      // Reconcile this Session's projection values once on mount and then
      // slowly, so a status change made without a Session event catches up.
      useEffect(() => {
        let cancelled = false
        const refresh = () => { if (!cancelled) void refreshSessionProjections(sessionId) }
        refresh()
        const timer = setInterval(refresh, PROJECTION_REFRESH_MS)
        return () => { cancelled = true; clearInterval(timer) }
      }, [sessionId])
      // Same gating as the shipped pill: nothing until a settlement reports tokens.
      if (usage === undefined || (billedInputTokens(usage) === 0 && usage.outputTokens === 0)) return null

      const cacheHit = cacheHitPercent(usage)
      const cacheHitText = cacheHit !== null ? t('stats.cacheHit', { percent: cacheHit }) : null
      const total = billedInputTokens(usage) + usage.outputTokens
      const totalText = t('message.turnUsage.count', { count: formatTokens(total, t) })
      const hasCost = cost !== undefined && typeof cost.costNano === 'number' && cost.costNano > 0
      const checkFailed = checkFailedOf(cost)
      const costText = hasCost
        ? `${cost.unpriced ? '≈' : ''}${formatCost(cost.costNano, cost.currency)}`
        : null
      const icon = h(DatabaseIcon)
      // A failed official-page check leaves the stored prices usable but
      // possibly stale; mark the money segment instead of hiding it.
      const costNode = costText === null
        ? null
        : checkFailed
          ? h('span', null, costText, h('span', { className: 'scp-warn', title: t('cost.checkWarnHint') }, '!'))
          : costText
      const detail = joined(totalText, costNode, cacheHitText)
      const ariaLabel = [
        totalText,
        costText === null ? null : (checkFailed ? `${costText} ${t('cost.checkFailed')}` : costText),
        cacheHitText,
      ].filter(part => part !== null).join(' · ')

      if (mode === 'compact') {
        // Compact parity: the shipped pill keeps one reading; keep cost + cache hit.
        const compactText = joined(costNode, cacheHitText)
        if (compactText === null) return null
        return h(PlainPill, { stat: 'usage', icon, label: compactText, ariaLabel })
      }

      const rows = []
      if (cost !== undefined && typeof cost.costNano === 'number') {
        // A route with no configured price yields no money figure at all; show
        // that explicitly instead of a misleading ¥0.
        const exactCost = cost.costNano > 0
          ? `${cost.unpriced ? '≈' : ''}${formatExactCost(cost.costNano, cost.currency)}`
          : t('cost.unpriced')
        rows.push(h('dt', { key: 'dt-cost' }, t('message.turnUsage.cost')))
        rows.push(h('dd', { key: 'dd-cost', 'data-session-cost': '' },
          cost.unpriced && cost.costNano > 0 ? `${exactCost} ${t('cost.unpricedHint')}` : exactCost))
      }
      // Price-table provenance: the config snapshot date, the newest effective
      // revision (an auto-detected update shows as `old → new`), and the last
      // official-page check outcome.
      if (cost !== undefined && typeof cost.checkStatus === 'number') {
        const asOf = typeof cost.priceAsOf === 'string' ? cost.priceAsOf : '—'
        const revisionAt = typeof cost.priceRevisionAt === 'string' ? cost.priceRevisionAt : null
        rows.push(h('dt', { key: 'dt-price' }, t('cost.priceTable')))
        rows.push(h('dd', { key: 'dd-price', 'data-session-price-asof': '' },
          revisionAt !== null && revisionAt !== asOf ? `${asOf} → ${revisionAt}` : asOf))
        rows.push(h('dt', { key: 'dt-check' }, t('cost.priceCheck')))
        if (cost.checkStatus === CHECK_FAILED) {
          rows.push(h('dd', {
            key: 'dd-check',
            'data-session-price-check': 'failed',
            title: typeof cost.priceCheckError === 'string' ? cost.priceCheckError : undefined,
          }, `${formatDateTime(cost.priceCheckedAt)} ${t('cost.checkFailed')}`))
          rows.push(h('dt', { key: 'dt-check-advice' }, t('cost.advice')))
          rows.push(h('dd', { key: 'dd-check-advice' }, t('cost.checkFailedHint')))
        } else if (cost.checkStatus === 1) {
          rows.push(h('dd', { key: 'dd-check' }, `${formatDateTime(cost.priceCheckedAt)} ${t('cost.checkOk')}`))
        } else {
          rows.push(h('dd', { key: 'dd-check' }, t('cost.checkNever')))
        }
      }
      if (cacheHit !== null) {
        rows.push(h('dt', { key: 'dt-hit' }, t('message.turnUsage.cacheHit')))
        rows.push(h('dd', { key: 'dd-hit' }, `${cacheHit}%`))
      }
      rows.push(h('dt', { key: 'dt-in' }, t('message.turnUsage.input')))
      rows.push(h('dd', { key: 'dd-in' }, exactCount(usage.uncachedInputTokens, t)))
      rows.push(h('dt', { key: 'dt-read' }, t('message.turnUsage.cacheRead')))
      rows.push(h('dd', { key: 'dd-read' }, exactCount(usage.cacheReadTokens, t)))
      if (usage.cacheWriteTokens !== 0) {
        rows.push(h('dt', { key: 'dt-write' }, t('message.turnUsage.cacheWrite')))
        rows.push(h('dd', { key: 'dd-write' }, exactCount(usage.cacheWriteTokens, t)))
      }
      rows.push(h('dt', { key: 'dt-out' }, t('message.turnUsage.output')))
      rows.push(h('dd', { key: 'dd-out' }, exactCount(usage.outputTokens, t)))

      return h(DialogPill, {
        stat: 'usage',
        icon,
        label: detail,
        ariaLabel,
        title: t('stats.dialog.usageTitle'),
        titleValue: exactCount(total, t),
      },
      h('dl', { className: 'scp-details', 'data-session-stats-usage': '' }, rows))
    }

    /* ------------------------------------------------------------------ */
    /* 7. Performance-usage detail mode (best effort).                     */
    /*    Profile ships `performanceUsage: detailed`; when the client       */
    /*    settings service is reachable we follow the live preference.     */
    /* ------------------------------------------------------------------ */

    let performanceModeStore = {
      get: () => 'detailed',
      subscribe: () => () => {},
    }

    function usePerformanceUsageMode() {
      return useSyncExternalStore(
        listener => performanceModeStore.subscribe(listener),
        () => performanceModeStore.get(),
      )
    }

    function connectPerformanceMode(ctx) {
      const listeners = new Set()
      let mode = 'detailed'
      const emit = () => { for (const listener of listeners) { try { listener() } catch (_ignored) { /* a listener must not break the pill */ } } }
      let unsubscribe = null
      try {
        const forms = ctx.get('configForms')
        if (forms !== undefined && forms !== null && typeof forms.get === 'function') {
          const form = forms.get('ui-chat')
          if (form !== undefined && form !== null && typeof form.getSnapshot === 'function') {
            const read = () => {
              const snapshot = form.getSnapshot()
              const value = snapshot?.value?.performanceUsage
              if ((value === 'compact' || value === 'detailed') && value !== mode) {
                mode = value
                emit()
              }
            }
            read()
            if (typeof form.subscribe === 'function') {
              const off = form.subscribe(read)
              if (typeof off === 'function') unsubscribe = off
            }
          }
        }
      } catch (_unavailableSettings) { /* keep the detailed default */ }
      performanceModeStore = {
        get: () => mode,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
      return () => {
        listeners.clear()
        if (unsubscribe !== null) { try { unsubscribe() } catch (_ignored) { /* already released */ } }
      }
    }

    /* ------------------------------------------------------------------ */
    /* 7b. Frame-wide notice for a failed official price-table check.      */
    /*     `shell.overlay` has no Session, so it scans every Session's      */
    /*     shared projection block for the first failed `sessionCost` view. */
    /* ------------------------------------------------------------------ */

    const NOTICE_DISMISS_KEY = 'dsh-session-cost:price-check-failed-at'
    const selectProjectionsBySession = state => state.projectionsBySession
    const selectSessionIds = state => state.ids

    function readDismissedFailedAt() {
      try {
        const raw = window.localStorage.getItem(NOTICE_DISMISS_KEY)
        return raw === null ? null : Number(raw)
      } catch (_unavailableStorage) {
        return null
      }
    }

    function writeDismissedFailedAt(timestamp) {
      try {
        window.localStorage.setItem(NOTICE_DISMISS_KEY, String(timestamp))
      } catch (_unavailableStorage) {
        /* the notice reappears on the next load when storage is unavailable */
      }
    }

    /** First failed price check across all visible Sessions, or null. */
    function findPriceCheckFailure(projectionsBySession) {
      if (projectionsBySession === undefined || projectionsBySession === null) return null
      for (const sessionId of Object.keys(projectionsBySession)) {
        const values = projectionsBySession[sessionId]?.values
        const cost = values === undefined ? undefined : values.sessionCost
        if (checkFailedOf(cost) && typeof cost.priceCheckedAt === 'number') {
          return {
            checkedAt: cost.priceCheckedAt,
            error: typeof cost.priceCheckError === 'string' ? cost.priceCheckError : null,
          }
        }
      }
      return null
    }

    function PriceCheckNotice({ useSessions, t }) {
      const projectionsBySession = useSessions(selectProjectionsBySession)
      const sessionIds = useSessions(selectSessionIds)
      const idsRef = useRef(sessionIds)
      idsRef.current = sessionIds
      const [dismissedAt, setDismissedAt] = useState(readDismissedFailedAt)
      // Reconcile every visible Session's shared projection values on mount and
      // slowly thereafter: a price-check status change is global, while the
      // projection frames only advance on a Session's own events.
      useEffect(() => {
        let cancelled = false
        const refreshAll = () => {
          if (cancelled) return
          for (const sessionId of idsRef.current) void refreshSessionProjections(sessionId)
        }
        refreshAll()
        const timer = setInterval(refreshAll, PROJECTION_REFRESH_MS)
        return () => { cancelled = true; clearInterval(timer) }
      }, [])
      const failure = findPriceCheckFailure(projectionsBySession)
      if (failure === null || failure.checkedAt === dismissedAt) return null
      const dismiss = () => {
        writeDismissedFailedAt(failure.checkedAt)
        setDismissedAt(failure.checkedAt)
      }
      return h('div', { className: 'scp-notice', role: 'alert' },
        h('div', { className: 'scp-notice-body' },
          h('div', { className: 'scp-notice-title' }, t('cost.noticeTitle')),
          h('div', { className: 'scp-notice-text' },
            t('cost.noticeBody', { time: formatDateTime(failure.checkedAt) })),
          failure.error === null ? null : h('div', { className: 'scp-notice-error' }, failure.error)),
        h('button', {
          type: 'button',
          className: 'scp-notice-dismiss',
          onClick: dismiss,
        }, t('cost.noticeDismiss')))
    }

    /* ------------------------------------------------------------------ */
    /* 8. Stylesheet — verbatim copy of StatsPills.module.css +             */
    /*    stat-dialog.module.css, classes renamed under `scp-`.             */
    /* ------------------------------------------------------------------ */

    const CSS = `
.scp-anchor {
  display: inline-flex;
  min-width: 0;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.scp-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  max-width: 100%;
  padding: 1px 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-variant-numeric: tabular-nums;
  line-height: inherit;
  white-space: nowrap;
}
.scp-pill svg {
  width: 14px;
  height: 14px;
  flex: none;
}
button.scp-pill {
  cursor: pointer;
}
button.scp-pill:hover,
button.scp-pill[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.scp-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.scp-sep {
  color: var(--dsw-alias-separator-primary);
  margin: 0 6px;
}
.scp-panel {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  width: max-content;
  min-width: min(300px, calc(100vw - 24px));
  max-width: min(440px, calc(100vw - 24px));
  padding: 16px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  cursor: default;
}
.scp-title {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.scp-titleRule {
  margin-bottom: 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.scp-titleValue {
  font-variant-numeric: tabular-nums;
}
.scp-titleLabel {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.scp-titleLabel svg {
  width: 14px;
  height: 14px;
  flex: none;
}
.scp-details {
  display: grid;
  grid-template-columns: minmax(76px, auto) minmax(0, 1fr);
  gap: 6px 16px;
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
}
.scp-details dt,
.scp-details dd {
  min-width: 0;
  margin: 0;
}
.scp-details dd {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.scp-warn {
  margin-left: 2px;
  color: var(--dsw-alias-state-warn-primary, #d97706);
  font-weight: 600;
}
/* Frame-wide dismissible notice: the overlay layer is click-through, so the
   card re-enables pointer events for its own box. */
.scp-notice {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 1200;
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  gap: 16px;
  max-width: min(440px, calc(100vw - 48px));
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  pointer-events: auto;
}
.scp-notice-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.scp-notice-title {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.scp-notice-text {
  overflow-wrap: anywhere;
}
.scp-notice-error {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.scp-notice-dismiss {
  flex: none;
  margin-left: auto;
  padding: 2px 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-brand-primary);
  font: inherit;
  cursor: pointer;
}
.scp-notice-dismiss:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
`

    /* ------------------------------------------------------------------ */
    /* 9. Dictionaries — own namespace, official strings copied verbatim.  */
    /* ------------------------------------------------------------------ */

    const zh = {
      'number.thousand': '{value}K',
      'number.million': '{value}M',
      'number.groupSeparator': ',',
      'message.turnUsage.count': '{count} tok',
      'message.turnUsage.cacheHit': '缓存命中',
      'message.turnUsage.input': '未缓存输入',
      'message.turnUsage.cacheRead': '缓存读取',
      'message.turnUsage.cacheWrite': '缓存写入',
      'message.turnUsage.output': '输出',
      'message.turnUsage.cost': '消费金额',
      'stats.cacheHit': '缓存命中 {percent}%',
      'stats.dialog.usageTitle': 'Token 用量',
      'cost.unpriced': '未配置价格',
      'cost.unpricedHint': '（含未配置价格的模型）',
      'cost.priceTable': '价格表',
      'cost.priceCheck': '价目自动检查',
      'cost.checkNever': '尚未执行',
      'cost.checkOk': '成功',
      'cost.checkFailed': '失败',
      'cost.checkFailedHint': '金额可能已过期，请手动核对官方价目表',
      'cost.checkWarnHint': '官方价目表自动检查失败，金额可能已过期',
      'cost.advice': '建议',
      'cost.noticeTitle': '会话 API 消费：价目表待核对',
      'cost.noticeBody': '官方价目表自动检查失败（{time}），金额可能已过期，请手动核对。',
      'cost.noticeDismiss': '知道了',
    }

    const en = {
      'number.thousand': '{value}K',
      'number.million': '{value}M',
      'number.groupSeparator': ',',
      'message.turnUsage.count': '{count} tok',
      'message.turnUsage.cacheHit': 'Cache hit',
      'message.turnUsage.input': 'Uncached input',
      'message.turnUsage.cacheRead': 'Cached input',
      'message.turnUsage.cacheWrite': 'Cache write',
      'message.turnUsage.output': 'Output',
      'message.turnUsage.cost': 'API cost',
      'stats.cacheHit': 'Cache hit {percent}%',
      'stats.dialog.usageTitle': 'Token usage',
      'cost.unpriced': 'No price configured',
      'cost.unpricedHint': '(includes models without a configured price)',
      'cost.priceTable': 'Price table',
      'cost.priceCheck': 'Price auto-check',
      'cost.checkNever': 'Not run yet',
      'cost.checkOk': 'succeeded',
      'cost.checkFailed': 'failed',
      'cost.checkFailedHint': 'The amount may be stale — please verify the official price table manually',
      'cost.checkWarnHint': 'The official price-table auto-check failed; the amount may be stale',
      'cost.advice': 'Advice',
      'cost.noticeTitle': 'Session API cost: price table needs review',
      'cost.noticeBody': 'The official price-table auto-check failed ({time}); the amount may be stale — please check manually.',
      'cost.noticeDismiss': 'Dismiss',
    }

    /* ------------------------------------------------------------------ */
    /* 10. Plugin body.                                                    */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      try {
        clientSessionsService = ctx.get('sessions') ?? null
      } catch (_unavailableSessions) {
        clientSessionsService = null
      }
      // Head-level sheet (the first-party ui-theme pattern): the pill root must
      // stay the dock's flex item, so styles are not rendered in the slot tree.
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = '@ceasarxuu/dsh-session-cost'
        tag.dataset.pluginCss = '@ceasarxuu/dsh-session-cost/pill.css'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, 'session-cost: stylesheet')
      ctx.effect(() => {
        const disconnect = connectPerformanceMode(ctx)
        return () => { disconnect() }
      }, 'session-cost: performance usage mode')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-cost: dictionaries')
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'usage', // same cell as the shipped pill -> replaces it
        order: 1, // same row position (shipped activity is order 0)
        priority: -1, // a static bundle must shadow explicitly; lowest rank renders
        locale: NS, // synthesizes the `t` prop from our dictionaries
      }, UsageCostPill))
      // Frame-wide, non-blocking notice when the bounded official-page check
      // failed; a fresh id keeps it additive beside the shipped overlays.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-cost-price-notice',
        order: 100,
        locale: NS,
      }, PriceCheckNotice))
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
