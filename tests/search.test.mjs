import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, termsOf, prepare, keywordSearch, snippet, candidates, applyPicks, extractJson } from '../lib/search.mjs'
import { createSearcher } from '../index.mjs'

const rounds = [
  { gameId: 'g1', turn: 1, input: '', text: '雨夜里，林岚把那枚旧怀表还给了你，眼泪落在表盖上。' },
  { gameId: 'g1', turn: 2, input: '我接过怀表，问她为什么哭', text: '她摇摇头，说：「没什么，只是想起了父亲。」' },
  { gameId: 'g1', turn: 4, input: '去市场买菜', text: 'Market 里人声鼎沸，你买了三颗土豆。' },
  { gameId: 'g2', turn: 1, input: '', text: '另一局：怀表停在了三点。' },
].map(prepare)

test('normalize 去掉空白和标点并记下原位置', () => {
  const { text, map } = normalize('你、好 A!')
  assert.equal(text, '你好a')
  assert.deepEqual(map, [0, 2, 4])
})

test('termsOf 去重、规范化', () => {
  assert.deepEqual(termsOf('  怀表  怀表 林岚，'), ['怀表', '林岚'])
})

test('多个词要同时出现；同一局新的轮次在前', () => {
  const found = keywordSearch(rounds, '怀表', { order: ['g1', 'g2'] })
  assert.deepEqual(found.results.map(r => `${r.gameId}:${r.turn}`), ['g1:2', 'g1:1', 'g2:1'])
  const both = keywordSearch(rounds, '怀表 父亲', { order: ['g1', 'g2'] })
  assert.deepEqual(both.results.map(r => r.turn), [2])
  assert.equal(both.loose, false)
})

test('只搜我说的', () => {
  const found = keywordSearch(rounds, '怀表', { who: 'me', order: ['g1', 'g2'] })
  assert.deepEqual(found.results.map(r => r.turn), [2])
  assert.equal(found.results[0].parts[0].who, 'me')
})

test('没有同时命中时退一步', () => {
  const found = keywordSearch(rounds, '怀表 火车', { order: ['g1', 'g2'] })
  assert.equal(found.loose, true)
  assert.equal(found.total, 3)
})

test('忽略大小写和标点', () => {
  assert.equal(keywordSearch(rounds, 'market').total, 1)
  assert.equal(keywordSearch(rounds, '没什么只是').total, 1)
})

test('片段标出命中的原文', () => {
  const segments = snippet('前面'.repeat(60) + '旧怀表' + '后面'.repeat(60), ['怀表'], { radius: 4 })
  const hit = segments.filter(s => s.hit).map(s => s.text)
  assert.deepEqual(hit, ['怀表'])
  assert.equal(segments[0].text.startsWith('…'), true)
  assert.equal(segments.at(-1).text.endsWith('…'), true)
  const spaced = snippet('她说：没 什么。', ['没什么'])
  assert.deepEqual(spaced.filter(s => s.hit).map(s => s.text), ['没 什么'])
})

test('候选按少见的词加分，applyPicks 丢掉不对的编号', () => {
  const list = candidates(rounds, ['怀表', '眼泪', '雨夜', '土豆'], { limit: 3 })
  assert.equal(list[0].turn, 1)
  assert.ok(list[0].brief.includes('雨夜'))
  const picks = applyPicks(list, [{ id: 1, why: '雨夜还怀表', quote: '林岚把那枚旧怀表还给了你' }, { id: 99 }, { id: 1 }])
  assert.equal(picks.length, 1)
  assert.equal(picks[0].why, '雨夜还怀表')
  assert.equal('brief' in picks[0], false)
  assert.equal('raw' in picks[0], false)
  assert.equal(picks[0].quote, '林岚把那枚旧怀表还给了你')
  assert.equal(applyPicks(list, [{ id: 1, why: 'x', quote: '模型自己编的一句话' }])[0].quote, '')
})

