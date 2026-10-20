#!/usr/bin/env node
'use strict'
/**
 * 音源端到端体检
 * ------------------------------------------------------------------
 * 用法：
 *   node tools/e2e.js                     测所有源的 latest.js
 *   node tools/e2e.js qdy                 只测 qdy
 *   node tools/e2e.js qdy wy tx           只测指定源/平台
 *   node tools/e2e.js --file path/to.js   测任意脚本
 *   node tools/e2e.js --verify            额外用 HEAD 验证返回链接是否真的是音频
 *   node tools/e2e.js --trap             用「错歌陷阱」样本歌测（验证 aggregator 不播错歌）
 *
 * 退出码：0 = 至少一个源全平台可用；1 = 存在失败；2 = 脚本加载失败
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const { loadSource } = require('./lx_runtime')

const ROOT = path.resolve(__dirname, '..')
const IDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'ids.json'), 'utf8'))
const ALL_PLATFORMS = ['wy', 'tx', 'kw', 'kg', 'mg']
// 默认只测 128k / flac（覆盖面与耗时平衡）；给 --allq 可扩到全部 4 档
const ALL_QUALITIES = process.argv.includes('--allq') ? ['128k', '320k', 'flac', 'flac24bit'] : ['128k', 'flac']

const argv = process.argv.slice(2)
const VERIFY = argv.includes('--verify')
/**
 * 默认用 songs_wellknown（各平台同一首 mainstream 歌）测「能不能取到链」。
 * ids.json 里的 songs 是**刻意设计的错歌陷阱**（wy 是「晴天(深情版)」翻唱，
 * 其余平台是周杰伦原版）：Aggregator 的三重校验会正确地拒绝跨源匹配，
 * 所以拿它当通用通过率指标会平白判失败。想专门验证防错歌用 --trap。
 */
// --songset <ids.json 里的键> 可换样本歌，如 --songset songs_jj
const songsetIdx = argv.indexOf('--songset')
const SONGSET = songsetIdx >= 0 ? argv[songsetIdx + 1] : null
const SONG = (SONGSET && IDS[SONGSET]) || (argv.includes('--trap') ? IDS.songs : (IDS.songs_wellknown || IDS.songs))
const fileIdx = argv.indexOf('--file')
const CUSTOM_FILE = fileIdx >= 0 ? argv[fileIdx + 1] : null
const positional = argv.filter((a) => !a.startsWith('--') && a !== CUSTOM_FILE && a !== SONGSET)
const SOURCE_NAMES = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, 'latest.js')))
  .map((d) => d.name)
const platforms = positional.filter((a) => ALL_PLATFORMS.includes(a))
const targets = positional.filter((a) => SOURCE_NAMES.includes(a))

function listSources() {
  if (CUSTOM_FILE) return [CUSTOM_FILE]
  return SOURCE_NAMES
    .filter((n) => !targets.length || targets.includes(n))
    .map((n) => path.join(ROOT, n, 'latest.js'))
}

function buildMusicInfo(platform) {
  const s = SONG[platform]
  if (!s) throw new Error('未知平台 ' + platform)
  // 严格照洛雪 2.12.x 实际发出的形态构造（从 user-api 页面抓的真实请求）：
  //   - musicInfo 嵌在 info.musicInfo 里，不是平铺
  //   - singer 是字符串（'周杰伦'），不是 {name} 数组
  //   - interval 是 '04:41' 这种 mm:ss 字符串，不是秒数
  //   - 没有 type 字段（type 在外层）
  const interval = `${String(Math.floor(s.interval / 60)).padStart(2, '0')}:${String(s.interval % 60).padStart(2, '0')}`
  return { ...s, singer: s.singer, source: platform, interval, img: '', img1: '', typeUrl: {}, types: [], _types: [] }
}

/**
 * 用 Range GET 确认链接真的能拿到音频。
 * LX 播放器（axios/follow-redirects）会跟随重定向，而 lx.request 不会，
 * 所以这里必须手动跟随，才能判断 .php 网关链到底能不能播。
 */
function probeAudio(url, depth = 0) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.request(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-2047' },
      timeout: 10000,
    }, (res) => {
      const status = res.statusCode
      const loc = res.headers.location
      if (status >= 300 && status < 400 && loc && depth < 5) {
        res.destroy()
        const next = new URL(loc, url).href
        probeAudio(next, depth + 1).then((r) => resolve({ ...r, chain: [`${status} → ${next}`, ...(r.chain || [])] }))
        return
      }
      res.destroy()
      const ct = String(res.headers['content-type'] || '')
      const isAudio = /^(audio|video)\//i.test(ct)
      const isEmpty = status === 403 && !ct.includes('octet')
      resolve({ status, type: ct, ok: isAudio && !isEmpty, chain: depth ? [`跟随 ${depth} 次重定向`] : [] })
    })
    req.on('error', (e) => resolve({ status: 0, type: 'ERR ' + e.message, ok: false }))
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, type: 'TIMEOUT', ok: false }) })
    req.end()
  })
}

const ICON = { ok: '✅', bad: '❌', warn: '⚠️ ' }

