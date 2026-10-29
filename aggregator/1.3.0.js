/*!
 * @name 聚合音源
 * @description v1.3.0 跨源降级 + 三重校验防错歌 + 音质降级保播放
 * @version v1.3.0
 * @author pdone
 * @homepage https://github.com/BeYourDreams/lx-music-source
 * @netease MUSIC_U=;
 * @tencent ts_last=y.qq.com/n/ryqq/album;
 * @preserve
 */

/**
 * 聚合音源 v1.1.0 —— 跨源降级，但绝不播放错歌
 *
 * ── 核心权衡 ──────────────────────────────────────────────
 * 「优先保证播放」和「别播错歌」天然冲突：网关把 A 平台的 id
 * 降级到 B 平台的资源时，id 格式对不上就会播成另一首歌。
 * 本脚本用两条规则同时满足两者：
 *
 *   规则 1：跨源只能走「搜索」，不能走「换 id」
 *     把 tx 的 songmid 直接丢给 kw 网关 = 必然错歌（数字对不上）。
 *     正确做法是用 歌名+歌手 去目标平台搜索，拿到那边**正确的 id**
 *     再取链 —— 这样跨源后拿到的仍是同一首歌。
 *
 *   规则 2：搜索结果必须过三重校验才能用
 *     歌名相似度 + 歌手匹配 + 时长差 ≤ 5s。
 *     三条全过才采纳；宁可报「未找到匹配歌曲」，也不返回错歌。
 *     时长是最强判别器：网易云搜「晴天 周杰伦」首条是
 *     「晴天(深情版)」278s，而原版是 269s —— 差 9s，光靠歌名分不开，
 *     加了时长校验后被准确拦下。
 *
 * ── 平台策略 ──────────────────────────────────────────────
 *   wy / kw  本平台有「真链」网关，id 天然正确，零错歌风险 → 最优先
 *   tx / kg  本平台网关是降级到酷我的，有错歌风险 → 改为优先跨源拿真链
 *   mg       本平台全站失效 → 跨源是唯一出路
 *
 *   换句话说：tx/kg/mg 通过跨源拿到的网易云链，比它们自己网关
 *   给的酷我链「更正确」，而耗时相当（1.4s vs 0.6s）。
 */

'use strict'

/* ============================ 配置 ============================ */

/** 单次请求超时 */
const REQ_TIMEOUT = 5000
/** 搜索接口超时（比网关短，搜索挂了就没必要等） */
const SEARCH_TIMEOUT = 3500
/** 主流程总预算。LX 主进程对每个 action 有 20000ms 硬超时，留足余量。 */
const TOTAL_BUDGET = 17000
/** 时长校验容差（秒）。翻唱/现场版通常差 10s+，原版各平台一致。 */
const DURATION_TOLERANCE = 5

/** LX 音质 → 网关 level 参数 */
const LEVEL_PARAM = {
  '128k': 'standard',
  '320k': '320k',
  flac: 'lossless',
  flac24bit: 'hiLossless',
}

/**
 * 各平台的「直连网关」。id 传本平台 id，取回本平台资源，错歌风险最低。
 * order 小的先试。
 */
const DIRECT_GATEWAY = {
  // 网易云：type=flac 返回 JSON {code,data:{url}}，拿到 m801.music.126.net 真链
  wy: [
    { name: 'haitangw/wy', mode: 'json',
      url: (id, q) => `https://yinyue.haitangw.net/wy/wy.php?type=flac&id=${enc(id)}&level=${LEVEL_PARAM[q]}` },
  ],
  // 酷我：musicapi 网关返回 302 到 car-er.kuwo.cn，LX 播放器会跟随
  kw: [
    { name: 'musicapi/kw', mode: 'redir',
      url: (id, q) => `https://musicapi.haitangw.net/music/kw.php?type=mp3&id=${enc(id)}&level=${LEVEL_PARAM[q]}` },
  ],
  // 咪咕上游全站失效（对所有歌曲都回「歌曲下线」），保留配置以便恢复后自动生效
  mg: [
    { name: 'haitangw/mg', mode: 'json',
      url: (id, q) => `https://yinyue.haitangw.net/mg/migu.php?type=mp3&id=${enc(id)}&level=${LEVEL_PARAM[q]}` },
  ],
}

/**
 * 各平台的「降级网关」。本平台 id → 别的平台资源。
 * 有错歌风险，只在前面的路都走不通时兜底。
 */
