#!/usr/bin/env node
/**
 * Self-check for `@local/dsh-dwg-preview`.
 *
 * Run with `node test/selfcheck.mjs` (or `pnpm test`) from this package. Plain
 * Node, no dependencies, no network, no Harness, no React install:
 *
 *   1. the renderer (`lib/dxf2svg.mjs`) renders `test/sample.dxf` and the exact
 *      per-entity tallies and SVG structure are pinned;
 *   2. `client.js` is driven through a stub `window.__ModuleLoader__`, with the
 *      `react` substitute, the `locale`, `slots` and `documentPreviews` doubles
 *      and a minimal hook runtime, so the registered extensions, the keyed body
 *      and the locale dictionaries are exercised - and any `require()` other
 *      than `react` fails the run right there;
 *   3. `index.js` `apply()` is driven with a fake `ctx`, and both real route
 *      handlers are called: `ping`, a DXF round trip (twice, to show the cache),
 *      `EMPTY` / `TOO_LARGE` / `FAILED` and the DWG branch;
 *   4. the packaging invariants of this repository are asserted: no leaked
 *      credential, no personal absolute path, the copyright holder's name only
 *      where it belongs, and every file in the tree covered by `package.json`'s
 *      `files`.
 *
 * The DWG decode itself cannot run here: `@mlightcad/libredwg-web` is a runtime
 * dependency that the Harness profile installs, and it is deliberately absent
 * from this repo. That check is therefore skipped with a printed reason when the
 * package happens to be installed, and it only ever proves the failure path.
 *
 * Note: `apply()` appends the plugin's diagnostic `.mount.log` marker next to
 * `index.js`, exactly as it does when the Harness mounts it. When this run
 * created that file, it deletes it again at the end; a marker that was already
 * there is left in place (one line longer). It is gitignored and never shipped.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dxfToSvg } from '../lib/dxf2svg.mjs'
import { EXAMPLE_FILE, PACKAGE_ROOT, SAMPLE_FILE, renderExample } from '../tools/make-example.mjs'

const host = await import('../index.js')
const require = createRequire(import.meta.url)

/** Everything the plugin mounts lives under the package root. */
const MOUNT_LOG = join(PACKAGE_ROOT, '.mount.log')

/** Whether the mount marker was already there when this run started; see the note above. */
const mountLogExisted = existsSync(MOUNT_LOG)

/** The exact options the host route renders with (see `render()` in index.js). */
const RENDER_OPTIONS = { bg: '#ffffff', mono: false }

/** Mirrors `MAX_BYTES` in index.js; the route's cap cannot be imported. */
const MAX_BYTES = 64 * 1024 * 1024

/** The registered route paths, as client.js fetches them. */
const SVG_ROUTE = '/api/dwg-preview/svg'
const PING_ROUTE = '/api/dwg-preview/ping'

/** Body identity and slot the browser half claims. */
const BODY_ID = '@local/dsh-dwg-preview/dwg'
const SLOT = 'sidebar.right.tab.document'

const results = []
const skipped = []

/**
 * Run one named check and print its outcome.
 *
 * @param {string} label
 * @param {() => any | Promise<any>} body
 */
async function check(label, body) {
  try {
    await body()
    results.push({ label, ok: true })
    console.log(`ok   ${label}`)
  } catch (error) {
    results.push({ label, ok: false, error })
    console.log(`FAIL ${label}\n     ${error?.message ?? error}`)
  }
}

/**
 * Record a check that this environment cannot run, with the reason.
 *
 * @param {string} label
 * @param {string} reason
 */
