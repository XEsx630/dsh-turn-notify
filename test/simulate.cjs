// Runnable check for the client half: no framework, just the state transitions.
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

let registration
const notifications = []
const tones = []
const hostCalls = []

global.window = {
  __ModuleLoader__: { load: (value) => { registration = value } },
  addEventListener() {},
  removeEventListener() {},
  focus() {},
}

global.Notification = class {
  static permission = 'granted'
  static requestPermission = async () => 'granted'
  constructor(title, options) {
    this.title = title
    this.options = options
    notifications.push(this)
  }
  close() {}
}

global.AudioContext = class {
  constructor() {
    this.state = 'running'
    this.currentTime = 0
    this.destination = {}
  }
  createGain() {
    return {
      gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
    }
  }
  createOscillator() {
    return {
      type: '',
      frequency: { value: 0 },
      connect() {},
      start() { tones.push(this.frequency.value) },
      stop() {},
    }
  }
  resume() { this.state = 'running'; return Promise.resolve() }
  close() { return Promise.resolve() }
}

global.fetch = async (url, options) => {
  hostCalls.push({ url, options })
  return { ok: false } // force the renderer fallback in this check
}

global.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { append() {} },
}
global.localStorage = {
  data: new Map(),
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null },
  setItem(key, value) { this.data.set(key, value) },
}

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8'), { filename: 'client.js' })

const listStore = {
  snapshot: { ids: [], byId: {} },
  listeners: new Set(),
  getSnapshot() { return this.snapshot },
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  },
  set(rows) {
    this.snapshot = {
      ids: rows.map((row) => row.id),
      byId: Object.fromEntries(rows.map((row) => [row.id, row])),
    }
    for (const listener of [...this.listeners]) listener()
  },
}

const statusStore = {
  snapshot: new Map(),
  listeners: new Set(),
  getSnapshot() { return this.snapshot },
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  },
  set(entries) {
    this.snapshot = new Map(entries.map(([id, running]) => [id, { running }]))
    for (const listener of [...this.listeners]) listener()
  },
}

const sessionStores = new Map()
const getSession = (id) => {
  let entry = sessionStores.get(id)
  if (entry === undefined) {
    const listeners = new Set()
    entry = {
      running: false,
      getSnapshot() { return { running: this.running } },
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      setRunning(running) {
        if (this.running === running) return
        this.running = running
        for (const listener of [...listeners]) listener()
      },
    }
    sessionStores.set(id, entry)
  }
  return entry
}

const row = (id, running, extra = {}) => ({
  id,
  displayTitle: `会话 ${id}`,
  running,
  blank: false,
  retainedBy: { mainView: 0 },
  ...extra,
})

const sync = (rows, statuses) => {
  listStore.set(rows)
  statusStore.set(statuses)
  for (const item of rows) getSession(item.id).setRunning(item.running === true)
}

const React = { createElement: () => null, useState: (value) => [value, () => {}] }
const requireMock = (id) => id === 'react' ? React : { Switch: () => null }
const flush = () => new Promise((resolve) => setImmediate(resolve))

;(async () => {
  // Enabled while a turn is already running: its completion still notifies.
  listStore.set([row('a', true)])
  statusStore.snapshot = new Map([['a', { running: true }]])
  getSession('a').running = true

  const plugin = registration.factory(requireMock)
  const cleanups = []
  const ctx = {
    sessions: { list: listStore, get: getSession },
    uiSession: { sessionStatus: statusStore },
    slots: { inject(_name, callback) { callback() }, register() {} },
    effect(callback) { cleanups.push(callback()) },
  }
  plugin.apply(ctx)

  sync([row('a', false)], [['a', false]])
  await flush()
  assert.equal(notifications.length, 1, 'running -> idle notifies')
  assert.equal(notifications[0].title, '会话 a')
  assert.equal(notifications[0].options.tag, 'dsh-turn:a')
  assert.equal(notifications[0].options.silent, true, 'the renderer fallback is silent; it chimes')
  assert.equal(tones.length, 2, 'completion plays the two-note chime')
  assert.equal(hostCalls.length, 1, 'the Host toast endpoint is called first')
  assert.match(hostCalls[0].url, /\/dsh-turn-notify\/notify$/)

  // The main conversation notifies too, even while it is focused.
  sync([row('a', true, { retainedBy: { mainView: 1 } })], [['a', true]])
  sync([row('a', false, { retainedBy: { mainView: 1 } })], [['a', false]])
  await flush()
  assert.equal(notifications.length, 2, 'focused main conversation still notifies')

  // Subagent sessions stay quiet.
  sync([row('a', false), row('child', true, { parentId: 'a' })], [['a', false], ['child', true]])
  sync([row('a', false), row('child', false, { parentId: 'a' })], [['a', false], ['child', false]])
  await flush()
  assert.equal(notifications.length, 2, 'subagents stay quiet')

  // A background session finishing notifies as well.
  sync([row('a', false), row('b', true)], [['a', false], ['b', true]])
  sync([row('a', false), row('b', false)], [['a', false], ['b', false]])
  await flush()
  assert.equal(notifications.length, 3, 'background session notifies')
  assert.equal(notifications[2].title, '会话 b')
  assert.equal(hostCalls.length, 3, 'each completion asks the Host for a toast')

  // The focused Session's own running bit can be the only source that flips.
  sync([row('a', false), row('b', false), row('c', false, { retainedBy: { mainView: 1 } })], [['a', false], ['b', false], ['c', false]])
  getSession('c').setRunning(true)
  getSession('c').setRunning(false)
  await flush()
  assert.equal(notifications.length, 4, 'Session running bit catches the focused session')
  assert.equal(notifications[3].title, '会话 c')
  assert.equal(hostCalls.length, 4, 'each completion asks the Host for a toast')

  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup()
  console.log('ok: turn-notify client transitions')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
