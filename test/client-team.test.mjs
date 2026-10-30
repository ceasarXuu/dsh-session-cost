// Offline tests for the Agent Teams cost decoration in client.js.
//
// The browser bundle registers a factory with window.__ModuleLoader__; this
// harness captures that registration, runs the factory with stub React modules
// and exercises the exported pure helpers plus a tiny fake DOM. No browser and
// no network are involved.
import assert from 'node:assert/strict'

let entry = null
globalThis.window = {
  __SESSION_COST_TEST__: true,
  __ModuleLoader__: {
    load(next) { entry = next },
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
  },
}

const reactStub = {
  createElement: () => null,
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: () => ({ current: null }),
  useState: () => [false, () => {}],
  useSyncExternalStore: () => undefined,
}
const reactDomStub = { createPortal: () => null }

await import('../client.js')
assert.ok(entry !== null, 'the bundle did not register with the module loader')
const bundle = entry.factory((id) => {
  if (id === 'react') return reactStub
  if (id === 'react-dom') return reactDomStub
  throw new Error(`unexpected require: ${id}`)
})
const { __test } = bundle
assert.ok(__test !== undefined, 'test internals missing (window.__SESSION_COST_TEST__ not applied)')

const t = (key, vars) => {
  const dictionary = {
    'team.total': '合计 {cost}',
    'team.totalTitle': '全部成员累计 API 消费（估算）',
    'team.memberTitle': '{name} 的累计 API 消费（估算）',
    'team.inheritedHint': '（另有 {total} 为从 Lead 继承的历史，不计入团队合计）',
    'cost.unpricedHint': '（含未配置价格的模型）',
    'cost.checkWarnHint': '官方价目表自动检查失败，金额可能已过期',
  }
  const template = dictionary[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_match, name) => vars?.[name] ?? '')
}

/** A `sessionCost` wire view as the Host emits it (`costNano` in 1e-9 units). */
const costView = (costNano, overrides = {}) => ({
  costNano,
  currency: 'CNY',
  unpriced: false,
  unpricedTokens: 0,
  checkStatus: 1,
  priceAsOf: '2026-10-28',
  priceRevisionAt: null,
  priceCheckedAt: 1,
  priceCheckError: null,
  ...overrides,
})

const projections = {
  lead: { values: { sessionCost: costView(2_000_000_000) } },
  'cc-api-researcher': { values: { sessionCost: costView(500_000_000) } },
  'cc-ref-researcher': { values: { sessionCost: costView(12_000_000) } },
}
const members = [
  { id: 'lead', name: 'lead', role: 'lead', phase: 'active' },
  { id: 'cc-api-researcher', name: 'cc-api-researcher', role: 'teammate', phase: 'active' },
  { id: 'cc-ref-researcher', name: 'cc-ref-researcher', role: 'teammate', phase: 'active' },
]

// 1. The total sums every member (the Lead included) and reports completeness.
{
  const summary = __test.summarizeTeamCosts(members, projections)
  assert.equal(summary.total, 3)
  assert.equal(summary.priced, 3)
  assert.equal(summary.complete, true)
  assert.equal(summary.costNano, 2_512_000_000)
  assert.equal(summary.currency, 'CNY')
  assert.equal(summary.unpriced, false)
  assert.equal(__test.teamTotalLabel(summary, t), '合计 ¥2.51')
  console.log('1. team total sums lead + teammates:', __test.teamTotalLabel(summary, t))
}

// 2. A missing member view is unknown, not zero; the total marks the gap.
{
  const partial = __test.summarizeTeamCosts(members, {
    lead: projections.lead,
    'cc-api-researcher': projections['cc-api-researcher'],
  })
  assert.equal(partial.priced, 2)
  assert.equal(partial.complete, false)
  assert.equal(partial.costNano, 2_500_000_000)
  assert.equal(__test.teamTotalLabel(partial, t), '合计 ≈¥2.50')
  console.log('2. missing member view:', __test.teamTotalLabel(partial, t))
}

// 3. Unpriced routes mark both the member reading and the total.
{
  const unpricedProjections = {
    ...projections,
    'cc-ref-researcher': { values: { sessionCost: costView(0, { unpriced: true, unpricedTokens: 4_000 }) } },
  }
  const summary = __test.summarizeTeamCosts(members, unpricedProjections)
  assert.equal(summary.unpriced, true)
  assert.equal(summary.complete, true)
  assert.equal(summary.costNano, 2_500_000_000)
  assert.equal(__test.teamCostLabel(summary.rows[2].cost), '≈¥0')
  assert.equal(__test.teamTotalLabel(summary, t), '合计 ≈¥2.50')
  console.log('3. unpriced member is marked:', __test.teamCostLabel(summary.rows[2].cost))
}

