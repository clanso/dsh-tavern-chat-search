// 宿主侧：用 Tavern 插件接口（getTurnState / getHistory / backgroundModel / handle）读各局已经写完的正文，给浏览器侧的「搜对话」面板搜。
// 读过的局按「最新一轮 + 正文版本」记在内存里，没变就不重读；回退、编辑、删局时作废那一局。
// 有哪些局：Tavern 没有列出全部游戏的接口，这里读 Tavern 数据目录下的 sessions.json 只取局号（读不到就只搜见过的局和当前这一局）。
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  prepare, keywordSearch, candidates, unitsOf, itemOf, normalize, extractJson, applyPicks, descriptionTerms,
  EXPAND_SYSTEM, expandPrompt, PICK_SYSTEM, pickPrompt,
} from './lib/search.mjs'
import { createSemantic } from './lib/semantic.mjs'

export const name = 'dsh-tavern-chat-search'
export const inject = ['tavern']

const PAGE = 50
const PARALLEL = 4

const dshHome = () => (process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), '.dsh'))
const SESSIONS_FILE = () => join(dshHome(), 'profile-data', 'tavern', 'data', 'sessions.json')
/** 插件自己的数据（设置、向量缓存）：不放在插件文件夹里（改了会触发 Tavern 重新加载），也不放进 Tavern 的数据目录。 */
const DATA_DIR = () => join(dshHome(), 'dsh-tavern-chat-search')
const KEY_REF = 'DSH_TAVERN_CHAT_SEARCH_EMBED_KEY'

export const DEFAULTS = Object.freeze({ rounds: 3, semantic: { enabled: false, baseURL: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3' } })

/**
 * 设置优先用 Tavern 的插件数据（savePluginData，第 3 版起；更新插件不丢），旧版 Tavern 存在 DATA_DIR/settings.json。
 * 向量接口的 Key 存进 DSH 的凭据（credentials 服务），没有凭据服务时存在 DATA_DIR/secret.json。
 */
export function createSettings({ dir = DATA_DIR(), credentials = () => null, tavern = null } = {}) {
  const file = join(dir, 'settings.json')
  const pluginData = tavern && tavern.apiVersion >= 3
  const secretFile = join(dir, 'secret.json')
  const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')) || {} } catch { return {} } }
  const writeJson = async (path, data) => {
    await mkdir(dir, { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n')
    await rename(tmp, path)
  }
  const service = () => { const c = credentials(); return c && typeof c.resolve === 'function' && typeof c.set === 'function' ? c : null }
  // 之前版本存在 settings.json 里的设置：插件数据还空着时接着用
  const readSaved = async () => (pluginData ? ((await tavern.readPluginData()) || readJson(file)) : readJson(file))
  const writeSaved = data => (pluginData ? tavern.savePluginData({ data }) : writeJson(file, data))
  async function get() {
    const saved = await readSaved()
    const rounds = Math.max(1, Math.min(3, Number.isInteger(saved.rounds) ? saved.rounds : DEFAULTS.rounds))
    return { rounds, semantic: { ...DEFAULTS.semantic, ...(saved.semantic || {}), enabled: Boolean(saved.semantic?.enabled) } }
  }
  async function key() {
    const c = service()
    if (c) { try { const r = await c.resolve(KEY_REF); if (r?.value) return String(r.value) } catch {} }
    return String((await readJson(secretFile))[KEY_REF] || '')
  }
  async function save({ rounds, semantic = {} } = {}, newKey) {
    const now = await get()
    const next = {
      rounds: Math.max(1, Math.min(3, Number(rounds) || now.rounds)),
      semantic: {
        enabled: Boolean(semantic.enabled),
        baseURL: String(semantic.baseURL ?? now.semantic.baseURL).trim(),
        model: String(semantic.model ?? now.semantic.model).trim(),
      },
    }
    await writeSaved(next)
    if (typeof newKey === 'string') {
      const value = newKey.trim()
      if (/[\r\n]/.test(value)) throw new Error('Key 里不能有换行')
      const c = service()
      let stored = false
      if (c) { try { await c.set(KEY_REF, value); stored = true } catch {} }
      const secrets = await readJson(secretFile)
      if (stored || !value) delete secrets[KEY_REF]
      else secrets[KEY_REF] = value
      await writeJson(secretFile, secrets)
    }
    return next
  }
  return { get, key, save }
}

/** 局号列表，先开的在前。读不到时返回空数组。 */
async function listedGames() {
  try {
    const data = JSON.parse(await readFile(SESSIONS_FILE(), 'utf8'))
    return data && typeof data === 'object' ? Object.keys(data) : []
  } catch { return [] }
}

async function eachLimited(items, limit, fn) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const item = items[next++]; await fn(item) }
  })
  await Promise.all(workers)
}

/**
 * 收完一次 llm.stream，返回文字。后台模型常是推理模型，思考也算进输出额度，所以额度给足；
 * 写到额度上限被截断（max_tokens）时，只要已经写出了东西就照用，由调用方去抠 JSON。
 */
async function callModel(llm, { provider, model, system, user, maxTokens = 16000, signal }) {
  const stream = llm.stream({
    provider, model, system, temperature: 0.2, maxTokens, signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
  })
  let text = '', failure = ''
  try {
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) failure = chunk.reason.failure?.message || '模型调用失败'
    }
  } catch (error) {
    failure = error?.message || String(error)
  }
  if (!text.trim()) throw new Error(/max[_-]?tokens|length/i.test(failure) ? '后台模型想太久，还没写出结果就用完了输出额度' : (failure || '模型没有回话'))
  return text
}

