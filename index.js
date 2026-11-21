/**
 * Host half of Turn Beacon.
 *
 * Reads the Windows system media session (GSMTC) through Windows PowerShell,
 * which is where a WinRT session can be queried from this profile. One
 * long-lived watcher emits a line whenever playback changes; the Client half
 * reads it from a small local read-only route. No media is played, controlled,
 * uploaded or recorded.
 */
import { spawn } from 'node:child_process'

const MEDIA_ROUTE = '/api/turn-beacon/media'
const RESTART_MS = 4000

/** Prints `1|<app id>` or `0|<app id>` whenever the active media session changes. */
const WATCH = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$op = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]::RequestAsync()
$ext = [System.WindowsRuntimeSystemExtensions]
$method = $ext.GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
$gm = $method.MakeGenericMethod([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$task = $gm.Invoke($null, @($op))
$manager = $task.GetAwaiter().GetResult()
$last = ''
while ($true) {
  $line = '0|'
  $session = $manager.GetCurrentSession()
  if ($null -ne $session) {
    $info = $session.GetPlaybackInfo()
    $flag = '0'
    if ($info.PlaybackStatus -eq 4) { $flag = '1' }
    $line = $flag + '|' + $session.SourceAppUserModelId
  }
  if ($line -ne $last) { Write-Output $line; $last = $line }
  Start-Sleep -Milliseconds 900
}
`

function powershellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

export const inject = ['webServer']

export function apply(ctx) {
  let state = { playing: false, app: '', available: false }
  let child = null
  let restartTimer = null
  let disposed = false

  function startWatcher() {
    if (disposed || process.platform !== 'win32') return
    let buffer = ''
    try {
      child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', WATCH], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      child.stdout.on('data', chunk => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          const text = line.trim()
          if (!text) continue
          const separator = text.indexOf('|')
          const flag = separator === -1 ? text : text.slice(0, separator)
          const app = separator === -1 ? '' : text.slice(separator + 1)
          state = { playing: flag === '1', app, available: true }
        }
      })
      child.on('close', () => {
        child = null
        state = { playing: false, app: '', available: false }
        if (!disposed) restartTimer = setTimeout(startWatcher, RESTART_MS)
      })
      child.on('error', () => { /* close handler restarts */ })
    } catch {
      state = { playing: false, app: '', available: false }
      if (!disposed) restartTimer = setTimeout(startWatcher, RESTART_MS)
    }
  }

  ctx.effect(() => {
    startWatcher()
    return () => {
      disposed = true
      if (restartTimer) clearTimeout(restartTimer)
      if (child) child.kill()
      child = null
    }
  }, 'turn-beacon: system media watcher')

  if (ctx.webServer) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: MEDIA_ROUTE,
      handler(req, res) {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(state))
      },
    }), `turn-beacon: GET ${MEDIA_ROUTE}`)
  }
}