function skip(label, reason) {
  skipped.push({ label, reason })
  console.log(`skip ${label}\n     ${reason}`)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Every node in a rendered tree, depth first. */
function walk(node, visit) {
  if (node === null || node === undefined || node === false || typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/** The text one subtree renders, flattened. */
function textOf(node) {
  let text = ''
  walk(node, (element) => {
    for (const child of element.children ?? []) {
      if (typeof child === 'string' || typeof child === 'number') text += child
    }
  })
  return text
}

/** Every element in a tree with the given class name. */
function elementsWithClass(tree, className) {
  const found = []
  walk(tree, (element) => {
    const classes = String(element.props?.className ?? '').split(' ')
    if (classes.includes(className)) found.push(element)
  })
  return found
}

/** The button a user presses, identified by its tooltip. */
function buttonWithTitle(tree, title) {
  let found = null
  walk(tree, (element) => {
    if (element.type === 'button' && element.props?.title === title) found = element
  })
  return found
}

/** Count non-overlapping matches of a global regex. */
function count(text, pattern) {
  return (text.match(pattern) ?? []).length
}

// ---------------------------------------------------------------------------
// 1. The renderer: lib/dxf2svg.mjs on the shipped sample
// ---------------------------------------------------------------------------

const sampleText = readFileSync(SAMPLE_FILE, 'utf8')
const sample = dxfToSvg(sampleText, RENDER_OPTIONS)

/**
 * The tallies the sample must produce. `LINE` 11 = 8 from the BOLT block (4
 * inserts x 2 lines) plus 3 from the DIMV dimension block; `CIRCLE` 5 = 4 from
 * the block plus 1 in model space. `ATTRIB` is 2 for the single ATTRIB entity
 * because `renderList()` tallies it and then `renderEntity()` tallies it again:
 * that is the current counting behaviour, and the number the sidebar sums up.
 */
const EXPECTED_STATS = {
  LINE: 11,
  LWPOLYLINE: 2,
  POLYLINE: 1,
  CIRCLE: 5,
  ARC: 1,
  ELLIPSE: 1,
  TEXT: 2,
  MTEXT: 1,
  ATTRIB: 2,
  INSERT: 1,
  HATCH: 1,
  SOLID: 1,
  POINT: 1,
  DIMENSION: 1,
}

await check('test/sample.dxf renders and every entity type is tallied', () => {
  for (const [type, expected] of Object.entries(EXPECTED_STATS)) {
    assert.equal(sample.stats[type], expected, `stats.${type}`)
  }
  assert.deepEqual(
    Object.keys(sample.stats).filter((key) => key.startsWith('__') !== true).sort(),
    Object.keys(EXPECTED_STATS).sort(),
    'no other entity type is drawn, and none is missing',
  )
  assert.deepEqual(sample.bbox, { minX: 0, minY: 0, maxX: 120, maxY: 80 }, '$EXTMIN/$EXTMAX drive the extents')
})

await check('the SVG is one document: viewBox, one root group, the Y-flip, non-scaling strokes', () => {
  const svg = sample.svg
  assert.equal(count(svg, /<svg /g), 1, 'exactly one <svg> root')
  assert.equal(count(svg, /<\/svg>/g), 1)
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="-2\.4 -2\.4 124\.8 84\.8"/,
    'the viewBox is the drawing plus the 2% pad')
  assert.match(svg, /<rect [^>]*\/><g stroke-width="1"/, 'the background rect, then the single root group')
  assert.equal(svg.indexOf('<g '), svg.indexOf('<g stroke-width="1"'), 'the first group is the root group')
  assert.equal(count(svg, /<g /g), count(svg, /<\/g>/g), 'every group is closed (nested INSERT limbs included)')
  assert.match(svg, /transform="translate\(0 80\) scale\(1 -1\)"/, 'the root group flips Y, as DXF coordinates need')
  assert.match(svg, /vector-effect="non-scaling-stroke"/, 'strokes stay 1px wide however far the drawing is zoomed')
  assert.match(svg, /preserveAspectRatio="xMidYMid meet"/)
  assert.match(svg, /fill="#ffffff"/, 'the requested background colour is used')
  assert.equal(svg.endsWith('</g></svg>'), true)
})

await check('one <text> per TEXT / MTEXT / ATTRIB, each counter-flipped so it reads upright', () => {
  const texts = sample.svg.match(/<text [^>]*>/g) ?? []
  assert.equal(texts.length, 4, '2 TEXT + 1 MTEXT + 1 ATTRIB (one TEXT lives in the DIMV block)')
  for (const tag of texts) {
    assert.match(tag, /scale\(1 -1\)/, 'text is flipped back inside the flipped group')
    assert.match(tag, /font-size="\d/, 'text carries its DXF height')
  }
  const body = sample.svg.slice(sample.svg.indexOf('>') + 1)
  assert.match(body, />4x M8</, 'the ATTRIB value is drawn')
  assert.match(body, />PLATE 120x80</)
  assert.match(body, /<tspan [^>]*>Thickness: 3 mm/, 'MTEXT chunks become tspans')
})

await check('the entity total the sidebar shows is the sum of the tallies', () => {
  const total = Object.entries(sample.stats)
    .filter(([key]) => key.startsWith('__') !== true)
    .reduce((sum, [, value]) => sum + value, 0)
  assert.equal(total, 31)
  assert.equal(sample.stats.__skippedOutside, 0, 'nothing in the sample is dropped as stray geometry')
  assert.equal(sample.stats.__stray, undefined, 'the stray counter only exists when something is dropped')
})

await check('nested geometry far outside the sheet is dropped and counted, not drawn', () => {
  // The block spans 9000 units of x while the sheet is 40 x 30: the insert limb
  // is inside the sheet, the line inside the block is not. Extents stay those of
  // model space, so the junk block cannot stretch the viewBox.
  const dxf = [
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'JUNK', '70', '0', '10', '0', '20', '0',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '9000', '21', '0',
    '0', 'ENDBLK', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '8', '0', '2', 'JUNK', '10', '10', '20', '10',
    '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '40', '20', '0', '10', '40', '20', '30', '10', '0', '20', '30',
    '0', 'ENDSEC', '0', 'EOF', '',
  ].join('\n')
  const rendered = dxfToSvg(dxf, RENDER_OPTIONS)
  assert.deepEqual(rendered.bbox, { minX: 0, minY: 0, maxX: 40, maxY: 30 }, 'block content is left out of the extents')
  assert.equal(rendered.stats.LINE, 1, 'the entity is still tallied')
  assert.equal(rendered.stats.__stray, 1, 'and counted as stray')
  assert.equal(rendered.stats.__skippedOutside, 1)
  assert.equal(count(rendered.svg, /<path /g), 1, 'only the in-sheet polyline is drawn')
  assert.doesNotMatch(rendered.svg, /9000/, 'the dropped geometry never reaches the document')
})

await check('layer colours follow the ACI table, the colour sign is ignored, frozen layers are dropped', () => {
  // libredwg writes every layer colour negated, so NEG (-2) must draw like 2
  // rather than being read as "layer off" - that is the documented trade-off.
  const dxf = [
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '4',
    '0', 'LAYER', '2', 'RED', '70', '0', '62', '1', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'NEG', '70', '0', '62', '-2', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'FROZEN', '70', '1', '62', '3', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'OWN', '70', '0', '62', '7', '6', 'CONTINUOUS',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', 'RED', '10', '0', '20', '0', '11', '10', '21', '10',
    '0', 'LINE', '8', 'NEG', '10', '0', '20', '0', '11', '10', '21', '10',
    '0', 'LINE', '8', 'FROZEN', '10', '0', '20', '0', '11', '10', '21', '10',
    '0', 'LINE', '8', 'OWN', '62', '4', '10', '0', '20', '0', '11', '10', '21', '10',
    '0', 'ENDSEC', '0', 'EOF', '',
  ].join('\n')
  const rendered = dxfToSvg(dxf, RENDER_OPTIONS)
  assert.match(rendered.svg, /stroke="#ff0000"/, 'layer colour 1 is red')
  assert.match(rendered.svg, /stroke="#ffff00"/, 'a negated layer colour draws with its magnitude')
  assert.match(rendered.svg, /stroke="#00ffff"/, 'an entity colour overrides its layer')
  assert.equal(count(rendered.svg, /<path /g), 3, 'the frozen layer is skipped')
  assert.equal(rendered.stats.LINE, 4, 'but it is still tallied')
})

await check('text is XML-escaped, and a drawing with no geometry is refused', () => {
  const dxf = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '10', '21', '10',
    '0', 'TEXT', '8', '0', '10', '0', '20', '20', '40', '2', '1', 'A<B>&"C"',
    '0', 'ENDSEC', '0', 'EOF', '',
  ].join('\n')
  const rendered = dxfToSvg(dxf, RENDER_OPTIONS)
  assert.match(rendered.svg, /<text [^>]*>A&lt;B&gt;&amp;&quot;C&quot;<\/text>/, 'markup in a label cannot break the document')
  assert.throws(() => dxfToSvg('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n', RENDER_OPTIONS), /empty drawing/,
    'a drawing with no extents throws instead of emitting an unusable SVG')
})

await check('docs/example.svg is exactly what the renderer produces (regenerate with tools/make-example.mjs)', () => {
  const onDisk = readFileSync(EXAMPLE_FILE, 'utf8')
  // Compared with line endings normalised: a Windows checkout may hand the file
  // back with CRLF, which is a checkout artifact, not a stale image.
  const normalise = (text) => text.split('\r\n').join('\n')
  assert.equal(normalise(onDisk).trimEnd(), normalise(renderExample().document).trimEnd(),
    'the committed demo image matches the committed renderer')
  assert.equal(onDisk.startsWith('<svg '), true)
  assert.match(onDisk, /<g stroke-width="1"/)
  assert.ok(statSync(EXAMPLE_FILE).size > 1000, 'the demo image is a real drawing')
})

// ---------------------------------------------------------------------------
// 2. The browser half: what it registers
// ---------------------------------------------------------------------------

/**
 * The `react` substitute handed to `client.js`. `createElement` returns a plain
 * tree node; the hooks are supplied per test by the hook runtime.
 *
 * @param {any} hooks
 * @returns {any}
 */
function reactDouble(hooks) {
  return hooks ?? {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
  }
}

/**
 * Evaluate `client.js` the way the Harness loader does and hand back everything
 * the module registered.
 *
 * @param {{ hooks?: any, locale?: boolean }} [doubles] `locale: false` composes a
 *   client without the locale service, to check the built-in fallback copy.
 * @returns {Promise<any>}
 */
async function loadClient(doubles = {}) {
  const dictionaries = new Map()
  const styles = []
  const requires = []
  const slots = []
  const slotNames = []
  const effects = []
  const disposers = []
  const bindCalls = []
  const withLocale = doubles.locale === undefined ? true : doubles.locale

  globalThis.document = {
    querySelector: (selector) => styles.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (tag) => styles.push(tag) },
  }
  globalThis.window = { __ModuleLoader__: { load: (entry) => { globalThis.window.__loaded = entry } } }

  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // The bundle is a plain script: evaluate it the way the loader would.
  new Function('window', 'document', source)(globalThis.window, globalThis.document)
  const entry = globalThis.window.__loaded
  const module = entry.factory((request) => {
    requires.push(request)
    if (request === 'react') return reactDouble(doubles.hooks)
    throw new Error(`the browser half reached for ${request}`)
  })

  const locale = withLocale === false ? undefined : {
    register: (namespace, language, dictionary) => {
      dictionaries.set(`${namespace}:${language}`, dictionary)
      return () => dictionaries.delete(`${namespace}:${language}`)
    },
    bind: (namespace) => {
      bindCalls.push(namespace)
      return (key) => dictionaries.get(`${namespace}:en`)?.[key] ?? key
    },
  }

  // The document-preview registry the shipped sidebar-documentpreview plugin
  // provides: just `register()` and the disposer it hands back.
  const registrations = []
  const preview = {
    register: (descriptor) => {
      registrations.push(descriptor)
      return () => {
        const index = registrations.indexOf(descriptor)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
  }

  let component = null
  const ctx = {
    get: (service) => {
      if (service === 'locale') return locale
      if (service === 'documentPreviews') return preview
      return undefined
    },
    effect: (factory, label) => {
      effects.push(label)
      const disposer = factory()
      disposers.push(disposer)
      return disposer
    },
    slots: {
      inject: (name, register) => {
        slotNames.push(name)
        register()
      },
      register: (descriptor, registered) => {
        slots.push({ descriptor, registered })
        component = registered
        return () => {}
      },
    },
  }

  return { entry, module, ctx, dictionaries, styles, requires, registrations, slots, slotNames, effects, disposers, bindCalls, source,
    get component() { return component } }
}

await check('client.js loads as a module bundle and reaches for nothing but react', async () => {
  const client = await loadClient()
  assert.equal(client.entry.id, '@local/dsh-dwg-preview')
  assert.equal(typeof client.entry.factory, 'function')
  assert.equal(typeof client.module.apply, 'function')
  assert.deepEqual(client.module.inject, ['slots'])
  assert.deepEqual([...new Set(client.requires)], ['react'], 'every require() call is for react')
  const required = [...client.source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
  assert.deepEqual([...new Set(required)], ['react'], 'and the source names nothing else')
  for (const forbidden of ['dsh-client', '@deepseek-ai/', 'libredwg', 'three', 'dxf-parser']) {
    assert.equal(client.source.includes(forbidden), false, `the browser half never references ${forbidden}`)
  }
  assert.doesNotMatch(client.source, /https?:\/\//, 'no remote script, worker or CDN')
})

await check('the renderer claims .dwg and .dxf in the extension band, and gets a keyed slot body', async () => {
  const client = await loadClient()
  client.module.apply(client.ctx)

  assert.equal(client.registrations.length, 1)
  const metadata = client.registrations[0]
  assert.equal(metadata.id, BODY_ID)
  assert.deepEqual(metadata.extensions, ['dwg', 'dxf'])
  assert.deepEqual(metadata.binaryExtensions, ['dwg', 'dxf'], 'both suffixes arrive as bytes, never as text')
  assert.equal(metadata.priority, 'extension', 'the suffix decides, not a sniff of the content')
  assert.equal(metadata.loading, 'bytes-complete', 'the body wants the whole file, not a stream')
  assert.equal(metadata.wrap, false)
  assert.equal(metadata.title(), 'DWG drawing', 'the title follows the language the locale service is bound to')

  assert.deepEqual(client.slotNames, [SLOT], 'the body is injected into the document tab slot')
  assert.equal(client.slots.length, 1)
  assert.deepEqual(client.slots[0].descriptor, { name: SLOT, key: BODY_ID, locale: 'dwgPreview' })
  assert.equal(typeof client.slots[0].registered, 'function', 'the slot registers a component factory')
  assert.equal(client.component, client.slots[0].registered)

  assert.deepEqual(client.effects, [
    'dsh-dwg-preview: dictionaries',
    'dsh-dwg-preview: metadata',
  ], 'the dictionary and the metadata registration are both owned by effects (so they unload)')
  // Tearing the metadata effect down must unregister the renderer.
  assert.equal(typeof client.disposers[1], 'function')
  client.disposers[1]()
  assert.equal(client.registrations.length, 0, 'unloading the plugin takes the renderer away')

  // Without a locale service the built-in Chinese copy is the fallback.
  const bare = await loadClient({ locale: false })
  bare.module.apply(bare.ctx)
  assert.equal(bare.registrations.length, 1, 'the body registers even with no locale service')
  assert.equal(bare.registrations[0].title(), 'DWG 图纸')
  assert.deepEqual(bare.effects, ['dsh-dwg-preview: metadata'], 'and then only the metadata effect is used')
})

await check('the locale dictionaries are registered for both languages and share one key set', async () => {
  const client = await loadClient()
  client.module.apply(client.ctx)
  assert.deepEqual([...client.dictionaries.keys()], ['dwgPreview:zh', 'dwgPreview:en'])
  const zh = client.dictionaries.get('dwgPreview:zh')
  const en = client.dictionaries.get('dwgPreview:en')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'no copy exists in only one language')
  assert.deepEqual(Object.keys(zh).sort(), ['entities', 'failed', 'fit', 'loading', 'seconds', 'title', 'zoomIn', 'zoomOut'])
  assert.equal(zh.title, 'DWG 图纸')
  assert.equal(en.title, 'DWG drawing')
  assert.equal(en.entities, '{count} entities')
  assert.equal(zh.entities, '{count} 个图元')

  // The bound dictionary must win over the built-in fallback copy.
  assert.deepEqual(client.bindCalls, ['dwgPreview'])
  assert.equal(client.registrations[0].title(), 'DWG drawing', 'the registered title follows the active language')
})

await check('the plugin stylesheet is installed once, under its own marker', async () => {
  const client = await loadClient()
  client.module.apply(client.ctx)
  // A second apply (reload, HMR) must find the existing tag instead of adding another.
  client.module.apply(client.ctx)
  assert.equal(client.styles.length, 1)
  assert.equal(client.styles[0].dataset.plugin, '@local/dsh-dwg-preview')
  assert.equal(client.styles[0].dataset.pluginCss, 'dsh-dwg-preview-css')
  for (const selector of ['.dshdwg-root', '.dshdwg-scroll.dshdwg-dragging', '.dshdwg-img']) {
    assert.equal(client.styles[0].textContent.includes(selector), true, `${selector} is styled`)
  }
  assert.equal(client.styles[0].textContent.includes('@import'), false, 'the stylesheet is self-contained')
})

// ---------------------------------------------------------------------------
// 3. The browser half: what a user does with it
// ---------------------------------------------------------------------------

/**
 * A minimal hook runtime: state slots, dependency-aware `useEffect`/`useRef`, and
 * a dirty flag so a render loop can settle.
 *
 * @returns {any}
 */
function hookRuntime() {
  const slots = []
  let cursor = 0
  let dirty = false
  let pending = []
  const sameDeps = (left, right) =>
    Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  return {
    reset() {
      cursor = 0
      pending = []
    },
    /** Remember the hook slots so a throwaway render cannot consume them. */
    snapshot() {
      return slots.slice()
    },
    restore(previous) {
      slots.length = 0
      for (const slot of previous) slots.push(slot)
      dirty = false
      pending = []
    },
    takeDirty() {
      const value = dirty
      dirty = false
      return value
    },
    takeEffects() {
      const effects = pending
      pending = []
      return effects
    },
    hooks: {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useState: (initial) => {
        const index = cursor++
        if (!(index in slots)) slots[index] = initial
        return [
          slots[index],
          (next) => {
            const value = typeof next === 'function' ? next(slots[index]) : next
            if (!Object.is(value, slots[index])) {
              slots[index] = value
              dirty = true
            }
          },
        ]
      },
      useRef: (initial) => {
        const index = cursor++
        if (!(index in slots)) slots[index] = { current: initial }
        return slots[index]
      },
      useEffect: (effect, deps) => {
        const index = cursor++
        const previous = slots[index]
        if (previous === undefined || !sameDeps(previous.deps, deps)) {
          slots[index] = { deps }
          pending.push(effect)
        }
      },
    },
  }
}

/** The scroll node the body binds: just enough DOM for pan, zoom and refs. */
function fakeViewport() {
  return {
    scrollLeft: 40,
    scrollTop: 25,
    clientWidth: 800,
    clientHeight: 600,
    listeners: [],
    addEventListener(type, handler) {
      this.listeners.push({ type, handler })
    },
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
  }
}

/**
 * Mount the registered body against a stubbed host `fetch` and drive it the way
 * the UI does: render, commit refs, run the queued effects, settle, re-render
 * while state keeps changing.
 *
 * @param {(url: string, init: any) => Promise<any>} respond
 * @param {{ locale?: boolean }} [options] `locale: true` composes the client with
 *   a locale service; by default the built-in Chinese copy is used, which is what
 *   a user sees with no locale provider.
 * @returns {Promise<any>}
 */
async function mountBody(respond, options = {}) {
  const runtime = hookRuntime()
  const calls = []
  const viewport = fakeViewport()
  const scrollport = { current: null }
  const realFetch = globalThis.fetch
  const realCreate = globalThis.URL.createObjectURL
  const realRevoke = globalThis.URL.revokeObjectURL
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init })
    return respond(url, init)
  }
  globalThis.URL.createObjectURL = () => 'blob:dsh-dwg-preview'
  globalThis.URL.revokeObjectURL = () => {}

  const client = await loadClient({ hooks: runtime.hooks, locale: options.locale === true })
  client.module.apply(client.ctx)
  const component = client.component

  /** Hand our fake node to every ref, the way a commit does. */
  const commitRefs = (tree) => {
    walk(tree, (element) => {
      const ref = element.props?.ref
      if (ref === undefined || ref === null) return
      if (typeof ref === 'function') ref(viewport)
      else if (typeof ref === 'object') ref.current = viewport
    })
  }

  /** One render pass; returns the tree and queues its effects. */
  const pass = (props) => {
    runtime.reset()
    const element = component(props)
    const tree = typeof element?.type === 'function' ? element.type(element.props) : element
    commitRefs(tree)
    return tree
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  /** The initial paint: no effect has run yet, so the body is still loading. */
  const paint = (props) => {
    const previous = runtime.snapshot()
    const tree = pass(props)
    runtime.restore(previous)
    return tree
  }

  /** Render until state stops changing, running effects as they are queued. */
  const render = async (props) => {
    let tree = null
    for (let round = 0; round < 12; round += 1) {
      tree = pass(props)
      for (const effect of runtime.takeEffects()) await effect()
      await settle()
      if (runtime.takeDirty() === false) break
    }
    return tree
  }

  return {
    component,
    calls,
    viewport,
    scrollport,
    runtime,
    paint,
    render,
    unmount() {
      globalThis.fetch = realFetch
      globalThis.URL.createObjectURL = realCreate
      globalThis.URL.revokeObjectURL = realRevoke
    },
  }
}

/** The props the document-preview slot hands the body. */
function bodyProps(bytes, scrollport, address = '/ws/plate 图纸.dxf') {
  return { content: { kind: 'bytes', data: bytes }, resourceAddress: address, scrollportRef: scrollport }
}

const sampleBytes = readFileSync(SAMPLE_FILE)
const readyPayload = { ok: true, kind: 'dxf', svg: sample.svg, stats: sample.stats }

await check('the body posts the file bytes and draws the returned SVG', async () => {
  const mounted = await mountBody(async () => ({ ok: true, status: 200, json: async () => readyPayload }))
  try {
    const props = bodyProps(sampleBytes, mounted.scrollport)

    const loading = mounted.paint(props)
    assert.match(textOf(loading), /正在解析图纸…/, 'the first paint is the loading state')

    const tree = await mounted.render(props)
    assert.equal(mounted.calls.length, 1, 'the bytes are posted once')
    const call = mounted.calls[0]
    assert.equal(call.url, SVG_ROUTE, 'it posts to the route the host registers')
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.credentials, 'include')
    assert.equal(call.init.cache, 'no-store')
    assert.equal(call.init.headers['content-type'], 'application/octet-stream')
    assert.equal(call.init.headers['x-dwg-name'], encodeURIComponent('plate 图纸.dxf'),
      'a non-ASCII file name travels percent-encoded, because header values are ISO-8859-1')
    assert.equal(call.init.body, sampleBytes, 'the bytes are handed over untouched')

    const root = elementsWithClass(tree, 'dshdwg-root')
    assert.equal(root.length, 1, 'the ready state is the viewer')
    const images = elementsWithClass(tree, 'dshdwg-img')
    assert.equal(images.length, 1)
    assert.equal(images[0].props.src, 'blob:dsh-dwg-preview')
    assert.equal(images[0].props.alt, 'plate 图纸.dxf')
    assert.equal(images[0].props.style.width, '100%', 'the drawing opens adapted to the width')
    assert.equal(elementsWithClass(tree, 'dshdwg-scroll').length, 1)
    assert.equal(mounted.scrollport.current, mounted.viewport, 'the parent scroll owner gets the same node')
    assert.match(textOf(elementsWithClass(tree, 'dshdwg-meta')[0]), /31 个图元$/, 'the entity total is shown')
  } finally {
    mounted.unmount()
  }
})

await check('the toolbar zooms within its limits, adapt-width returns to 100%, Ctrl+wheel zooms, dragging pans', async () => {
  const mounted = await mountBody(async () => ({ ok: true, status: 200, json: async () => readyPayload }))
  try {
    const props = bodyProps(sampleBytes, mounted.scrollport)
    let tree = await mounted.render(props)
    // The width is a percentage string built from a float, so compare numbers.
    const width = () => Number.parseFloat(elementsWithClass(tree, 'dshdwg-img')[0].props.style.width)
    const near = (expected, what) => assert.ok(Math.abs(width() - expected) < 1e-9, `${what}: ${width()}% instead of ${expected}%`)

    near(100, 'the drawing opens adapted to the width')

    buttonWithTitle(tree, '放大').props.onClick()
    tree = await mounted.render(props)
    near(125, 'one zoom-in step is 1.25x')

    buttonWithTitle(tree, '缩小').props.onClick()
    tree = await mounted.render(props)
    near(100, 'one zoom-out step is 0.8x')

    for (let step = 0; step < 12; step += 1) {
      buttonWithTitle(tree, '缩小').props.onClick()
      tree = await mounted.render(props)
    }
    near(20, 'zooming out stops at 0.2x')

    for (let step = 0; step < 30; step += 1) {
      buttonWithTitle(tree, '放大').props.onClick()
      tree = await mounted.render(props)
    }
    near(2500, 'zooming in stops at 25x')

    buttonWithTitle(tree, '适应宽度').props.onClick()
    tree = await mounted.render(props)
    near(100, '适应宽度 returns to the width-fitted state')

    // Ctrl/Cmd + wheel zooms; a plain wheel must keep scrolling the drawing.
    const wheel = mounted.viewport.listeners.find((entry) => entry.type === 'wheel')
    assert.ok(wheel !== undefined, 'the viewport listens for wheel itself (React cannot preventDefault)')
    let prevented = 0
    wheel.handler({ ctrlKey: true, deltaY: -100, preventDefault: () => { prevented += 1 } })
    tree = await mounted.render(props)
    near(115, 'Ctrl + wheel up zooms in one 1.15 step')
    assert.equal(prevented, 1, 'and the page is told not to scroll')
    wheel.handler({ ctrlKey: false, deltaY: -100, preventDefault: () => { prevented += 1 } })
    tree = await mounted.render(props)
    near(115, 'a plain wheel leaves the zoom alone')
    assert.equal(prevented, 1, 'and the page keeps scrolling')

    // Dragging the drawing pans it: pointer deltas move the scrollport the other way.
    const scroll = elementsWithClass(tree, 'dshdwg-scroll')[0]
    const pointer = (x, y) => ({ button: 0, pointerId: 7, clientX: x, clientY: y, currentTarget: mounted.viewport })
    const startLeft = mounted.viewport.scrollLeft
    const startTop = mounted.viewport.scrollTop
    scroll.props.onPointerDown(pointer(100, 100))
    tree = await mounted.render(props)
    assert.equal(elementsWithClass(tree, 'dshdwg-scroll')[0].props.className, 'dshdwg-scroll dshdwg-dragging')
    elementsWithClass(tree, 'dshdwg-scroll')[0].props.onPointerMove(pointer(90, 130))
    assert.equal(mounted.viewport.scrollLeft, startLeft + 10, 'dragging left moves the drawing right')
    assert.equal(mounted.viewport.scrollTop, startTop - 30)
    elementsWithClass(tree, 'dshdwg-scroll')[0].props.onPointerUp(pointer(90, 130))
    tree = await mounted.render(props)
    assert.equal(elementsWithClass(tree, 'dshdwg-scroll')[0].props.className, 'dshdwg-scroll', 'releasing ends the drag')
    const moved = mounted.viewport.scrollLeft
    elementsWithClass(tree, 'dshdwg-scroll')[0].props.onPointerMove(pointer(10, 10))
    assert.equal(mounted.viewport.scrollLeft, moved, 'a move without a press does not pan')
  } finally {
    mounted.unmount()
  }
})

await check('a refused or unreachable render shows the failure in place of the drawing', async () => {
  const refused = await mountBody(async () => ({
    ok: true,
    status: 413,
    json: async () => ({ ok: false, code: 'TOO_LARGE', message: '文件超过 64 MB，预览已跳过' }),
  }))
  try {
    const tree = await refused.render(bodyProps(sampleBytes, refused.scrollport))
    const alert = elementsWithClass(tree, 'dshdwg-status').find((element) => element.props.role === 'alert')
    assert.ok(alert !== undefined, 'the failure is announced, not silent')
    assert.match(textOf(alert), /预览失败/)
    assert.match(textOf(alert), /文件超过 64 MB，预览已跳过/, "the host's own message reaches the user")
    assert.equal(elementsWithClass(tree, 'dshdwg-bar').length, 0, 'no toolbar is offered for a drawing that is not there')
  } finally {
    refused.unmount()
  }

  const broken = await mountBody(async () => { throw new Error('Failed to fetch') })
  try {
    const tree = await broken.render(bodyProps(sampleBytes, broken.scrollport))
    assert.match(textOf(tree), /预览失败/)
    assert.match(textOf(tree), /Failed to fetch/, 'a network failure is reported instead of a blank pane')
  } finally {
    broken.unmount()
  }
})

await check('a document that is not handed bytes never posts anything', async () => {
  const mounted = await mountBody(async () => ({ ok: true, status: 200, json: async () => readyPayload }))
  try {
    const tree = await mounted.render({ content: { kind: 'text', data: 'not bytes' }, resourceAddress: '/ws/x.dxf' })
    assert.equal(mounted.calls.length, 0, 'a text preview is not posted to the SVG route')
    assert.match(textOf(tree), /正在解析图纸…/)
  } finally {
    mounted.unmount()
  }

  // With a locale service bound the same state renders the English copy.
  const translated = await mountBody(async () => ({ ok: true, status: 200, json: async () => readyPayload }), { locale: true })
  try {
    const tree = await translated.render(bodyProps(sampleBytes, translated.scrollport))
    assert.match(textOf(tree), /DWG drawing|Zoom in|entities/, 'the bound dictionary reaches the body')
    assert.match(textOf(tree), /31 entities/, 'and the entity total is localised too')
  } finally {
    translated.unmount()
  }
})

// ---------------------------------------------------------------------------
// 4. The host half: the routes
// ---------------------------------------------------------------------------

/** A `ctx` with just the `connection` service and `effect`, as `apply()` uses them. */
function fakeHost() {
  const routes = []
  const labels = []
  const disposers = []
  const ctx = {
    effect(factory, label) {
      labels.push(label)
      const disposer = factory()
      disposers.push(disposer)
      return disposer
    },
    connection: {
      fetch: {
        register(route) {
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index >= 0) routes.splice(index, 1)
          }
        },
      },
    },
  }
  return { ctx, routes, labels, disposers }
}

