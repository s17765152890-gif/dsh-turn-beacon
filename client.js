window.__ModuleLoader__.load({
  id: 'dsh-turn-beacon',
  factory(require) {
    const React = require('react')

    const NS = 'turnBeacon'
    const BOOKMARK_KEY = 'turn-beacon:bookmarks:v2'
    const MEDIA_URL = '/api/turn-beacon/media'
    // 本地媒体桥（wallpaper-engine media bridge）的系统音频频谱：64 段 0-255，
    // Windows 上来自 WASAPI loopback。只在它报告 running 且确实有信号时才采用。
    const SPECTRUM_URL = '/wallpaper-engine/audio-spectrum'
    const RAIL_ATTR = 'data-tb-rail'
    const LIVE_CLASS = 'tb-rail-live'
    const NAV_SELECTOR = [
      '.SNx2jG_frame',
      'nav:has(> div > div > button[data-index])',
    ].join(', ')

    // ---------------------------------------------------------------- locale
    const en = { add: 'Bookmark this turn', remove: 'Remove bookmark' }
    const zh = { add: '收藏本回合', remove: '取消收藏' }
    const dictionaries = { en, zh, ja: en, es: en, fr: en, de: en, ru: en, pt: en }

    // ------------------------------------------------------------- bookmarks
    function readSet() {
      try {
        const raw = localStorage.getItem(BOOKMARK_KEY)
        const parsed = raw ? JSON.parse(raw) : []
        return new Set(Array.isArray(parsed) ? parsed : [])
      } catch { return new Set() }
    }
    const bookmarks = readSet()
    let sessionScope = 'local'
    const bookmarkKey = turn => `${sessionScope}:${turn}`
    function saveBookmarks() {
      try { localStorage.setItem(BOOKMARK_KEY, JSON.stringify([...bookmarks])) } catch { /* storage disabled */ }
    }

    // -------------------------------------------------------------- playback
    let systemPlaying = false
    let pagePlaying = false
    const playing = () => systemPlaying || pagePlaying

    let watchUsers = 0
    let stopWatchers = null
    function watchMedia() {
      if (stopWatchers) return
      let disposed = false

      const checkPage = () => {
        let now = false
        try {
          for (const node of document.querySelectorAll('audio, video')) {
            if (!node.paused && !node.ended) { now = true; break }
          }
          const session = navigator.mediaSession
          if (!now && session && session.playbackState === 'playing') now = true
        } catch { /* unsupported browser */ }
        if (now !== pagePlaying) { pagePlaying = now; onPlaybackChange() }
      }
      const onEvent = () => { checkPage() }
      document.addEventListener('play', onEvent, true)
      document.addEventListener('playing', onEvent, true)
      document.addEventListener('pause', onEvent, true)
      document.addEventListener('ended', onEvent, true)

      const checkSystem = async () => {
        if (disposed) return
        try {
          const response = await fetch(MEDIA_URL, { cache: 'no-store' })
          if (!response.ok) throw new Error('status ' + response.status)
          const data = await response.json()
          const now = Boolean(data && data.playing)
          if (now !== systemPlaying) { systemPlaying = now; onPlaybackChange() }
        } catch { /* Host bridge unavailable */ }
      }

      checkPage()
      void checkSystem()
      const pageTimer = setInterval(checkPage, 1500)
      const systemTimer = setInterval(() => { void checkSystem() }, 1000)

      stopWatchers = () => {
        disposed = true
        clearInterval(pageTimer)
        clearInterval(systemTimer)
        document.removeEventListener('play', onEvent, true)
        document.removeEventListener('playing', onEvent, true)
        document.removeEventListener('pause', onEvent, true)
        document.removeEventListener('ended', onEvent, true)
        systemPlaying = false
        pagePlaying = false
      }
    }

    function releaseWatcher() {
      watchUsers--
      if (watchUsers <= 0 && stopWatchers) { stopWatchers(); stopWatchers = null }
    }

    // -------------------------------------------------------------- spectrum
    const BAND_COUNT = 64
    const bands = new Float32Array(BAND_COUNT)
    let bandsLive = false
    let silentPolls = 0
    let spectrumTimer = null
    let spectrumBusy = false

    function pollSpectrum() {
      if (spectrumBusy) return
      spectrumBusy = true
      fetch(SPECTRUM_URL, { cache: 'no-store' })
        .then(response => (response.ok ? response.json() : null))
        .then(data => {
          if (!data || !Array.isArray(data.bands) || data.running !== true) {
            bandsLive = false
            return
          }
          const list = data.bands
          const size = Math.min(BAND_COUNT, list.length)
          let total = 0
          for (let i = 0; i < size; i += 1) {
            const value = Number(list[i]) || 0
            bands[i] = value
            total += value
          }
          for (let i = size; i < BAND_COUNT; i += 1) bands[i] = 0
          if (total <= 0) {
            silentPolls += 1
            if (silentPolls > 8) bandsLive = false
          } else {
            silentPolls = 0
            bandsLive = true
          }
        })
        .catch(() => { bandsLive = false })
        .finally(() => { spectrumBusy = false })
    }

    function startSpectrum() {
      if (spectrumTimer) return
      pollSpectrum()
      spectrumTimer = setInterval(pollSpectrum, 70)
    }
    function stopSpectrum() {
      if (spectrumTimer) { clearInterval(spectrumTimer); spectrumTimer = null }
      bands.fill(0)
      bandsLive = false
      silentPolls = 0
    }

    // ------------------------------------------------------------ wave engine
    /** Pointer ripples: `{ index, at, amp }`, newest last, propagate and decay. */
    const ripples = []
    const RIPPLE_LIFE = 1500
    const written = new WeakMap()

    let envBass = 0
    let envMid = 0
    let envHigh = 0
    let envKick = 0
    let phase = 0
    let rafId = 0
    let lastFrame = 0
    let pointerInside = false

    const clamp = (value, low, high) => (value < low ? low : value > high ? high : value)
    const approach = (current, target, attack, release) =>
      current + (target - current) * (target > current ? attack : release)

    function featuresOf(now, dt) {
      const seconds = now / 1000
      let bass = 0
      let mid = 0
      let high = 0
      if (bandsLive) {
        for (let i = 0; i < 11; i += 1) bass += bands[i]
        for (let i = 11; i < 35; i += 1) mid += bands[i]
        for (let i = 35; i < BAND_COUNT; i += 1) high += bands[i]
        bass /= 11 * 255
        mid /= 24 * 255
        high /= 29 * 255
      } else {
        // 桥不可用（未装 / 未授权 / 被关掉）时退化成有机漂移：两个无理比例的
        // 慢振荡叠一点伪噪声，避免"死循环"的机械感，也不假装在分析音频。
        bass = 0.22 + 0.16 * Math.sin(seconds * 0.63) + 0.08 * Math.sin(seconds * 1.71 + 1.2)
        mid = 0.18 + 0.12 * Math.sin(seconds * 0.47 + 2.1)
        high = 0.14 + 0.10 * Math.sin(seconds * 1.13 + 0.7)
      }
      const k = 1 - Math.exp(-dt * 9)
      envBass = approach(envBass, clamp(bass, 0, 1), k * 1.6, k * 0.45)
      envMid = approach(envMid, clamp(mid, 0, 1), k * 1.2, k * 0.5)
      envHigh = approach(envHigh, clamp(high, 0, 1), k * 1.4, k * 0.6)
      // 低频起音（kick）单独抽出来做一次"整列一起被打一下"的冲击感。
      const kickTarget = envBass > envKick ? Math.max(0, envBass - envKick) * 2.2 : 0
      envKick = approach(envKick, clamp(kickTarget, 0, 1), k * 3, k * 0.28)
    }

    function rippleAt(index, now) {
      let total = 0
      for (let i = ripples.length - 1; i >= 0; i -= 1) {
        const ripple = ripples[i]
        const age = now - ripple.at
        if (age > RIPPLE_LIFE) { ripples.splice(i, 1); continue }
        const life = 1 - age / RIPPLE_LIFE
        const distance = index - ripple.index
        const spread = 2.4
        total += ripple.amp * life * life * Math.exp(-(distance * distance) / (2 * spread * spread))
          * Math.cos(age * 0.016 - Math.abs(distance) * 0.9)
      }
      return total
    }

    function paint(now, active) {
      if (!railNav) return
      const marks = railNav.querySelectorAll('button[data-index]')
      if (marks.length === 0) return
      document.documentElement.classList.toggle(LIVE_CLASS, active)
      if (!active) { clearPaint(marks); return }

      // 时间与空间频率都由音频本身推着变：波速跟高频，波长跟中频，振幅跟低频。
      const speed = 1.4 + 6.5 * envHigh + envKick * 3.2
      phase += speed * 0.016
      const wavelength = 2.6 + 5.4 * (1 - envMid)
      const amplitude = 0.12 + 1.05 * envBass + envKick * 0.55

      for (let i = 0, n = marks.length; i < n; i += 1) {
        const mark = marks[i]
        const index = Number(mark.getAttribute('data-index')) || i
        const travelling = Math.sin(phase - index / wavelength)
          + 0.55 * Math.sin(phase * 0.62 - index / (wavelength * 1.8) + 1.7)
          + 0.28 * Math.sin(phase * 1.37 + index / (wavelength * 0.7) + 0.4)
        const ripple = rippleAt(index, now)
        const scale = clamp(0.62 + amplitude * travelling * 0.62 + ripple * 0.55, 0.22, 1.95)
        const opacity = clamp(0.42 + Math.abs(travelling) * 0.42 + Math.abs(ripple) * 0.5, 0.3, 1)

        const previous = written.get(mark)
        if (previous !== undefined
          && Math.abs(previous.scale - scale) < 0.008
          && Math.abs(previous.opacity - opacity) < 0.008) continue
        mark.style.setProperty('--tb-s', scale.toFixed(3))
        mark.style.setProperty('--tb-o', opacity.toFixed(3))
        written.set(mark, { scale, opacity })
      }
    }

    function clearPaint(marks) {
      const list = marks || (railNav ? railNav.querySelectorAll('button[data-index]') : [])
      for (const mark of list) {
        if (written.has(mark)) {
          mark.style.removeProperty('--tb-s')
          mark.style.removeProperty('--tb-o')
          written.delete(mark)
        }
      }
    }

    function loop(time) {
      const dt = lastFrame === 0 ? 0.016 : Math.min(0.05, (time - lastFrame) / 1000)
      lastFrame = time
      featuresOf(time, dt)
      const active = pointerInside || playing() || ripples.length > 0
      paint(time, active)
      if (!active) { stopLoop(); return }
      rafId = requestAnimationFrame(loop)
    }

    function startLoop() {
      if (rafId || reducedMotion) return
      lastFrame = 0
      rafId = requestAnimationFrame(loop)
    }
    function stopLoop() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
      document.documentElement.classList.remove(LIVE_CLASS)
      clearPaint()
      ripples.length = 0
      envBass = 0
      envMid = 0
      envHigh = 0
      envKick = 0
    }

    const reducedMotion = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches

    function onPlaybackChange() {
      if (playing()) {
        startSpectrum()
        startLoop()
      } else {
        stopSpectrum()
        if (!pointerInside) stopLoop()
      }
    }

    // ------------------------------------------------------------ rail bridge
    let railNav = null
    let ourButton = null
    let hoveredTurn = null
    let navObserver = null
    let bodyObserver = null
    let syncFrame = 0
    let pointerFrame = 0
    let lastPointerY = 0
    let lastRipple = 0
    let lastRippleY = 0
    let translate = key => key

    function turnOf(mark) {
      const label = mark.getAttribute('aria-label') || ''
      const found = label.match(/\d+/)
      if (found) return Number(found[0])
      const index = Number(mark.getAttribute('data-index'))
      return Number.isFinite(index) ? index + 1 : null
    }

    function removeButton() {
      if (ourButton && ourButton.parentNode) ourButton.parentNode.removeChild(ourButton)
      ourButton = null
    }

    function onClick(event) {
      event.preventDefault()
      event.stopPropagation()
      const turn = Number(ourButton && ourButton.dataset.turn)
      if (!Number.isFinite(turn)) return
      const key = bookmarkKey(turn)
      if (bookmarks.has(key)) bookmarks.delete(key)
      else bookmarks.add(key)
      saveBookmarks()
      syncRail()
    }

    function ensureButton() {
      if (ourButton && railNav && ourButton.parentNode === railNav) return ourButton
      removeButton()
      if (!railNav) return null
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'tb-rb'
      button.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" '
        + 'stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">'
        + '<path d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4-6.5 4v-16a1 1 0 0 1 1-1z"/></svg>'
      button.addEventListener('click', onClick, true)
      button.addEventListener('pointerdown', event => event.stopPropagation(), true)
      railNav.appendChild(button)
      ourButton = button
      return button
    }

    function syncMarks() {
      if (!railNav) return
      for (const mark of railNav.querySelectorAll('button[data-index]')) {
        const turn = turnOf(mark)
        const booked = turn !== null && bookmarks.has(bookmarkKey(turn))
        if (booked) {
          mark.setAttribute('data-tb-booked', '1')
          if (!mark.querySelector('.tb-bk-dot')) {
            const dot = document.createElement('span')
            dot.className = 'tb-bk-dot'
            dot.setAttribute('aria-hidden', 'true')
            mark.appendChild(dot)
          }
        } else {
          if (mark.hasAttribute('data-tb-booked')) mark.removeAttribute('data-tb-booked')
          const dot = mark.querySelector('.tb-bk-dot')
          if (dot) dot.remove()
        }
      }
    }

    function syncButton() {
      if (!railNav) return
      const preview = railNav.querySelector('[role="tooltip"]')
      if (!preview || hoveredTurn === null) { removeButton(); return }
      const button = ensureButton()
      if (!button) return
      button.style.top = `${preview.offsetTop + preview.offsetHeight / 2}px`
      button.dataset.turn = String(hoveredTurn)
      const booked = bookmarks.has(bookmarkKey(hoveredTurn))
      const label = translate(booked ? 'remove' : 'add')
      button.setAttribute('aria-pressed', booked ? 'true' : 'false')
      button.setAttribute('aria-label', label)
      button.title = label
    }

    function syncRail() { syncMarks(); syncButton() }

    function schedule() {
      if (syncFrame) return
      syncFrame = requestAnimationFrame(() => { syncFrame = 0; syncRail() })
    }

    function applyPointer(y) {
      if (!railNav) return
      const marks = railNav.querySelectorAll('button[data-index]')
      let nearest = null
      let best = Infinity
      for (const mark of marks) {
        const box = mark.getBoundingClientRect()
        const center = box.top + box.height / 2
        const distance = Math.abs(center - y)
        if (distance < best) { best = distance; nearest = mark }
      }
      if (nearest === null) return
      hoveredTurn = turnOf(nearest)
      syncButton()
    }

    function onPointerMove(event) {
      if (!railNav) return
      pointerInside = true
      if (!rafId) startLoop()
      lastPointerY = event.clientY
      if (!pointerFrame) {
        pointerFrame = requestAnimationFrame(() => { pointerFrame = 0; applyPointer(lastPointerY) })
      }
      // 手指划过水面：每次移动都在指针所在那一格注入一个涟漪源，向两侧扩散衰减。
      const now = performance.now()
      if (now - lastRipple < 55) return
      if (Math.abs(event.clientY - lastRippleY) < 2.5) return
      lastRipple = now
      lastRippleY = event.clientY
      const mark = document.elementFromPoint(event.clientX, event.clientY)
      const bucket = mark && mark.closest ? mark.closest('button[data-index]') : null
      const index = bucket ? Number(bucket.getAttribute('data-index')) : Math.round(hoveredTurn || 0)
      if (!Number.isFinite(index)) return
      ripples.push({ index, at: now, amp: 0.55 })
      if (ripples.length > 6) ripples.shift()
    }

    function onPointerLeave() {
      pointerInside = false
      hoveredTurn = null
      lastRippleY = 0
      removeButton()
      if (!playing()) {
        // 让最后几个涟漪自然收完再停，而不是立刻掐断。
        setTimeout(() => { if (!playing() && !pointerInside) stopLoop() }, RIPPLE_LIFE + 120)
      }
    }

    function attach(nav) {
      if (!nav || nav.hasAttribute(RAIL_ATTR)) return
      railNav = nav
      nav.setAttribute(RAIL_ATTR, '1')
      nav.addEventListener('pointermove', onPointerMove)
      nav.addEventListener('pointerleave', onPointerLeave)
      if (typeof MutationObserver !== 'undefined') {
        navObserver = new MutationObserver(() => { schedule() })
        navObserver.observe(nav, { childList: true, subtree: true })
      }
      if (playing()) startSpectrum()
      if (playing() || pointerInside) startLoop()
      syncRail()
    }

    function detach() {
      if (navObserver) { navObserver.disconnect(); navObserver = null }
      if (railNav) {
        railNav.removeEventListener('pointermove', onPointerMove)
        railNav.removeEventListener('pointerleave', onPointerLeave)
        for (const mark of railNav.querySelectorAll('[data-tb-booked]')) mark.removeAttribute('data-tb-booked')
        for (const dot of railNav.querySelectorAll('.tb-bk-dot')) dot.remove()
        clearPaint()
        railNav.removeAttribute(RAIL_ATTR)
      }
      removeButton()
      railNav = null
    }

    function locate() {
      if (railNav && document.documentElement.contains(railNav)) return
      if (railNav) detach()
      let candidate = null
      try {
        candidate = document.querySelector(NAV_SELECTOR)
      } catch {
        // 老引擎不认 `:has()` 时退回已编译的类名选择器。
        candidate = document.querySelector('.SNx2jG_frame')
      }
      if (candidate) attach(candidate)
    }

    // ----------------------------------------------------------------- styles
    const CSS = `
[${RAIL_ATTR}] button[data-index][data-tb-booked="1"]::before{
  transform:translateY(-50%) scaleX(1.1);
  background:linear-gradient(90deg,var(--dsw-alias-border-l4),var(--dsw-alias-brand-primary));
  opacity:1;
  box-shadow:0 0 6px 0 var(--dsw-alias-brand-primary);
  transition:transform .3s ease,background .3s ease;
}
html.${LIVE_CLASS} [${RAIL_ATTR}] button[data-index]::before{
  transform:translateY(-50%) scaleX(var(--tb-s,.62));
  opacity:var(--tb-o,1);
  background:var(--dsw-alias-brand-primary);
  transition:none;
  will-change:transform,opacity;
}
html.${LIVE_CLASS} [${RAIL_ATTR}] button[data-index][aria-current="true"]::before{
  background:var(--dsw-alias-label-primary);
}
html.${LIVE_CLASS} [${RAIL_ATTR}] button[data-index][data-tb-booked="1"]::before{
  background:linear-gradient(90deg,var(--dsw-alias-brand-primary),var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary)));
  box-shadow:0 0 7px 0 var(--dsw-alias-brand-primary);
}
.tb-bk-dot{
  position:absolute;top:50%;right:24px;width:3px;height:3px;border-radius:50%;
  background:var(--dsw-alias-brand-primary);transform:translateY(-50%);pointer-events:none;
}
.tb-rb{
  position:absolute;right:26px;z-index:8;display:inline-flex;align-items:center;justify-content:center;
  width:20px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;
  transform:translateY(-50%);box-shadow:var(--dsw-elevation-panel);
  transition:color .2s ease,border-color .2s ease,background .2s ease;
}
.tb-rb:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.tb-rb[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.tb-rb svg{display:block}
@media(prefers-reduced-motion:reduce){
  html.${LIVE_CLASS} [${RAIL_ATTR}] button[data-index]::before{transition:none}
}
`

    // ------------------------------------------------------------------ mount
    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale')
        if (locale) locale.register(NS, dictionaries)
        const bound = locale ? locale.bind(NS) : null
        translate = key => {
          if (bound) return bound(key)
          return document.documentElement.lang.toLowerCase().startsWith('en') ? en[key] : zh[key]
        }

        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.turnBeacon = '1'
          tag.textContent = CSS
          document.head.append(tag)
          return () => { tag.remove() }
        }, 'turn-beacon: stylesheet')

        ctx.effect(() => {
          watchUsers++
          watchMedia()
          return () => { releaseWatcher(); stopSpectrum(); stopLoop() }
        }, 'turn-beacon: audio')

        ctx.effect(() => {
          locate()
          if (typeof MutationObserver !== 'undefined') {
            bodyObserver = new MutationObserver(() => { locate(); schedule() })
            bodyObserver.observe(document.body, { childList: true, subtree: true })
          }
          const onResize = () => { schedule() }
          globalThis.addEventListener('resize', onResize)
          return () => {
            globalThis.removeEventListener('resize', onResize)
            if (bodyObserver) { bodyObserver.disconnect(); bodyObserver = null }
            if (syncFrame) { cancelAnimationFrame(syncFrame); syncFrame = 0 }
            if (pointerFrame) { cancelAnimationFrame(pointerFrame); pointerFrame = 0 }
            stopSpectrum()
            stopLoop()
            detach()
          }
        }, 'turn-beacon: rail bridge')

        // 不可见：只用来记录当前会话，让书签按会话区分；不占任何版面。
        const SessionScope = props => {
          React.useEffect(() => {
            if (props.sessionId) sessionScope = props.sessionId
          }, [props.sessionId])
          return null
        }
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'turn-beacon-scope',
          order: 100,
        }, SessionScope))
      },
    }
  },
})
