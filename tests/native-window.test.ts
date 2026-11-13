import { describe, expect, it } from 'vitest'
import {
  NativeWindowError,
  buildGrabArgs,
  buildXdotoolArgs,
  clampBounds,
  frameMime,
  frameTag,
  grabFrame,
  jpegQscale,
  parseDisplayEnv,
  readBrowserDisplay,
  sendNativeInput,
  type NativeExec,
} from '../src/worker/native-window.ts'

const bounds = { left: 10, top: 20, width: 1280, height: 900 }

describe('native window: display discovery', () => {
  it('reads DISPLAY and XAUTHORITY from a /proc environ blob', () => {
    expect(parseDisplayEnv('HOME=/root\0DISPLAY=:99\0XAUTHORITY=/tmp/xa\0')).toEqual({ DISPLAY: ':99', XAUTHORITY: '/tmp/xa' })
    expect(parseDisplayEnv('DISPLAY=:0.0\0')).toEqual({ DISPLAY: ':0.0' })
  })

  it('rejects a missing or malformed DISPLAY', () => {
    expect(parseDisplayEnv('HOME=/root\0')).toBeNull()
    expect(parseDisplayEnv('DISPLAY=\0')).toBeNull()
    expect(parseDisplayEnv('DISPLAY=:99 -i /etc/passwd\0')).toBeNull()
  })

  it('returns null for an unreadable process', async () => {
    expect(await readBrowserDisplay(0)).toBeNull()
    expect(await readBrowserDisplay(123, async () => { throw new Error('ENOENT') })).toBeNull()
    expect(await readBrowserDisplay(123, async () => 'DISPLAY=:7\0')).toEqual({ DISPLAY: ':7' })
  })

  it('falls back to child processes when the main process environ is empty', async () => {
    const files: Record<string, string> = {
      '/proc/100/environ': '',
      '/proc/100/task/100/children': '101 102 ',
      '/proc/101/environ': 'HOME=/root\0',
      '/proc/102/environ': 'DISPLAY=:99\0',
    }
    const read = async (path: string): Promise<string> => {
      if (path in files) return files[path]!
      throw new Error('ENOENT')
    }
    expect(await readBrowserDisplay(100, read)).toEqual({ DISPLAY: ':99' })
    expect(await readBrowserDisplay(101, read)).toBeNull()
  })
})