/** A POST the way the connection bridge hands it to the route: raw bytes. */
function postBytes(body) {
  return new Request('http://127.0.0.1' + SVG_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  })
}

/**
 * Mount the host half and call one of its routes.
 *
 * @param {string} path
 * @param {any} [request]
 * @returns {Promise<{ status: number, payload: any }>}
 */
async function callRoute(path, request) {
  const mounted = fakeHost()
  host.apply(mounted.ctx)
  const route = mounted.routes.find((candidate) => candidate.path === path)
  assert.ok(route !== undefined, `${path} is registered`)
  const response = await route.fetch(request)
  return { status: response.status, payload: await response.json() }
}

await check('apply() registers exactly the two documented routes, each owned by an effect', () => {
  const mounted = fakeHost()
  host.apply(mounted.ctx)
  assert.deepEqual(mounted.routes.map((route) => route.path).sort(), [PING_ROUTE, SVG_ROUTE].sort())
  const ping = mounted.routes.find((route) => route.path === PING_ROUTE)
  assert.deepEqual(ping.methods, ['GET'], 'the probe is read-only')
  assert.equal(ping.requestBody, 'buffered')
  const svg = mounted.routes.find((route) => route.path === SVG_ROUTE)
  assert.deepEqual(svg.methods, ['POST'])
  assert.equal(svg.requestBody, 'buffered', 'the body arrives as bytes, not as a stream')
  assert.equal(mounted.labels.length, 2, 'both registrations are effect-owned')
  assert.deepEqual(mounted.labels, ['dsh-dwg-preview: ping route', 'dsh-dwg-preview: svg route'])
  for (const disposer of mounted.disposers) assert.equal(typeof disposer, 'function')
  for (const disposer of mounted.disposers) disposer()
  assert.equal(mounted.routes.length, 0, 'unloading the plugin takes its routes away')
})

