/**
 * Full-window ("native") mode for the watch panel — Linux/X11 only.
 *
 * The CDP screencast and CDP input only reach the page layer, so browser-native
 * UI (external-protocol prompts, permission bubbles, the omnibox…) is invisible
 * in the panel and cannot be clicked, yet a tab-modal prompt makes Chrome drop
 * every CDP input for that tab. On a remote host the "pop out window" escape
 * hatch lands on a virtual display nobody can see.
 *
 * This module grabs the browser's X11 window region as a JPEG and injects
 * X-level input with xdotool, so the panel can show and operate the whole
 * window. It is a low-frame-rate takeover path, not a replacement for the
 * screencast backends.
 */
import { execFile as nodeExecFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFile = promisify(nodeExecFile)

export interface NativeBounds {
  left: number
  top: number
  width: number
  height: number
}

export interface NativeDisplayEnv {
  DISPLAY: string
  XAUTHORITY?: string
}

export type NativeInputEvent = Record<string, unknown>

export class NativeWindowError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** X keysyms the panel may send. Anything else is rejected, never passed through. */
export const NATIVE_KEYS: Record<string, string> = {
  Enter: 'Return', Escape: 'Escape', Tab: 'Tab', Backspace: 'BackSpace', Delete: 'Delete',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'Page_Up', PageDown: 'Page_Down', ' ': 'space',
}

export const NATIVE_TEXT_MAX = 500

/** Parse DISPLAY / XAUTHORITY out of a NUL-separated /proc/<pid>/environ blob. */
export function parseDisplayEnv(environ: string): NativeDisplayEnv | null {
  let display = ''
  let xauthority = ''
  for (const entry of environ.split('\0')) {
    if (entry.startsWith('DISPLAY=')) display = entry.slice(8)
    else if (entry.startsWith('XAUTHORITY=')) xauthority = entry.slice(11)
  }
  if (!/^[A-Za-z0-9.:_-]*:\d+(\.\d+)?$/.test(display)) return null
  return xauthority ? { DISPLAY: display, XAUTHORITY: xauthority } : { DISPLAY: display }
}

/**
 * The display the browser draws into — the worker itself usually has no DISPLAY.
 * Chrome's main process may rewrite its own environ area (it then reads back
 * empty), so fall back to its direct children, which keep the inherited value.
 */
export async function readBrowserDisplay(pid: number, read: (path: string) => Promise<string> = (path) => readFile(path, 'utf8')): Promise<NativeDisplayEnv | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const own = await read(`/proc/${pid}/environ`).then(parseDisplayEnv, () => null)
  if (own) return own
  const children = await read(`/proc/${pid}/task/${pid}/children`).then((text) => text.trim().split(/\s+/).filter((entry) => /^\d+$/.test(entry)), () => [] as string[])
  for (const child of children.slice(0, 16)) {
    const env = await read(`/proc/${child}/environ`).then(parseDisplayEnv, () => null)
    if (env) return env
  }
  return null
}

/** Clamp window bounds to the screen: x11grab refuses a region that leaves it. */
export function clampBounds(bounds: NativeBounds, screen: { width: number; height: number } | null): NativeBounds | null {
  const left = Math.max(0, Math.round(bounds.left))
  const top = Math.max(0, Math.round(bounds.top))
  let right = Math.round(bounds.left + bounds.width)
  let bottom = Math.round(bounds.top + bounds.height)
  if (screen) {
    right = Math.min(right, screen.width)
    bottom = Math.min(bottom, screen.height)
  }
  // x11grab + mjpeg want even dimensions.
  const width = Math.floor((right - left) / 2) * 2
  const height = Math.floor((bottom - top) / 2) * 2
  if (!(width >= 2 && height >= 2)) return null
  return { left, top, width, height }
}

export function buildGrabArgs({ display, bounds, maxWidth = 1280, quality = 6 }: { display: string; bounds: NativeBounds; maxWidth?: number; quality?: number }): string[] {
  const args = [
    '-nostdin', '-loglevel', 'error',
    '-f', 'x11grab', '-draw_mouse', '1',
    '-video_size', `${bounds.width}x${bounds.height}`,
    '-i', `${display}+${bounds.left},${bounds.top}`,
    '-frames:v', '1',
  ]
  const width = Math.max(2, Math.floor(maxWidth / 2) * 2)
  if (width < bounds.width) args.push('-vf', `scale=${width}:-2`)
  args.push('-q:v', String(Math.min(31, Math.max(2, Math.round(quality)))), '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1')
  return args
}

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * Translate a panel event into an xdotool argv (never a shell string). x/y are
 * window-relative pixels; anything outside the window, or any event type or key
 * not listed here, yields null so the caller answers 400.
 */
