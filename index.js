import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'turn-notify'
export const inject = ['webServer']

const AUMID = 'electron.app.DeepSeek Harness'
const PREFIX = '/dsh-turn-notify'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** Escape text inserted into the Toast XML. */
function xml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[char]))
}

/**
 * Show a native Windows toast through PowerShell's WinRT projection. The
 * renderer Notification API is bound to a random loopback port and loses its
 * permission on every restart; the host process can always post a real toast.
 */
function showToast(title, body) {
  const document = `<toast><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>`
  const encodedDocument = Buffer.from(document, 'utf8').toString('base64')
  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null
$document = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDocument}'))
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml($document)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}').Show($toast)
`
  const file = join(tmpdir(), `dsh-turn-notify-${randomUUID()}.ps1`)
  writeFileSync(file, `${script}
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
`, 'utf8')
  const child = spawn(POWERSHELL, [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    file,
  ], {
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('exit', () => {})
}

function isLocal(req) {
  const host = String(req.headers?.host ?? '').replace(/:\d+$/, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

export function apply(ctx) {
  const handler = async (req, res) => {
    try {
      if (!isLocal(req)) {
        res.writeHead(403)
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      if (new URL(req.url ?? '/', 'http://dsh.local').pathname !== `${PREFIX}/notify`) {
        res.writeHead(404)
        res.end()
        return
      }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const title = typeof payload?.title === 'string' ? payload.title.slice(0, 120) : '任务完成'
      const body = typeof payload?.body === 'string' ? payload.body.slice(0, 300) : '会话已完成'
      showToast(title, body)
      res.writeHead(204)
      res.end()
    } catch (error) {
      ctx.logger?.warn?.(error)
      res.writeHead(500)
      res.end()
    }
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }),
    'turn-notify: toast api',
  )
}