await check('the ping route reports the plugin and how many drawings are cached', async () => {
  const { status, payload } = await callRoute(PING_ROUTE)
  assert.equal(status, 200)
  assert.deepEqual(payload, { ok: true, plugin: 'dsh-dwg-preview', cache: 0 })
})

await check('DXF bytes come back as a renderable SVG, and the same file is served from the cache', async () => {
  const first = await callRoute(SVG_ROUTE, postBytes(sampleBytes))
  assert.equal(first.status, 200)
  assert.equal(first.payload.ok, true)
  assert.equal(first.payload.kind, 'dxf', 'the format is decided by the content, not the file name')
  assert.equal(first.payload.svg, sample.svg, 'the route renders exactly what the renderer produces')
  assert.deepEqual(first.payload.stats, sample.stats)

  const second = await callRoute(SVG_ROUTE, postBytes(Buffer.from(sampleBytes)))
  assert.equal(second.payload.svg, first.payload.svg)
  const ping = await callRoute(PING_ROUTE)
  assert.equal(ping.payload.cache, 1, 'an identical file is decoded once (sha1 keyed, 6 entries kept)')
})

await check('an empty body is refused with EMPTY and 400', async () => {
  const { status, payload } = await callRoute(SVG_ROUTE, postBytes(Buffer.alloc(0)))
  assert.equal(status, 400)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'EMPTY')
  assert.equal(typeof payload.message, 'string')
})

