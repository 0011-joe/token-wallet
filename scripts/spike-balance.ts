// ============================================================
// T1.1 余额接口探针: spike-balance.ts
// 运行: node --env-file=.env.local scripts/spike-balance.ts
// 行为:
//   1) 第 1 次 GET https://api.deepseek.com/user/balance (Bearer key, 10s 超时)
//   2) 若 200 -> 等待 3 秒 -> 第 2 次调用(观察限流/耗时)
//   3) 若 401/403 -> 记录响应体, 不再调用
//   4) 若 429   -> 记录 Retry-After 头与响应体, 等待后最多再观察 1 次
//   5) 其他错误 -> 记录状态码+响应体
// 安全: 所有输出(含写入笔记)先经 sanitize() 脱敏; 任何输出中不会出现 key。
// ============================================================

const { getBuiltinModule } = process
const fs = getBuiltinModule('node:fs')
const path = getBuiltinModule('node:path')

const ENDPOINT = 'https://api.deepseek.com/user/balance'
const TIMEOUT_MS = 10_000
const WAIT_200_MS = 3_000
const notesFile = path.join(process.cwd(), 'scripts', 'spike-notes.md')

const key = process.env.DEEPSEEK_API_KEY ?? ''
if (key === '') {
  console.error('[spike-balance] 未取到 DEEPSEEK_API_KEY, 请用: node --env-file=.env.local scripts/spike-balance.ts')
  process.exit(2)
}

// ---------------- 脱敏 ----------------
let KEY_PREFIX: string = ''
if (key.length >= 12) KEY_PREFIX = key.slice(0, 12)
function sanitize(s: unknown): string {
  let t = String(s)
  if (key.length >= 8) t = t.split(key).join('[已脱敏]')
  if (KEY_PREFIX !== '') t = t.split(KEY_PREFIX).join('[已脱敏]')
  t = t.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[已脱敏]')
  return t
}

// ---------------- 输出(每条先脱敏) ----------------
const lines: string[] = []
function out(s = ''): void {
  const t = sanitize(s)
  lines.push(t)
  console.log(t)
}

// ---------------- JSON 结构描述 ----------------
function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array(len=' + String((v as unknown[]).length) + ')'
  const t = typeof v
  if (t === 'object') return 'object'
  return t
}

function scalarSample(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v.length > 60 ? v.slice(0, 60) + '…' : v)
  return String(v)
}

function walkJson(v: unknown, p: string, outRows: Array<{ path: string; type: string; sample: string }>, depth = 0): void {
  if (depth > 6) return
  if (v === null || Array.isArray(v)) {
    outRows.push({ path: p, type: typeName(v), sample: Array.isArray(v) ? 'len=' + String(v.length) : 'null' })
    if (Array.isArray(v) && v.length > 0) walkJson(v[0], p + '[0]', outRows, depth + 1)
    return
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of Object.keys(o)) {
      const val = o[k]
      outRows.push({ path: p + '.' + k, type: typeName(val), sample: typeof val === 'object' ? '' : scalarSample(val) })
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) walkJson(val, p + '.' + k, outRows, depth + 1)
      else if (Array.isArray(val)) walkJson(val[0], p + '.' + k + '[0]', outRows, depth + 1)
    }
    return
  }
  outRows.push({ path: p, type: typeof v, sample: scalarSample(v) })
}

// ---------------- 一次调用 ----------------
interface CallRecord {
  label: string
  ok: boolean
  status?: number
  statusText?: string
  ms: number
  retryAfter: string | null
  rateLimitHeaders: Record<string, string>
  bodyText: string
  json: unknown | undefined
  error: string
}

