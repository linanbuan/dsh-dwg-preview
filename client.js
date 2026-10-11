/**
 * DWG / DXF sidebar preview - browser half.
 *
 * Registers one document renderer: the .dwg and .dxf suffixes, claimed at the
 * "extension" band, plus the keyed body that draws them in
 * sidebar.right.tab.document. Bytes are handed to the host half
 * (POST /api/dwg-preview/svg), which decodes the DWG with LibreDWG/WASM and
 * returns a self-contained SVG; this half only shows it, so no wasm, worker or
 * third-party viewer library is loaded into the page.
 *
 * @module @local/dsh-dwg-preview/client
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-dwg-preview',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    /** Body identity, shared by the metadata registration and the keyed slot. */
    var BODY_ID = '@local/dsh-dwg-preview/dwg'
    /** Locale namespace this bundle registers its dictionary under. */
    var NS = 'dwgPreview'
    /** Marker used to inject the plugin stylesheet once. */
    var STYLE_ID = 'dsh-dwg-preview-css'
    /** Suffixes this renderer claims. */
    var EXTENSIONS = ['dwg', 'dxf']

    var DICT = {
      zh: {
        title: 'DWG 图纸',
        loading: '正在解析图纸…',
        failed: '预览失败',
        zoomIn: '放大',
        zoomOut: '缩小',
        fit: '适应宽度',
        entities: '{count} 个图元',
        seconds: '{value} 秒',
      },
      en: {
        title: 'DWG drawing',
        loading: 'Reading the drawing…',
        failed: 'Preview failed',
        zoomIn: 'Zoom in',
        zoomOut: 'Zoom out',
        fit: 'Fit width',
        entities: '{count} entities',
        seconds: '{value} s',
      },
    }

    var CSS = [
      '.dshdwg-root{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:#fff}',
      '.dshdwg-bar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid rgba(127,127,127,.25);flex:none;font-size:12px}',
      '.dshdwg-btn{min-width:26px;height:22px;padding:0 8px;border:1px solid rgba(127,127,127,.35);border-radius:5px;background:transparent;color:inherit;font-size:12px;line-height:1;cursor:pointer}',
      '.dshdwg-btn:hover{background:rgba(127,127,127,.12)}',
      '.dshdwg-meta{margin-left:auto;opacity:.6;font-variant-numeric:tabular-nums}',
      '.dshdwg-scroll{flex:1 1 auto;min-height:0;overflow:auto;background:#fff;display:block;padding:4px 0;cursor:grab;touch-action:none}',
      '.dshdwg-scroll.dshdwg-dragging{cursor:grabbing}',
      '.dshdwg-scroll.dshdwg-dragging .dshdwg-img{pointer-events:none}',
      '.dshdwg-img{display:block;margin:0 auto;background:#fff;user-select:none;-webkit-user-drag:none}',
      '.dshdwg-status{display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;height:100%;padding:24px;font-size:13px;opacity:.75;text-align:center}',
      '.dshdwg-msg{opacity:.75;font-size:12px;word-break:break-word;max-width:40ch}',
    ].join('\n')

    /** Inject the plugin stylesheet once per document. */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return
      var tag = document.createElement('style')
      tag.dataset.plugin = '@local/dsh-dwg-preview'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** Last path segment of a resource address, decoded. */
    function fileNameOf(address) {
      if (typeof address !== 'string') return ''
      var clean = address.split('?')[0].split('#')[0]
      var parts = clean.split('/')
      var last = parts[parts.length - 1] || ''
      try { return decodeURIComponent(last) } catch (error) { return last }
    }

    /** Count of drawn entities, ignoring the renderer's own bookkeeping keys. */
    function countEntities(stats) {
      var total = 0
      if (stats === undefined || stats === null) return total
      for (var key in stats) {
        if (key.indexOf('__') === 0) continue
        var value = stats[key]
        if (typeof value === 'number') total += value
      }
      return total
    }

    /**
     * The DWG body: post the bytes, then show the returned vector drawing.
     * @param props document bytes, resource identity, and copy.
     */
    function DwgBody(props) {
      var t = props.t
      var name = fileNameOf(props.resourceAddress)
      var data = props.content !== undefined && props.content.kind === 'bytes' ? props.content.data : undefined
      var viewState = useState({ status: 'loading' })
      var view = viewState[0]
      var setView = viewState[1]
      var zoomState = useState(0)
      var zoom = zoomState[0]
      var setZoom = zoomState[1]
      var scrollRef = useRef(null)
      var imgRef = useRef(null)
      var dragRef = useRef(null)
      var sizeRef = useRef(null)
      var dragState = useState(false)
      var dragging = dragState[0]
      var setDragging = dragState[1]

      /** Bind our own scroll node and hand the same node to the parent's scroll owner. */
      var bindScrollport = function (node) {
        scrollRef.current = node
        var outer = props.scrollportRef
        if (typeof outer === 'function') outer(node)
        else if (outer !== null && typeof outer === 'object') outer.current = node
      }

      // Keep the point under the viewport centre steady while the drawing scales.
      useEffect(function () {
        var node = scrollRef.current
        var img = imgRef.current
        if (node === null || img === null) return
        var width = img.clientWidth
        var height = img.clientHeight
        var previous = sizeRef.current
        if (previous !== null && previous.width > 0 && width > 0 && (previous.width !== width || previous.height !== height)) {
          node.scrollLeft = (node.scrollLeft + node.clientWidth / 2) * (width / previous.width) - node.clientWidth / 2
          node.scrollTop = (node.scrollTop + node.clientHeight / 2) * (height / previous.height) - node.clientHeight / 2
        }
        sizeRef.current = { width: width, height: height }
      })

      // Ctrl/Cmd + wheel zooms, a plain wheel keeps scrolling. A native listener is
      // needed because React registers wheel passively and cannot preventDefault.
      useEffect(function () {
        var node = scrollRef.current
        if (node === null) return undefined
        var onWheel = function (event) {
          if (event.ctrlKey !== true && event.metaKey !== true) return
          event.preventDefault()
          var factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
          setZoom(function (value) { return Math.min(25, Math.max(0.2, (value || 1) * factor)) })
        }
        node.addEventListener('wheel', onWheel, { passive: false })
        return function () { node.removeEventListener('wheel', onWheel) }
      }, [view.status])

      /** Drag anywhere in the viewport to pan, the way a CAD viewer does. */
      var onPointerDown = function (event) {
        if (event.button !== 0) return
        var node = scrollRef.current
        if (node === null) return
        dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* capture is best effort */ }
        setDragging(true)
      }
      var onPointerMove = function (event) {
        var drag = dragRef.current
        if (drag === null || drag.id !== event.pointerId) return
        var node = scrollRef.current
        if (node === null) return
        node.scrollLeft = drag.left - (event.clientX - drag.x)
        node.scrollTop = drag.top - (event.clientY - drag.y)
      }
      var endDrag = function (event) {
        var drag = dragRef.current
        if (drag === null || drag.id !== event.pointerId) return
        dragRef.current = null
        setDragging(false)
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch (error) { /* already released */ }
      }

      useEffect(function () {
        if (data === undefined) return undefined
        var cancelled = false
        var url
        setView({ status: 'loading' })
        var run = async function () {
          try {
            var response = await fetch('/api/dwg-preview/svg', {
              method: 'POST',
              credentials: 'include',
              // Header values are ISO-8859-1 only, so a Chinese file name must be
              // percent-encoded before it can travel here; the host only logs it.
              headers: { 'content-type': 'application/octet-stream', 'x-dwg-name': encodeURIComponent(name) },
              cache: 'no-store',
              body: data,
              signal: AbortSignal.timeout(180000),
            })
            var payload = await response.json()
            if (cancelled === true) return
            if (payload.ok !== true) {
              setView({ status: 'error', message: payload.message || t('failed') })
              return
            }
            url = URL.createObjectURL(new Blob([payload.svg], { type: 'image/svg+xml' }))
            setView({ status: 'ready', url: url, count: countEntities(payload.stats), kind: payload.kind })
          } catch (error) {
            if (cancelled === true) return
            setView({ status: 'error', message: String((error && error.message) || error) })
          }
        }
        run()
        return function () {
          cancelled = true
          if (url !== undefined) URL.revokeObjectURL(url)
        }
      }, [data])

      if (data === undefined || view.status === 'loading') {
        return h('div', { className: 'dshdwg-status' }, t('loading'))
      }
      if (view.status === 'error') {
        return h('div', { className: 'dshdwg-status', role: 'alert' },
          h('strong', null, t('failed')),
          h('span', { className: 'dshdwg-msg' }, view.message))
      }

      var bar = h('div', { className: 'dshdwg-bar' },
        h('button', {
          type: 'button', className: 'dshdwg-btn', title: t('zoomOut'),
          onClick: function () { setZoom(function (value) { return Math.max(0.2, (value || 1) * 0.8) }) },
        }, '\u2212'),
        h('button', {
          type: 'button', className: 'dshdwg-btn', title: t('zoomIn'),
          onClick: function () { setZoom(function (value) { return Math.min(25, (value || 1) * 1.25) }) },
        }, '+'),
        h('button', {
          type: 'button', className: 'dshdwg-btn', title: t('fit'),
          onClick: function () { setZoom(0) },
        }, t('fit')),
        h('span', { className: 'dshdwg-meta' }, t('entities', { count: view.count })))

      var style = zoom === 0 ? { width: '100%' } : { width: (zoom * 100) + '%' }
      return h('div', { className: 'dshdwg-root' },
        bar,
        h('div', {
          className: dragging === true ? 'dshdwg-scroll dshdwg-dragging' : 'dshdwg-scroll',
          ref: bindScrollport,
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
        },
          h('img', { ref: imgRef, className: 'dshdwg-img', src: view.url, style: style, alt: name, draggable: false })))
    }

    /**
     * Register the dictionaries, the renderer metadata, and its body.
     * @param ctx client plugin context.
     */
    function apply(ctx) {
      ensureStyle()
      var locale = ctx.get('locale')
      var translate
      if (locale !== undefined) {
        ctx.effect(function () {
          var offZh = locale.register(NS, 'zh', DICT.zh)
          var offEn = locale.register(NS, 'en', DICT.en)
          try { translate = locale.bind(NS) } catch (error) { translate = undefined }
          return function () {
            translate = undefined
            offZh()
            offEn()
          }
        }, 'dsh-dwg-preview: dictionaries')
      }

      var t = function (key, params) {
        var text
        if (translate !== undefined) text = translate(key)
        if (text === undefined || text === null || text === '' || text === key) text = DICT.zh[key] || key
        if (params !== undefined && params !== null) {
          for (var name in params) text = text.split('{' + name + '}').join(String(params[name]))
        }
        return text
      }

      // The document-preview registry is provided by the shipped
      // sidebar-documentpreview plugin, which the bundle metadata loads first; poll
      // briefly so a slow provider cannot silently drop the renderer.
      var attempts = 0
      var wired = false
      var wire = function () {
        if (wired) return
        var previews = ctx.get('documentPreviews')
        if (previews === undefined) {
          if (attempts++ < 40) setTimeout(wire, 150)
          return
        }
        wired = true
        ctx.effect(function () {
          return previews.register({
            id: BODY_ID,
            extensions: EXTENSIONS,
            binaryExtensions: EXTENSIONS,
            priority: 'extension',
            title: function () { return t('title') },
            loading: 'bytes-complete',
            wrap: false,
          })
        }, 'dsh-dwg-preview: metadata')
        ctx.slots.inject('sidebar.right.tab.document', function () {
          return ctx.slots.register({ name: 'sidebar.right.tab.document', key: BODY_ID, locale: NS },
            function (bodyProps) { return h(DwgBody, Object.assign({}, bodyProps, { t: t })) })
        })
      }
      wire()
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
