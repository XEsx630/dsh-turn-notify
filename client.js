window.__ModuleLoader__.load({
  id: 'dsh-turn-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { Switch } = require('@deepseek-ai/dsh-client-ui-primitives')

    const ENABLED_KEY = 'dsh-turn-notify:enabled:v1'

    const api = typeof Notification === 'function' ? Notification : undefined
    const granted = () => api !== undefined && api.permission === 'granted'
    let asking

    const readEnabled = () => {
      try {
        return localStorage.getItem(ENABLED_KEY) !== '0'
      } catch {
        return true
      }
    }
    let enabled = readEnabled()

    const storeEnabled = (value) => {
      enabled = value
      try {
        localStorage.setItem(ENABLED_KEY, value ? '1' : '0')
      } catch {
        // Private-mode storage failures leave the in-memory value in charge.
      }
    }

    // Windows toasts from Electron do not reliably carry the system sound, so
    // play a short in-app chime and mark the toast silent to avoid doubling.
    let audioContext
    const audio = () => {
      if (audioContext === undefined) {
        const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext
        if (Ctor === undefined) return undefined
        try {
          audioContext = new Ctor()
        } catch {
          return undefined
        }
      }
      return audioContext
    }
    const primeAudio = () => {
      const context = audio()
      if (context?.state === 'suspended') void context.resume()
    }
    const chime = () => {
      const context = audio()
      if (context === undefined) return
      const play = () => {
        const start = context.currentTime + 0.02
        const master = context.createGain()
        master.gain.value = 0.4
        master.connect(context.destination)
        for (const [frequency, delay, duration] of [[880, 0, 0.28], [1318.51, 0.15, 0.5]]) {
          const oscillator = context.createOscillator()
          const envelope = context.createGain()
          oscillator.type = 'triangle'
          oscillator.frequency.value = frequency
          envelope.gain.setValueAtTime(0.0001, start + delay)
          envelope.gain.exponentialRampToValueAtTime(1, start + delay + 0.012)
          envelope.gain.exponentialRampToValueAtTime(0.0001, start + delay + duration)
          oscillator.connect(envelope)
          envelope.connect(master)
          oscillator.start(start + delay)
          oscillator.stop(start + delay + duration + 0.05)
        }
      }
      if (context.state === 'suspended') void context.resume().then(play, () => {})
      else play()
    }

    /** Browsers require a user gesture; Electron grants page-initiated requests. */
    const ask = () => {
      if (api === undefined || api.permission !== 'default') return Promise.resolve(granted())
      asking ??= Promise.resolve(api.requestPermission()).then(
        (state) => state === 'granted',
        () => false,
      ).finally(() => { asking = undefined })
      return asking
    }

    // Keep live Notification objects referenced: Chromium may collect an unreferenced
    // one immediately, leaving the toast recorded but never displayed.
    const live = new Map()
    const show = (key, title, body) => {
      try {
        const previous = live.get(key)
        if (previous !== undefined) {
          try { previous.close() } catch {}
        }
        const item = new Notification(title, { body, tag: key, silent: true })
        live.set(key, item)
        const release = () => { if (live.get(key) === item) live.delete(key) }
        item.onclose = release
        item.onerror = release
        item.onclick = () => {
          try { window.focus() } catch {}
          item.close()
          release()
        }
        return true
      } catch {
        return false
      }
    }

    // The Host posts a real Windows toast (see index.js): unlike the renderer
    // Notification API, it does not depend on the random loopback origin's
    // permission. Fall back to the renderer only when the Host route is down.
    const hostToast = (title, body) => {
      try {
        return fetch('/dsh-turn-notify/notify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, body }),
        }).then((response) => response.ok, () => false)
      } catch {
        return Promise.resolve(false)
      }
    }

    const announce = (key, title, body) => {
      chime()
      void hostToast(title, body).then((done) => {
        if (done || api === undefined || api.permission === 'denied') return
        if (granted()) {
          show(key, title, body)
          return
        }
        void ask().then((ok) => { if (ok && enabled) show(key, title, body) })
      })
    }

    const notify = (key, title, body) => {
      if (!enabled) return
      announce(key, title, body)
    }

    const CSS = `
.dtn-root{display:flex;flex-direction:column;gap:14px;max-width:660px;margin:0 auto;padding:4px 0 24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dtn-heading{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em}
.dtn-card{display:flex;flex-direction:column;gap:12px;padding:14px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:12px;background:var(--dsw-alias-settings-card-fill,rgba(127,127,127,.06))}
.dtn-group{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dtn-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.dtn-copy{min-width:0}
.dtn-title{font-weight:600}
.dtn-desc{margin-top:2px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dtn-actions{display:flex;justify-content:flex-end;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px}
.dtn-test{height:28px;padding:0 11px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dtn-test:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));color:var(--dsw-alias-label-primary)}
.dtn-test:disabled{opacity:.55;cursor:default}
`

    function NotificationsPage() {
      const [on, setOn] = React.useState(enabled)

      const change = (next) => {
        storeEnabled(next)
        setOn(next)
        if (next) announce('dsh-turn-notify:enabled', '完成通知已开启', '会话完成任务时会在这里提醒你')
      }

      const test = () => {
        announce('dsh-turn-notify:test', '任务完成通知', '如果你看到这条通知并听到提示音，说明通知工作正常')
      }

      return h('div', { className: 'dtn-root' },
        h('h2', { className: 'dtn-heading' }, '通知'),
        h('section', { className: 'dtn-card' },
          h('div', { className: 'dtn-group' }, 'DeepSeek Harness'),
          h('div', { className: 'dtn-row' },
            h('div', { className: 'dtn-copy' },
              h('div', { className: 'dtn-title' }, '任务完成'),
              h('div', { className: 'dtn-desc' }, '接收有关 DSH 任务完成的通知（由 Host 直接发送 Windows 系统通知）。')),
            h(Switch, {
              checked: on,
              label: '接收任务完成通知',
              onChange: change,
            })),
          h('div', { className: 'dtn-actions' },
            h('button', {
              type: 'button',
              className: 'dtn-test',
              disabled: !on,
              onClick: test,
            }, '发送测试通知'))))
    }

    return {
      inject: ['sessions', 'slots', 'uiSession'],
      apply(ctx) {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-turn-notify'
        style.textContent = CSS
        document.head.append(style)
        ctx.effect(() => () => style.remove(), 'turn-notify: styles')

        primeAudio()
        ctx.effect(() => () => {
          void audioContext?.close()
          audioContext = undefined
          for (const item of live.values()) {
            try { item.close() } catch {}
          }
          live.clear()
        }, 'turn-notify: audio')

        const list = ctx.sessions.list
        // uiSession.sessionStatus is the UI's own running/completion projection:
        // it observes api-session/status directly, so it covers background
        // sessions even when the list snapshot would not change.
        const status = ctx.uiSession.sessionStatus
        const runningBefore = new Map()

        const seed = () => {
          for (const [id, state] of status.getSnapshot()) runningBefore.set(id, state.running === true)
        }

        const onChange = () => {
          const snapshot = status.getSnapshot()
          for (const [id, state] of snapshot) {
            const running = state.running === true
            const previous = runningBefore.get(id)
            runningBefore.set(id, running)
            if (previous !== true || running) continue
            const row = list.getSnapshot().byId[id]
            if (row === undefined || row.parentId !== undefined || row.blank === true) continue
            notify(`dsh-turn:${id}`, row.displayTitle ?? '会话已完成', '任务已完成 · 点击返回会话')
          }
          for (const id of [...runningBefore.keys()]) if (!snapshot.has(id)) runningBefore.delete(id)
        }

        seed()
        const unsubscribe = status.subscribe(onChange)
        ctx.effect(() => () => unsubscribe(), 'turn-notify: session status')

        const gesture = () => {
          primeAudio()
          void ask()
        }
        const options = { capture: true, passive: true }
        window.addEventListener('pointerdown', gesture, options)
        window.addEventListener('keydown', gesture, options)
        ctx.effect(() => () => {
          window.removeEventListener('pointerdown', gesture, true)
          window.removeEventListener('keydown', gesture, true)
        }, 'turn-notify: permission gesture')
        if (enabled) void ask()

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-turn-notify',
          order: 20,
          label: () => '通知',
        }, NotificationsPage))
      },
    }
  },
})

// Completion trigger: uiSession.sessionStatus running true -> false; toast goes through the Host.