async function callOnce(label: string): Promise<CallRecord> {
  const t0 = Date.now()
  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    const err = e as { name?: string; message?: string }
    return {
      label, ok: false, ms: Date.now() - t0, retryAfter: null, rateLimitHeaders: {},
      bodyText: '', json: undefined,
      error: (err.name ?? 'Error') + ': ' + (err.message ?? '(无错误信息)'),
    }
  }
  const ms = Date.now() - t0
  const bodyText = await res.text().catch(() => '')
  let json: unknown
  try { json = JSON.parse(bodyText) } catch { json = undefined }
  const rateLimitHeaders: Record<string, string> = {}
  for (const [k, v] of res.headers.entries()) {
    const lk = k.toLowerCase()
    if (lk.includes('ratelimit') || lk === 'retry-after') rateLimitHeaders[k] = v
  }
  return {
    label, ok: res.ok, status: res.status, statusText: res.statusText, ms,
    retryAfter: res.headers.get('retry-after'), rateLimitHeaders, bodyText, json, error: '',
  }
}

function parseRetryAfter(v: string | null): number {
  if (!v) return 0
  const sec = Number(v)
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000)
  const t = Date.parse(v)
  if (!Number.isNaN(t)) return Math.max(0, t - Date.now())
  return 0
}

// ---------------- 主流程 ----------------
async function main(): Promise<void> {
  const results: CallRecord[] = []

  const r1 = await callOnce('第1次')
  results.push(r1)

  if (r1.status === 200) {
    out('第 1 次返回 200, 等待 ' + WAIT_200_MS + 'ms 后第 2 次调用(观察限流头/耗时)…')
    await new Promise((r) => setTimeout(r, WAIT_200_MS))
    const r2 = await callOnce('第2次')
    results.push(r2)
  } else if (r1.status === 429) {
    const waitMs = Math.min(parseRetryAfter(r1.retryAfter) || 2_000, 5_000)
    out('第 1 次返回 429, 按 Retry-After 等待 ' + waitMs + 'ms 后再观察 1 次…')
    await new Promise((r) => setTimeout(r, waitMs))
    const r2 = await callOnce('第2次(429观察)')
    results.push(r2)
  }
  // 401/403 与其他错误: 只记录, 不再调用(避免无谓请求)

  // ---------------- 输出结果 ----------------
  out('')
  out('===== Q2 余额接口探针结果 (spike-balance.ts) =====')
  out('时间: ' + new Date().toISOString())
  out('端点: GET ' + ENDPOINT + ' (Authorization: Bearer <已脱敏>, 超时 ' + TIMEOUT_MS + 'ms)')

  for (const r of results) {
    out('')
    out('--- ' + r.label + ' ---')
    if (r.error !== '') {
      out('调用失败: ' + r.error)
      continue
    }
    out('HTTP 状态: ' + r.status + ' ' + (r.statusText ?? ''))
    out('耗时: ' + r.ms + ' ms')
    const rlKeys = Object.keys(r.rateLimitHeaders)
    if (rlKeys.length === 0) out('限流相关响应头: 无')
    else {
      for (const k of rlKeys) out('限流相关响应头: ' + k + ' = ' + r.rateLimitHeaders[k])
    }
    if (r.retryAfter) out('Retry-After: ' + r.retryAfter)

    if (r.status === 200) {
      if (r.json === undefined) {
        out('响应体非 JSON, 前 200 字符: ' + sanitize(r.bodyText.slice(0, 200)))
        continue
      }
      const rows: Array<{ path: string; type: string; sample: string }> = []
      walkJson(r.json, '$', rows)
      out('响应 JSON 字段结构(字段名\t类型\t样例):')
      for (const row of rows) out('  ' + row.path + '\t' + row.type + '\t' + row.sample)
      out('字段清单: ' + rows.map((x) => x.path).join(', '))
    } else {
      out('错误响应体: ' + (sanitize(r.bodyText.slice(0, 500)) || '(空)'))
    }
  }

  // ---------------- 结论 + 写入笔记 ----------------
  out('')
  out('===== Q2 结论 =====')
  const q2Lines: string[] = []
  for (const r of results) {
    const statusStr = r.status !== undefined ? 'HTTP ' + r.status : '调用失败'
    q2Lines.push('- ' + r.label + ': ' + statusStr + ', 耗时 ' + r.ms + 'ms')
    if (r.status === 429 || r.status === 401 || r.status === 403) {
      q2Lines.push('  - 响应体(已脱敏): ' + (sanitize(r.bodyText.slice(0, 300)) || '(空)'))
    }
  }
  const last = results[results.length - 1]
  const rateLimitSummary = Object.keys(last.rateLimitHeaders).length === 0
    ? '未观察到限流相关响应头'
    : '观察到限流相关响应头: ' + Object.keys(last.rateLimitHeaders).map((k) => k + '=' + last.rateLimitHeaders[k]).join(', ')

  if (last.status === 200 && last.json !== undefined) {
    const rows: Array<{ path: string; type: string; sample: string }> = []
    walkJson(last.json, '$', rows)
    q2Lines.push('- 200 响应 JSON 结构(字段路径\t类型\t样例):')
    for (const row of rows) q2Lines.push('  - ' + row.path + ': ' + row.type + ', 样例=' + row.sample)
    q2Lines.push('- 字段清单: ' + rows.map((x) => x.path).join(', '))
  }
  q2Lines.push('- 限流情况: ' + rateLimitSummary)
  q2Lines.push('- 请求头为 Authorization: Bearer <已脱敏>; 本笔记与输出不含任何明文 key 片段。')

  const q2Body = [
    '- 探针脚本: scripts/spike-balance.ts, 运行命令: node --env-file=.env.local scripts/spike-balance.ts',
    '- 端点: GET ' + ENDPOINT + ', Bearer 认证(已脱敏), 超时 ' + TIMEOUT_MS + 'ms, 共发起 ' + results.length + ' 次调用',
    ...q2Lines,
  ].join('\n')

  upsertSection(notesFile, 'Q2 余额接口结论', q2Body)
  out('结论已写入 ' + notesFile + ' 的「Q2 余额接口结论」节')
  for (const l of q2Lines) out(l)
}