export function buildXdotoolArgs(event: NativeInputEvent, bounds: NativeBounds): string[] | null {
  const type = event.type
  if (type === 'text') {
    const text = typeof event.text === 'string' ? event.text : ''
    if (text === '' || text.length > NATIVE_TEXT_MAX) return null
    return ['type', '--delay', '0', '--', text]
  }
  if (type === 'key') {
    const keysym = typeof event.key === 'string' && Object.hasOwn(NATIVE_KEYS, event.key) ? NATIVE_KEYS[event.key] : null
    return keysym ? ['key', '--', keysym] : null
  }
  const x = finite(event.x)
  const y = finite(event.y)
  if (x === null || y === null || x < 0 || y < 0 || x > bounds.width || y > bounds.height) return null
  const move = ['mousemove', String(Math.round(bounds.left + x)), String(Math.round(bounds.top + y))]
  if (type === 'move') return move
  if (type === 'click') {
    const button = event.button === 3 ? '3' : '1'
    const count = event.count === 2 ? '2' : '1'
    return [...move, 'click', '--repeat', count, button]
  }
  if (type === 'wheel') {
    const deltaY = finite(event.deltaY)
    if (deltaY === null || deltaY === 0) return null
    const steps = Math.min(10, Math.max(1, Math.round(Math.abs(deltaY) / 100)))
    return [...move, 'click', '--repeat', String(steps), deltaY > 0 ? '5' : '4']
  }
  return null
}

export type NativeExec = (command: string, args: readonly string[], options: Record<string, unknown>) => Promise<{ stdout: string | Buffer }>

const defaultExec = execFile as unknown as NativeExec

function childEnv(env: NativeDisplayEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...env }
}

function missingTool(error: unknown, tool: string): NativeWindowError | null {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
    ? new NativeWindowError(`native-${tool}-missing`, `${tool} is not installed on the host`)
    : null
}

export async function screenSize(env: NativeDisplayEnv, run: NativeExec = defaultExec): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await run('xdotool', ['getdisplaygeometry'], { env: childEnv(env), timeout: 3000, encoding: 'utf8' })
    const match = /^(\d+)\s+(\d+)/.exec(String(stdout).trim())
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null
  } catch (error) {
    const missing = missingTool(error, 'xdotool')
    if (missing) throw missing
    return null
  }
}

export async function grabFrame({ env, bounds, ffmpegPath = 'ffmpeg', maxWidth, quality, run = defaultExec }: {
  env: NativeDisplayEnv
  bounds: NativeBounds
  ffmpegPath?: string
  maxWidth?: number
  quality?: number
  run?: NativeExec
}): Promise<Buffer> {
  try {
    const { stdout } = await run(ffmpegPath || 'ffmpeg', buildGrabArgs({ display: env.DISPLAY, bounds, maxWidth, quality }), {
      env: childEnv(env), timeout: 6000, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024,
    })
    const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
    if (buffer.length < 4) throw new NativeWindowError('native-grab-empty', 'screen grab returned no image')
    return buffer
  } catch (error) {
    if (error instanceof NativeWindowError) throw error
    throw missingTool(error, 'ffmpeg') ?? new NativeWindowError('native-grab-failed', String((error as Error)?.message || error).slice(0, 300))
  }
}

export async function sendNativeInput({ env, bounds, event, run = defaultExec }: {
  env: NativeDisplayEnv
  bounds: NativeBounds
  event: NativeInputEvent
  run?: NativeExec
}): Promise<void> {
  const args = buildXdotoolArgs(event, bounds)
  if (!args) throw new NativeWindowError('native-input-invalid', 'unsupported or out-of-window input event')
  try {
    await run('xdotool', args, { env: childEnv(env), timeout: 4000, encoding: 'utf8' })
  } catch (error) {
    throw missingTool(error, 'xdotool') ?? new NativeWindowError('native-input-failed', String((error as Error)?.message || error).slice(0, 300))
  }
}
