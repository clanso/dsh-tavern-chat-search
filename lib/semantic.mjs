// 语义检索（可选，默认关）：给每一段算向量，按意思找，描述和原文一个字都对不上时也能找到。
// 接 OpenAI 兼容的 /embeddings 接口（硅基流动、OpenAI、本地 Ollama 之类）。向量按「模型 + 段落原文」的哈希缓存在磁盘上，
// 第一次要把全部对话算一遍，之后只算新增或改过的段。存的是归一化后量化成 int8 的向量，一段 1024 维约 1.4KB。
import { createHash } from 'node:crypto'
import { mkdir, readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

const BATCH = 32
const PARALLEL = 2
const MAX_CHARS = 512

const hashOf = (model, text) => createHash('sha1').update(model).update('\0').update(text).digest('base64url')
const slug = model => String(model).replace(/[^\w.-]+/g, '_').slice(0, 80)

/** 单位长度化后量化成 int8。 */
export function quantize(vector) {
  let norm = 0
  for (const v of vector) norm += v * v
  norm = Math.sqrt(norm) || 1
  const out = new Int8Array(vector.length)
  for (let i = 0; i < vector.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round((vector[i] / norm) * 127)))
  return out
}

export function similarity(a, b) {
  let dot = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) dot += a[i] * b[i]
  return dot / (127 * 127)
}

/** 调一次 /embeddings。 */
export async function embed({ baseURL, model, key, texts, fetchImpl = fetch, signal }) {
  const url = String(baseURL || '').replace(/\/+$/, '') + '/embeddings'
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, input: texts.map(text => String(text).slice(0, MAX_CHARS)) }),
    signal,
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`向量接口报错 ${response.status}：${body.slice(0, 200)}`)
  let data
  try { data = JSON.parse(body) } catch { throw new Error('向量接口回的不是 JSON') }
  const rows = Array.isArray(data?.data) ? data.data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : []
  if (rows.length !== texts.length || !rows.every(row => Array.isArray(row.embedding))) throw new Error('向量接口回的条数不对')
  return rows.map(row => row.embedding)
}

/**
 * dir：缓存放哪；config()：{ baseURL, model }；key()：Key。
 * 返回 { ensure(units, onProgress), search(query, units, { limit, skip }), test() }，units 是 [{ key, body }]。
 */
export function createSemantic({ dir, config, key, fetchImpl = fetch, logger = console }) {
  let loaded = null // { model, vectors: Map<hash, Int8Array> }

  async function store() {
    const { model } = await config()
    if (loaded && loaded.model === model) return loaded
    const vectors = new Map()
    const file = join(dir, `vectors-${slug(model)}.jsonl`)
    try {
      for (const line of (await readFile(file, 'utf8')).split('\n')) {
        if (!line) continue
        const tab = line.indexOf('\t')
        if (tab > 0) { const bytes = Buffer.from(line.slice(tab + 1), 'base64'); vectors.set(line.slice(0, tab), new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length)) }
      }
    } catch {}
    loaded = { model, file, vectors }
    return loaded
  }

  async function settings() {
    const { baseURL, model } = await config()
    if (!baseURL || !model) throw new Error('语义检索还没填接口地址或模型（搜对话 → 设置）')
    return { baseURL, model, key: await key() }
  }

  /** 把还没有向量的段算出来，写进缓存。onProgress(done, total)。 */
  async function ensure(units, onProgress = () => {}) {
    const s = await settings()
    const cache = await store()
    const missing = []
    const seen = new Set()
    for (const unit of units) {
      const hash = hashOf(s.model, unit.body)
      unit.hash = hash
      if (!cache.vectors.has(hash) && !seen.has(hash)) { seen.add(hash); missing.push(unit) }
    }
    if (!missing.length) return 0
    await mkdir(dir, { recursive: true })
    let done = 0
    onProgress(done, missing.length)
    const batches = []
    for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH))
    let next = 0
    const workers = Array.from({ length: Math.min(PARALLEL, batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++]
        const vectors = await embed({ ...s, texts: batch.map(unit => unit.body), fetchImpl })
        let lines = ''
        batch.forEach((unit, i) => {
          const q = quantize(vectors[i])
          cache.vectors.set(unit.hash, q)
          lines += `${unit.hash}\t${Buffer.from(q.buffer).toString('base64')}\n`
        })
        await appendFile(cache.file, lines)
        done += batch.length
        onProgress(done, missing.length)
      }
    })
    await Promise.all(workers)
    return missing.length
  }

  /** 按意思最像的 limit 段（跳过 skip 里的 key）。返回 [{ unit, score }]。 */
  async function search(query, units, { limit = 30, skip = new Set() } = {}) {
    const s = await settings()
    const cache = await store()
    const [vector] = await embed({ ...s, texts: [query], fetchImpl })
    const q = quantize(vector)
    const scored = []
    for (const unit of units) {
      if (skip.has(unit.key)) continue
      const v = cache.vectors.get(unit.hash || hashOf(s.model, unit.body))
      if (v) scored.push({ unit, score: similarity(q, v) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  async function test() {
    const s = await settings()
    const [vector] = await embed({ ...s, texts: ['测试：雨夜里她把怀表还给了我'], fetchImpl })
    return { dims: vector.length }
  }

  return { ensure, search, test }
}
