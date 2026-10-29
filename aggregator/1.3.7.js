/*!
 * @name 聚合音源
 * @description v1.3.7 修好日志里版本号双 v（vv1.3.6）的显示：已是最新/发现新版本都只带一个 v
 * @version v1.3.7
 * @author pdone
 * @homepage https://github.com/BeYourDreams/lx-music-source
 * @netease MUSIC_U=;
 * @tencent ts_last=y.qq.com/n/ryqq/album;
 * @preserve
 */

/**
 * 聚合音源 —— 跨源降级，但绝不播放错歌
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
/**
 * 主流程总预算。
 * LX 主进程对每个 action 有 20000ms 硬超时，一旦撞上，主进程会直接把
 * action 判为失败并弹出通用的「换源失败，请尝试手动在搜索页指定其他来源…」。
 * 那句提示不含任何原因，无法定位。v1.3.0 用 17000ms，在网络稍慢时会
 * 连带 LX 自身开销一起撞线，表现为**全平台一律换源失败**。
 * 这里压到 12000ms：留足 8s 余量，我们自己抛出的错误才能带回真实 reason。
 */
const TOTAL_BUDGET = 12000

/* ======================= 自动检查更新 ======================= */

/**
 * 依次尝试这些地址取最新版脚本。**加速源放在前面**，国内直连 raw 放最后兜底。
 * 全部指向同一个文件（aggregator/latest.js），由 CreateLatest.py 从最新版本号生成。
 * 注意：ghproxy.cn 已失效（返回 200 但是拦截页），不要加进来。
 */
const UPDATE_URLS = [
'https://ghfast.top/https://raw.githubusercontent.com/BeYourDreams/lx-music-source/main/aggregator/latest.js',
'https://gh-proxy.com/https://raw.githubusercontent.com/BeYourDreams/lx-music-source/main/aggregator/latest.js',
'https://ghproxy.net/https://raw.githubusercontent.com/BeYourDreams/lx-music-source/main/aggregator/latest.js',
'https://raw.githubusercontent.com/BeYourDreams/lx-music-source/main/aggregator/latest.js',
]
/** 单个更新地址的超时。更新检查不能拖慢启动，也不能拖慢取链。 */
const UPDATE_TIMEOUT = 3000
/** 启动后延迟多久开始检查（秒）。避开启动那波请求和用户的第一次播放。 */
const UPDATE_DELAY = 8000

/** 'v1.3.2' → [1,3,2]；解析不出来返回 null */
function parseVersion(v) {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v || ''))
  if (!m) return null
  return [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0]
}

/** a 比 b 新返回 true */
function isNewer(a, b) {
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return false
}

/**
 * 检查有没有新版本，有就调 lx.send(updateAlert) 让洛雪弹更新提示。
 *
 * 洛雪的机制：脚本发 updateAlert → 客户端弹窗显示 log，并给一个「打开链接」按钮
 * 指向 updateUrl。所以这里把**加速源地址**给出去，点一下就能下到最新版，
 * 再在「设置 → 音源设置 → 自定义源」里重新导入即可。
 *
 * 全程不抛错、不阻塞：拉不到就算了，绝不能影响取链。
 */
/** 版本号统一显示：头部注释里的 @version 自带 v 前缀，别再拼一个变成 vv1.3.7 */
function vtag(version) {
  const text = String(version == null ? '' : version).trim()
  return !text || /^v/i.test(text) ? text : `v${text}`
}

