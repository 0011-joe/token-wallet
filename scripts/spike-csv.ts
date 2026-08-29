// ============================================================
// T1.2 CSV 样本探针: spike-csv.ts
// 运行: node scripts/spike-csv.ts
// 读取: samples/amount-2026-07-31_2026-08-28.csv
//       samples/cost-2026-07-31_2026-08-28.csv  (UTF-8 BOM, 自动去 BOM)
// 安全: api_key 列只输出"形状"(真实字符全部替换为 x)与长度/星号段统计,
//       不输出任何真实字符, 也不输出完整打码形态。
// ============================================================

const { getBuiltinModule } = process
const fs = getBuiltinModule('node:fs')
const path = getBuiltinModule('node:path')

const samplesDir = path.join(process.cwd(), 'samples')
const amountFile = path.join(samplesDir, 'amount-2026-07-31_2026-08-28.csv')
const costFile = path.join(samplesDir, 'cost-2026-07-31_2026-08-28.csv')
const notesFile = path.join(process.cwd(), 'scripts', 'spike-notes.md')

function fail(msg: string): never {
  console.error('[spike-csv] ' + msg)
  process.exit(2)
}

// -------- 引号感知 CSV 解析 + 去 BOM --------
function readCsv(p: string): string[][] {
  let text: string
  try { text = fs.readFileSync(p, 'utf8') } catch { fail('无法读取 ' + p) }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') {
      if (field.endsWith('\r')) field = field.slice(0, -1)
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) {
    if (field.endsWith('\r')) field = field.slice(0, -1)
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
  }
  return rows
}

// -------- 计数助手 --------
function count(arr: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const v of arr) m.set(v, (m.get(v) ?? 0) + 1)
  return m
}

// -------- key 形状: 字母数字 -> x, 保留 * 与 - --------
function keyShape(v: string): string {
  return v.replace(/[A-Za-z0-9]/g, 'x')
}

// -------- 打码规则描述(仅长度/位置, 不输出字符) --------
function describeMask(v: string): string {
  if (!v.includes('*')) return '未打码(脚本不输出其内容, 仅长度=' + v.length + ')'
  const starCount = (v.match(/\*/g) ?? []).length
  const plain = v.replace(/\*/g, '')
  const segs = v.split('*').map((s) => s.length)
  const skPrefix = v.startsWith('sk-') ? '是' : '否'
  return '长度=' + v.length + '; 是否以标准API key前缀(即 s 加 k 加连字符)开头: ' + skPrefix +
    '; 星号数=' + starCount +
    '; 星号分段长度序列(真实字符段长度): ' + segs.join('+') +
    '; 去除星号后非星字符数=' + plain.length
}