// 4. Mixed currencies are never summed together.
{
  const usd = { values: { sessionCost: costView(1_000_000_000, { currency: 'USD' }) } }
  const summary = __test.summarizeTeamCosts(members, { ...projections, lead: usd })
  assert.equal(summary.currency, 'USD')
  assert.equal(summary.costNano, 1_000_000_000)
  assert.equal(summary.priced, 1)
  assert.equal(summary.complete, false)
  console.log('4. mixed currency excluded:', __test.teamTotalLabel(summary, t))
}

// 5. Formatting and title helpers.
{
  assert.equal(__test.teamCostLabel(costView(12_000_000)), '¥0.012')
  assert.equal(__test.teamCostLabel(costView(0)), '¥0')
  assert.equal(__test.teamCostLabel(null), null)
  assert.equal(
    __test.teamCostTitle('cc-ref-researcher', costView(12_000_000), t),
    'cc-ref-researcher 的累计 API 消费（估算）: ¥0.012',
  )
  assert.equal(
    __test.teamCostTitle(null, costView(500_000_000, { unpriced: true, checkStatus: 2 }), t),
    '全部成员累计 API 消费（估算）: ≈¥0.5 （含未配置价格的模型） 官方价目表自动检查失败，金额可能已过期',
  )
  const completeSummary = __test.summarizeTeamCosts(members, projections)
  assert.equal(__test.teamTotalTitle(completeSummary, t), '全部成员累计 API 消费（估算）: ¥2.512')
  const partialSummary = __test.summarizeTeamCosts(members, {
    lead: projections.lead,
    'cc-api-researcher': projections['cc-api-researcher'],
  })
  assert.equal(__test.teamTotalTitle(partialSummary, t), '全部成员累计 API 消费（估算）: ≈¥2.5')
  assert.equal(__test.teamTotalTitle(__test.summarizeTeamCosts(members, projections), t), '全部成员累计 API 消费（估算）: ¥2.512')
  assert.equal(__test.sessionCostOf({}, 'lead'), null)
  assert.equal(__test.sessionCostOf({ lead: { values: { sessionCost: { costNano: -1 } } } }, 'lead'), null)
  console.log('5. formatting, titles and malformed views verified')
}

/* ------------------------------------------------------------------ */
/* 6. DOM decoration: one node per card, total in the heading, idempotent. */
/* ------------------------------------------------------------------ */

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase()
    this.ownerDocument = ownerDocument
    this.children = []
    this.attributes = new Map()
    this.textContent = ''
    this.title = ''
    this.parent = null
  }

  get className() {
    return this.attributes.get('class') ?? ''
  }

  set className(value) {
    this.attributes.set('class', String(value))
  }

  appendChild(node) {
    node.parent = this
    this.children.push(node)
    return node
  }

  remove() {
    if (this.parent === null) return
    const index = this.parent.children.indexOf(this)
    if (index >= 0) this.parent.children.splice(index, 1)
    this.parent = null
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  descendants() {
    const found = []
    for (const child of this.children) {
      found.push(child, ...child.descendants())
    }
    return found
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector) {
    switch (selector) {
      case 'h3':
        return this.descendants().filter(element => element.tagName === 'H3')
      case ':scope > div':
        return this.children.filter(element => element.tagName === 'DIV')
      case ':scope > button':
        return this.children.filter(element => element.tagName === 'BUTTON')
      case 'button':
        return this.descendants().filter(element => element.tagName === 'BUTTON')
      case ':scope > [data-session-cost-total]':
        return this.children.filter(element => element.hasAttribute('data-session-cost-total'))
      case ':scope > [data-session-cost-member]':
        return this.children.filter(element => element.hasAttribute('data-session-cost-member'))
      default:
        throw new Error(`fake DOM cannot match selector ${selector}`)
    }
  }
}

function buildSection() {
  const document = {
    elements: [],
    createElement(tagName) {
      const element = new FakeElement(tagName, document)
      document.elements.push(element)
      return element
    },
    querySelectorAll(selector) {
      if (selector !== '[data-session-cost-member], [data-session-cost-total]') {
        throw new Error(`fake DOM cannot match document selector ${selector}`)
      }
      return document.elements.filter(element => element.parent !== null
        && (element.hasAttribute('data-session-cost-member') || element.hasAttribute('data-session-cost-total')))
    },
  }
  const section = document.createElement('section')
  const heading = document.createElement('h3')
  heading.appendChild(document.createElement('span'))
  section.appendChild(heading)
  const roster = document.createElement('div')
  for (const member of members) {
    const button = document.createElement('button')
    button.textContent = member.name
    button.appendChild(document.createElement('span'))
    button.appendChild(document.createElement('span'))
    roster.appendChild(button)
  }
  section.appendChild(roster)
  return { document, section, heading, buttons: roster.children }
}