;(async () => {
  const files = listSources()
  if (!files.length) { console.error('没有找到要测试的源'); process.exit(2) }
  const usePlatforms = platforms.length ? platforms : ALL_PLATFORMS

  const summary = []
  for (const file of files) {
    const name = path.basename(path.dirname(file))
    let src
    try {
      src = await loadSource(file)
    } catch (e) {
      console.log(`\n${ICON.bad} ${name}  加载失败: ${e.message}`)
      summary.push({ name, platform: '(加载失败)', quality: '-', ok: false, error: e.message })
      continue
    }
    src.netLog ??= []
    if (src.loadError) {
      console.log(`\n=== ${name}  (${path.relative(ROOT, file)}) ===`)
      console.log(`  ${ICON.bad}加载失败: ${src.loadError}`)
      summary.push({ name, platform: '(加载失败)', quality: '-', ok: false, error: src.loadError })
      continue
    }
    const declared = Object.keys(src.declared?.sources || {})
    console.log(`\n=== ${name}  (${path.relative(ROOT, file)}) ===`)
    console.log(`  声明源: ${declared.join(', ') || '(无)'}   LX 保留: ${Object.keys(src.sources).join(', ') || '(无)'}`)
    if (src.scriptInfo) console.log(`  脚本信息: name=${src.scriptInfo.name} version=${src.scriptInfo.version} author=${src.scriptInfo.author}`)
    if (src.logs.length) {
      console.log(`  脚本日志(${src.logs.length} 条): ${src.logs.slice(0, 5).join(' | ').slice(0, 300)}`)
    }
    if (src.netLog && src.netLog.length) {
      for (const n of (src.netLog || []).slice(0, 8)) {
        console.log(`  ${ICON.warn}网络 ${n.status || 'ERR'} ${n.ms}ms ${n.ct || ''} ${n.url.slice(0, 110)}`)
        if (process.env.SHOW_BODY) console.log(`        └ ${String(n.body).replace(/\s+/g, ' ').slice(0, 1200)}`)
      }
    }
    if (src.dropped.length) console.log(`  ${ICON.warn}被 LX 丢弃(不在平台白名单): ${src.dropped.join(', ')}`)
    if (!Object.keys(src.sources).length) {
      console.log(`  ${ICON.bad}未通过 LX 平台/音质白名单过滤，LX 不会调用本源`)
      summary.push({ name, platform: '(无有效源)', quality: '-', ok: false, error: '未通过 LX 平台/音质白名单过滤' })
    }
    const netMark = src.netLog.length
    for (const [p, q] of Object.entries(src.sources)) {
      if (!q.qualitys.length) console.log(`  ${ICON.warn}${p}: 声明的音质与 LX 无交集 → LX 只会按默认音质请求`)
    }
    for (const p of usePlatforms) {
      if (src.loadError) break
      if (!src.sources[p]) { console.log(`  ${ICON.warn}${p}: 该源未声明（LX 不会调用）`); continue }
      if (!SONG[p]) { console.log(`  ${ICON.warn}${p}: ids.json 里没有该平台的样本歌 ID，跳过`); continue }
      for (const q of ALL_QUALITIES) {
        let res
        // 严格按洛雪 2.12.x 的真实约定：info = { type, musicInfo }。
        // 之前这里额外平铺了一份字段，等于同时喂两种形态，
        // 结果 aggregator 读 info.name 读不到真正值（真实是 info.musicInfo.name）
        // 这种 bug 在测试里永远测不出来 —— 只能照真实形态喂。
        const mi = buildMusicInfo(p)
        try { res = await src.call('musicUrl', p, { type: q, musicInfo: mi }) } catch (e) { res = { ok: false, elapsed: 0, error: e.message } }
        let line
        if (!res.ok) {
          line = `  ${ICON.bad} ${p}/${q} ${String(res.elapsed).padStart(6)}ms  错误: ${res.error}`
          if (res.value !== undefined) line += `  → 实际返回: ${String(res.value).slice(0, 120)}`
          if (process.env.SHOW_STACK && res.stack) line += `\n       └ ${res.stack.split('\n').slice(0, 4).join('\n       ')}`
          summary.push({ name, platform: p, quality: q, ok: false, error: res.error })
        } else {
          let probe = ''
          if (VERIFY) {
            const r = await probeAudio(res.value)
            probe = r.ok ? ` [音频验证 OK ${r.status} ${r.type}${r.chain?.length ? ' · 跟随' + (r.chain.length - 1) + '次跳转' : ''}]` : ` [音频验证失败 ${r.status} ${r.type}]`
          }
          line = `  ${probe ? (probe.includes('失败') ? ICON.bad : ICON.ok) : ICON.ok} ${p}/${q} ${String(res.elapsed).padStart(6)}ms  ${String(res.value).slice(0, 96)}${probe}`
          summary.push({ name, platform: p, quality: q, ok: VERIFY ? probe.includes('失败') === false : true, url: res.value })
        }
        console.log(line)
      }
    }
    if (process.env.SHOW_NET && src.netLog.length > netMark) {
      console.log(`  ${ICON.warn}取链期间的网络请求 (${src.netLog.length - netMark} 条)`)
      for (const n of src.netLog.slice(netMark, netMark + 10)) {
        console.log(`    ${n.status || 'ERR'} ${n.ms}ms ${n.ct || ''} ${n.url.slice(0, 150)}`)
        if (n.err) console.log(`      └ ${n.err}`)
        if (process.env.SHOW_BODY && n.body) console.log(`      └ ${String(n.body).replace(/\s+/g, ' ').slice(0, 600)}`)
      }
    }
  }

  console.log('\n================ 汇总 ================')
  const byName = {}
  for (const s of summary) {
    byName[s.name] ??= { ok: 0, bad: 0 }
    s.ok ? byName[s.name].ok++ : byName[s.name].bad++
  }
  for (const [n, v] of Object.entries(byName)) {
    console.log(`  ${v.bad === 0 ? ICON.ok : ICON.bad} ${n.padEnd(10)} 通过 ${v.ok} / 失败 ${v.bad}`)
  }
  const allOk = Object.values(byName).every((v) => v.bad === 0)
  process.exit(allOk ? 0 : 1)
})()