// ============================================================
// 主分析
// ============================================================
async function main(): Promise<void> {
  const amount = readCsv(amountFile)
  const cost = readCsv(costFile)
  if (amount.length < 2) fail(amountFile + ' 无数据行(仅表头)')
  const aHeaders = amount[0]
  const aRows = amount.slice(1)
  const cHeaders = cost[0]
  const cRows = cost.slice(1)

  const idx = (headers: string[]): ((name: string) => number) => {
    const m: Record<string, number> = {}
    headers.forEach((x, i) => { m[x] = i })
    return (name: string) => m[name]
  }
  const ai = idx(aHeaders)
  const ci = idx(cHeaders)
  const needA = ['user_id', 'start_time_iso', 'end_time_iso', 'model', 'api_key_name', 'api_key', 'type', 'price', 'amount']
  for (const n of needA) if (ai(n) === undefined) fail('amount 文件缺少列: ' + n)
  for (const n of ['user_id', 'start_time_iso', 'end_time_iso', 'model', 'wallet_type', 'cost', 'currency']) {
    if (ci(n) === undefined) fail('cost 文件缺少列: ' + n)
  }

  out('===== Q1 CSV 结构探针结果 (spike-csv.ts) =====')
  out('时间: ' + new Date().toISOString())

  out('')
  out('--- 文件 1: samples/amount-2026-07-31_2026-08-28.csv ---')
  out('数据行数: ' + aRows.length)
  out('列名(精确): ' + aHeaders.map((x) => JSON.stringify(x)).join(', '))
  out('每列样例值(第 1 行数据; api_key 列不显示字符):')
  const sr = aRows[0]
  for (const name of aHeaders) {
    if (name === 'api_key') {
      out('  "' + name + '" = <不显示; 打码规则见下>')
    } else {
      out('  "' + name + '" = ' + JSON.stringify(sr[ai(name)]))
    }
  }

  const typeCounts = count(aRows.map((r) => r[ai('type')]))
  out('type 取值全集: ' + [...typeCounts.entries()].map(([k, v]) => k + ' x' + v).join(', '))

  const pd = new Map<string, { rows: number; sum: number }>()
  for (const r of aRows) {
    const k = r[ai('type')] + '||' + r[ai('price')]
    const cur = pd.get(k) ?? { rows: 0, sum: 0 }
    cur.rows += 1
    cur.sum += Number(r[ai('amount')] ?? 0)
    pd.set(k, cur)
  }
  out('price 分布(type x price -> 行数, amount 合计; 同 type 可能多档价格):')
  for (const [k, v] of pd.entries()) {
    const parts = k.split('||')
    out('  type=' + parts[0] + ', price=' + (parts[1] === '' ? '(空)' : parts[1]) +
      ' -> 行数=' + v.rows + ', amount合计=' + v.sum)
  }

  const modelCounts = count(aRows.map((r) => r[ai('model')]))
  out('模型 ID 全集: ' + [...modelCounts.entries()].map(([k, v]) => k + ' x' + v).join(', '))

  const rcRows = aRows.filter((r) => r[ai('type')] === 'request_count')
  const rcPrices = [...new Set(rcRows.map((r) => r[ai('price')]))]
  out('request_count: 行数=' + rcRows.length +
    ', price 取值集=' + (rcPrices.length === 0 ? '(无)' : rcPrices.map((x) => x === '' ? '(空字符串)' : x).join(', ')) +
    ' -> request_count 是否有 price: ' + (rcPrices.length === 0 || (rcPrices.length === 1 && rcPrices[0] === '') ? '否(无价格)' : '是'))

  const keys = aRows.map((r) => r[ai('api_key')])
  const keyLens = count(keys.map((k) => String(k.length)))
  const shapes = [...new Set(keys.map(keyShape))]
  out('api_key 字段分析(不显示任何真实字符):')
  out('  唯一值数量: ' + new Set(keys).size)
  out('  长度分布: ' + [...keyLens.entries()].map(([k, v]) => k + ' x' + v).join(', '))
  out('  是否全部含 * (打码标志): ' + keys.every((k) => k.includes('*')))
  out('  形状(真实字符->x, 保留 * 与 -): ' + shapes.join(' / '))
  out('  打码规则: ' + describeMask(keys[0]))
  const keyNameCounts = count(aRows.map((r) => r[ai('api_key_name')]))
  out('  api_key_name 取值: ' + [...keyNameCounts.entries()].map(([k, v]) => k + ' x' + v).join(', '))

  const TOKEN_TYPES = ['input_cache_hit_tokens', 'input_cache_miss_tokens', 'output_tokens']
  out('按模型聚合的 token 合计(amount 求和; cache_hit/cache_miss/output 分开):')
  const modelSet = [...new Set(aRows.map((r) => r[ai('model')]))]
  for (const m of modelSet) {
    const parts: string[] = []
    for (const tt of TOKEN_TYPES) {
      const rows = aRows.filter((r) => r[ai('model')] === m && r[ai('type')] === tt)
      const sum = rows.reduce((acc, r) => acc + Number(r[ai('amount')] ?? 0), 0)
      parts.push(tt + '=' + sum + '(行数' + rows.length + ')')
    }
    const rc = aRows.filter((r) => r[ai('model')] === m && r[ai('type')] === 'request_count')
    const rcSum = rc.reduce((acc, r) => acc + Number(r[ai('amount')] ?? 0), 0)
    out('  model=' + m + ': ' + parts.join(', ') + '; request_count合计=' + rcSum + '(行数' + rc.length + ')')
  }

  out('')
  out('--- 文件 2: samples/cost-2026-07-31_2026-08-28.csv ---')
  out('数据行数: ' + cRows.length)
  out('列名(精确): ' + cHeaders.map((x) => JSON.stringify(x)).join(', '))
  if (cRows.length > 0) {
    out('样例值(第 1 行): ' + cRows[0].map((v, i) => cHeaders[i] + '=' + JSON.stringify(v)).join(', '))
  }
  const wt = count(cRows.map((r) => r[ci('wallet_type')]))
  out('wallet_type 取值(全部行): ' + [...wt.entries()].map(([k, v]) => k + ' x' + v).join(', '))
  const costSum = cRows.reduce((acc, r) => acc + Number(r[ci('cost')] ?? 0), 0)
  const curSet = [...new Set(cRows.map((r) => r[ci('currency')]))]
  out('cost 合计: ' + costSum + '; currency 取值: ' + (curSet.join(', ') || '(空)'))


  // -------- Q1 结论(简明) + 写入笔记 --------
  const q1Lines: string[] = []
  q1Lines.push('- 探针脚本: scripts/spike-csv.ts, 运行命令: node scripts/spike-csv.ts')
  q1Lines.push('- 文件1 ' + path.basename(amountFile) + ': ' + aRows.length + ' 行数据; 列名: ' + aHeaders.map((x) => JSON.stringify(x)).join(', '))
  q1Lines.push('- type 取值全集: ' + [...typeCounts.entries()].map(([k, v]) => k + ' x' + v).join(', '))
  q1Lines.push('- price 分布(type x price, 同 type 存在多档价格):')
  for (const [k, v] of pd.entries()) {
    const p = k.split('||')
    q1Lines.push('  - ' + p[0] + ' | price=' + (p[1] === '' ? '(空)' : p[1]) + ' | 行数=' + v.rows + ' | amount合计=' + v.sum)
  }
  q1Lines.push('- 模型 ID 全集: ' + [...modelCounts.entries()].map(([k, v]) => k + ' x' + v).join(', '))
  q1Lines.push('- request_count: 行数=' + rcRows.length + ', price=' +
    (rcPrices.length === 0 ? '(无)' : rcPrices.map((x) => x === '' ? '(空字符串)' : x).join(', ')) +
    ' => 无价格')
  q1Lines.push('- api_key 字段: ' + keys.length + ' 行全部为打码形态(含 *), 长度=' + [...keyLens.entries()].map(([k, v]) => k + 'x' + v).join(',') +
    ', 唯一值 ' + new Set(keys).size + ' 个; 打码规则: ' + describeMask(keys[0]) + '; 形状: ' + shapes.join(' / ') +
    '; api_key_name: ' + [...keyNameCounts.entries()].map(([k, v]) => k + ' x' + v).join(', '))
  q1Lines.push('- 按模型 token 合计:')
  for (const m of modelSet) {
    const parts: string[] = []
    for (const tt of TOKEN_TYPES) {
      const rows = aRows.filter((r) => r[ai('model')] === m && r[ai('type')] === tt)
      const sum = rows.reduce((acc, r) => acc + Number(r[ai('amount')] ?? 0), 0)
      parts.push(tt + '=' + sum)
    }
    const rc = aRows.filter((r) => r[ai('model')] === m && r[ai('type')] === 'request_count')
    const rcSum = rc.reduce((acc, r) => acc + Number(r[ai('amount')] ?? 0), 0)
    q1Lines.push('  - model=' + m + ': ' + parts.join(', ') + '; request_count合计=' + rcSum)
  }
  q1Lines.push('- 文件2 ' + path.basename(costFile) + ': ' + cRows.length + ' 行数据; 列名: ' + cHeaders.map((x) => JSON.stringify(x)).join(', '))
  q1Lines.push('- wallet_type 取值: ' + [...wt.entries()].map(([k, v]) => k + ' x' + v).join(', '))
  q1Lines.push('- cost 合计=' + costSum + ', currency=' + (curSet.join(', ') || '(空)'))

  out('')
  out('===== Q1 结论 =====')
  for (const l of q1Lines) out(l)
  upsertSection(notesFile, 'Q1 CSV 结构结论', q1Lines.join('\n'))
  out('')
  out('结论已写入 ' + notesFile + ' 的「Q1 CSV 结构结论」节')
}

// ---------------- 笔记文件写入(按节替换; 与 spike-balance.ts 中实现一致) ----------------

// ---------------- 输出与脱敏 ----------------
const lines: string[] = []
function out(s = ''): void {
  const t = sanitize(s)
  lines.push(t)
  console.log(t)
}

// 兜底脱敏: 替换疑似 sk- 长串(现实中 CSV 无真实 key, 但防御性保留)
function sanitize(s: unknown): string {
  return String(s).replace(/sk-[A-Za-z0-9_-]{12,}/g, '[已脱敏]')
}

main().catch((e) => {
  console.error('[spike-csv] 未处理异常:', e)
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