async function checkUpdate() {
  if (!lx.EVENT_NAMES || !lx.EVENT_NAMES.updateAlert) return
  const info = lx.currentScriptInfo || {}
  const current = parseVersion(info.version)
  if (!current) return

  for (const url of UPDATE_URLS) {
    let body = ''
    // 末尾加时间戳打破加速站缓存：不加的话仓库刚推的最新版会被当成旧版，
    // 表现为「明明发布了却提示已是最新」。
    const probe = `${url}?_=${Date.now()}`
    // 先用 Range 只取头部（省流量），拿不到就退回整份 —— 加速站对 Range 的支持
    // 很不一致（实测会直接失败），不退回的话自动更新形同虚设。整份也就 30KB。
    for (const headers of [{ Range: 'bytes=0-2047' }, null]) {
      try {
        const res = await fetchUrl(probe, UPDATE_TIMEOUT, headers)
        if (res.err || res.statusCode !== 200 || !res.body) continue
        body = String(res.body)
      } catch { continue }
      if (/@version/.test(body.slice(0, 2000))) break
    }
    if (!body) continue

    const vm = /@version\s+([^\n*]+)/.exec(body)
    const dm = /@description\s+([^\n*]+)/.exec(body)
    const latest = parseVersion(vm && vm[1])
    if (!latest || !isNewer(latest, current)) {
      dlog(`已是最新版本 ${vtag(info.version)}`)
      return
    }
    const log = `发现新版本 ${vtag(vm[1])}\n${dm ? String(dm[1]).trim() : ''}\n\n点击「打开链接」下载最新版，然后在「设置 → 音源设置 → 自定义源」里重新导入即可。`
    dlog(log)
    try { lx.send(lx.EVENT_NAMES.updateAlert, { log, updateUrl: url }) } catch { /* 已弹过或不支持 */ }
    return
  }
  dlog('更新检查未取得结果（网络不通或全部加速源失效）')
}
/**
 * 诊断日志开关。每一步的成败都打到开发者工具控制台，
 * 这样「换源失败」时能直接看到卡在哪一环（网络 / 无版权 / 搜索 / 解析）。
 */
const DEBUG = true
const LOG_PREFIX = '[聚合源]'

function dlog(...args) {
  if (!DEBUG) return
  try {
    if (typeof console !== 'undefined' && console.log) console.log(LOG_PREFIX, ...args)
  } catch { /* 沙箱里没有 console 就静默 */ }
}
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
  // 网易云：type=flac 返回 JSON {code,data:{url}}，拿到 m801.music.126.net 真链。
  //
  // ⚠️ 不要加 musicapi.haitangw.net/music/wy.php 这条「备用主机」：
  // 1.3.3 加过，用户实测**歌曲只剩几十秒**（该接口返回的是
  // iot1xx.music.126.net/.../ymusic/... 的试听片段，不是全曲）。
  // 上游宕机时宁可报「未取到链接」，也不要把截断的音频丢给播放器。
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
  // QQ 的降级网关。同样不要加 musicapi 那条镜像，理由见上面 wy 的注释。
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
 * 只列 SEARCH_API 里真正实现了的平台：
 *   - 网易云 music.163.com/api/search/get（相关性尚可，300ms）
 *   - QQ c.y.qq.com/soso/fcgi-bin/client_search_cp（相关性最好，2.2s）
 * 已排除：酷我（SEARCH_API 里没有它，写进来只会每次都「搜索失败」白跑一轮）、
 *        酷狗（需 kg_music token，IP 被 Access Deny）、咪咕（DNS 无解析）。
 */