const FALLBACK_GATEWAY = {
  wy: [
    { name: 'haitangw/wy-302', mode: 'redir',
      url: (id, q) => `http://yinyue.haitangw.net/wy/wy.php?type=mp3&id=${enc(id)}&level=${LEVEL_PARAM[q]}` },
  ],
  tx: [
    { name: 'haitangw/qq_kw', mode: 'text',
      url: (id, q) => `https://yinyue.haitangw.net/qq/qq_kw.php?type=mp3&id=${enc(id)}&level=${LEVEL_PARAM[q]}` },
  ],
  kg: [
    { name: 'haitangw/kg_kw', mode: 'text',
      url: (id, q) => `https://yinyue.haitangw.net/kg/kg_song_kw.php?type=mp3&id=${enc(id)}&level=${LEVEL_PARAM[q]}` },
  ],
  kw: [
    { name: 'haitangw/kw-302', mode: 'redir',
      url: (id, q) => `http://yinyue.haitangw.net/kw/kw.php?type=mp3&id=${enc(id)}&level=${LEVEL_PARAM[q]}` },
  ],
  mg: [],
}

/**
 * 跨源顺序。对每个平台给出「优先去哪些平台搜歌」。
 * 只列搜索质量可靠的平台：
 *   - 网易云 music.163.com/api/search/get（相关性尚可，300ms）
 *   - QQ c.y.qq.com/soso/fcgi-bin/client_search_cp（相关性最好，2.2s）
 * 已排除：酷我（旧接口搜「晴天 周杰伦」首条是 KTV 伴奏，且新旧 id 格式不通用）、
 *        酷狗（需 kg_music token，IP 被 Access Deny）、咪咕（DNS 无解析）。
 */
const CROSS_SOURCE_ORDER = {
  wy: ['kw'],       // 网易云直连已足够，跨源只作救命用；酷我搜索质量差故不放前面
  tx: ['wy', 'kw'],
  kw: ['wy', 'tx'],
  kg: ['wy', 'tx'],
  mg: ['wy', 'tx'],
}

/** 从 musicInfo 提取本平台取链用的 id */
const ID_PICKER = {
  wy: (m) => m.songmid || m.id,
  tx: (m) => m.songmid || m.strMediaMid || m.id,
  kw: (m) => m.songmid || m.id,
  kg: (m) => m.hash || m.songmid || m.id,
  mg: (m) => m.copyrightId || m.songmid || m.id,
}

/* ============================ HTTP ============================ */

function enc(s) { return encodeURIComponent(String(s)) }

/**
 * 带超时的 GET。lx.request 是回调风格 cb(err, resp)，且不跟随重定向
 * —— 正好用来拿 3xx 的 Location。网络异常一律转成 statusCode 0，不抛。
 */
function fetchUrl(url, timeout) {
  const ms = timeout || REQ_TIMEOUT
  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v) }
    const timer = setTimeout(() => finish({ statusCode: 0, headers: {}, body: '', err: 'timeout' }), ms)

    lx.request(url, { method: 'GET', timeout: ms, headers: { 'User-Agent': 'Mozilla/5.0' } }, (err, resp) => {
      if (err) return finish({ statusCode: 0, headers: {}, body: '', err: err.message || String(err) })
      const statusCode = (resp && resp.statusCode) || 0
      const headers = (resp && resp.headers) || {}
      if (statusCode >= 300 && statusCode < 400) {
        return finish({ statusCode, headers, body: '', location: String(headers.location || '') })
      }
      let body = resp && resp.body
      if (body == null) body = ''
      else if (typeof body === 'object') { try { body = JSON.stringify(body) } catch { body = '' } }
      else body = String(body)
      finish({ statusCode, headers, body, contentType: String(headers['content-type'] || '') })
    })
  })
}

/* ============================ 歌名/歌手比对 ============================ */

/** 全角转半角 */
function toHalf(s) { return s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) }

/**
 * 歌名归一化：去括号补充说明、去标点空格、转小写。
 * "晴天(深情版)" / "晴天 (Live)" / "【HQ】晴天" → "晴天"
 * 这样能避免翻唱版仅靠括号后缀就混过去 —— 真正的区分交给歌手和时长。
 */