describe('native window: geometry', () => {
  it('clamps to the screen and keeps even dimensions', () => {
    expect(clampBounds({ left: 0, top: 0, width: 1281, height: 901 }, null)).toEqual({ left: 0, top: 0, width: 1280, height: 900 })
    expect(clampBounds({ left: 1000, top: 800, width: 1280, height: 900 }, { width: 1600, height: 1200 })).toEqual({ left: 1000, top: 800, width: 600, height: 400 })
    expect(clampBounds({ left: -50, top: -10, width: 300, height: 200 }, { width: 1600, height: 1200 })).toEqual({ left: 0, top: 0, width: 250, height: 190 })
  })

  it('returns null when the window is off-screen', () => {
    expect(clampBounds({ left: 2000, top: 0, width: 800, height: 600 }, { width: 1600, height: 1200 })).toBeNull()
  })

  it('builds a one-frame x11grab command for the window region', () => {
    const args = buildGrabArgs({ display: ':99', bounds, maxWidth: 1280 })
    expect(args).toContain('-nostdin')
    expect(args.slice(args.indexOf('-video_size'), args.indexOf('-video_size') + 4)).toEqual(['-video_size', '1280x900', '-i', ':99+10,20'])
    expect(args).not.toContain('-vf')
    expect(args.slice(-5)).toEqual(['-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'])
  })

  it('defaults to the low-bandwidth frame size and quality', () => {
    const args = buildGrabArgs({ display: ':99', bounds })
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=960:-2')
    expect(args[args.indexOf('-q:v') + 1]).toBe('14')
  })

  it('maps 1-100 quality onto the ffmpeg scale and switches to PNG at 100', () => {
    expect([1, 30, 60, 99].map(jpegQscale)).toEqual([31, 23, 14, 2])
    expect(frameMime(99)).toBe('image/jpeg')
    expect(frameMime(100)).toBe('image/png')
    const png = buildGrabArgs({ display: ':99', bounds, maxWidth: 1920, quality: 100 })
    expect(png).not.toContain('-q:v')
    expect(png).not.toContain('-vf')
    expect(png.slice(-5)).toEqual(['-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'])
    const best = buildGrabArgs({ display: ':99', bounds, maxWidth: 1920, quality: 99 })
    expect(best[best.indexOf('-q:v') + 1]).toBe('2')
  })

  it('tags identical frames identically so the panel can skip them', () => {
    const a = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
    expect(frameTag(a)).toBe(frameTag(Buffer.from(a)))
    expect(frameTag(a)).not.toBe(frameTag(Buffer.from([0xff, 0xd8, 1, 2, 4, 0xff, 0xd9])))
    expect(frameTag(a)).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  it('downscales only when the window is wider than maxWidth', () => {
    const args = buildGrabArgs({ display: ':99', bounds, maxWidth: 641 })
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=640:-2')
  })
})

describe('native window: input translation', () => {
  it('maps window-relative clicks to absolute screen coordinates', () => {
    expect(buildXdotoolArgs({ type: 'click', x: 100, y: 50 }, bounds)).toEqual(['mousemove', '110', '70', 'click', '--repeat', '1', '1'])
    expect(buildXdotoolArgs({ type: 'click', x: 0, y: 0, button: 3, count: 2 }, bounds)).toEqual(['mousemove', '10', '20', 'click', '--repeat', '2', '3'])
    expect(buildXdotoolArgs({ type: 'move', x: 1.4, y: 2.6 }, bounds)).toEqual(['mousemove', '11', '23'])
  })

  it('turns wheel deltas into bounded button 4/5 repeats', () => {
    expect(buildXdotoolArgs({ type: 'wheel', x: 5, y: 5, deltaY: 250 }, bounds)).toEqual(['mousemove', '15', '25', 'click', '--repeat', '3', '5'])
    expect(buildXdotoolArgs({ type: 'wheel', x: 5, y: 5, deltaY: -30 }, bounds)).toEqual(['mousemove', '15', '25', 'click', '--repeat', '1', '4'])
    expect(buildXdotoolArgs({ type: 'wheel', x: 5, y: 5, deltaY: 99999 }, bounds)?.[5]).toBe('10')
    expect(buildXdotoolArgs({ type: 'wheel', x: 5, y: 5, deltaY: 0 }, bounds)).toBeNull()
  })

  it('rejects points outside the window and non-numeric coordinates', () => {
    expect(buildXdotoolArgs({ type: 'click', x: -1, y: 5 }, bounds)).toBeNull()
    expect(buildXdotoolArgs({ type: 'click', x: 5, y: 901 }, bounds)).toBeNull()
    expect(buildXdotoolArgs({ type: 'click', x: '5', y: 5 }, bounds)).toBeNull()
    expect(buildXdotoolArgs({ type: 'click', x: Number.NaN, y: 5 }, bounds)).toBeNull()
  })

  it('types text after "--" so it can never be read as an option', () => {
    expect(buildXdotoolArgs({ type: 'text', text: '--help' }, bounds)).toEqual(['type', '--delay', '0', '--', '--help'])
    expect(buildXdotoolArgs({ type: 'text', text: '' }, bounds)).toBeNull()
    expect(buildXdotoolArgs({ type: 'text', text: 'x'.repeat(501) }, bounds)).toBeNull()
  })

  it('only sends allow-listed keys', () => {
    expect(buildXdotoolArgs({ type: 'key', key: 'Enter' }, bounds)).toEqual(['key', '--', 'Return'])
    expect(buildXdotoolArgs({ type: 'key', key: 'Escape' }, bounds)).toEqual(['key', '--', 'Escape'])
    expect(buildXdotoolArgs({ type: 'key', key: 'ctrl+alt+Delete' }, bounds)).toBeNull()
    expect(buildXdotoolArgs({ type: 'key', key: 'constructor' }, bounds)).toBeNull()
    expect(buildXdotoolArgs({ type: 'exec', command: 'rm -rf /' }, bounds)).toBeNull()
  })
})

describe('native window: process calls', () => {
  const env = { DISPLAY: ':99' }

  it('runs xdotool with the browser display and an argv, never a shell string', async () => {
    const calls: Array<{ command: string; args: readonly string[]; display: unknown }> = []
    const run: NativeExec = async (command, args, options) => {
      calls.push({ command, args, display: (options.env as NodeJS.ProcessEnv).DISPLAY })
      return { stdout: '' }
    }
    await sendNativeInput({ env, bounds, event: { type: 'click', x: 1, y: 1 }, run })
    expect(calls).toEqual([{ command: 'xdotool', args: ['mousemove', '11', '21', 'click', '--repeat', '1', '1'], display: ':99' }])
  })

  it('reports invalid events and missing tools with a code', async () => {
    const never: NativeExec = async () => { throw new Error('must not run') }
    await expect(sendNativeInput({ env, bounds, event: { type: 'nope' }, run: never })).rejects.toMatchObject({ code: 'native-input-invalid' })
    const enoent: NativeExec = async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }
    await expect(sendNativeInput({ env, bounds, event: { type: 'move', x: 1, y: 1 }, run: enoent })).rejects.toMatchObject({ code: 'native-xdotool-missing' })
    await expect(grabFrame({ env, bounds, run: enoent })).rejects.toMatchObject({ code: 'native-ffmpeg-missing' })
  })

  it('returns the grabbed image and rejects an empty one', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    expect(await grabFrame({ env, bounds, run: async () => ({ stdout: jpeg }) })).toEqual(jpeg)
    const error = await grabFrame({ env, bounds, run: async () => ({ stdout: Buffer.alloc(0) }) }).catch((e) => e)
    expect(error).toBeInstanceOf(NativeWindowError)
    expect(error.code).toBe('native-grab-empty')
  })
})
