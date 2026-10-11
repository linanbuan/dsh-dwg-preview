# DWG preview · dsh-dwg-preview

[中文](README.md) | [English](README.en.md)

> A document-preview plugin for the DeepSeek Harness (DSH) desktop app: open a `.dwg` / `.dxf`
> drawing in the workspace and the right-hand preview tab shows the vector drawing itself —
> drag to pan, Ctrl/⌘ + wheel to zoom, one button to fit the width.

DSH's built-in preview only understands text and images, so a DWG drawing opens as "cannot be previewed". This plugin fills that gap: the host half decodes the DWG into DXF with LibreDWG (compiled to WebAssembly), then draws it into one self-contained SVG with the dependency-free renderer `lib/dxf2svg.mjs` shipped in this repo; the browser half only displays that image — it does not decode, and it loads no third-party viewer library. DXF is plain text, needs no LibreDWG, and goes straight into the renderer.

![Example drawing](docs/example.svg)

The image above is generated from `test/sample.dxf` (`node tools/make-example.mjs`) and covers the entity types listed below.

## What it does

- Where: open a `.dwg` or `.dxf` in the workspace file tree, and the right-hand document preview tab shows it — slot `sidebar.right.tab.document`, body key `@local/dsh-dwg-preview/dwg`.
- Row id: `dwg-preview` (see `cordis.patch.yml`). The plugin registers no settings page, so it declares no `order`.
- How it claims the files: it registers one renderer with the registry that the official `sidebar-documentpreview` plugin provides, declaring the suffixes `dwg` and `dxf`, `priority: 'extension'` (claimed by suffix) and `loading: 'bytes-complete'` (the whole file, not a stream). Other suffixes are untouched.
- Toolbar: zoom in, zoom out, fit width, and the entity total of the current drawing; inside the view you can drag to pan, Ctrl/⌘ + wheel to zoom, and a plain wheel still scrolls.
- Two host routes (registered on the shared `/api` channel of `connection`):

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/dwg-preview/ping` | `200 {"ok":true,"plugin":"dsh-dwg-preview","cache":<cached drawings>}` |
| POST | `/api/dwg-preview/svg` | `200 {"ok":true,"kind":"dwg"\|"dxf","svg":…,"stats":…}` |
| POST | `/api/dwg-preview/svg` | `400 {"ok":false,"code":"EMPTY","message":"文件内容为空"}` |
| POST | `/api/dwg-preview/svg` | `413 {"ok":false,"code":"TOO_LARGE","message":"文件超过 64 MB，预览已跳过"}` |
| POST | `/api/dwg-preview/svg` | `500 {"ok":false,"code":"FAILED","message":…}` |

- Dependencies: the browser half only calls `require('react')`; DWG decoding needs `@mlightcad/libredwg-web` (see the licence at the end).

## How it works

1. The document preview hands the raw bytes of the file to this renderer (`content.kind === 'bytes'`).
2. The browser half `POST`s those bytes to `/api/dwg-preview/svg`, with `x-dwg-name` attached (the percent-encoded file name, a side note only — the host does not look at it to decide the format).
3. The host decides the format from the **content**: `AC10xx` in the first 8 bytes means DWG; `SECTION` together with `HEADER`/`ENTITIES` within the first 8 KB means DXF; neither is reported as `FAILED`.
4. A DWG goes through LibreDWG (WASM) into DXF; a DXF goes straight into `dxfToSvg()`.
5. The result is one self-contained SVG (`viewBox` + a background `rect` + one flipped `g`), returned whole as a string to the browser, which shows it through a Blob URL.

Why the detour: LibreDWG's wasm is about 9.5 MB, and DWG decoding is a CPU-bound synchronous call. In the host process the page side only handles one image; in the page, every preview tab would pay that cost. The DXF path is a pure function, so it can be tested fully offline.

Entity types the renderer covers: LINE, LWPOLYLINE (including bulge arcs), POLYLINE + VERTEX, CIRCLE, ARC, ELLIPSE, TEXT, MTEXT, ATTRIB, INSERT (nested blocks, row/column arrays, rotation and scale), HATCH (polyline boundaries and edge boundaries: lines, arcs, elliptic arcs, fit points), SOLID / 3DFACE, POINT, DIMENSION (through its anonymous block). **Anything outside that list is ignored** — no error, no drawing.

### Deliberate trade-offs

- **Extents**: the drawing's own `$EXTMIN` / `$EXTMAX` are preferred; when they are missing or degenerate, the raw span of model-space coordinates is used. **Block content takes no part in the extents** — some blocks carry junk geometry far outside the sheet, which would otherwise blow up the view. A 2% padding is added last.
- **Junk-geometry filter**: a nested entity (depth > 0) is dropped whole when its world-space footprint is more than 3x the drawing diagonal, or more than 0.8x while its centre falls outside the clip band of "the sheet ± 0.6x its span"; insert-array limbs that fall outside that band are not drawn either. The dropped count is recorded in `stats.__stray` (per entity) and `stats.__skippedOutside` (the total, including dropped array limbs) and is not shown in the UI.
- **Layer colours are taken as absolute values**: the DXF that libredwg writes negates every layer colour (which means "layer off" in DXF), so the sign is ignored here and only the colour number is used. The price is that "colour-off layers" are not implemented; only a layer with `70` bit 1 (frozen) is skipped.
- **Curves**: bulge segments become SVG `A` commands; an ARC becomes one `A`; the arc boundaries of a HATCH are approximated by one polyline segment per 10° (at most 64 per curve), and its elliptic arcs by one per 15°.
- **Text**: TEXT / ATTRIB / MTEXT live inside the flipped group and are flipped back with `scale(1 -1)`, so the glyphs read upright. MTEXT gets only limited cleaning (`\P` line breaks, `\A…;`-style format codes, `{}`, `\~`), so **formatting and stacked fractions are lost**; no font is embedded, glyphs come from the system font (`SimSun, 'Microsoft YaHei', sans-serif`) and change from machine to machine; no wrapping, no columns, no SHX big fonts.
- **No line types or line weights**: everything is drawn as a solid line, and `vector-effect="non-scaling-stroke"` keeps it 1 pixel at any zoom.
- **Read-only**: no entity picking, no layer toggles, no dimension editing, no print or export.

The counting rule, stated plainly: the "N entities" on the preview page is the sum of the renderer's per-type tallies; `ATTRIB` is tallied once while walking entities and once while rendering, so a drawing with attribute blocks counts one too many. That is a display rule only and does not affect the drawing.

## Installation

This plugin is a standard DSH bundle: `package.json` declares `dsh.bundle.patch` and `dsh.client`, so it installs into any profile the same way. Install the DSH desktop app first ([deepseek.com/download](https://www.deepseek.com/download/)), then pick any one of the following.

### Method 1 · Install it inside the DSH desktop app (recommended)

1. In the sidebar click **Plugins** → **Add plugin**;
2. Type any one of these specs into the box:
   - this repository's URL: `https://github.com/linanbuan/dsh-dwg-preview`
   - the tarball URL of this repository (GitHub's `Source code (zip)`)
   - the **absolute path of a directory** you already cloned
   - a package name (if it is ever published to npm)
3. Click **Install**: Harness first reads what the spec points at (package name, description, version) and installs after you confirm;
4. When it is done, click **Enable now**.

The whole install is done by Harness's own plugin manager: it writes this package into the current profile's `dsh.profile.bundles` and mounts the host half. **Installing a plugin in the desktop app needs no command line and no hand-edited profile file.**

### Method 2 · Let the agent install it

Hand the repository URL or a local directory to the agent in any session and it will call the `plugin_manager` tool (`action: install_bundle`), which takes the same path. This is the official installation route for third-party plugins.

### Method 3 · Command line

On a machine that has the dsh CLI:

```bash
dsh plugin --profile <profile name> add <spec>
```

`<spec>` is the same as in Method 1 (package name, Git URL, tarball URL or local path); the arguments follow whatever `dsh plugin --help` actually prints.

### Method 4 · Register it into a profile by hand (troubleshooting only, not recommended)

The profile directory is `~/.dsh/profiles/<profile name>` by default. Put the package there and register it in two places in the profile's own `package.json`:

```json
"dependencies": { "@local/dsh-dwg-preview": "link:<absolute path of this directory>" },
"dsh": { "profile": { "bundles": [ "…", "@local/dsh-dwg-preview" ] } }
```

Editing a profile file by hand goes through a permission prompt, and breaking it keeps Harness from starting, so please use one of the first three methods for normal installs. A manual install does not install dependencies for you: the host half needs `@mlightcad/libredwg-web`, which you have to add to the profile yourself (Methods 1 to 3 install it from `dependencies`).

## After installing

- **Browser half**: registers the `documentPreviews` renderer and the body of `sidebar.right.tab.document`, loaded with the startup graph; HMR updates need no page refresh.
- **Host half**: registers the two `/api/dwg-preview/*` routes. If the install asks for a restart, **restart the DeepSeek Harness app** (not the page) — the desktop profile's base composition enables HMR with `root: []` (only explicitly registered configuration is watched), and HMR's ignore rules contain `**/node_modules` by default, so plugin code installed under `node_modules` is not watched.
- **The registry has to be there first**: the renderer registers with the registry that the official `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` plugin provides (`dsh.client.inject` declares that load order). While the registry is not ready, the browser half retries every 150 ms for 6 seconds (40 attempts) instead of silently dropping the renderer.
- **The first DWG is slower**: the host lazily loads LibreDWG's wasm (about 9.5 MB) and builds exactly one engine instance, then reuses it.
- **Confirm it is running**: sidebar **Plugins** → find this package and check that the component state is "running"; you can also request `GET /api/dwg-preview/ping` from a session.

### Disable / uninstall

To switch it off temporarily (in the profile's own `cordis.patch.yml`, or straight from the toggle on that row in the plugins page):

```yaml
- id: dwg-preview
  disabled: true
```

To remove it for good: plugins page → this package → **Uninstall**, which drops the package from the profile's dependencies and from `dsh.profile.bundles`.

## Notes

1. **This is not an official plugin**: it has no relationship with DeepSeek AI and comes with no service commitment. It works against Harness's plugin seams and may stop working after a Harness upgrade; when that happens the preview degrades into an error code or "preview failed" and Harness itself still starts.
2. **It does not update itself**: the official plugin manager has no auto-update yet, so upgrading means uninstalling and installing the new version. After replacing an installed package by hand, the host half needs an **app restart** to load the new code (Node's ESM cache is keyed by file URL, so disabling and re-enabling only re-runs `apply()` of the old module); the browser half updates through HMR during development.
3. **Platforms**: it works anywhere DSH runs (Windows / macOS / Linux). The DXF path is plain Node code; the DWG path relies on the `@mlightcad/libredwg-web` wasm, which is cross-platform too. This plugin was tested on the **Windows desktop app with DSH `0.1.7-rc.2`**.
4. **The internal seams it uses are not a stable API**: `connection.fetch.register`, `slots.register`, `locale.register` and the `documentPreviews` registry are internal shapes with no official compatibility promise, and may be renamed or reshaped by a version upgrade.
5. **Permissions**: read-only preview. Apart from appending one `.mount.log` mount marker line in the plugin directory (gitignored, diagnostics only) it writes no file; it does not read your sessions, does not read credentials, does not use the network and has no telemetry.
6. **Where the data is**: the file bytes are handled **only inside the local host process** — read into memory, decoded, rendered, released when the request ends; the rendered result is cached in memory by sha1 (at most 6 drawings, gone when the process exits). The browser half only ever receives an SVG string. Nothing is uploaded and nothing is written to disk.
7. **Redistributing it together has a GPL-3.0 price**: DWG decoding depends on `@mlightcad/libredwg-web` (GPL-3.0), which the Harness profile installs separately from `dependencies`; this repository does not distribute it. If you bundle this plugin together with it and redistribute that, the combination falls under GPL-3.0; this repository's own code stays MIT.
8. **Failure degrades, it does not crash**: an empty file is `400 EMPTY`, over 64 MB is `413 TOO_LARGE`, unrecognised content or a failed decode is `500 FAILED`, and the UI shows "preview failed" with the reason; the routes keep every exception inside the response and never take the host process down.
9. **Nothing destructive**: it does not delete, overwrite or rename any file, and does not modify the profile configuration; the only write is that one mount marker line. Uninstalling removes the package itself.
10. **64 MB is the request-body cap**: anything larger is not decoded and returns `TOO_LARGE` straight away. A large drawing within the cap still costs the host process memory and keeps it synchronously busy for a moment (rendering is synchronous).
11. **No editing features**: no entity picking, layer toggles, dimension editing, print or export. Entities the renderer does not know are silently ignored, so when "it drew something but is missing parts", check the entity list above first.
12. **Privacy**: this repository contains no credential, no account identifier and no local machine path; the sample drawing `test/sample.dxf` was written for this repository and holds no real drawing data.

## Self-check

```bash
node test/selfcheck.mjs      # or pnpm test
node tools/make-example.mjs  # regenerate docs/example.svg (or pnpm run example)
```

The self-check needs no network, no Harness, no React and no installed dependency: plain Node runs all 31 checks, prints `31/31 checks passed` and exits 0 when everything holds, and exits non-zero on any failure (so it can go straight into CI). Note that `pnpm test` goes through pnpm's own pipeline: on its first run it really installs the dependencies from `dependencies` (so it writes `node_modules/` and `pnpm-lock.yaml`, both of which are in `.gitignore` and are not distributed with the repository), and once `@mlightcad/libredwg-web` is installed the DWG check skips itself with a printed reason — real decoding can only be verified in a profile that has the dependency. What it does:

- renders `test/sample.dxf` with the real renderer and pins `stats` per type (LINE 11, CIRCLE 5, ARC 1, …) plus the SVG structure: the exact `viewBox` numbers, the single root `g`, the `translate(0 80) scale(1 -1)` flip, `non-scaling-stroke`, and balanced tags;
- one `<text>` each for TEXT / MTEXT / ATTRIB (4 in total), all flipped back inside the flipped group, with XML special characters escaped;
- synthetic drawings verify the junk-geometry filter (`stats.__stray`), absolute layer colours, skipped frozen layers, and the error thrown for an empty drawing;
- drives `client.js`: the claimed suffixes (`dwg`/`dxf`), `priority: 'extension'`, the keyed body (`sidebar.right.tab.document` + `@local/dsh-dwg-preview/dwg`), matching zh/en dictionary keys, a stylesheet installed once — and asserts that `require` was only ever called with `'react'` (the moment it reaches for any official client package, the self-check fails right there);
- runs the view against a stub `fetch`: the bytes are `POST`ed to `/api/dwg-preview/svg`, `x-dwg-name` is percent-encoded, the returned SVG becomes a Blob URL, the entity total reads `31 个图元`; zoom in / zoom out / fit width, Ctrl + wheel and drag-to-pan each have their percentage and scroll offset asserted;
- drives `index.js`'s `apply()` with a fake `ctx` and really calls both routes: `ping`, a DXF round trip (a second identical file is served from the cache), an empty body `400 EMPTY`, garbage content `500 FAILED`, an over-64 MB body `413 TOO_LARGE` (the request body is a zero-filled `SharedArrayBuffer` view one byte over the cap: no copy, no 64 MB of memory), and an `AC10xx` body taking the DWG branch;
- asserts the packaging constraints: `package.json`'s license / repository / keywords / `files` covering every file in the tree, `engines.node` and **no** `engines.dsh`; `.gitignore` covering `node_modules/`, `*.log`, `.mount.log`; both READMEs agreeing on chapters, code fences and table row counts; and a whole-tree scan finding no credential, no personal absolute path, and the copyright holder's name only in LICENSE / package.json / both READMEs.

What it does **not** prove, stated plainly:

- **DWG decoding itself**: `@mlightcad/libredwg-web` is a runtime dependency outside this repository (see the licence), so all that is checked here is that content starting with `AC10xx` takes the DWG branch and that a missing dependency is reported honestly as `FAILED`. Real DWG decoding can only be tried in a profile that has the dependency installed; when the self-check finds it present, it skips that one check and prints the reason.
- **A real browser**: the browser half runs on a stub `__ModuleLoader__` and a minimal hook runtime, not a DOM, and without the official registry, so fonts, paints and the real semantics of Blob are not covered.
- **The behaviour of the official seams**: `documentPreviews`, `slots`, `locale` and `connection.fetch.register` are all doubles in the self-check, and HMR and the restart rules cannot be verified here either.
- **Glyphs and line types**: the SVG depends on system fonts, and the self-check inspects attributes, not glyph shapes.

## Layout

```
package.json           bundle manifest (dsh.bundle.patch + dsh.client)
cordis.patch.yml       one insert row: mounts the host half
index.js               host half: the two /api/dwg-preview/* routes, content sniffing, sha1 cache
client.js              browser half: documentPreviews renderer + sidebar.right.tab.document view (hand-written lazy CJS, react only)
lib/dxf2svg.mjs        dependency-free DXF -> SVG renderer (dxfToSvg(text, options))
icon.svg               plugin icon
docs/example.svg       demo image generated from test/sample.dxf (the one at the top)
test/sample.dxf        sample drawing: covers the 14 entity types listed above
test/selfcheck.mjs     self-check (31 checks)
tools/make-example.mjs regenerates docs/example.svg
```

## Credits and third-party licences

- **`@mlightcad/libredwg-web` (GPL-3.0)**: the DWG decoding dependency, i.e. the WebAssembly wrapper around LibreDWG (upstream LibreDWG is GPL-3.0 as well). It is an npm package the Harness profile installs separately from `dependencies`; **this repository does not distribute it, does not vendor it and does not bundle it into any artifact**. Bundling this plugin together with it for redistribution puts that combination under GPL-3.0; this repository's own code stays MIT (see [LICENSE](LICENSE)).
- **No copied third-party plugin code**: `index.js`, `client.js`, `lib/dxf2svg.mjs` and `test/sample.dxf` were all written for this plugin; the ACI colour values come from the DXF specification itself.
- **Harness seams it uses**: the `connection`, `slots` and `locale` services, plus the `documentPreviews` registry that the official `sidebar-documentpreview` plugin provides. The browser half itself does not `require` any official client package and loads no third-party viewer library (no three.js, no dxf-parser, no wasm in the page); `dsh.client.inject` only declares a load order, it is not a code reference.

## License

[MIT](LICENSE) © 2026 linanbuan
