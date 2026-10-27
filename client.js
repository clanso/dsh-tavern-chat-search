// 浏览器侧：右侧栏「搜对话」面板。关键词搜索 + 记不清原词时让 AI 帮着找；点结果跳到那一轮（别的局先切过去）。
window.__ModuleLoader__.load({
  id: 'dsh-tavern-chat-search',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React
    const PLUGIN = 'dsh-tavern-chat-search'

    const css = {
      // 面板自己滚动：侧栏不给插件面板滚动条，结果一多就拉不下去
      panel: { display: 'grid', alignContent: 'start', gap: '10px', padding: '2px 6px 24px 2px', fontSize: '13px', lineHeight: 1.6, maxHeight: 'calc(100vh - 80px)', overflowY: 'auto', overscrollBehavior: 'contain' },
      row: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' },
      input: {
        flex: '1 1 160px', minWidth: 0, boxSizing: 'border-box', padding: '6px 8px', borderRadius: '6px',
        border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', font: 'inherit',
      },
      area: {
        width: '100%', minHeight: '64px', resize: 'vertical', boxSizing: 'border-box', padding: '6px 8px', borderRadius: '6px',
        border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', font: 'inherit',
      },
      button: {
        padding: '5px 10px', borderRadius: '6px', border: '1px solid rgba(127,127,127,.35)',
        background: 'rgba(127,127,127,.08)', color: 'inherit', cursor: 'pointer', font: 'inherit',
      },
      primary: {
        padding: '5px 10px', borderRadius: '6px', border: '1px solid rgba(120,170,255,.6)',
        background: 'rgba(120,170,255,.16)', color: 'inherit', cursor: 'pointer', font: 'inherit',
      },
      chip: on => ({
        padding: '2px 8px', borderRadius: '999px', cursor: 'pointer', font: 'inherit', fontSize: '12px', color: 'inherit',
        border: '1px solid ' + (on ? 'rgba(120,170,255,.7)' : 'rgba(127,127,127,.3)'),
        background: on ? 'rgba(120,170,255,.16)' : 'transparent',
      }),
      hint: { color: 'var(--dsh-text-secondary, #8a8a8a)', fontSize: '12px' },
      error: { color: '#e5534b', fontSize: '12px', whiteSpace: 'pre-wrap' },
      list: { display: 'grid', gap: '8px' },
      card: { display: 'grid', gap: '4px', padding: '8px', borderRadius: '8px', border: '1px solid rgba(127,127,127,.22)' },
      head: { display: 'flex', gap: '6px', alignItems: 'baseline', flexWrap: 'wrap', fontSize: '12px', color: 'var(--dsh-text-secondary, #8a8a8a)' },
      title: { fontWeight: 600, color: 'inherit' },
      who: { fontSize: '11px', padding: '0 5px', borderRadius: '4px', background: 'rgba(127,127,127,.14)', marginRight: '4px' },
      mark: { background: 'rgba(255,200,60,.38)', color: 'inherit', borderRadius: '2px', padding: '0 1px' },
      why: { fontSize: '13px', color: 'inherit' },
      quote: { margin: 0, padding: '4px 8px', borderLeft: '3px solid rgba(255,190,60,.8)', background: 'rgba(255,200,60,.10)', borderRadius: '0 4px 4px 0', whiteSpace: 'pre-wrap' },
      full: { whiteSpace: 'pre-wrap', maxHeight: '320px', overflow: 'auto', padding: '6px 8px', borderRadius: '6px', background: 'rgba(127,127,127,.08)' },
      box: { display: 'grid', gap: '8px', padding: '8px', borderRadius: '8px', border: '1px solid rgba(127,127,127,.22)' },
      field: { display: 'grid', gap: '2px' },
      window: { cursor: 'pointer', borderRadius: '4px', padding: '1px 2px' },
      link: { border: 'none', background: 'none', padding: 0, color: 'rgb(110,160,255)', cursor: 'pointer', font: 'inherit', fontSize: '12px' },
    }

    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

    // ───── 跳到某一轮：和 Tavern 自己的轮次导轨一样，找 data-chat-turn 那一行，找不到就点「更早」加载再找 ─────
    function rowOf(turn) {
      for (const row of document.querySelectorAll('[data-chat-turn="' + turn + '"]')) {
        if (row.getBoundingClientRect().height > 0) return row
      }
      return null
    }
    function loadEarlier() {
      const box = document.querySelector('[class*="_older"]')
      const button = box && box.querySelector('button')
      if (!button || button.disabled) return false
      button.click()
      return true
    }
    function flash(row) {
      const before = row.style.outline
      const offset = row.style.outlineOffset
      row.style.outline = '2px solid rgba(255,190,60,.9)'
      row.style.outlineOffset = '4px'
      setTimeout(() => { row.style.outline = before; row.style.outlineOffset = offset }, 2200)
    }

    // ───── 在这一轮里精确找到那一句：页面文字和搜索用的一样去掉空格标点再比，显示时的换行、加粗、标点差异不影响 ─────
    const SKIP = /[\s\p{P}\p{S}]/u
    function normalize(source) {
      let out = ''
      for (const ch of String(source || '')) if (!SKIP.test(ch)) out += ch.toLowerCase()
      return out
    }
    function locate(turn, anchor) {
      const rows = [...document.querySelectorAll('[data-chat-turn="' + turn + '"]')].filter(row => row.getBoundingClientRect().height > 0)
      if (!rows.length || !anchor) return null
      let norm = ''
      const map = [] // 规范化后每个字 → [文字节点, 节点里的位置]
      for (const row of rows) {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const value = node.nodeValue || ''
          let at = 0
          for (const ch of value) {
            if (!SKIP.test(ch)) { const lower = ch.toLowerCase(); for (let k = 0; k < lower.length; k++) map.push([node, at, ch.length]); norm += lower }
            at += ch.length
          }
        }
      }
      const key = normalize(anchor)
      const tries = [key, key.slice(Math.max(0, Math.floor(key.length / 2) - 6), Math.floor(key.length / 2) + 6), key.slice(0, 8), key.slice(-8)].filter(item => item.length >= 3)
      for (const probe of tries) {
        const index = norm.indexOf(probe)
        if (index < 0) continue
        const [startNode, startAt] = map[index]
        const [endNode, endAt, size] = map[index + probe.length - 1]
        const range = document.createRange()
        range.setStart(startNode, startAt)
        range.setEnd(endNode, endAt + size)
        return range
      }
      return null
    }
    let styled = false
    function mark(range) {
      const target = range.startContainer.parentElement
      try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch (error) { target.scrollIntoView(true) }
      if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function') {
        if (!styled) {
          const style = document.createElement('style')
          style.textContent = '::highlight(dsh-tavern-chat-search) { background-color: rgba(255,190,60,.6); }'
          document.head.appendChild(style)
          styled = true
        }
        CSS.highlights.set(PLUGIN, new Highlight(range))
        setTimeout(() => { try { CSS.highlights.delete(PLUGIN) } catch (error) {} }, 5000)
      } else flash(target)
    }

    async function scrollToTurn(turn, anchor) {
      for (let load = 0; load < 80; load++) {
        const row = rowOf(turn)
        if (row) {
          const range = locate(turn, anchor)
          if (range) { mark(range); return true }
          try { row.scrollIntoView({ block: 'start', behavior: 'smooth' }) } catch (error) { row.scrollIntoView(true) }
          flash(row)
          return true
        }
        if (!loadEarlier()) { if (load > 4) return false }
        await wait(700)
      }
      return false
    }

    function Segments({ segments }) {
      return h(React.Fragment, null, (segments || []).map((segment, index) => segment.hit ? h('mark', { key: index, style: css.mark }, segment.text) : h('span', { key: index }, segment.text)))
    }

    function ResultCard({ item, title, showGame, onJump, ui }) {
      const [full, setFull] = useState(null)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const [hits, setHits] = useState(false)
      const located = !!item.why
      const toggle = async () => {
        if (full) { setFull(null); return }
        try { const round = await ui.callHost(PLUGIN + '/round', { gameId: item.gameId, turn: item.turn }); setFull(round || { text: '（这一轮读不到了）' }) } catch (error) { setNote(String(error && error.message || error)) }
      }
      const firstAnchor = () => item.anchor || ((item.parts || [])[0] && (item.parts[0].windows || [])[0] && item.parts[0].windows[0].anchor) || ''
      const jump = async (anchor) => {
        setBusy(true); setNote('')
        try { const result = await onJump(item, anchor || firstAnchor()); if (result) setNote(result) } finally { setBusy(false) }
      }
      return h('div', { style: css.card },
        h('div', { style: css.head },
          showGame ? h('span', { style: css.title }, title || '（未命名的一局）') : null,
          h('span', null, '第 ' + item.turn + ' 轮'),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: css.link, onClick: toggle }, full ? '收起' : '整轮'),
          h('button', { type: 'button', style: css.link, onClick: () => jump(), disabled: busy }, busy ? '跳转中…' : '跳过去'),
        ),
        located ? h('div', { style: css.why }, item.why) : null,
        located && item.quote ? h('blockquote', { style: { ...css.quote, cursor: 'pointer' }, title: '跳到这一句', onClick: () => jump(item.quote) }, item.quote) : null,
        located ? h('button', { type: 'button', style: { ...css.link, justifySelf: 'start' }, onClick: () => setHits(!hits) }, hits ? '收起命中的词' : '看命中的词') : null,
        // 每处命中单独一段，点哪段跳到哪一处
        (located && !hits ? [] : item.parts || []).map((part, index) => h('div', { key: index, style: { display: 'grid', gap: '2px' } },
          (part.windows || []).map((window, at) => h('div', { key: at, style: css.window, title: '跳到这一处', onClick: () => jump(window.anchor) },
            at === 0 ? h('span', { style: css.who }, part.who === 'me' ? '我' : '正文') : null,
            h(Segments, { segments: window.segments }),
          )),
        )),
        full ? h('div', { style: css.full }, (full.input ? '【我】' + full.input + '\n\n' : '') + (full.text || '')) : null,
        note ? h('div', { style: css.hint }, note) : null,
      )
    }

    // ───── 设置：多轮追问几轮、语义检索（可选，默认关） ─────
    function Settings({ ui, onClose }) {
      const [conf, setConf] = useState(null)
      const [key, setKey] = useState('')
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)
      useEffect(() => { ui.callHost(PLUGIN + '/settings', {}).then(setConf).catch(e => setNote(String(e && e.message || e))) }, [])
      if (!conf) return h('div', { style: css.box }, note || '读取设置…')
      const sem = conf.semantic
      const set = patch => setConf({ ...conf, ...patch })
      const setSem = patch => set({ semantic: { ...sem, ...patch } })
      const save = async () => {
        setBusy(true); setNote('')
        try {
          const next = await ui.callHost(PLUGIN + '/settings/save', { settings: conf, key: key ? key : undefined })
          setConf(next); setKey(''); setNote('已保存')
        } catch (e) { setNote(String(e && e.message || e)) } finally { setBusy(false) }
      }
      const test = async () => {
        setBusy(true); setNote('')
        try {
          await ui.callHost(PLUGIN + '/settings/save', { settings: conf, key: key ? key : undefined })
          setKey('')
          const r = await ui.callHost(PLUGIN + '/settings/test', {})
          setNote('接通了：向量 ' + r.dims + ' 维（设置已保存）')
          setConf(await ui.callHost(PLUGIN + '/settings', {}))
        } catch (e) { setNote('没接通：' + String(e && e.message || e)) } finally { setBusy(false) }
      }
      const field = (label, input) => h('label', { style: css.field }, h('span', { style: css.hint }, label), input)
      return h('div', { style: css.box },
        h('div', { style: css.row },
          h('span', null, 'AI 觉得都不像时，换词再找'),
          [1, 2, 3].map(n => h('button', { key: n, type: 'button', style: css.chip(conf.rounds === n), onClick: () => set({ rounds: n }) }, n === 1 ? '不追问' : '最多 ' + n + ' 轮')),
        ),
        h('label', { style: { ...css.row, flexWrap: 'nowrap', alignItems: 'flex-start', cursor: 'pointer' } },
          h('input', { type: 'checkbox', style: { marginTop: '5px' }, checked: sem.enabled, onChange: e => setSem({ enabled: e.target.checked }) }),
          h('span', null, '语义检索（按意思找，描述和原文一个字都对不上也能找到）'),
        ),
        sem.enabled ? h('div', { style: { display: 'grid', gap: '6px' } },
          h('div', { style: css.hint }, '要一个 OpenAI 兼容的向量（embedding）接口。默认是硅基流动的 BAAI/bge-m3，中文效果好；本地 Ollama 填 http://127.0.0.1:11434/v1 和模型名。第一次会把全部对话算一遍向量，存在本机，之后只算新增的。'),
          field('接口地址', h('input', { style: css.input, value: sem.baseURL, onChange: e => setSem({ baseURL: e.target.value }) })),
          field('模型', h('input', { style: css.input, value: sem.model, onChange: e => setSem({ model: e.target.value }) })),
          field('Key' + (conf.hasKey ? '（已保存，留空不改）' : ''), h('input', { style: css.input, type: 'password', value: key, placeholder: conf.hasKey ? '••••••' : '没有就留空', onChange: e => setKey(e.target.value) })),
        ) : null,
        h('div', { style: css.row },
          h('button', { type: 'button', style: css.primary, disabled: busy, onClick: save }, '保存'),
          sem.enabled ? h('button', { type: 'button', style: css.button, disabled: busy, onClick: test }, '测试接口') : null,
          h('button', { type: 'button', style: css.button, onClick: onClose }, '收起'),
          note ? h('span', { style: css.hint }, note) : null,
        ),
      )
    }

    function progressText(p) {
      if (!p) return ''
      if (p.phase === 'read') return '正在读对话…'
      if (p.phase === 'index') return '正在算语义向量 ' + p.done + ' / ' + p.total + '（只有第一次要算全部）'
      if (p.phase === 'expand') return '第 ' + p.round + ' 轮：AI 在想原文里可能用的词…'
      if (p.phase === 'pick') return '第 ' + p.round + ' 轮：AI 在 ' + p.candidates + ' 段候选里挑…'
      return ''
    }

    function SearchPanel({ gameId, ui, workspace }) {
      const [query, setQuery] = useState('')
      const [scope, setScope] = useState('game')
      const [who, setWho] = useState('all')
      const [askOpen, setAskOpen] = useState(false)
      const [describe, setDescribe] = useState('')
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [outcome, setOutcome] = useState(null)
      const [titles, setTitles] = useState({})
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [progress, setProgress] = useState(null)
      const shown = useRef(30)
      const [, bump] = useState(0)

      useEffect(() => {
        const ids = outcome ? [...new Set(outcome.results.map(item => item.gameId))].filter(id => !(id in titles)) : []
        if (!ids.length || typeof ui.getGames !== 'function') return
        let live = true
        ui.getGames(ids.slice(0, 500)).then(found => {
          if (!live) return
          const next = { ...titles }
          for (const id of ids) next[id] = found && found[id] ? (found[id].title || found[id].cardName || '') : ''
          setTitles(next)
        }).catch(() => {})
        return () => { live = false }
      }, [outcome])

      const run = async (kind) => {
        setError(''); setBusy(kind); shown.current = 30
        // AI 找要等一会儿：边等边问宿主进行到哪一步
        let polling = kind === 'ai'
        const poll = async () => {
          while (polling) {
            try { const p = await ui.callHost(PLUGIN + '/status', {}); if (polling) setProgress(p) } catch (e) {}
            await wait(800)
          }
        }
        if (polling) poll()
        try {
          const args = { current: gameId, scope, who }
          const result = kind === 'ai'
            ? await ui.callHost(PLUGIN + '/ai', { ...args, description: describe })
            : await ui.callHost(PLUGIN + '/search', { ...args, query })
          setOutcome({ kind, ...result })
        } catch (e) {
          setError(String(e && e.message || e))
        } finally { polling = false; setProgress(null); setBusy('') }
      }

      const jump = async (item, anchor) => {
        if (item.gameId !== gameId) {
          if (!workspace || typeof workspace.openSession !== 'function') return '这条在另一局里：先在左边打开「' + (titles[item.gameId] || '那一局') + '」，再点一次「跳过去」。'
          try { await workspace.openSession(item.gameId) } catch (e) { return '切不过去（' + (e && e.message || e) + '）：先在左边打开那一局，再点一次「跳过去」。' }
          await wait(1200)
        }
        const ok = await scrollToTurn(item.turn, anchor)
        return ok ? '' : '没在页面上找到第 ' + item.turn + ' 轮，可以先点「整轮」看原文。'
      }

      const summary = () => {
        if (!outcome) return null
        const where = scope === 'all' ? '在 ' + outcome.games + ' 局、' + outcome.rounds + ' 轮里' : '在这一局 ' + outcome.rounds + ' 轮里'
        if (outcome.kind === 'ai') {
          const terms = (outcome.terms || []).slice(0, 16).join('、')
          const notes = (outcome.notes || []).length ? outcome.notes.join('；') + '。' : ''
          const how = (outcome.semantic ? '按词和按意思' : '按词') + (outcome.tries > 1 ? '找了 ' + outcome.tries + ' 轮、' : '') + '看了 ' + outcome.candidates + ' 段'
          return notes + (outcome.results.length
            ? 'AI ' + where + how + '，定位到 ' + outcome.results.length + ' 处，最像的在最上面'
            : 'AI ' + where + how + '，没找到像的。它试过的词：' + (terms || '（没想出词）') + '。可以换个说法、改成搜全部局，或者在设置里打开语义检索。')
        }
        if (!outcome.total) return where + '没有找到。记不清原词的话，点下面「让 AI 帮我找」。'
        return (outcome.loose ? '没有同时包含所有词的，下面是包含其中一部分的，' : '') + where + '找到 ' + outcome.total + ' 条' + (outcome.total > outcome.results.length ? '（只列前 ' + outcome.results.length + ' 条）' : '')
      }

      const results = outcome ? outcome.results : []
      return h('div', { style: css.panel },
        h('form', { style: css.row, onSubmit: e => { e.preventDefault(); if (query.trim()) run('search') } },
          h('input', { style: css.input, value: query, placeholder: '关键词，多个用空格分开', onChange: e => setQuery(e.target.value) }),
          h('button', { type: 'submit', style: css.primary, disabled: !!busy || !query.trim() }, busy === 'search' ? '搜索中…' : '搜索'),
        ),
        h('div', { style: css.row },
          h('button', { type: 'button', style: css.chip(scope === 'game'), onClick: () => setScope('game') }, '这一局'),
          h('button', { type: 'button', style: css.chip(scope === 'all'), onClick: () => setScope('all') }, '全部局'),
          h('span', { style: { width: '8px' } }),
          h('button', { type: 'button', style: css.chip(who === 'all'), onClick: () => setWho('all') }, '都搜'),
          h('button', { type: 'button', style: css.chip(who === 'me'), onClick: () => setWho('me') }, '只搜我说的'),
          h('button', { type: 'button', style: css.chip(who === 'story'), onClick: () => setWho('story') }, '只搜正文'),
        ),
        askOpen
          ? h('div', { style: { display: 'grid', gap: '6px' } },
              h('textarea', { style: css.area, value: describe, placeholder: '用自己的话描述记得的内容，比如：她好像在雨夜里把什么东西还给我，还哭了', onChange: e => setDescribe(e.target.value) }),
              h('div', { style: css.row },
                h('button', { type: 'button', style: css.primary, disabled: !!busy || !describe.trim(), onClick: () => run('ai') }, busy === 'ai' ? 'AI 正在找…' : '让 AI 找'),
                h('button', { type: 'button', style: css.button, onClick: () => setAskOpen(false) }, '收起'),
                h('span', { style: css.hint }, busy === 'ai' && progress ? progressText(progress) : '用这一局的后台模型，要等一会儿'),
              ))
          : h('button', { type: 'button', style: { ...css.button, justifySelf: 'start' }, onClick: () => setAskOpen(true) }, '记不清原词？让 AI 帮我找'),
        settingsOpen
          ? h(Settings, { ui, onClose: () => setSettingsOpen(false) })
          : h('button', { type: 'button', style: { ...css.link, justifySelf: 'start' }, onClick: () => setSettingsOpen(true) }, '设置（多轮追问、语义检索）'),
        error ? h('div', { style: css.error }, error) : null,
        outcome ? h('div', { style: css.hint }, summary()) : null,
        h('div', { style: css.list },
          results.slice(0, shown.current).map(item => h(ResultCard, {
            key: item.key || item.gameId + ':' + item.turn, item, ui, onJump: jump,
            showGame: scope === 'all', title: titles[item.gameId],
          })),
        ),
        results.length > shown.current ? h('button', { type: 'button', style: css.button, onClick: () => { shown.current += 30; bump(n => n + 1) } }, '再显示 30 条') : null,
      )
    }

    return {
      name: PLUGIN,
      inject: ['tavernUi'],
      apply(ctx) {
        const ui = ctx.tavernUi
        if (!ui || !(ui.apiVersion >= 2)) return
        // 切到别的局要用 DSH 的 uiWorkspace；没有就让玩家自己点开那一局。
        let workspace = null
        try { workspace = (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null) || ctx.uiWorkspace || null } catch (error) { workspace = null }
        ui.registerPanel({ id: 'search', title: '搜对话', render: ({ gameId }) => h(SearchPanel, { key: 'search', gameId, ui, workspace }) })
      },
    }
  },
})
