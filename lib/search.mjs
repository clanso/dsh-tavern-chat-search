// 搜索核心：不碰 Tavern，只处理「一轮一条」的记录 { gameId, turn, input, text }。
// 匹配时忽略大小写、空格和标点（「你、好」也能搜到「你好」），片段按原文切出来，命中的地方标出来。

const SKIP = /[\s\p{P}\p{S}]/u

/** 规范化：去掉空白和标点、转小写。map[i] 是规范化后第 i 个字符在原文里的位置。 */
export function normalize(source) {
  const text = String(source ?? '')
  let out = ''
  const map = []
  let at = 0
  for (const ch of text) {
    if (!SKIP.test(ch)) {
      const lower = ch.toLowerCase()
      for (let k = 0; k < lower.length; k++) map.push(at)
      out += lower
    }
    at += ch.length
  }
  return { text: out, map }
}

/** 搜索词：按空白分开，规范化，去重，丢掉空的。 */
export function termsOf(query) {
  const seen = new Set()
  const terms = []
  for (const part of String(query ?? '').split(/\s+/)) {
    const term = normalize(part).text
    if (term && !seen.has(term)) { seen.add(term); terms.push(term) }
  }
  return terms
}

const FIELDS = { me: ['input'], story: ['text'], all: ['input', 'text'] }
export const fieldsOf = who => FIELDS[who] || FIELDS.all

/** 记录 → 搜索用的样子：每个字段的规范化文本先算好，搜索时不用重复算。 */
export function prepare(round) {
  return {
    gameId: round.gameId,
    turn: round.turn,
    input: String(round.input ?? ''),
    text: String(round.text ?? ''),
    norm: { input: normalize(round.input).text, text: normalize(round.text).text },
    passages: ['input', 'text'].flatMap(field => passagesOf(round[field]).map(({ start, end }) => {
      const body = String(round[field] ?? '').slice(start, end)
      return { field, body, norm: normalize(body).text }
    })),
  }
}

function count(haystack, needle) {
  let n = 0
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) n++
  return n
}