test('extractJson 容忍外面包的话', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"terms":["a"]}\n```'), { terms: ['a'] })
})

function fakeTavern(games) {
  const calls = { history: 0 }
  return {
    calls,
    apiVersion: 4,
    async getTurnState({ gameId }) {
      const list = games[gameId]
      if (!list) throw new Error('no game')
      return { gameId, turn: list.at(-1).turn, textVersion: 'v' + list.length, settled: true }
    },
    async getHistory({ gameId, from, to }) {
      calls.history++
      return games[gameId].filter(r => r.turn >= from && r.turn <= to)
    },
    async backgroundModel() { return { provider: 'p', model: 'm' } },
  }
}

test('搜索器：全部局按局号列表倒序，缓存不重读，作废后重读', async () => {
  const games = {
    a: [{ turn: 1, input: '', text: '开场：怀表' }],
    b: Array.from({ length: 120 }, (_, i) => ({ turn: i + 1, input: '', text: i === 70 ? '怀表在这里' : '路人' })),
  }
  const tavern = fakeTavern(games)
  const searcher = createSearcher({ tavern, games: async () => ['a', 'b', 'gone'], logger: { warn() {} } })
  const found = await searcher.search({ current: 'a', scope: 'all', query: '怀表' })
  assert.deepEqual(found.results.map(r => `${r.gameId}:${r.turn}`), ['a:1', 'b:71'])
  assert.equal(found.games, 2)
  assert.equal(found.skipped, 1)
  assert.equal(tavern.calls.history, 1 + 3)
  await searcher.search({ current: 'a', scope: 'all', query: '路人' })
  assert.equal(tavern.calls.history, 4)
  games.b.push({ turn: 121, input: '', text: '新的一轮' })
  await searcher.search({ current: 'a', scope: 'all', query: '新的' })
  assert.equal(tavern.calls.history, 7)
  const one = await searcher.round({ gameId: 'b', turn: 71 })
  assert.equal(one.text, '怀表在这里')
})

test('搜索器：AI 找先扩词再挑', async () => {
  const games = { a: rounds.filter(r => r.gameId === 'g1').map(r => ({ turn: r.turn, input: r.input, text: r.text })) }
  const tavern = fakeTavern(games)
  const replies = ['{"terms":["怀表","哭","雨"]}', '{"picks":[{"id":1,"why":"雨夜还怀表还哭了"}]}']
  const prompts = []
  const llm = {
    async *stream(request) {
      prompts.push(request)
      yield { type: 'text-delta', text: replies.shift() }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const searcher = createSearcher({ tavern, llm: () => llm, games: async () => ['a'] })
  const found = await searcher.ai({ current: 'a', scope: 'game', description: '她在下雨的晚上把东西还我，还哭了' })
  assert.equal(found.results.length, 1)
  assert.equal(found.results[0].why, '雨夜还怀表还哭了')
  assert.equal(prompts[0].provider, 'p')
  assert.ok(prompts[1].messages[0].content[0].text.includes('候选'))
})

test('搜索器：模型思考用完额度没写出字时，退回用描述里的词粗筛', async () => {
  const games = { a: [{ turn: 3, input: '', text: '阿黛尔的触手卷住了柯萝伊：「难道你想看自己的脑袋被砍下来？」' }, { turn: 4, input: '', text: '路人' }] }
  const tavern = fakeTavern(games)
  const llm = { async *stream() { yield { type: 'reasoning-delta', text: '想啊想' }; yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Provider finish_reason: max_tokens' } } } } }
  const searcher = createSearcher({ tavern, llm: () => llm, games: async () => ['a'] })
  const found = await searcher.ai({ current: 'a', scope: 'game', description: '变成触手怪的阿黛尔说难道柯萝伊想看自己的脑袋被砍下来吗' })
  assert.equal(found.results[0].turn, 3)
  assert.equal(found.notes.length, 2)
  assert.match(found.notes[0], /输出额度/)
})

test('搜索器：截断但已写出 JSON 时照用', async () => {
  const games = { a: [{ turn: 2, input: '', text: '雨夜还怀表' }] }
  const replies = ['{"terms":["怀表"]}', '{"picks":[{"id":1,"why":"就是这条"}]}']
  const llm = { async *stream() { yield { type: 'text-delta', text: replies.shift() }; yield { type: 'finish', reason: { kind: 'max_tokens' } } } }
  const searcher = createSearcher({ tavern: fakeTavern(games), llm: () => llm, games: async () => ['a'] })
  const found = await searcher.ai({ current: 'a', description: '怀表' })
  assert.equal(found.results[0].why, '就是这条')
  assert.equal(found.notes.length, 0)
})

test('命中很密的长文不会整段铺开', () => {
  const long = Array.from({ length: 200 }, (_, i) => '阿黛尔和柯萝伊' + i).join('，')
  const total = snippet(long, ['阿黛尔', '柯萝伊']).map(s => s.text).join('').length
  assert.ok(total < 600, String(total))
})

test('长正文里名字到处都是时，AI 候选按段找到深处那句台词', () => {
  const filler = Array.from({ length: 80 }, (_, i) => `**阿黛尔**「柯萝伊，第 ${i} 层的魔物又来了。」\n**柯萝伊**「阿黛尔小心！」\n`).join('')
  const story = filler + '**阿黛尔**「柯萝伊啊。你想看到我被人砍掉脑袋的样子吗？」\n**柯萝伊**「——怎么可能啊！！」\n' + filler
  const long = [prepare({ gameId: 'x', turn: 2, input: '设定：阿黛尔和柯萝伊是同伴，变成触手怪物，脑袋里……'.repeat(20), text: story })]
  const list = candidates(long, ['变成', '触手', '阿黛尔', '柯萝伊', '脑袋', '砍下来', '回到地上', '不愿意'], { who: 'all', limit: 5 })
  assert.ok(list.some(item => item.brief.includes('砍掉脑袋')), list.map(i => i.brief.slice(0, 40)).join('\n'))
  const top = list.find(item => item.brief.includes('砍掉脑袋'))
  assert.ok(top.brief.length < 400)
})

test('关键词结果每处命中一段，各带定位用的原文', () => {
  const found = keywordSearch([prepare({ gameId: 'g', turn: 2, input: '', text: '甲'.repeat(300) + '脑袋A' + '乙'.repeat(300) + '脑袋B' })], '脑袋')
  const windows = found.results[0].parts[0].windows
  assert.equal(windows.length, 2)
  assert.ok(windows[1].anchor.includes('脑袋B'))
})

const memorySettings = (conf = {}) => ({
  async get() { return { rounds: 3, semantic: { enabled: false, baseURL: '', model: '' }, ...conf } },
  async key() { return '' },
})

test('多轮追问：第一轮 AI 觉得都不像时换词再筛，不再给它看已经看过的段', async () => {
  const games = { a: [{ turn: 1, input: '', text: '甲：今天天气不错。' }, { turn: 2, input: '', text: '乙把银色的钥匙丢进了井里。' }] }
  const prompts = []
  const replies = ['{"terms":["天气"]}', '{"picks":[]}', '{"terms":["钥匙","井"]}', '{"picks":[{"id":1,"why":"钥匙丢进井里","quote":"把银色的钥匙丢进了井里"}]}']
  const llm = { async *stream(request) { prompts.push(request.messages[0].content[0].text); yield { type: 'text-delta', text: replies.shift() } } }
  const searcher = createSearcher({ tavern: fakeTavern(games), llm: () => llm, games: async () => ['a'], settings: memorySettings() })
  const found = await searcher.ai({ current: 'a', description: '有人把一个东西扔掉了' })
  assert.equal(found.tries, 2)
  assert.equal(found.results[0].turn, 2)
  assert.match(prompts[2], /上次试过这些词.*天气/)
  assert.ok(!prompts[3].includes('天气不错'))
})

test('语义检索：按意思找到一个字都对不上的段，和按词找的交错给 AI', async () => {
  const games = { a: [{ turn: 1, input: '', text: '她把怀表还给了我。' }, { turn: 2, input: '', text: '城门外下着大雨。' }] }
  const semantic = {
    ensured: 0,
    async ensure(units) { this.ensured = units.length },
    async search(query, units, { skip }) { return units.filter(unit => !skip.has(unit.key) && unit.body.includes('怀表')).map(unit => ({ unit, score: 0.9 })) },
  }
  const replies = ['{"terms":["雨"]}', 'P']
  let seenPrompt = ''
  const llm = { async *stream(request) { let text = replies.shift(); if (text === 'P') { seenPrompt = request.messages[0].content[0].text; text = '{"picks":[{"id":1,"why":"归还旧物"}]}' } yield { type: 'text-delta', text } } }
  const searcher = createSearcher({ tavern: fakeTavern(games), llm: () => llm, games: async () => ['a'], semantic, settings: memorySettings({ semantic: { enabled: true, baseURL: 'x', model: 'm' } }) })
  const found = await searcher.ai({ current: 'a', description: '归还旧物' })
  assert.equal(semantic.ensured, 2)
  assert.ok(seenPrompt.includes('怀表') && seenPrompt.includes('大雨'))
  assert.equal(found.results[0].turn, 1)
  assert.equal(found.semantic, true)
})

test('语义检索出错时退回只按词找', async () => {
  const games = { a: [{ turn: 1, input: '', text: '城门外下着大雨。' }] }
  const semantic = { async ensure() { throw new Error('向量接口报错 401') }, async search() { throw new Error('no') } }
  const replies = ['{"terms":["雨"]}', '{"picks":[{"id":1,"why":"下雨"}]}']
  const llm = { async *stream() { yield { type: 'text-delta', text: replies.shift() } } }
  const searcher = createSearcher({ tavern: fakeTavern(games), llm: () => llm, games: async () => ['a'], semantic, settings: memorySettings({ semantic: { enabled: true, baseURL: 'x', model: 'm' } }) })
  const found = await searcher.ai({ current: 'a', description: '下雨' })
  assert.equal(found.results.length, 1)
  assert.match(found.notes[0], /401/)
})

test('设置存进 Tavern 插件数据，Key 存进凭据', async () => {
  const { createSettings } = await import('../index.mjs')
  let data = null
  const creds = new Map()
  const tavern = { apiVersion: 4, async readPluginData() { return data }, async savePluginData({ data: d }) { data = d } }
  const credentials = { async resolve(ref) { return { value: creds.get(ref) } }, async set(ref, value) { creds.set(ref, value) } }
  const { mkdtemp } = await import('node:fs/promises')
  const dir = await mkdtemp((await import('node:os')).tmpdir() + '/cs-')
  const settings = createSettings({ dir, tavern, credentials: () => credentials })
  assert.equal((await settings.get()).semantic.enabled, false)
  await settings.save({ rounds: 2, semantic: { enabled: true, baseURL: 'u', model: 'm' } }, 'sk-1')
  assert.deepEqual(data, { rounds: 2, semantic: { enabled: true, baseURL: 'u', model: 'm' } })
  assert.equal(await settings.key(), 'sk-1')
  assert.equal((await settings.get()).rounds, 2)
})