function normTitle(s) {
  return toHalf(String(s || ''))
    .replace(/[(（\[【].*?[)）\]】]/g, ' ')
    .replace(/[\s\-_·・,，.。!！?？~～'"'"`|、\/\\]+/g, '')
    .toLowerCase()
}

/** 歌手归一化：支持字符串和 {name} 数组两种形态（LX 与第三方源格式不统一） */
function normSingers(v) {
  const arr = Array.isArray(v) ? v : (v ? [v] : [])
  return arr
    .map((s) => (typeof s === 'string' ? s : (s && s.name) || ''))
    .flatMap((s) => toHalf(String(s)).split(/[\/、,&＆;；\s]+/))
    .map((s) => s.replace(/[\s\-_·・,，.。!！?？~～'"'"`|]+/g, '').toLowerCase())
    .filter(Boolean)
}

/**
 * 歌名相似度（字符集合 Jaccard，0~1）。
 * 归一化后集合重合度，对「晴天」vs「晴天MV」这类足够。
 */
function titleSim(a, b) {
  const A = new Set(a)
  const B = new Set(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const c of A) if (B.has(c)) inter++
  return inter / (A.size + B.size - inter)
}

/** 歌手是否匹配：任一歌手完全相同，或互为子串（「周杰伦」vs「Jay Chou」不行，但「周」vs「周杰伦」行） */
function singerMatch(aList, bList) {
  if (!aList.length || !bList.length) return true // 没歌手信息就不断言，交给时长
  for (const a of aList) for (const b of bList) {
    if (a === b) return true
    if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return true
  }
  return false
}

/** 时长是否匹配（统一成秒，允许 undefined 表示未知） */
function durationMatch(aSec, bSec) {
  if (aSec == null || bSec == null) return true
  return Math.abs(aSec - bSec) <= DURATION_TOLERANCE
}

/**
 * 判断候选歌曲是否就是目标歌曲。三条全过才算。
 * 这是「别播错歌」的唯一闸门。
 */
function isSameSong(want, got) {
  const tSim = titleSim(normTitle(want.name), normTitle(got.name))
  if (tSim < 0.7) return { ok: false, reason: `歌名不符(${tSim.toFixed(2)}「${got.name}」)` }
  if (!singerMatch(normSingers(want.singer), normSingers(got.singer))) {
    return { ok: false, reason: `歌手不符(「${(got.singer || []).map((s) => (typeof s === 'string' ? s : s.name)).join(',')}」)` }
  }
  if (!durationMatch(want.interval, got.interval)) {
    return { ok: false, reason: `时长不符(${want.interval}s vs ${got.interval}s)` }
  }
  return { ok: true, score: tSim }
}

/* ============================ 搜索 ============================ */

/** 从 musicInfo 取出用于搜索的目标信息 */
function targetInfo(info) {
  return {
    name: info.name || info.songname || '',
    singer: info.singer || info.singers || [],
    interval: info.interval != null ? Number(info.interval) : null,
  }
}

const SEARCH_API = {
  wy: {
    name: '网易云',
    url: (kw) => `https://music.163.com/api/search/get?csrf_token=&hlpretag=&hlposttag=&s=${enc(kw)}&type=1&offset=0&total=true&limit=8`,
    headers: { Referer: 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0' },
    parse: (j) => ((((j || {}).result || {}).songs) || []).map((s) => ({
      name: s.name,
      singer: (s.artists || []).map((a) => a.name),
      interval: s.duration ? Math.round(s.duration / 1000) : null, // 网易云是毫秒
      id: String(s.id),
    })),
  },
  tx: {
    name: 'QQ',
    url: (kw) => `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${enc(kw)}&format=json&p=1&n=8`,
    headers: { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' },
    parse: (j) => ((((j || {}).data || {}).song || {}).list || []).map((s) => ({
      name: s.songname,
      singer: (s.singer || []).map((a) => a.name),
      interval: s.interval != null ? Number(s.interval) : null, // QQ 已是秒
      id: String(s.songmid),
    })),
  },
}

/**
 * 在目标平台搜歌，并返回**通过三重校验**的最佳候选。
 * 一个都过不了就返回 null —— 这是宁可不给也不给错歌的体现。
 */
async function searchVerified(target, platform, deadline) {
  const api = SEARCH_API[platform]
  if (!api) return null
  const remain = deadline - Date.now()
  if (remain <= 1200) return null

  // 关键词：歌名 + 第一位歌手
  const firstSinger = normSingers(target.singer)[0]
  const kw = firstSinger ? `${target.name} ${firstSinger}` : target.name

  const res = await fetchUrl(api.url(kw), Math.min(SEARCH_TIMEOUT, remain))
  if (res.err || res.statusCode !== 200 || !res.body) return null

  let j
  try { j = JSON.parse(res.body) } catch { return null }

  let list = []
  try { list = api.parse(j) || [] } catch { return null }
  if (!list.length) return null

  const rejects = []
  let best = null
  for (const cand of list) {
    if (!cand.id) continue
    const v = isSameSong(target, cand)
    if (v.ok) {
      if (!best || v.score > best.score) best = { ...cand, score: v.score }
    } else if (rejects.length < 3) {
      rejects.push(v.reason)
    }
  }

  if (best) return { hit: best, rejects }
  return { hit: null, rejects }
}

/* ============================ URL 解析 ============================ */

function isValidUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u) && u.length > 12 && u.length <= 2048 && !/^https?:\/\/[^/]*\/?$/i.test(u)
}

function pickUrlFromJson(text) {
  let j = text
  if (typeof text === 'string') {
    const unquoted = text.trim().replace(/^["']|["']$/g, '').trim()
    if (isValidUrl(unquoted)) return unquoted
    try { j = JSON.parse(text) } catch { return null }
  }
  if (!j || typeof j !== 'object') return null
  for (const c of [j.url, j.data && j.data.url, j.data, j.play_url, j.src, j.link]) {
    if (isValidUrl(c)) return c
  }
  return null
}

function pickUrlFromText(text) {
  if (typeof text !== 'string') return null
  const t = text.trim().replace(/^["']|["']$/g, '').trim()
  if (isValidUrl(t)) return t
  const m = t.match(/https?:\/\/[^\s"'<>\\]+/i)
  return m && isValidUrl(m[0]) ? m[0] : null
}

/* ============================ 网关 ============================ */

/**
 * 可播性预检：对一个「需要再跳一次」的链接手动跟随重定向，
 * 用 Range GET 确认最终确实能拿到音频。
 *
 * 为什么需要：某些网关地址（如 wy.php?type=mp3）自己不返回音频，
 * 而是 302 到真音频。LX 播放器会跟，但这一步能把「预检过」写进日志，
 * 也能拦住那些跳到首页/占位页的假链 —— 那类链返回 200 看似成功，
 * 实际播不出来。
 */
async function isPlayable(url, deadline) {
  let cur = url
  for (let hop = 0; hop < 5; hop++) {
    if (deadline - Date.now() <= 800) return { ok: false, reason: '预算不足' }
    const res = await fetchUrl(cur, Math.min(REQ_TIMEOUT, deadline - Date.now()))
    if (res.err || res.statusCode === 0) return { ok: false, reason: res.err || '无响应' }
    if (res.statusCode >= 300 && res.statusCode < 400) {
      if (!res.location) return { ok: false, reason: '重定向无 Location' }
      try { cur = new URL(res.location, cur).href } catch { return { ok: false, reason: 'Location 非法' } }
      continue
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const ct = String(res.contentType || '')
      if (/^audio\//i.test(ct)) return { ok: true, reason: `${res.statusCode} ${ct}` }
      return { ok: false, reason: `200 但非音频(${ct.slice(0, 25)})` }
    }
    return { ok: false, reason: `HTTP ${res.statusCode}` }
  }
  return { ok: false, reason: '重定向跳数过多' }
}

/**
 * 试一个网关。
 * 失败时返回 { url: null, reason }，reason 区分「网络挂了」和「此歌无版权」，
 * 便于决定是换网关还是换平台。
 */
async function tryGateway(gw, id, quality, deadline) {
  const remain = deadline - Date.now()
  if (remain <= 500) return { url: null, reason: '预算耗尽' }

  let url
  try { url = gw.url(id, quality) } catch { return { url: null, reason: 'URL 构造失败' } }

  const res = await fetchUrl(url, Math.min(REQ_TIMEOUT, remain))
  if (res.err || res.statusCode === 0) return { url: null, reason: `网络失败(${res.err || '无响应'})` }

  if (res.statusCode >= 300 && res.statusCode < 400) {
    if (!res.location) return { url: null, reason: '重定向但无 Location' }
    let loc
    try { loc = new URL(res.location, url).href } catch { return { url: null, reason: 'Location 非法' } }
    // 排掉跳到网站首页/占位页的情况
    if (/\.(html?|php)$/i.test(loc) && !/music|audio|song|stream|\.mp3|\.flac|\.m4a/i.test(loc)) {
      return { url: null, reason: '重定向到网页而非音频' }
    }
    return isValidUrl(loc) ? { url: loc, reason: '302 跳转(LX 播放器会跟随)' } : { url: null, reason: '重定向目标非法' }
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return { url: null, reason: /^50\d$/.test(String(res.statusCode)) ? `上游故障(HTTP ${res.statusCode})` : `HTTP ${res.statusCode}` }
  }
  if (/^audio\//i.test(String(res.contentType || ''))) return { url, reason: '网关内联转发' }

  // 走到这里说明网关自己没内联音频，但它把 302 的目标地址直接吐在 body 里。
  // 这类链接不预检就等于赌播放器会跟跳，所以先验证一遍。
  const u0 = gw.mode === 'json'
    ? pickUrlFromJson(res.body)
    : (pickUrlFromJson(res.body) || pickUrlFromText(res.body))
  if (!u0) {
    // 区分三类失败，对应三种不同的下一步选择
    try {
      const j = JSON.parse(res.body)
      const msg = (j && (j.msg || j.message)) || ''
      const code = j && (j.code ?? j.status)
      if (code === 500 || code === 502 || code === 503) {
        return { url: null, reason: `上游故障(${String(msg).slice(0, 24)})` }
      }
      if (code === 404) return { url: null, reason: '网关无此歌' }
      if (msg) return { url: null, reason: `网关无版权(${String(msg).slice(0, 30)})` }
    } catch { /* 非 JSON */ }
    return { url: null, reason: '响应里没有可用的 URL' }
  }

  if (isGatewayAddress(u0)) {
    const playable = await isPlayable(u0, deadline)
    if (!playable.ok) return { url: null, reason: `预检不可播(${playable.reason})` }
    return { url: u0, reason: `预检通过(${playable.reason})` }
  }
  return { url: u0, reason: '已解析' }
}

/** 是不是一个「自己不做代理、只负责跳转」的 .php 网关地址 */
function isGatewayAddress(u) {
  return /\/(wy|qq_kw|kw|kg_song_kw|migu|musicapi)\.php(\?|$)/i.test(u)
}

/* ============================ 主流程 ============================ */

const QUALITIES = ['128k', '320k', 'flac', 'flac24bit']

/**
 * 取链主流程。按「错歌风险由低到高」排列，保证又快又不会播错：
 *
 *   1. 本平台直连网关      —— 错歌风险 0（id 就是本平台的）
 *   2. 跨源搜索 + 目标平台直连 —— 错歌风险低（过了三重校验）
 *   3. 本平台降级网关      —— 错歌风险中（网关内部做了平台映射）
 */
const DEGRADE_MIN_BUDGET = 2500

/**
 * 音质降级链：从请求音质往下逐级退，最低到 128k。
 * 高音质失败往往是「无版权 / 网关无此曲」这类**快速失败**，
 * 此时预算基本没花完，正好拿来用低音质再试一轮。
 */
function degradeChain(quality) {
  const i = QUALITIES.indexOf(quality)
  return i < 0 ? ['128k'] : QUALITIES.slice(0, i + 1).reverse()
}

/**
 * 对外入口：按降级链重试。全程共用一个 deadline，保证总耗时不超预算。
 */
async function resolve(source, info, quality) {
  const deadline = Date.now() + TOTAL_BUDGET
  const chain = degradeChain(quality)
  const allLog = []

  for (let i = 0; i < chain.length; i++) {
    const q = chain[i]
    if (i > 0) {
      const remain = deadline - Date.now()
      // 预算不够再开一轮就是白跑，不如保留给「换源」这一个结果
      if (remain < DEGRADE_MIN_BUDGET) {
        allLog.push(`✗ 剩余预算 ${remain}ms 不足，放弃降级到 ${q}`)
        break
      }
      allLog.push(`── 降级重试：${quality} → ${q} ──`)
    }
    const r = await resolveOnce(source, info, q, deadline)
    for (const line of r.log) allLog.push(i > 0 ? `[${q}] ${line}` : line)
    if (r.url) {
      if (i > 0) allLog.push(`⚠ 已从 ${quality} 降级到 ${q} 以保证播放`)
      return { url: r.url, log: allLog }
    }
  }
  return { url: null, log: allLog }
}

async function resolveOnce(source, info, quality, deadline) {
  const target = targetInfo(info)
  const log = []

  const ownId = ID_PICKER[source] ? ID_PICKER[source](info) : null
  const ownGateways = [...(DIRECT_GATEWAY[source] || []), ...(FALLBACK_GATEWAY[source] || [])]
  const directs = DIRECT_GATEWAY[source] || []
  const fallbacks = FALLBACK_GATEWAY[source] || []

  // ── 阶段 1：本平台直连 ──
  if (ownId) {
    for (const gw of directs) {
      const r = await tryGateway(gw, ownId, quality, deadline)
      if (r.url) { log.push(`✓ ${source} 直连 ${gw.name} (${r.reason})`); return { url: r.url, log } }
      log.push(`✗ ${source} 直连 ${gw.name}: ${r.reason}`)
    }
  }

  // ── 阶段 2：跨源搜索 ──
  // 必须确认还剩足够预算再进这个阶段，否则跑了也是白跑
  // 预算不够时应直接跳到阶段 3 降级网关，把时间留给还能出结果的路
  if (target.name) {
    for (const other of CROSS_SOURCE_ORDER[source] || []) {
      if (deadline - Date.now() < 3000) { log.push('✗ 预算不足，跳过剩余跨源'); break }
      const r = await searchVerified(target, other, deadline)
      if (!r) { log.push(`✗ ${source}→${other} 搜索失败`); continue }
      if (!r.hit) {
        log.push(`✗ ${source}→${other} 无匹配（${(r.rejects || []).slice(0, 2).join('; ')}）`)
        continue
      }
      // 用目标平台搜到的 id 走目标平台的网关。
      // 注意：tx/kg/mg 并无「直连网关」——它们只能经 qq_kw / kg_kw 这类
      // 降级网关取链。所以这里必须把直连和降级都遍历一遍，
      // 否则搜到了正确 id 却没有网关可用，会静默失败。
      const targetGws = [...(DIRECT_GATEWAY[other] || []), ...(FALLBACK_GATEWAY[other] || [])]
      if (!targetGws.length) { log.push(`✗ ${source}→${other} 命中「${r.hit.name}」但该平台无取链网关`); continue }
      for (const gw of targetGws) {
        const g = await tryGateway(gw, r.hit.id, quality, deadline)
        if (g.url) {
          log.push(`✓ ${source}→${other}「${r.hit.name}」三重校验通过 → ${gw.name} (${g.reason})`)
          return { url: g.url, log }
        }
        log.push(`✗ ${source}→${other} 命中「${r.hit.name}」但取链失败: ${g.reason}`)
      }
    }
  } else {
    log.push('✗ musicInfo 无歌名，跳过跨源（无法校验是否同一首歌）')
  }

  // ── 阶段 3：本平台降级兜底 ──
  if (ownId) {
    for (const gw of fallbacks) {
      const r = await tryGateway(gw, ownId, quality, deadline)
      if (r.url) { log.push(`✓ ${source} 降级 ${gw.name} (${r.reason})`); return { url: r.url, log } }
      log.push(`✗ ${source} 降级 ${gw.name}: ${r.reason}`)
    }
  }

  return { url: null, log }
}

/* ============================ LX 接口 ============================ */

/** 所有支持的平台 = 直连网关有的 ∪ 降级网关有的 */
const ALL_PLATFORMS = [...new Set([...Object.keys(DIRECT_GATEWAY), ...Object.keys(FALLBACK_GATEWAY)])]

lx.on(lx.EVENT_NAMES.request, ({ source, action, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error(`不支持的操作: ${action}`))
  if (ALL_PLATFORMS.indexOf(source) < 0) return Promise.reject(new Error(`不支持的源: ${source}`))

  const quality = info && info.type ? info.type : '128k'
  const q = QUALITIES.indexOf(quality) > -1 ? quality : '128k'

  return resolve(source, info || {}, q).then((r) => {
    if (r.url) return r.url
    const detail = r.log.slice(-4).join(' | ')
    throw new Error(`聚合源：${source} 未取到链接。${detail}`)
  })
})

lx.send(lx.EVENT_NAMES.inited, {
  status: true,
  openDevTools: false,
  sources: Object.fromEntries(ALL_PLATFORMS.map((p) => [p, { type: 'music', actions: ['musicUrl'], qualitys: QUALITIES }])),
})