/** 命中的位置（原文里的 [起, 止)），重叠的合并。 */
function hitRanges(text, terms) {
  const { text: norm, map } = normalize(text)
  const ranges = []
  for (const term of terms) {
    for (let at = norm.indexOf(term); at >= 0; at = norm.indexOf(term, at + term.length)) {
      const lastStart = map[at + term.length - 1]
      ranges.push([map[at], lastStart + (text.codePointAt(lastStart) > 0xffff ? 2 : 1)])
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const hits = []
  for (const range of ranges) {
    const last = hits.at(-1)
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else hits.push(range.slice())
  }
  return hits
}

/**
 * 原文片段，一处一段：每处命中前后各 radius 个字，挨得近的合并（一段不超过 radius * 2 + 60 字），最多 windows 段。
 * 每段 { segments: [{ text, hit }], anchor }：hit 为 true 的是命中的字，被截断处放「…」；
 * anchor 是第一处命中连同前后几个字的原文，浏览器侧拿它在页面上找到这一处、滚过去。
 */
export function snippetWindows(source, terms, { radius = 50, windows = 3 } = {}) {
  const text = String(source ?? '')
  if (!text) return []
  const hits = hitRanges(text, terms)
  if (!hits.length) {
    const head = text.replace(/\s+/g, ' ').trim()
    return [{ segments: [{ text: head.length > radius * 2 ? head.slice(0, radius * 2) + '…' : head, hit: false }], anchor: head.slice(0, 24) }]
  }
  const spans = []
  for (const [start, end] of hits) {
    const from = Math.max(0, start - radius), to = Math.min(text.length, end + radius)
    const last = spans.at(-1)
    if (last && from <= last.to && to - last.from <= radius * 2 + 60) { last.to = Math.max(last.to, to); last.hits.push([start, end]) }
    else if (last && start < last.to) continue
    else spans.push({ from: last ? Math.max(from, last.to) : from, to, hits: [[start, end]] })
  }
  return spans.slice(0, windows).map(span => {
    const out = []
    const push = (piece, hit) => {
      const clean = piece.replace(/\s+/g, ' ')
      if (!clean) return
      const last = out.at(-1)
      if (last && last.hit === hit) last.text += clean
      else out.push({ text: clean, hit })
    }
    if (span.from > 0) push('…', false)
    let at = span.from
    for (const [start, end] of span.hits) {
      push(text.slice(at, start), false)
      push(text.slice(start, end), true)
      at = end
    }
    push(text.slice(at, span.to), false)
    if (span.to < text.length) push('…', false)
    const [first, last] = span.hits[0]
    return { segments: out, anchor: text.slice(Math.max(0, first - 8), Math.min(text.length, last + 8)) }
  })
}

/** 片段连成一串（给模型看的、或只要一段时）。 */
export function snippet(source, terms, options) {
  const out = []
  for (const window of snippetWindows(source, terms, options)) {
    for (const segment of window.segments) {
      const last = out.at(-1)
      if (last && last.hit === segment.hit) last.text = last.text.endsWith('…') && segment.text.startsWith('…') ? last.text + segment.text.slice(1) : last.text + segment.text
      else out.push({ ...segment })
    }
  }
  return out
}

/**
 * 长文切段：按换行分段，攒到 size 字左右为一段；单个段落太长时按句末标点再切，还长就硬切。
 * 返回 [{ start, end }]（原文位置）。AI 找按段打分、按段给模型看，长正文里的一句台词不会被开头几段挤掉。
 */
export function passagesOf(source, size = 280) {
  const text = String(source ?? '')
  const pieces = []
  const re = /[^\n]*(\n+|$)/g
  for (let m = re.exec(text); m && m[0]; m = re.exec(text)) {
    const start = m.index, end = m.index + m[0].length
    if (end - start <= size) { pieces.push([start, end]); continue }
    let at = start
    const sentence = /[^。！？!?…」』”]*[。！？!?…」』”]+/g
    sentence.lastIndex = start
    for (let n = sentence.exec(text); n && n.index < end; n = sentence.exec(text)) {
      const stop = Math.min(end, n.index + n[0].length)
      while (stop - at > size) { pieces.push([at, at + size]); at += size }
      if (stop - at > 0) { pieces.push([at, stop]); at = stop }
      if (stop >= end) break
    }
    while (at < end) { pieces.push([at, Math.min(end, at + size)]); at += size }
  }
  const out = []
  for (const [start, end] of pieces) {
    const last = out.at(-1)
    if (last && end - last.start <= size) last.end = end
    else out.push({ start, end })
  }
  return out.filter(item => text.slice(item.start, item.end).trim())
}

/** 一条结果：命中的字段各出一段片段。 */
function resultOf(round, terms, fields, extra = {}) {
  const parts = []
  for (const field of fields) {
    if (terms.some(term => round.norm[field].includes(term))) parts.push({ who: field === 'input' ? 'me' : 'story', windows: snippetWindows(round[field], terms) })
  }
  return { gameId: round.gameId, turn: round.turn, parts, ...extra }
}

/**
 * 关键词搜索。所有词都要出现在同一轮里（选中的字段合起来算）；一条都没有、又不止一个词时，退一步找「出现了其中几个」的，结果标 loose。
 * order 是游戏的先后（靠前的先列），同一局里新的轮次在前。
 */
export function keywordSearch(rounds, query, { who = 'all', limit = 200, order = [] } = {}) {
  const terms = termsOf(query)
  if (!terms.length) return { terms, results: [], total: 0, loose: false }
  const fields = fieldsOf(who)
  const rank = new Map(order.map((gameId, index) => [gameId, index]))
  const scored = []
  for (const round of rounds) {
    let found = 0, hits = 0
    for (const term of terms) {
      let n = 0
      for (const field of fields) n += count(round.norm[field], term)
      if (n) { found++; hits += n }
    }
    if (found) scored.push({ round, found, hits })
  }
  const byPlace = (a, b) => (rank.get(a.round.gameId) ?? 1e9) - (rank.get(b.round.gameId) ?? 1e9) || b.round.turn - a.round.turn
  let picked = scored.filter(item => item.found === terms.length).sort(byPlace)
  let loose = false
  if (!picked.length && terms.length > 1) {
    loose = true
    picked = scored.sort((a, b) => b.found - a.found || b.hits - a.hits || byPlace(a, b))
  }
  return { terms, total: picked.length, loose, results: picked.slice(0, limit).map(item => resultOf(item.round, terms, fields)) }
}

/** 要比对的段：选中字段里每一轮的每一段，key 在全部局里唯一（多轮追问时用来跳过已经给 AI 看过的）。 */
export function unitsOf(rounds, who = 'all') {
  const fields = fieldsOf(who)
  const units = []
  for (const round of rounds) {
    (round.passages || []).forEach((passage, index) => {
      if (fields.includes(passage.field)) units.push({ key: `${round.gameId}|${round.turn}|${index}`, round, passage, body: passage.body })
    })
  }
  return units
}

/** 一段 → 给面板和模型的候选。has 是这一段命中的词（语义检索来的可能没有）。 */
export function itemOf({ key, round, passage }, has = []) {
  const who = passage.field === 'input' ? 'me' : 'story'
  return {
    key, gameId: round.gameId, turn: round.turn,
    parts: [{ who, windows: snippetWindows(passage.body, has, { radius: 60, windows: 2 }) }],
    anchor: passage.body.replace(/\s+/g, ' ').trim().slice(0, 24),
    raw: passage.norm,
    brief: `${who === 'me' ? '玩家写的' : '正文'}：${normalizeSpace(passage.body)}`,
  }
}

/**
 * AI 找：拿模型想出来的一堆词给每一段（不是每一轮：长正文切成两三百字一段）打分，
 * 越少见的词分越高，挑出最像的 limit 段当候选（跳过 skip 里的）。
 */
export function candidates(rounds, terms, { who = 'all', limit = 50, skip = new Set(), units = unitsOf(rounds, who) } = {}) {
  const list = [...new Set(terms.map(term => normalize(term).text).filter(term => term.length > 0))]
  if (!list.length) return []
  const df = new Map(list.map(term => [term, 0]))
  const seen = units.map(({ passage }) => {
    const has = list.filter(term => passage.norm.includes(term))
    for (const term of has) df.set(term, df.get(term) + 1)
    return has
  })
  const total = units.length || 1
  const weight = term => Math.log(1 + total / (df.get(term) || 1)) * Math.min(1.6, 0.6 + term.length * 0.25)
  const scored = []
  units.forEach((unit, index) => {
    const has = seen[index]
    if (!has.length || skip.has(unit.key)) return
    scored.push({ unit, has, score: has.reduce((sum, term) => sum + weight(term), 0) })
  })
  scored.sort((a, b) => b.score - a.score || b.has.length - a.has.length)
  return scored.slice(0, limit).map(({ unit, has, score }) => ({ ...itemOf(unit, has), score }))
}

const normalizeSpace = text => String(text ?? '').replace(/\s+/g, ' ').trim()

/** 从模型的回答里抠出 JSON（允许它在外面包了 ```json 或多说两句）。 */
export function extractJson(text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有按要求回 JSON')
  return JSON.parse(source.slice(start, end + 1))
}

export const EXPAND_SYSTEM = [
  '你在帮玩家翻他自己的角色扮演聊天记录。玩家只记得大概发生了什么，记不清原文用的词。',
  '把玩家的描述扩展成一组检索词，这些词要尽可能是原文里会逐字出现的：',
  '- 人名、称呼、地点、物品、动作、情绪、关键台词里的词，以及它们的同义词、近义说法、口语说法；',
  '- 每个词 1 到 6 个字，越具体越好；不要「我」「他」「的」「什么」这类到处都有的词；',
  '- 15 到 30 个，最可能的放前面。',
  '只回 JSON：{"terms":["词1","词2"]}',
].join('\n')

export function expandPrompt(description, tried = []) {
  const again = tried.length ? `\n\n上次试过这些词，但按它们找到的片段都不对：${tried.join('、')}\n这次换一批不同角度的说法：人物的别称和代称、具体动作、物品、场景、台词里可能的口吻和用词，不要重复上面的词。` : ''
  return `玩家记得的内容：\n${normalizeSpace(description)}${again}`
}

export const PICK_SYSTEM = [
  '你在帮玩家翻他自己的角色扮演聊天记录。下面是玩家对要找的那段内容的描述，以及按检索词粗筛出来的候选片段。',
  '玩家要找的是剧情里实际发生过的一段情节或一句台词：按情节对不对得上来判断，不要只看关键词重合多少；玩家写的长设定、开局说明一般不是要找的。',
  '挑出最可能就是玩家要找的那几条，最多 5 条，最像的放前面；都不像就回空数组。',
  'why：一句话说这一轮发生了什么、为什么对得上（不超过 40 字）。quote：从这条候选里逐字摘抄最能对上的一句原文（不超过 60 字，不要改字）。',
  '只回 JSON：{"picks":[{"id":候选编号,"why":"理由","quote":"原文摘抄"}]}',
].join('\n')

export function pickPrompt(description, list) {
  const body = list.map((item, index) => `[${index + 1}] 第 ${item.turn} 轮 · ${item.brief}`).join('\n\n')
  return `玩家要找的：\n${normalizeSpace(description)}\n\n候选：\n\n${body}`
}

/** 按模型挑的编号取候选，丢掉编号不对的、重复的。 */
export function applyPicks(list, picks) {
  const out = []
  const used = new Set()
  for (const pick of Array.isArray(picks) ? picks : []) {
    const index = Number(pick?.id) - 1
    if (!Number.isInteger(index) || index < 0 || index >= list.length || used.has(index)) continue
    used.add(index)
    const { brief, score, raw, ...item } = list[index]
    // 摘抄要真在这一轮的原文里（忽略空格标点），对不上就不显示，免得把模型编的话当原文
    const quote = normalizeSpace(pick.quote).slice(0, 80)
    const key = normalize(quote).text
    const real = key.length >= 4 && typeof raw === 'string' && raw.includes(key)
    out.push({ ...item, why: normalizeSpace(pick.why).slice(0, 80), quote: real ? quote : '', anchor: real ? quote : item.anchor })
  }
  return out
}

/** 没有模型帮忙时，从描述里切词：按标点、空白和常见虚词断开，再把长的段切成 2～4 字的片。 */
export function descriptionTerms(description) {
  const stop = /[的了着过吗呢吧啊呀么是在和与跟把被给让对说想要会就都也还又很太我你他她它们这那个一些什么怎么为什么好像似乎难道自己]+/gu
  const pieces = String(description ?? '').split(/[\s\p{P}\p{S}]+/u).flatMap(part => part.split(stop)).filter(Boolean)
  const out = new Set()
  for (const piece of pieces) {
    if (/^[\p{Script=Latin}\p{N}]+$/u.test(piece)) { if (piece.length > 1) out.add(piece); continue }
    if (piece.length <= 4) { if (piece.length > 1) out.add(piece); continue }
    for (let at = 0; at + 2 <= piece.length; at++) out.add(piece.slice(at, at + 2))
    for (let at = 0; at + 3 <= piece.length; at++) out.add(piece.slice(at, at + 3))
  }
  return [...out].slice(0, 40)
}