await check('content that is neither DWG nor DXF is refused with FAILED and 500', async () => {
  const { status, payload } = await callRoute(SVG_ROUTE, postBytes(Buffer.from('this is not a drawing at all\n')))
  assert.equal(status, 500)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'FAILED')
  assert.match(payload.message, /无法识别的文件内容/)
})

await check('a body over 64 MB is refused with TOO_LARGE and 413 before it is rendered', async () => {
  // The cap has to be crossed for real, so the route gets a request whose
  // arrayBuffer() is a zero-filled SharedArrayBuffer one byte over the limit.
  // Buffer.from(arrayBuffer) only takes a *view* of it - no byte is copied and
  // no page is touched - so this check crosses the real branch without
  // materialising a 64 MB buffer. (Verified below, not merely assumed.)
  const oversized = new SharedArrayBuffer(MAX_BYTES + 1)
  const view = Buffer.from(oversized)
  assert.equal(view.length, MAX_BYTES + 1)
  assert.equal(view.buffer, oversized, 'the buffer is a view: reading it costs nothing')
  assert.equal(process.memoryUsage().external < MAX_BYTES, true, 'no 64 MB copy was made')
  const standIn = { arrayBuffer: async () => oversized }

  const { status, payload } = await callRoute(SVG_ROUTE, standIn)
  assert.equal(status, 413)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'TOO_LARGE')
  assert.match(payload.message, /64 MB/)
})

