// Offline tests for the DeepSeek account balance decoration in client.js.
//
// The browser bundle registers a factory with window.__ModuleLoader__; this
// harness captures that registration, runs the factory with stub React modules
// and exercises the exported pure helpers plus a tiny fake trigger element.
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
assert.ok(__test !== undefined, 'test internals missing')

const t = (key, vars) => {
  const dictionary = {
    'balance.label': '余额 {amount}',
    'balance.title': 'DeepSeek 余额',
    'balance.breakdown': '充值 {normal}、赠金 {bonus}',
    'balance.unavailable': '余额 —',
    'balance.unavailableTitle': 'DeepSeek 余额暂不可用，稍后自动重试',
  }
  const template = dictionary[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_match, name) => vars?.[name] ?? '')
}

// 1. Normal and bonus wallets merge by currency, CNY first.
{
  const wallets = __test.mergeBalanceWallets({
    value: [
      { currency: 'USD', balance: '2.50' },
      { currency: 'CNY', balance: '10.00' },
      { currency: 'CNY', balance: '0.50' },
      { currency: 'EUR', balance: '9.99' },
      { currency: 'CNY', balance: 'not-a-number' },
    ],
    bonusWallets: [
      { currency: 'CNY', balance: '2.00' },
      { currency: 'CNY', balance: '0.25' },
      { currency: 'USD', balance: '0.10' },
    ],
  })
  assert.equal(wallets.length, 2)
  assert.equal(wallets[0].currency, 'CNY')
  assert.equal(wallets[0].normal, 10.5)
  assert.equal(wallets[0].bonus, 2.25)
  assert.equal(wallets[0].total, 12.75)
  assert.equal(wallets[1].currency, 'USD')
  assert.equal(wallets[1].total, 2.6)
  assert.equal(__test.mergeBalanceWallets({}).length, 0)
  assert.equal(__test.mergeBalanceWallets({ value: null }).length, 0)
  console.log('1. wallet merge:', JSON.stringify(wallets))
}

// 2. Compact money formatting.
{
  assert.equal(__test.formatBalanceAmount(12.345, 'CNY'), '¥12.35')
  assert.equal(__test.formatBalanceAmount(0, 'CNY'), '¥0')
  assert.equal(__test.formatBalanceAmount(0.004, 'USD'), '$0.004')
  assert.equal(__test.formatBalanceAmount(-3.2, 'CNY'), '-¥3.20')
  console.log('2. formatting verified')
}

// 3. Sidebar text and hover breakdown.
{
  const wallets = [
    { currency: 'CNY', normal: 10, bonus: 2.25, total: 12.25 },
    { currency: 'USD', normal: 2, bonus: 0, total: 2 },
  ]
  assert.equal(__test.accountBalanceText(wallets, t), '余额 ¥12.25 · $2.00')
  assert.equal(
    __test.accountBalanceTitle(wallets, t),
    'DeepSeek 余额: ¥12.25 (充值 ¥10.00、赠金 ¥2.25) · $2.00 (充值 $2.00、赠金 $0)',
  )
  assert.equal(__test.accountBalanceText([], t), null)
  assert.equal(__test.accountBalanceText(null, t), null)
  console.log('3. labels verified:', __test.accountBalanceText(wallets, t))
}

/* ------------------------------------------------------------------ */
/* 4. Trigger decoration: one right-aligned reading, updated in place.  */
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

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  querySelector(selector) {
    if (selector !== ':scope > [data-session-cost-balance]') {
      throw new Error(`fake DOM cannot match selector ${selector}`)
    }
    return this.children.find(child => child.hasAttribute('data-session-cost-balance')) ?? null
  }
}

function buildTrigger() {
  const document = {
    createElement(tagName) { return new FakeElement(tagName, document) },
  }
  const trigger = document.createElement('button')
  trigger.setAttribute('data-signed-out', 'false')
  trigger.setAttribute('aria-label', '账号菜单')
  trigger.appendChild(document.createElement('span'))
  trigger.appendChild(document.createElement('span'))
  return { document, trigger }
}

{
  const { trigger } = buildTrigger()
  const ready = {
    status: 'ready',
    wallets: [{ currency: 'CNY', normal: 10, bonus: 2.25, total: 12.25 }],
  }
  __test.updateAccountBalanceNode(trigger, ready, t)
  const node = trigger.querySelector(':scope > [data-session-cost-balance]')
  assert.ok(node !== null)
  assert.equal(node.className, 'scp-account-balance')
  assert.equal(node.textContent, '余额 ¥12.25')
  assert.equal(node.title, 'DeepSeek 余额: ¥12.25 (充值 ¥10.00、赠金 ¥2.25)')
  assert.equal(trigger.getAttribute('aria-description'), '余额 ¥12.25')
  assert.equal(trigger.children.length, 3)

  // Idempotent and updates the same node.
  const updated = { status: 'ready', wallets: [{ currency: 'USD', normal: 1, bonus: 0, total: 1 }] }
  __test.updateAccountBalanceNode(trigger, updated, t)
  assert.equal(trigger.children.length, 3)
  assert.equal(trigger.querySelector(':scope > [data-session-cost-balance]').textContent, '余额 $1.00')

  // A failed refresh keeps a readable placeholder.
  __test.updateAccountBalanceNode(trigger, { status: 'failed' }, t)
  assert.equal(trigger.querySelector(':scope > [data-session-cost-balance]').textContent, '余额 —')
  assert.equal(trigger.querySelector(':scope > [data-session-cost-balance]').title, 'DeepSeek 余额暂不可用，稍后自动重试')

  // Signed out removes the reading and its description.
  __test.updateAccountBalanceNode(trigger, { status: 'signed-out' }, t)
  assert.equal(trigger.querySelector(':scope > [data-session-cost-balance]'), null)
  assert.equal(trigger.hasAttribute('aria-description'), false)
  assert.equal(trigger.children.length, 2)

  // An absent trigger is a no-op, not a crash.
  __test.updateAccountBalanceNode(null, ready, t)
  console.log('4. account trigger decoration verified')
}

console.log('\nclient-balance: all checks passed')