export function createSearcher({ tavern, llm = () => null, games = listedGames, logger = console, settings = createSettings(), semantic = null }) {
  const cache = new Map() // gameId → { key, rounds }
  let progress = null // AI 找进行到哪一步，给面板显示
  const vectors = semantic || createSemantic({ dir: DATA_DIR(), config: async () => (await settings.get()).semantic, key: () => settings.key(), logger })
  const seen = new Set()
  const loading = new Map()

  async function load(gameId) {
    let state
    try { state = await tavern.getTurnState({ gameId }) } catch { cache.delete(gameId); return null }
    if (!state || !(state.turn >= 1)) { cache.delete(gameId); return null }
    const key = `${state.turn}|${state.textVersion}|${state.settled ? 1 : 0}`
    const hit = cache.get(gameId)
    if (hit && hit.key === key) return hit.rounds
    const rounds = []
    for (let from = 1; from <= state.turn; from += PAGE) {
      const page = await tavern.getHistory({ gameId, from, to: Math.min(state.turn, from + PAGE - 1) })
      for (const round of Array.isArray(page) ? page : []) rounds.push(prepare({ gameId, turn: round.turn, input: round.input, text: round.text }))
    }
    cache.set(gameId, { key, rounds })
    return rounds
  }

  /** 同一局同时只读一次。读不了的局（删了、坏了）当没有。 */
  function roundsOf(gameId) {
    if (!loading.has(gameId)) {
      loading.set(gameId, load(gameId).catch(error => {
        logger.warn?.(`[${name}] 读 ${gameId} 失败：${error?.message || error}`)
        return null
      }).finally(() => loading.delete(gameId)))
    }
    return loading.get(gameId)
  }

  /** 要搜的局（新的在前）和它们的全部轮次。 */
  async function gather({ current, scope }) {
    let ids
    if (scope === 'game') ids = current ? [current] : []
    else {
      const listed = await games()
      ids = [...new Set([...listed.slice().reverse(), ...seen])]
      if (current) ids = [current, ...ids.filter(id => id !== current)]
    }
    const byGame = new Map()
    await eachLimited(ids, PARALLEL, async id => { const rounds = await roundsOf(id); if (rounds) byGame.set(id, rounds) })
    const order = ids.filter(id => byGame.has(id))
    return { order, rounds: order.flatMap(id => byGame.get(id)), skipped: ids.length - order.length }
  }

  async function search({ current, scope = 'game', query = '', who = 'all' } = {}) {
    const { order, rounds, skipped } = await gather({ current, scope })
    const found = keywordSearch(rounds, query, { who, order })
    return { ...found, games: order.length, rounds: rounds.length, skipped }
  }

  async function pickModel(current, order) {
    for (const gameId of [current, ...order].filter(Boolean)) {
      try { const model = await tavern.backgroundModel({ gameId }); if (model?.provider && model?.model) return model } catch {}
    }
    return null
  }

  /**
   * AI 找：扩词 → 本地按段粗筛（开了语义检索时再加按意思最像的段）→ AI 从候选里挑。
   * AI 觉得都不像时换一批词再来，最多 settings.rounds 轮；给 AI 看过的段不再重复给。
   */
  async function ai({ current, scope = 'game', description = '', who = 'all' } = {}) {
    const text = String(description || '').trim()
    if (!text) throw new Error('先写几句你记得的内容')
    const host = llm()
    if (!host || typeof host.stream !== 'function') throw new Error('这个 DSH 没有可用的大模型服务')
    progress = { phase: 'read' }
    try {
      const { order, rounds, skipped } = await gather({ current, scope })
      const model = await pickModel(current, order)
      if (!model) throw new Error('没有可用的后台模型：先在 Tavern 里给这一局配好后台模型')
      const conf = await settings.get()
      const units = unitsOf(rounds, who)
      const notes = []
      let semanticOn = conf.semantic.enabled
      if (semanticOn) {
        try {
          await vectors.ensure(units, (done, total) => { progress = { phase: 'index', done, total } })
        } catch (error) {
          semanticOn = false
          notes.push(`语义检索没用上（${error?.message || error}），这次只按词找`)
        }
      }
      const own = descriptionTerms(text)
      const tried = []
      const expand = async round => {
        progress = { phase: 'expand', round, rounds: conf.rounds }
        try {
          const expanded = extractJson(await callModel(host, { ...model, system: EXPAND_SYSTEM, user: expandPrompt(text, tried) }))
          return (Array.isArray(expanded.terms) ? expanded.terms : []).map(String).filter(Boolean).slice(0, 40)
        } catch (error) {
          notes.push(`第 ${round} 轮 AI 扩词没成功（${error?.message || error}）`)
          return []
        }
      }
      const shown = new Set()
      let shownCount = 0
      for (let round = 1; round <= conf.rounds; round++) {
        const fresh = await expand(round)
        // 模型想的词加上描述里本来的词：模型换了说法、原文却用的是玩家的原话时也能对上
        const terms = [...new Set([...fresh, ...own])]
        tried.push(...fresh)
        const byWord = candidates(rounds, terms, { who, units, skip: shown, limit: semanticOn ? 30 : 50 })
        let list = byWord
        if (semanticOn) {
          try {
            const skip = new Set([...shown, ...byWord.map(item => item.key)])
            const keys = terms.map(term => normalize(term).text).filter(Boolean)
            const byMeaning = (await vectors.search(text, units, { limit: 30, skip })).map(({ unit }) => itemOf(unit, keys.filter(term => unit.passage.norm.includes(term))))
            // 交错排：两边最像的都排在前面
            list = []
            for (let i = 0; i < Math.max(byWord.length, byMeaning.length); i++) {
              if (byMeaning[i]) list.push(byMeaning[i])
              if (byWord[i]) list.push(byWord[i])
            }
          } catch (error) {
            semanticOn = false
            notes.push(`语义检索出错（${error?.message || error}），之后只按词找`)
          }
        }
        if (!list.length) { if (!fresh.length) break; continue }
        for (const item of list) shown.add(item.key)
        shownCount += list.length
        progress = { phase: 'pick', round, rounds: conf.rounds, candidates: list.length }
        const base = { terms, candidates: shownCount, tries: round, semantic: semanticOn, games: order.length, rounds: rounds.length, skipped }
        let picked
        try {
          picked = applyPicks(list, extractJson(await callModel(host, { ...model, system: PICK_SYSTEM, user: pickPrompt(text, list) })).picks)
        } catch (error) {
          // AI 挑不出来（报错）：按粗筛的分数给前 8 条
          notes.push(`AI 挑选没成功（${error?.message || error}），下面按粗筛分数排`)
          return { ...base, results: list.slice(0, 8).map(({ brief, score, raw, ...item }) => item), notes }
        }
        if (picked.length) return { ...base, results: picked, notes }
      }
      return { terms: [...new Set([...tried, ...own])], candidates: shownCount, tries: conf.rounds, semantic: semanticOn, games: order.length, rounds: rounds.length, skipped, results: [], notes }
    } finally {
      progress = null
    }
  }

  async function round({ gameId, turn }) {
    const rounds = await roundsOf(gameId)
    const found = rounds?.find(item => item.turn === Number(turn))
    return found ? { gameId, turn: found.turn, input: found.input, text: found.text } : null
  }

  return {
    search, ai, round,
    status: () => progress,
    settings: async () => ({ ...(await settings.get()), hasKey: Boolean(await settings.key()) }),
    saveSettings: async ({ settings: next, key } = {}) => { await settings.save(next, key); return { ...(await settings.get()), hasKey: Boolean(await settings.key()) } },
    testSemantic: () => vectors.test(),
    seen: gameId => { if (gameId) seen.add(gameId) },
    forget: gameId => { cache.delete(gameId) },
  }
}

