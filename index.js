/**
 * DWG / DXF sidebar preview - host half.
 *
 * Registers two read-only routes on the connection's shared /api channel:
 *
 *   GET  /api/dwg-preview/ping  - liveness probe (is the plugin mounted?)
 *   POST /api/dwg-preview/svg   - DWG or DXF bytes in, renderable SVG out
 *
 * The DWG is decoded by LibreDWG compiled to WebAssembly (@mlightcad/libredwg-web),
 * which runs inside this host process; the resulting DXF is turned into SVG by the
 * local, dependency-free renderer in ./lib/dxf2svg.mjs. Nothing is written to disk
 * and no external converter is required.
 *
 * @module @local/dsh-dwg-preview
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { dxfToSvg } from './lib/dxf2svg.mjs'

/** Plugin name; also the bundle row id in cordis.patch.yml. */
export const name = 'dsh-dwg-preview'

/** The connection service owns the /api channel these routes register on. */
export const inject = ['connection']

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/** Upper bound for a preview request body (bytes). */
const MAX_BYTES = 64 * 1024 * 1024

/** How many rendered drawings stay cached. */
const CACHE_LIMIT = 6

/** sha1 -> { kind, svg, stats } */
const cache = new Map()

/**
 * Locate the LibreDWG wasm directory inside the installed package.
 * @returns {string} directory ending in a separator, as emscripten expects.
 */
function wasmDirectory() {
  const entry = require.resolve('@mlightcad/libredwg-web')
  return path.join(path.dirname(entry), '..', 'wasm') + path.sep
}

/** Lazily instantiated LibreDWG module (its wasm is ~9.5 MB, so build it once). */
let enginePromise
function engine() {
  if (enginePromise === undefined) {
    enginePromise = import('@mlightcad/libredwg-web').then((mod) => mod.LibreDwg.create(wasmDirectory()))
  }
  return enginePromise
}

/**
 * Decide what the bytes are from their content, not from the file name.
 * @param {Buffer} buf
 * @returns {'dwg' | 'dxf' | 'unknown'}
 */
function sniff(buf) {
  const head = buf.subarray(0, 8).toString('latin1')
  if (/^AC10\d\d/.test(head)) return 'dwg'
  const text = buf.subarray(0, 8192).toString('utf8')
  if (text.includes('SECTION') && (text.includes('HEADER') || text.includes('ENTITIES'))) return 'dxf'
  return 'unknown'
}

/**
 * Convert DWG/DXF bytes into a single renderable SVG document.
 * @param {Buffer} buf raw file bytes.
 * @returns {Promise<{ kind: string, svg: string, stats: object }>}
 */
async function render(buf) {
  const kind = sniff(buf)
  let dxfText
  if (kind === 'dwg') {
    const libredwg = await engine()
    const view = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const out = libredwg.dwg_write_dxf(view)
    if (out === null || out === undefined || out.length === 0) {
      throw new Error('LibreDWG 无法解析这个 DWG（版本过旧或不支持的对象）')
    }
    dxfText = Buffer.from(out).toString('utf8')
  } else if (kind === 'dxf') {
    dxfText = buf.toString('utf8')
  } else {
    throw new Error('无法识别的文件内容：既不是 DWG（缺少 AC10xx 头）也不是 DXF')
  }
  const rendered = dxfToSvg(dxfText, { bg: '#ffffff', mono: false })
  return { kind, svg: rendered.svg, stats: rendered.stats }
}

/**
 * JSON response helper.
 * @param {unknown} payload
 * @param {number} [status]
 * @returns {Response}
 */
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Handler for POST /api/dwg-preview/svg.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleSvg(request) {
  try {
    const buf = Buffer.from(await request.arrayBuffer())
    if (buf.length === 0) return json({ ok: false, code: 'EMPTY', message: '文件内容为空' }, 400)
    if (buf.length > MAX_BYTES) return json({ ok: false, code: 'TOO_LARGE', message: '文件超过 64 MB，预览已跳过' }, 413)
    const key = crypto.createHash('sha1').update(buf).digest('hex')
    let entry = cache.get(key)
    if (entry === undefined) {
      entry = await render(buf)
      cache.set(key, entry)
      while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next()
        if (oldest.done === true) break
        cache.delete(oldest.value)
      }
    }
    return json({ ok: true, kind: entry.kind, svg: entry.svg, stats: entry.stats })
  } catch (error) {
    return json({ ok: false, code: 'FAILED', message: String((error && error.message) || error) }, 500)
  }
}

/**
 * Mount the plugin's routes.
 * @param {any} ctx plugin context.
 */
export function apply(ctx) {
  try {
    fs.appendFileSync(path.join(here, '.mount.log'), new Date().toISOString() + '\n')
  } catch (error) {
    /* the marker is only a diagnostic; never let it break mounting */
  }
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/dwg-preview/ping',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => json({ ok: true, plugin: name, cache: cache.size }),
      }),
    'dsh-dwg-preview: ping route',
  )
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/dwg-preview/svg',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleSvg(request),
      }),
    'dsh-dwg-preview: svg route',
  )
}