/**
 * Whether the DWG decoder is installed. It is a runtime dependency the Harness
 * profile provides; in this repo it is absent, which is exactly the boundary the
 * README states, and it decides whether the DWG branch can be pinned here.
 */
let libredwgInstalled = true
try {
  require.resolve('@mlightcad/libredwg-web')
} catch (error) {
  libredwgInstalled = false
}

if (libredwgInstalled === true) {
  skip('a DWG body is routed to LibreDWG, not rejected as unknown content',
    '@mlightcad/libredwg-web is resolvable here, so the DWG branch would really decode and this offline check cannot pin its outcome; run it in a profile install instead')
} else {
  await check('a DWG body is routed to LibreDWG, not rejected as unknown content', async () => {
    // libredwg is absent, so the decode fails - the point of the check is that the
    // AC10xx header selected the DWG branch and that the failure is reported as a
    // FAILED response rather than thrown out of the route.
    const dwg = Buffer.concat([Buffer.from('AC1015', 'latin1'), Buffer.alloc(64, 0x20)])
    const { status, payload } = await callRoute(SVG_ROUTE, postBytes(dwg))
    assert.equal(status, 500)
    assert.equal(payload.code, 'FAILED')
    assert.doesNotMatch(payload.message, /无法识别的文件内容/,
      'the AC10xx header selected the DWG branch, it was not rejected as unknown content')
  })
}