const CROSS_SOURCE_ORDER = {
  wy: [],           // 网易云直连已足够，且无处可搜
  tx: ['wy'],
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

/**
 * 洛雪 2.12.x 传进来的 musicInfo **嵌套在 info.musicInfo 里**：
 *   { type: '320k', musicInfo: { name, singer, source, songmid, interval: '04:41', … } }
 * 而旧版 / 部分调用方是平铺的。为了不挑客户端版本，两种都认。
 */
function unwrapInfo(info) {
  if (!info || typeof info !== 'object') return { musicInfo: {}, quality: '128k' }
  if (info.musicInfo && typeof info.musicInfo === 'object') {
    return { musicInfo: info.musicInfo, quality: info.type || info.musicInfo.type || '128k' }
  }
  return { musicInfo: info, quality: info.type || '128k' }
}

/**
 * 时长归一化成秒。洛雪给的是 '04:41' / '1:02:03' 这种字符串，
 * 直接 Number() 会得到 NaN，三重校验里的时长判别就整个失效了。
 */
function parseInterval(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const str = String(v).trim()
  if (/^\d+$/.test(str)) return Number(str)
  const parts = str.split(':').map((x) => Number(x))
  if (parts.some((n) => !Number.isFinite(n))) return null
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

/* ============================ HTTP ============================ */

function enc(s) { return encodeURIComponent(String(s)) }

/** 退避等待 */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/**
 * 带超时的 GET。lx.request 是回调风格 cb(err, resp)，且不跟随重定向
 * —— 正好用来拿 3xx 的 Location。网络异常一律转成 statusCode 0，不抛。
 */
function fetchUrl(url, timeout, extraHeaders) {
  const ms = timeout || REQ_TIMEOUT
  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v) }
    const timer = setTimeout(() => finish({ statusCode: 0, headers: {}, body: '', err: 'timeout' }), ms)

    let called = false
    const onResp = (err, resp) => {
      if (called) return
      called = true
      if (err) return finish({ statusCode: 0, headers: {}, body: '', err: err.message || String(err) })
      const statusCode = (resp && resp.statusCode) || 0
      const headers = (resp && resp.headers) || {}
      if (statusCode >= 300 && statusCode < 400) {
        const loc = headers.location || headers.Location || ''
        return finish({ statusCode, headers, body: '', location: String(loc || '') })
      }
      let body = resp && resp.body
      if (body == null) body = ''
      else if (typeof body === 'object') { try { body = JSON.stringify(body) } catch { body = '' } }
      else body = String(body)
      const ct = headers['content-type'] || headers['Content-Type'] || ''
      finish({ statusCode, headers, body, contentType: String(ct) })
    }

    // lx.request 在部分环境下对非法 URL 会**同步抛**（而不是回调 err），
    // v1.3.0 没接住，异常会一路冒到 action 里，客户端只显示「换源失败」。
    try {
      const headers = { 'User-Agent': 'Mozilla/5.0' }
      if (extraHeaders) for (const k of Object.keys(extraHeaders)) headers[k] = extraHeaders[k]
      lx.request(url, { method: 'GET', timeout: ms, headers }, onResp)
    } catch (e) {
      if (called) return
      called = true
      finish({ statusCode: 0, headers: {}, body: '', err: (e && e.message) || String(e) })
    }
  })
}

/**
 * 解析相对 Location。优先用内置 URL，沙箱里没有 URL 时退回手写拼接，
 * 避免「有 URL 依赖」在受限环境下变成静默失败。
 */
