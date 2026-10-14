import { getVersion } from '@tauri-apps/api/app'
import { getCurrentWindow, LogicalSize, PhysicalPosition } from '@tauri-apps/api/window'

const STATE_KEY = 'desktop.window'
const SAVE_DELAY_MS = 400

interface WindowState {
  width: number
  height: number
  x: number
  y: number
}

/** True inside the Tauri webview; false when the same code runs in a browser. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** The version comes from tauri.conf.json, which is what the bundles are built from. */
export async function appVersion(): Promise<string | null> {
  if (!isDesktop()) return null
  try {
    return await getVersion()
  } catch {
    return null
  }
}

/**
 * Reopens the window where the teacher left it. Tauri only remembers geometry
 * if the config asks it to, and that would also pin the size across displays
 * with different scaling, so the state is ours: applied once at startup, then
 * written back (debounced) whenever the window is moved or resized.
 */
export async function restoreWindowState(): Promise<void> {
  if (!isDesktop()) return
  const saved = readState()
  if (!saved) return

  const appWindow = getCurrentWindow()
  try {
    await appWindow.setSize(new LogicalSize(saved.width, saved.height))
    await appWindow.setPosition(new PhysicalPosition(saved.x, saved.y))
  } catch {
    // A monitor that is gone since last time: keep the default geometry.
  }
}

export async function watchWindowState(): Promise<void> {
  if (!isDesktop()) return
  const appWindow = getCurrentWindow()

  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void persist(), SAVE_DELAY_MS)
  }

  const persist = async () => {
    try {
      const size = await appWindow.outerSize()
      const position = await appWindow.outerPosition()
      writeState({
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
      })
    } catch {
      // The window is going away; nothing worth saving.
    }
  }

  await appWindow.onResized(save)
  await appWindow.onMoved(save)
}

const DECORATIONS_KEY = 'desktop.decorations'

/**
 * Whether the window keeps its system title bar.
 *
 * The bar is where minimize, maximize and close live, so turning it off takes
 * those buttons with it - that is what the setting is for, not a side effect of
 * it. The choice is stored rather than held in memory because it has to survive
 * a restart, and it is read here so the menu and the window agree on it.
 *
 * Nothing stored means the bar is on: the window opens the way it was built.
 */
export function readDecorations(): boolean {
  try {
    return localStorage.getItem(DECORATIONS_KEY) !== 'off'
  } catch {
    return true
  }
}

/** Turns the system title bar on or off and remembers the choice. */
export async function setDecorations(on: boolean): Promise<void> {
  try {
    localStorage.setItem(DECORATIONS_KEY, on ? 'on' : 'off')
  } catch {
    // Private mode or a full quota: the choice still applies for this run.
  }
  if (!isDesktop()) return
  try {
    await getCurrentWindow().setDecorations(on)
  } catch {
    // A platform that refuses - Wayland and some tiling compositors do - keeps
    // its bar. The app must not break over a bar it could not remove.
  }
}

/** Applied at startup, so the window opens the way it was left. */
export async function restoreDecorations(): Promise<void> {
  if (!isDesktop()) return
  try {
    await getCurrentWindow().setDecorations(readDecorations())
  } catch {
    // Same as above: a refusal leaves the built-in bar in place.
  }
}

function readState(): WindowState | null {
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<WindowState>
    const { width, height, x, y } = parsed
    if (
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      typeof x !== 'number' ||
      typeof y !== 'number'
    ) {
      return null
    }
    return { width, height, x, y }
  } catch {
    return null
  }
}

function writeState(state: WindowState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state))
  } catch {
    // Private mode or a full quota: the window just opens at the default size.
  }
}
/**
 * The server the app hosts.
 *
 * Every function here returns `null` in a browser, because the same source tree
 * is served as a web client where there is no sidecar to start and no settings
 * file to keep. That is what lets the shared components ask about the server
 * without branching on which app they are running in.
 */
export interface HostSettings {
  port: number
  dataDir: string
  teacherPassword: string
  webRoot: string
  binaryPath: string
}

export interface ServerStatus {
  running: boolean
  pid: number | null
  port: number
  startedAt: number | null
  uptimeMs: number | null
  exitCode: number | null
  binaryPath: string | null
  /** Every path the app looked for the binary in, when it found none. */
  searched: string[]
  error: string | null
  /**
   * Whether this app started the process. False on a server that was already
   * listening when the window opened: adopted rather than owned, which is the
   * difference between "stop" meaning kill our own child and meaning kill a
   * process somebody else launched.
   */
  managed: boolean
  /** The pid of an adopted server; set only while running and not managed. */
  externalPid: number | null
}

export interface ServerLogLine {
  raw: string
  /** pino's message; `raw` is the whole line, for a panic or a runtime warning. */
  msg: string
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  /** Epoch millis; formatted by the view, so no date handling here. */
  atMs: number
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isDesktop()) return null
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    return (await invoke<T>(command, args)) ?? null
  } catch (error) {
    // A missing command means an older binary behind a newer webview: reported
    // as "not available" rather than crashing the screen that asked.
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export function getHostSettings(): Promise<HostSettings | null> {
  return call<HostSettings>('host_settings')
}

export function saveHostSettings(settings: HostSettings): Promise<HostSettings | null> {
  return call<HostSettings>('save_host_settings', { settings })
}

export function getServerStatus(): Promise<ServerStatus | null> {
  return call<ServerStatus>('server_status')
}

export function startServer(): Promise<ServerStatus | null> {
  return call<ServerStatus>('start_server')
}

export function stopServer(): Promise<ServerStatus | null> {
  return call<ServerStatus>('stop_server')
}

/**
 * Looks for a server already on the port and takes it over if it finds one.
 *
 * Called before the window offers to start anything: a machine with the server
 * on autostart, or one where a teacher ran it from a terminal, is an ordinary
 * way to meet this app, and "start the server" over a port somebody is serving
 * fails on the one click nobody reads.
 */
export function adoptExternalServer(): Promise<ServerStatus | null> {
  return call<ServerStatus>('adopt_external_server')
}

export function restartServer(): Promise<ServerStatus | null> {
  return call<ServerStatus>('restart_server')
}

/** One line of the server's output, as it was written. */
export async function onServerLog(
  handler: (line: ServerLogLine) => void,
): Promise<() => void> {
  if (!isDesktop()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<ServerLogLine>('server-log', (event) => handler(event.payload))
  return unlisten
}

/** The server exited on its own: a crash, a taken port. The code is the clue. */
export async function onServerExit(handler: (code: number | null) => void): Promise<() => void> {
  if (!isDesktop()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<number | null>('server-exit', (event) => handler(event.payload))
  return unlisten
}


export interface SaveFilter {
  name: string
  extensions: string[]
}

/**
 * The system save dialog, when there is one to show.
 *
 * Returns the chosen path, or null where the platform has no such dialog - on
 * the web the browser picks its own way and the caller falls back to it. One
 * dialog settles both questions at once: the filters are the formats, and the
 * extension that comes back is the format that was chosen.
 */
export async function nativeSavePath(input: {
  defaultName: string
  filters: SaveFilter[]
}): Promise<string | null> {
  if (!isDesktop()) return null
  const { save } = await import('@tauri-apps/plugin-dialog')
  return await save({ defaultPath: input.defaultName, filters: input.filters })
}

/** Writes the bytes the teacher just chose a home for. */
export async function nativeWrite(path: string, bytes: Uint8Array): Promise<void> {
  if (!isDesktop()) return
  const { writeFile } = await import('@tauri-apps/plugin-fs')
  await writeFile(path, bytes)
}