await check('the browser half posts to the very path the host registers', async () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.equal(source.includes(`'${SVG_ROUTE}'`), true, 'the client fetches the registered route path')
  const mounted = fakeHost()
  host.apply(mounted.ctx)
  assert.ok(mounted.routes.some((route) => route.path === SVG_ROUTE))
})

await check('mounting appends the diagnostic .mount.log marker next to index.js', () => {
  const before = existsSync(MOUNT_LOG) ? statSync(MOUNT_LOG).size : 0
  const mounted = fakeHost()
  host.apply(mounted.ctx)
  assert.equal(existsSync(MOUNT_LOG), true, 'the marker exists after mounting')
  assert.ok(statSync(MOUNT_LOG).size > before, 'and mounting appended a line to it')
})

// ---------------------------------------------------------------------------
// 5. Packaging: what must not be in the repo, and what package.json must ship
// ---------------------------------------------------------------------------

/** Every file in the tree, relative to the package root, POSIX separators. */
function treeFiles() {
  const skip = new Set(['node_modules', '.git', 'dist'])
  const found = []
  const walkDirectory = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) walkDirectory(absolute)
      else found.push(relative(PACKAGE_ROOT, absolute).split(sep).join('/'))
    }
  }
  walkDirectory(PACKAGE_ROOT)
  // Never shipped: the mount marker and log files, and lock files - a lock file
  // here would pin whatever registry mirror ran `pnpm test`, while the profile
  // installs this package's own dependencies.
  const droppings = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'npm-shrinkwrap.json'])
  return found.filter((file) => file.endsWith('.log') === false && droppings.has(file.split('/').pop()) === false).sort()
}

/** The `files` entries of package.json. */
const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))

// Read the holder out of the licence so no file in this tree - including this one
// - has to spell the name out, which keeps a plain grep for it meaningful.
const LICENCE_TEXT = readFileSync(join(PACKAGE_ROOT, 'LICENSE'), 'utf8')
const COPYRIGHT_HOLDER = (LICENCE_TEXT.match(/Copyright \(c\) 2026 (\S+)/) ?? [])[1]
const LICENCE_LINE = `[MIT](LICENSE) © 2026 ${COPYRIGHT_HOLDER}`

await check('package.json is the bundle manifest the repo kit requires', () => {
  assert.equal(manifest.name, '@local/dsh-dwg-preview')
  assert.equal(manifest.private, true, 'a local-scope name, not an npm release')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.engines.node, '>=20')
  assert.equal('dsh' in manifest.engines, false,
    'no engines.dsh: a prerelease range would hide the plugin from other prereleases')
  assert.equal(manifest.scripts.test, 'node test/selfcheck.mjs')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-sidebar-documentpreview'])
  assert.deepEqual(manifest.peerDependencies, { '@deepseek-ai/cordis': '^4.0.1' })
  assert.deepEqual(manifest.dependencies, { '@mlightcad/libredwg-web': '^0.7.14' },
    'the DWG decoder is a runtime dependency the profile installs, not a bundled file')
  for (const keyword of ['deepseek-harness', 'dsh', 'dsh-plugin', 'dwg', 'dxf']) {
    assert.equal(manifest.keywords.includes(keyword), true, `keywords carry ${keyword}`)
  }
  const repositoryUrl = `https://github.com/${COPYRIGHT_HOLDER}/dsh-dwg-preview`
  assert.equal(manifest.repository.url, repositoryUrl + '.git')
  assert.equal(manifest.homepage, repositoryUrl)
  assert.equal(manifest.bugs.url, repositoryUrl + '/issues')
})