export function apply(ctx) {
  const logger = ctx.logger ?? console
  const tavern = ctx.tavern
  if (!tavern || !(tavern.apiVersion >= 2)) { logger.warn?.(`[${name}] 当前 Tavern 的插件接口太旧（要第 2 版以上），不工作`); return }
  let llm = null, credentials = null
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], scoped => { llm = scoped.llm })
    ctx.inject(['credentials'], scoped => { credentials = scoped.credentials })
  }
  const searcher = createSearcher({ tavern, llm: () => llm, logger, settings: createSettings({ credentials: () => credentials, tavern }) })

  // 注册类方法在插件卸载时由 Tavern 自动撤销；必须用 tavern.方法() 形式调用。
  tavern.onTurnSettled(turn => searcher.seen(turn.gameId))
  tavern.onTimelineChanged(change => { searcher.forget(change.gameId); searcher.seen(change.gameId) })
  tavern.onGameRemoved(({ gameId }) => searcher.forget(gameId))
  tavern.handle(`${name}/search`, args => searcher.search(args))
  tavern.handle(`${name}/ai`, args => searcher.ai(args))
  tavern.handle(`${name}/round`, args => searcher.round(args))
  tavern.handle(`${name}/status`, () => searcher.status())
  tavern.handle(`${name}/settings`, () => searcher.settings())
  tavern.handle(`${name}/settings/save`, args => searcher.saveSettings(args))
  tavern.handle(`${name}/settings/test`, () => searcher.testSemantic())
}