{
  const { document, section, heading, buttons } = buildSection()
  const summary = __test.summarizeTeamCosts(members, projections)
  __test.updateTeamCostNodes(section, summary, t)
  assert.equal(heading.children.length, 2)
  assert.equal(heading.children[1].textContent, '合计 ¥2.51')
  assert.equal(heading.children[1].getAttribute('data-session-cost-total'), '')
  assert.equal(heading.children[1].title, '全部成员累计 API 消费（估算）: ¥2.512')
  for (let index = 0; index < buttons.length; index += 1) {
    const costNodes = buttons[index].children.filter(child => child.hasAttribute('data-session-cost-member'))
    assert.equal(costNodes.length, 1)
    assert.equal(costNodes[0].getAttribute('data-session-cost-member'), members[index].id)
    assert.equal(costNodes[0].getAttribute('class'), 'scp-team-cost')
  }
  assert.equal(buttons[0].children.at(-1).textContent, '¥2.00')
  assert.equal(buttons[2].children.at(-1).textContent, '¥0.012')

  // Idempotent: a second sweep (React re-render) never accumulates nodes.
  __test.updateTeamCostNodes(section, summary, t)
  assert.equal(heading.children.length, 2)
  assert.equal(buttons[0].children.length, 3)

  // A member view disappearing removes that reading; a new total updates.
  const partial = __test.summarizeTeamCosts(members.slice(0, 2), {
    lead: projections.lead,
    'cc-api-researcher': projections['cc-api-researcher'],
  })
  const rebuilt = buildSection()
  __test.updateTeamCostNodes(rebuilt.section, summary, t)
  __test.updateTeamCostNodes(rebuilt.section, partial, t)
  assert.equal(rebuilt.heading.children[1].textContent, '合计 ¥2.50')
  assert.equal(rebuilt.buttons[2].children.filter(child => child.hasAttribute('data-session-cost-member')).length, 0)

  // A card whose text does not start with the mapped member name is skipped
  // rather than labeled with another member's amount.
  const mismatched = buildSection()
  mismatched.buttons[1].textContent = 'someone-else'
  __test.updateTeamCostNodes(mismatched.section, summary, t)
  assert.equal(mismatched.buttons[1].children.filter(child => child.hasAttribute('data-session-cost-member')).length, 0)
  assert.equal(mismatched.buttons[0].children.at(-1).textContent, '¥2.00')
  assert.equal(mismatched.buttons[2].children.at(-1).textContent, '¥0.012')

  // A team with no arriving views renders no total and no card readings.
  const empty = buildSection()
  const emptySummary = __test.summarizeTeamCosts(members, {})
  assert.equal(emptySummary.priced, 0)
  assert.equal(__test.teamTotalLabel(emptySummary, t), null)
  __test.updateTeamCostNodes(empty.section, emptySummary, t)
  assert.equal(empty.heading.children.length, 1)
  assert.equal(empty.buttons.every(button => button.children.length === 2), true)

  // Teardown removes only our nodes.
  __test.clearTeamCostNodes(document)
  assert.equal(document.querySelectorAll('[data-session-cost-member], [data-session-cost-total]').length, 0)
  assert.equal(section.children.length, 2)
  console.log('6. panel decoration is idempotent and removable')
}

// 7. A fork's inherited prefix is excluded from the member reading and total.
{
  const forkCost = {
    costNano: 3_000_000_000,
    ownCostNano: 600_000_000,
    ownUnpricedTokens: 0,
    currency: 'CNY',
    unpriced: false,
    unpricedTokens: 0,
    checkStatus: 1,
    priceAsOf: '2026-10-28',
    priceRevisionAt: null,
    priceCheckedAt: 1,
    priceCheckError: null,
  }
  const forkProjections = {
    lead: projections.lead,
    'cc-api-researcher': { values: { sessionCost: forkCost } },
  }
  const summary = __test.summarizeTeamCosts(members.slice(0, 2), forkProjections)
  assert.equal(summary.costNano, 2_600_000_000)
  assert.equal(__test.teamTotalLabel(summary, t), '合计 ¥2.60')
  const row = summary.rows[1]
  assert.equal(row.cost.costNano, 600_000_000)
  assert.equal(row.cost.inheritedCostNano, 2_400_000_000)
  assert.equal(
    __test.teamCostTitle('cc-api-researcher', row.cost, t),
    'cc-api-researcher 的累计 API 消费（估算）: ¥0.6 （另有 ¥3 为从 Lead 继承的历史，不计入团队合计）',
  )
  // A host without the split falls back to the whole-log reading.
  const legacy = __test.teamMemberCostOf({
    lead: { values: { sessionCost: costView(500_000_000) } },
  }, 'lead')
  assert.equal(legacy.costNano, 500_000_000)
  assert.equal(legacy.inheritedCostNano, 0)
  console.log('7. fork-inherited prefix excluded:', __test.teamTotalLabel(summary, t))
}


console.log('\nclient-team: all checks passed')