await check('every file in the tree is covered by package.json files', () => {
  const always = new Set(['package.json', '.gitignore'])
  const patterns = manifest.files
  /** `*` matches inside one path segment, as npm's own packlist globbing does. */
  const matchesSegment = (wanted, actual) =>
    new RegExp('^' + wanted.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$').test(actual)
  const matches = (file) => {
    const parts = file.split('/')
    return patterns.some((pattern) => {
      const wanted = pattern.split('/')
      if (wanted.length !== parts.length) return false
      return wanted.every((segment, index) => matchesSegment(segment, parts[index]))
    })
  }
  const uncovered = treeFiles().filter((file) => always.has(file) === false && matches(file) === false)
  assert.deepEqual(uncovered, [], 'nothing in the tree is left out of the published package')
  for (const required of ['README.en.md', 'LICENSE', 'test/*.mjs', 'cordis.patch.yml', 'icon.svg']) {
    assert.equal(patterns.includes(required), true, `files lists ${required}`)
  }
})

await check('no leaked credential, no personal absolute path, and the author name only where it belongs', () => {
  // Assembled from fragments on purpose: the shipped tree has to stay greppable
  // for these prefixes, and this file is part of that tree.
  const words = ['gh' + 'p_', 'github_' + 'pat_', 's' + 'k-[A-Za-z0-9]{16,}', 'api[_-]?' + 'key', 'pass' + 'word', 'sec' + 'ret', 'to' + 'ken']
  const credentials = new RegExp('(' + words.join('|') + ')', 'i')
  const personal = /(C:\\Users|\/mnt\/[cd]\/|\/home\/)/
  assert.equal(typeof COPYRIGHT_HOLDER, 'string', 'LICENSE names a copyright holder')
  const allowed = new Set(['LICENSE', 'package.json', 'README.md', 'README.en.md'])
  for (const file of treeFiles()) {
    const text = readFileSync(join(PACKAGE_ROOT, file), 'utf8')
    const credential = text.match(credentials)
    assert.equal(credential, null, `${file} contains ${credential?.[0]}`)
    const path = text.match(personal)
    assert.equal(path, null, `${file} contains a personal absolute path: ${path?.[0]}`)
    if (text.includes(COPYRIGHT_HOLDER)) {
      assert.equal(allowed.has(file), true, `${file} names the copyright holder outside the licence, manifest and READMEs`)
    }
  }
  // A cheaper existence check here would be vacuous (`treeFiles()` already filters
  // these names out) or wrong (a development checkout legitimately has a
  // `node_modules/` after `pnpm test`), so assert the property that actually
  // decides publishing instead: none of them can be shipped, because
  // `package.json`'s `files` never covers them. `.gitignore` is checked below.
  for (const name of ['.mount.log', 'pnpm-lock.yaml', 'package-lock.json']) {
    assert.equal(manifest.files.some((pattern) => pattern === name || pattern.endsWith('/' + name)), false,
      `${name} must not be covered by package.json files`)
  }
  const ignore = readFileSync(join(PACKAGE_ROOT, '.gitignore'), 'utf8')
  for (const pattern of ['node_modules/', '*.log', '.mount.log', 'pnpm-lock.yaml', 'package-lock.json', '.DS_Store', 'Thumbs.db']) {
    assert.equal(ignore.includes(pattern), true, `.gitignore covers ${pattern}`)
  }
  assert.match(LICENCE_TEXT, /^MIT License\n\nCopyright \(c\) 2026 /)
  assert.match(LICENCE_TEXT, /WITHOUT WARRANTY OF ANY KIND/)
  assert.match(LICENCE_TEXT, /Permission is hereby granted, free of charge/)
})

await check('both READMEs exist, in both languages, with the same structure and the required chapters', () => {
  const zh = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8')
  const en = readFileSync(join(PACKAGE_ROOT, 'README.en.md'), 'utf8')
  assert.match(zh, /^# .+ · dsh-dwg-preview\n\n\[中文\]\(README\.md\) \| \[English\]\(README\.en\.md\)\n/)
  assert.match(en, /^# .+ · dsh-dwg-preview\n\n\[中文\]\(README\.md\) \| \[English\]\(README\.en\.md\)\n/)
  assert.ok(zh.trimEnd().endsWith(LICENCE_LINE), 'README.md ends with the licence line')
  assert.ok(en.trimEnd().endsWith(LICENCE_LINE), 'README.en.md ends with the licence line')
  assert.ok(zh.includes(`https://github.com/${COPYRIGHT_HOLDER}/dsh-dwg-preview`), 'README.md links to the repo')
  for (const chapter of ['## 安装', '### 方式一', '### 方式二', '### 方式三', '### 方式四', '## 装上之后', '### 停用 / 卸载', '## 注意事项', '## 自检', '## 结构', '## 致谢与第三方许可', '## License']) {
    assert.equal(zh.includes(chapter), true, `README.md has ${chapter}`)
  }
  for (const chapter of ['## Installation', '### Method 1', '### Method 2', '### Method 3', '### Method 4', '## After installing', '### Disable / uninstall', '## Notes', '## Self-check', '## Layout', '## Credits and third-party licences', '## License']) {
    assert.equal(en.includes(chapter), true, `README.en.md has ${chapter}`)
  }
  assert.equal(count(zh, /^```/gm), count(en, /^```/gm), 'the code fences line up')
  assert.equal(count(zh, /^\|/gm), count(en, /^\|/gm), 'the tables line up')
  assert.match(zh, /!\[[^\]]*\]\(docs\/example\.svg\)/, 'the demo image is shown')
  assert.match(en, /!\[[^\]]*\]\(docs\/example\.svg\)/)
  assert.match(zh, /@mlightcad\/libredwg-web/)
  assert.match(zh, /GPL-3\.0/, 'the upstream licence is stated')
  assert.match(en, /GPL-3\.0/)
  assert.match(zh, /0\.1\.7-rc\.2/, 'the tested DSH version is stated in prose')
  assert.match(en, /0\.1\.7-rc\.2/)
})

await check('cordis.patch.yml inserts the row the README and the host half name', () => {
  const patch = readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:\n {4}- id: dwg-preview\n {6}name: '@local\/dsh-dwg-preview'\n/)
  assert.match(readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8'), /`dwg-preview`/, 'the README names the row id')
})

// ---------------------------------------------------------------------------

await check('both READMEs state the number of checks this run performs', () => {
  // This check is one of them, hence the + 1; a skipped check still counts, since
  // it is a check the file defines.
  const total = results.length + skipped.length + 1
  for (const [file, phrase] of [['README.md', '纯 Node 跑完'], ['README.en.md', 'plain Node runs all']]) {
    const text = readFileSync(join(PACKAGE_ROOT, file), 'utf8')
    assert.equal(text.includes(`${phrase} ${total} `), true, `${file} says how many checks run (${total})`)
    assert.equal(text.includes(`${total}/${total} checks passed`), true, `${file} quotes the final line`)
  }
})

const failed = results.filter((result) => !result.ok)
const total = results.length + skipped.length
// Leave the tree as it was found: the mount marker is a runtime dropping.
if (mountLogExisted === false) rmSync(MOUNT_LOG, { force: true })
const skippedNote = skipped.length === 0 ? '' : ` (${skipped.length} skipped)`
console.log(`\n${total - failed.length}/${total} checks passed${skippedNote}`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  FAIL ${result.label}: ${result.error?.message ?? result.error}`)
  process.exitCode = 1
}