function resolveLocation(loc, base) {
  if (/^https?:\/\//i.test(loc)) return loc
  try {
    if (typeof URL === 'function') return new URL(loc, base).href
  } catch { /* 退回手写 */ }
  const m = /^https?:\/\/([^/?#]+)/i.exec(base)
  if (!m) return loc
  const origin = m[0]
  if (loc.startsWith('/')) return origin + loc
  const path = base.replace(/^https?:\/\/[^/?#]+/i, '').replace(/[^/]*$/, '')
  return origin + path + loc
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
 * 歌手别名表。
 *
 * 为什么需要：同一个歌手在不同平台/不同年代署名不一样，最典型的是网易云搜索
 * 《晴天 周杰伦》返回的歌手是「Jay Chou」，而 QQ/酷我给的是「周杰伦」。
 * 不做这层映射，singerMatch 会判「歌手不符」，把**本来正确的歌**直接拒掉 ——
 * 实测这会让 tx→wy 的跨源对最热门的歌完全失效。
 *
 * 刻意保守：只收录「中英文互译」「繁简体」这类**确定等价**的写法，不做模糊音译。
 * 歌名和时长两道校验照常把关，放宽的只是署名写法。
 */
const SINGER_ALIASES = {
  '周杰伦': ['周杰伦', '周杰倫', 'jaychou'],
  '林俊杰': ['林俊杰', '林俊傑', 'jjlin'],
  '邓紫棋': ['邓紫棋', '鄧紫棋', 'gem'],
  '王菲': ['王菲', 'faye', 'fayewong'],
  '陈奕迅': ['陈奕迅', '陳奕迅', 'eason', 'easonchan'],
  '薛之谦': ['薛之谦', '薛之謙', 'jam'],
  '毛不易': ['毛不易', 'mao'],
  '孙燕姿': ['孙燕姿', '孫燕姿', 'stephy', 'sunyanzi'],
  '张杰': ['张杰', '張傑', 'zhangjie'],
  '五月天': ['五月天', 'mayday'],
  '华晨宇': ['华晨宇', '華晨宇', 'hcy'],
  'TFBOYS': ['tfboys'],
}

/** 归一化后某个歌手名的全部等价写法 */
function singerKeys(name) {
  const keys = new Set([name])
  const strip = (x) => x.replace(/[\s\-_·・,，.。!！?？~～'"'"`|]+/g, '').toLowerCase()
  for (const cn of Object.keys(SINGER_ALIASES)) {
    const list = SINGER_ALIASES[cn]
    if (!list || !list.length) continue
    if (name === strip(cn) || list.some((x) => strip(x) === name)) {
      keys.add(strip(cn))
      for (const k of list) keys.add(strip(k))
    }
  }
  return keys
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
/**
 * 一个歌手列表的全部可接受写法。
 * normSingers 按空格拆词，所以「Jay Chou」会变成 ['jay','chou']，
 * 单个 token 永远匹配不上别名表里的 'jaychou' —— 必须再把整串（已无空格）也纳入。
 */
function allSingerKeys(list) {
  const keys = new Set()
  for (const t of list) for (const k of singerKeys(t)) keys.add(k)
  if (list.length > 1) for (const k of singerKeys(list.join(''))) keys.add(k)
  return keys
}

function singerMatch(aList, bList) {
  if (!aList.length || !bList.length) return true // 没歌手信息就不断言，交给时长
  // 两侧都按「整串 + 逐词」展开后求交集，「周杰伦」vs「Jay Chou」才能碰上
  const aKeys = allSingerKeys(aList)
  const bKeys = allSingerKeys(bList)
  for (const k of aKeys) if (bKeys.has(k)) return true
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
    // 注意：洛雪给的 musicInfo.singer 是**字符串**，搜索结果里是 {name} 数组，
    // 这里只用于拼日志，绝不能假设它有 .map —— 曾因此抛 TypeError 让整个请求挂掉。
    const names = normSingers(got.singer)
    return { ok: false, reason: `歌手不符(「${names.join(',') || String(got.singer || '')}」)` }
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
    interval: parseInterval(info.interval),
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
      cur = resolveLocation(res.location, cur)
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
 * 各音质每秒字节数的**保守下限**（KB/s）。
 * flac 不按 700KB/s 算 —— 真实 flac 远大于这个值，
 * 用下限做阈值只会让「完整文件」轻松通过、让「试听片段」被拦下。
 */
const MIN_BYTES_PER_SEC = { '128k': 16, '320k': 40, flac: 40, flac24bit: 40 }

/**
 * 防「试听片段」闸门。
 *
 * 背景：上游对无版权资源会返回 30 秒试听（网易云的 ymusic 链接就是这种），
 * 链接本身 200、能播 content-type 也是 audio/*，所有常规校验都拦不住，
 * 用户听到的就是「歌只播几十秒就没了」，而脚本还报的是「✓ 命中」。
 *
 * 办法：用 Range 拿 content-range 里的总大小，和「按时长+音质算出的理论下限」比。
 * 阈值取 35% —— 30 秒 / 279 秒 ≈ 11%，稳稳被拦；真实文件几乎不可能低于 35%。
 * 查不到大小时一律放过，不能因为网关不配合 Content-Range 就误杀好链。
 */
async function checkNotPreview(url, intervalSec, quality, deadline) {
  const sec = Number(intervalSec)
  if (!Number.isFinite(sec) || sec < 30) return { ok: true }
  const perSec = MIN_BYTES_PER_SEC[quality] || MIN_BYTES_PER_SEC['128k']
  const nominal = sec * perSec * 1024
  let res
  try { res = await fetchUrl(url, Math.min(REQ_TIMEOUT, deadline - Date.now()), { Range: 'bytes=0-1023' }) } catch { return { ok: true } }
  if (res.err || !res.statusCode) return { ok: true }
  const headers = res.headers || {}
  const cr = String(headers['content-range'] || '')
  const total = cr.includes('/') ? Number(cr.split('/')[1]) : Number(headers['content-length'] || 0)
  if (!Number.isFinite(total) || total <= 0) return { ok: true }
  if (total < nominal * 0.35) {
    return { ok: false, reason: `疑似试听片段(实际 ${(total / 1048576).toFixed(1)}MB，${sec}s 的${quality}至少该有 ${(nominal / 1048576).toFixed(1)}MB)` }
  }
  return { ok: true }
}

/**
 * 试一个网关。
 * 失败时返回 { url: null, reason }，reason 区分「网络挂了」和「此歌无版权」，
 * 便于决定是换网关还是换平台。
 */
async function tryGateway(gw, id, quality, deadline, interval) {
  const remain = deadline - Date.now()
  if (remain <= 500) return { url: null, reason: '预算耗尽' }

  let url
  try { url = gw.url(id, quality) } catch { return { url: null, reason: 'URL 构造失败' } }

  let res = await fetchUrl(url, Math.min(REQ_TIMEOUT, remain))

  // 上游 5xx 基本都是网关瞬时限流/抖动（实测 nginx 会直接回 502），
  // 退避 400ms 重试一次就能拿到，胜过直接判定这首歌没版权。
  // 只对 5xx 重试：超时是网络问题，重复等待只会白烧预算。
  if (res.statusCode >= 500 && res.statusCode < 600 && deadline - Date.now() > 1500) {
    await sleep(400)
    const retry = await fetchUrl(url, Math.min(REQ_TIMEOUT, deadline - Date.now()))
    if (!retry.err && retry.statusCode) res = retry
  }
  if (res.err || res.statusCode === 0) return { url: null, reason: `网络失败(${res.err || '无响应'})` }

  if (res.statusCode >= 300 && res.statusCode < 400) {
    if (!res.location) return { url: null, reason: '重定向但无 Location' }
    const loc = resolveLocation(res.location, url)
    // 排掉跳到网站首页/占位页的情况
    if (/\.(html?|php)$/i.test(loc) && !/music|audio|song|stream|\.mp3|\.flac|\.m4a/i.test(loc)) {
      return { url: null, reason: '重定向到网页而非音频' }
    }
    if (!isValidUrl(loc)) return { url: null, reason: '重定向目标非法' }
    // 跳到 .php 网关地址的一律先自己跟完，确认真能拿到音频。
    // 这些网关时好时坏（实测 wy.php 302 有时直接转出 nginx 404），
    // 把没验证过的地址丢给播放器，客户端只会报 onError，
    // 用户看到的是「能取到链但播不出来」，比直接失败还难排查。
    if (isGatewayAddress(loc)) {
      const playable = await isPlayable(loc, deadline)
      if (!playable.ok) return { url: null, reason: `302 目标不可播(${playable.reason})` }
      return { url: loc, reason: `302 目标预检通过(${playable.reason})` }
    }
    const full2 = await checkNotPreview(loc, interval, quality, deadline)
    if (!full2.ok) return { url: null, reason: full2.reason }
    return { url: loc, reason: '302 跳转(LX 播放器会跟随)' }
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return { url: null, reason: /^50\d$/.test(String(res.statusCode)) ? `上游故障(HTTP ${res.statusCode})` : `HTTP ${res.statusCode}` }
  }
  if (/^audio\//i.test(String(res.contentType || ''))) {
    const full = await checkNotPreview(url, interval, quality, deadline)
    if (!full.ok) return { url: null, reason: full.reason }
    return { url, reason: '网关内联转发' }
  }

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
  const full3 = await checkNotPreview(u0, interval, quality, deadline)
  if (!full3.ok) return { url: null, reason: full3.reason }
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
  dlog(`开始 ${source} 音质=${quality} 降级链=[${chain.join('>')}] 预算=${TOTAL_BUDGET}ms`)

  for (let i = 0; i < chain.length; i++) {
    const q = chain[i]
    if (i > 0) {
      const remain = deadline - Date.now()
      // 预算不够再开一轮就是白跑，不如保留给「换源」这一个结果
      if (remain < DEGRADE_MIN_BUDGET) {
        allLog.push(`✗ 剩余预算 ${remain}ms 不足，放弃降级到 ${q}`)
        dlog(`✗ 剩余预算 ${remain}ms 不足，放弃降级到 ${q}`)
        break
      }
      allLog.push(`── 降级重试：${quality} → ${q} ──`)
      dlog(`── 降级重试：${quality} → ${q} ──`)
    }
    const r = await resolveOnce(source, info, q, deadline)
    for (const line of r.log) {
      allLog.push(i > 0 ? `[${q}] ${line}` : line)
      dlog(i > 0 ? `[${q}] ${line}` : line)
    }
    if (r.url) {
      if (i > 0) allLog.push(`⚠ 已从 ${quality} 降级到 ${q} 以保证播放`)
      dlog(`✓ 命中 ${r.url}`)
      return { url: r.url, log: allLog }
    }
  }
  dlog(`✗ ${source} 全部尝试失败，耗时 ${TOTAL_BUDGET - (deadline - Date.now())}ms`)
  return { url: null, log: allLog }
}

async function resolveOnce(source, info, quality, deadline) {
  // info 可能是 { type, musicInfo } 也可能已平铺，统一在这里解包
  const mi = (info && info.musicInfo) || info || {}
  const target = targetInfo(mi)
  const log = []

  const ownId = ID_PICKER[source] ? ID_PICKER[source](mi) : null
  if (!ownId) log.push(`✗ ${source} musicInfo 里没有可用 id（字段: ${Object.keys(mi).join(',')}）`)
  const directs = DIRECT_GATEWAY[source] || []
  const fallbacks = FALLBACK_GATEWAY[source] || []

  // ── 阶段 1：本平台直连（错歌风险 0，最快，优先）──
  // 同一平台的多个直连网关互不依赖，并发取，先成功者胜。
  if (ownId && directs.length) {
    const results = await Promise.all(directs.map((gw) => tryGateway(gw, ownId, quality, deadline, target.interval)))
    for (let i = 0; i < directs.length; i++) {
      const r = results[i]
      if (r.url) { log.push(`✓ ${source} 直连 ${directs[i].name} (${r.reason})`); return { url: r.url, log } }
    }
    // 全部失败时按配置顺序逐条记录，保留可读的排查信息
    for (let i = 0; i < directs.length; i++) log.push(`✗ ${source} 直连 ${directs[i].name}: ${results[i].reason}`)
  }

  // ── 阶段 2 + 3：跨源搜索 与 本平台降级网关 并发 ──
  //
  // 这两条路互不依赖（一个用「歌名+歌手」搜正确 id，一个让网关自己做平台映射），
  // 串行跑等于白等一个 RTT。改成同时发起，但**取用顺序不变**：
  // 先等跨源（错歌风险低），它失败才用降级的结果。
  // 副作用是当上游有台机器挂掉时（实测会白等 5s 超时），
  // 另一条路的请求早就在跑了，整体耗时从「相加」变成「取慢的那个」。
  const others = target.name ? (CROSS_SOURCE_ORDER[source] || []) : []
  if (!target.name) log.push('✗ musicInfo 无歌名，跳过跨源（无法校验是否同一首歌）')
  else if (!others.length) log.push(`✗ ${source} 没有可用的跨源平台`)

  // 跨源：多个目标平台的搜索也并发发起，结果仍按配置优先级依次取用
  const crossTask = (async () => {
    const out = { url: null, log: [] }
    if (!others.length || deadline - Date.now() < 3000) {
      if (others.length) out.log.push('✗ 预算不足，跳过跨源')
      return out
    }
    const searched = await Promise.all(others.map((o) => searchVerified(target, o, deadline)))
    for (let i = 0; i < others.length; i++) {
      const other = others[i]
      const r = searched[i]
      if (out.url) break
      if (!r) { out.log.push(`✗ ${source}→${other} 搜索失败`); continue }
      if (!r.hit) {
        out.log.push(`✗ ${source}→${other} 无匹配（${(r.rejects || []).slice(0, 2).join('; ')}）`)
        continue
      }
      // 用目标平台搜到的 id 走目标平台的网关。
      // 注意：tx/kg/mg 并无「直连网关」——它们只能经 qq_kw / kg_kw 这类
      // 降级网关取链。所以这里必须把直连和降级都遍历一遍，
      // 否则搜到了正确 id 却没有网关可用，会静默失败。
      const targetGws = [...(DIRECT_GATEWAY[other] || []), ...(FALLBACK_GATEWAY[other] || [])]
      if (!targetGws.length) { out.log.push(`✗ ${source}→${other} 命中「${r.hit.name}」但该平台无取链网关`); continue }
      const gs = await Promise.all(targetGws.map((gw) => tryGateway(gw, r.hit.id, quality, deadline, target.interval)))
      for (let j = 0; j < targetGws.length; j++) {
        if (gs[j].url) {
          out.log.push(`✓ ${source}→${other}「${r.hit.name}」三重校验通过 → ${targetGws[j].name} (${gs[j].reason})`)
          out.url = gs[j].url
          break
        }
      }
      if (!out.url) out.log.push(`✗ ${source}→${other} 命中「${r.hit.name}」但取链失败: ${gs.map((g) => g.reason).join('; ')}`)
    }
    return out
  })()

  // 降级网关：与跨源同时发起，作为「跨源全灭时立刻可用」的预取结果
  const fallbackTask = (async () => {
    const out = { url: null, log: [] }
    if (!ownId || !fallbacks.length) return out
    const gs = await Promise.all(fallbacks.map((gw) => tryGateway(gw, ownId, quality, deadline, target.interval)))
    for (let i = 0; i < fallbacks.length; i++) {
      if (gs[i].url) { out.log.push(`✓ ${source} 降级 ${fallbacks[i].name} (${gs[i].reason})`); out.url = gs[i].url; break }
    }
    for (let i = 0; i < fallbacks.length; i++) {
      if (!gs[i].url) out.log.push(`✗ ${source} 降级 ${fallbacks[i].name}: ${gs[i].reason}`)
    }
    return out
  })()

  const cross = await crossTask.catch((e) => ({ url: null, log: [`✗ 跨源阶段异常: ${(e && e.message) || e}`] }))
  for (const line of cross.log) log.push(line)
  if (cross.url) return { url: cross.url, log }

  const fb = await fallbackTask.catch((e) => ({ url: null, log: [`✗ 降级阶段异常: ${(e && e.message) || e}`] }))
  for (const line of fb.log) log.push(line)
  if (fb.url) return { url: fb.url, log }

  return { url: null, log }
}

/* ============================ LX 接口 ============================ */

/** 所有支持的平台 = 直连网关有的 ∪ 降级网关有的 */
const ALL_PLATFORMS = [...new Set([...Object.keys(DIRECT_GATEWAY), ...Object.keys(FALLBACK_GATEWAY)])]

lx.on(lx.EVENT_NAMES.request, ({ source, action, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error(`不支持的操作: ${action}`))
  if (ALL_PLATFORMS.indexOf(source) < 0) return Promise.reject(new Error(`不支持的源: ${source}`))

  // 洛雪 2.12.x 传的是 { type, musicInfo }，旧版是平铺的 —— 两种都认
  const { musicInfo, quality: rawQuality } = unwrapInfo(info)
  const quality = rawQuality || '128k'
  const q = QUALITIES.indexOf(quality) > -1 ? quality : '128k'
  // 洛雪不同版本传进来的 musicInfo 字段差异很大（name/songmid/songname…），
  // 出问题时必须能看到它到底给了什么，所以原样打一条。
  dlog('收到 musicInfo:', JSON.stringify(musicInfo), '音质:', quality)

  // 兜底 try/catch：任何一步意外抛错（网络库同步抛、字段为 null、运行时缺 API…）
  // 都不再让异常裸奔成客户端那句无信息的「换源失败」，而是把真实错误带出去。
  return resolve(source, { ...musicInfo, type: q }, q).then((r) => {
    if (r.url) return r.url
    // 报错里带上完整日志：只留最后 4 行会把「直连网关为什么失败」这条关键信息截掉
    const detail = r.log.join(' | ').slice(0, 900)
    throw new Error(`聚合源：${source} 未取到链接。${detail}`)
  }).catch((e) => {
    dlog('✗ 异常：', (e && e.stack) || e)
    throw new Error(`聚合源：${source} 异常 ${(e && e.message) || e}`)
  })
})

lx.send(lx.EVENT_NAMES.inited, {
  status: true,
  // 不自动弹开发者工具窗口（吵），但保留 dlog 日志：
  // 需要排查时按 Ctrl+Shift+I 打开控制台就能看到每一步原因。
  openDevTools: false,
  sources: Object.fromEntries(ALL_PLATFORMS.map((p) => [p, { type: 'music', actions: ['musicUrl'], qualitys: QUALITIES }])),
})

// 启动后静默检查更新：有新版就弹提示（不阻塞启动，也不影响取链）
setTimeout(() => { checkUpdate().catch(() => {}) }, UPDATE_DELAY)
