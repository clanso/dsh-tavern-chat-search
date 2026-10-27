import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSemantic, quantize, similarity } from '../lib/semantic.mjs'

// 假的向量接口：按几个字有没有出现给出向量
const DIMS = ['怀表', '雨', '钥匙', '归还']
function fakeFetch(calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, auth: init.headers.authorization, n: body.input.length })
    const data = body.input.map((text, index) => ({ index, embedding: DIMS.map(word => (text.includes(word) || (word === '怀表' && text.includes('归还')) ? 1 : 0.01)) }))
    return { ok: true, status: 200, text: async () => JSON.stringify({ data }) }
  }
}

test('quantize 后余弦相似度保持', () => {
  assert.ok(Math.abs(similarity(quantize([1, 0]), quantize([2, 0])) - 1) < 0.02)
  assert.ok(Math.abs(similarity(quantize([1, 0]), quantize([0, 1]))) < 0.02)
})

test('只算缺的段，缓存写盘后换个实例也能读回来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-search-'))
  const calls = []
  const config = async () => ({ baseURL: 'https://x/v1/', model: 'bge' })
  const units = [{ key: 'a', body: '她把怀表还给了我' }, { key: 'b', body: '外面下雨了' }, { key: 'c', body: '外面下雨了' }]
  const one = createSemantic({ dir, config, key: async () => 'sk', fetchImpl: fakeFetch(calls) })
  assert.equal(await one.ensure(units), 2)
  assert.equal(calls[0].url, 'https://x/v1/embeddings')
  assert.equal(calls[0].auth, 'Bearer sk')
  assert.equal(await one.ensure(units), 0)
  const two = createSemantic({ dir, config, key: async () => '', fetchImpl: fakeFetch(calls) })
  assert.equal(await two.ensure(units), 0)
  const top = await two.search('归还', units, { limit: 1 })
  assert.equal(top[0].unit.key, 'a')
  const skipped = await two.search('归还', units, { limit: 1, skip: new Set(['a']) })
  assert.notEqual(skipped[0].unit.key, 'a')
})

test('没填接口时报清楚的错', async () => {
  const s = createSemantic({ dir: tmpdir(), config: async () => ({ baseURL: '', model: '' }), key: async () => '' })
  await assert.rejects(s.test(), /还没填接口地址/)
})