// ---------------- 笔记文件写入(按节替换) ----------------

main().catch((e) => {
  console.error('[spike-balance] 未处理异常:', e)
  process.exitCode = 1
})

// ---------------- 笔记文件写入(按节替换; Q1 恒在 Q2 前) ----------------

// ---------------- 笔记文件写入(按节替换; 块间恒为 2 空行; Q1 恒在 Q2 前) ----------------
function upsertSection(file: string, heading: string, body: string): void {
  const marker = '## ' + heading
  const block = marker + '\n\n' + body.trimEnd()
  let existing = ''
  try { existing = fs.readFileSync(file, 'utf8') } catch { /* 文件不存在 */ }
  existing = sanitize(existing)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (existing.trim() === '') {
    fs.writeFileSync(file, '# DeepBalance M1 探针笔记\n\n' + block + '\n', 'utf8')
    return
  }
  const order: Record<string, number> = { 'Q1 CSV 结构结论': 0, 'Q2 余额接口结论': 1 }
  const titleEnd = existing.indexOf('## ')
  const title = (titleEnd === -1 ? existing : existing.slice(0, titleEnd)).trimEnd()
  const rest = titleEnd === -1 ? '' : existing.slice(titleEnd)
  const blocks = rest.split(/(?=^## )/m).map((b) => b.trimEnd()).filter((b) => b !== '')
  const kept = blocks.filter((b) => !b.startsWith(marker))
  const myOrder = order[heading] ?? 99
  let insertAt = -1
  for (let i = 0; i < kept.length; i++) {
    const h = kept[i].slice(0, kept[i].indexOf('\n')).replace('## ', '')
    if ((order[h] ?? 99) > myOrder) { insertAt = i; break }
  }
  const merged = insertAt === -1 ? [...kept, block] : [...kept.slice(0, insertAt), block, ...kept.slice(insertAt)]
  fs.writeFileSync(file, title + '\n\n' + merged.join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n', 'utf8')
}
