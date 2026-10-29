/*!
 * @name 聚合音源
 * @description v1.0.0 多网关聚合，自动降级
 * @version v1.0.0
 * @author pdone
 * @homepage https://github.com/BeYourDreams/lx-music-source
 * @netease MUSIC_U=;
 * @tencent ts_last=y.qq.com/n/ryqq/album;
 * @preserve
 */

/**
 * 聚合音源 v1.0.0
 *
 * 设计要点：
 * 1. 不 eval 任何混淆脚本，只用干净的 HTTP 网关，逻辑可审计。
 * 2. 每个平台配多个网关（JSON 模式优先，其次 302 模式），逐个降级。
 * 3. 区分「网关返回 JSON 但内容是错误」和「网关本身挂了」两种情况：
 *    - JSON 里带 code/msg 且 url 为空 → 该网关此歌无版权，换网关
 *    - 网络错误/超时/非 JSON → 换网关
 * 4. 任何一层拿到可用 URL 就立即返回，不再往下试。
 * 5. 严格校验返回值是 http(s) 直链，避免把 JSON 错误体当 URL 返回。
 *
 * ⚠️ LX 播放器会跟随 302 重定向，所以「302 网关」也能正常播放；
 *    但脚本内的 lx.request 不跟随，因此这里只把 302 当兜底，不当主路径。
 */

'use strict'

/* ============================ 常量配置 ============================ */

/** 网关超时（毫秒）。主进程硬超时 20s，留足重试余量。 */
const GATEWAY_TIMEOUT = 6000

/** 单次取链总预算（毫秒），防止多个网关叠加超过主进程 20s */
const TOTAL_BUDGET = 15000

/** LX 音质枚举 → 各网关 level 参数 */
const LEVEL_PARAM = {
  '128k': 'standard',
  '320k': '320k',
  flac: 'lossless',
  flac24bit: 'hiLossless',
}

/** LX 音质枚举 → 网关 type 参数（仅 wy 网关用，其它网关固定 mp3） */
const TYPE_PARAM = {
  '128k': 'flac',
  '320k': 'flac',
  flac: 'flac',
  flac24bit: 'flac',
}

/**
 * 网关优先级表。
 * mode:
 *   'json'  → 期望返回 JSON，取 data.url / url
 *   'text'  → 期望 body 直接是一段 http 开头 URL
 *   'redir' → 期望 302/301，交给播放器跟随
 * order 越小越先试。
 */
const GATEWAYS = {
  wy: [
    {
      // wy 网关的 type 参数控制的是输出形式而非音质：
      //   type=flac → 返回 JSON {code, data:{url}}，拿到网易云直链（快、稳定）
      //   type=mp3  → 返回 302 跳转，得靠播放器跟随（慢）
      // 所以这里固定用 type=flac，靠 level 控制实际音质。
      name: 'haitangw-json',
      mode: 'json',
      url: (id, quality) =>
        `https://yinyue.haitangw.net/wy/wy.php?type=flac&id=${encodeURIComponent(id)}&level=${LEVEL_PARAM[quality]}`,
    },
    {
      // 兼底：网易云官方 eapi 直连
      name: 'haitangw-redir',
      mode: 'redir',
      url: (id, quality) =>
        `http://yinyue.haitangw.net/wy/wy.php?type=mp3&id=${encodeURIComponent(id)}&level=${LEVEL_PARAM[quality]}`,
    },
  ],
  tx: [
    {
      // tx 网关只认 type=mp3；level=lossless 时才给 flac
      name: 'haitangw-text',
      mode: 'text',
      url: (id, quality) =>
        `https://yinyue.haitangw.net/qq/qq_kw.php?type=mp3&id=${encodeURIComponent(id)}&level=${LEVEL_PARAM[quality]}`,
    },
  ],
  kw: [
    {
      name: 'musicapi-redir',
      mode: 'redir',
      url: (id, quality) =>
        `https://musicapi.haitangw.net/music/kw.php?type=mp3&id=${encodeURIComponent(id)}&level=${LEVEL_PARAM[quality]}`,
    },
    {
      name: 'haitangw-redir',
      mode: 'redir',
      url: (id, quality) =>
        `http://yinyue.haitangw.net/kw/kw.php?type=mp3&id=${encodeURIComponent(id)}&level=${LEVEL_PARAM[quality]}`,
    },
  ],
  kg: [
    {
      // kg 网关只认 type=mp3，且 flac 要看 level=lossless
      name: 'haitangw-text',
      mode: 'text',
      url: (id, quality) =>
        `https://yinyue.haitangw.net/kg/kg_song_kw.php?type=mp3&id=${encodeURIComponent(id)}&level=${LEVEL_PARAM[quality]}`,
    },
    {
      name: 'musicapi-kg',
      mode: 'json',
      url: (id, quality) =>
        `https://musicapi.haitangw.net/music/kg.php?type=mp3&id=${encodeURIComponent(id)}&level=${LEVEL_PARAM[quality]}`,
    },
  ],
  mg: [
    {
      // 注意：2026-09 实测该网关对所有歌曲都返回 500「歌曲下线暂不支持播放」，
      // 属于上游不可用，不是参数问题。这里保留配置以便上游恢复后自动生效。
      name: 'haitangw-json',
      mode: 'json',
      url: (id, quality) =>
        `https://yinyue.haitangw.net/mg/migu.php?type=mp3&id=${encodeURIComponent(id)}&level=${LEVEL_PARAM[quality]}`,
    },
    {
      name: 'musicapi-mg',
      mode: 'json',
      url: (id, quality) =>
        `https://musicapi.haitangw.net/music/mg.php?type=mp3&id=${encodeURIComponent(id)}&level=${LEVEL_PARAM[quality]}`,
    },
  ],
}

/** 从 musicInfo 里取出该平台用于取链的 ID */
const ID_PICKER = {
  wy: (m) => m.songmid || m.songMid || m.id,
  tx: (m) => m.songmid || m.strMediaMid || m.id,
  kw: (m) => m.songmid || m.id,
  kg: (m) => m.hash || m.songmid || m.id,
  mg: (m) => m.copyrightId || m.songmid || m.id,
}

/* ============================ HTTP 封装 ============================ */

/**
 * 带超时的 GET（lx.request 是回调风格：cb(err, resp, body)）。
 * 注意：lx.request 不跟随重定向，正好用来拿 3xx 的 Location。
 * resp.body 可能是已解析的对象，也可能是字符串，统一成字符串处理。
 * 返回 { statusCode, headers, body, location, err }，网络异常转 statusCode 0。
 */
function fetchUrl(url, timeout) {
  const ms = timeout || GATEWAY_TIMEOUT
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }

    const timer = setTimeout(() => done({ statusCode: 0, headers: {}, body: '', err: 'timeout' }), ms)

    lx.request(url, { method: 'GET', timeout: ms, headers: { 'User-Agent': 'Mozilla/5.0' } }, (err, resp) => {
      if (err) return done({ statusCode: 0, headers: {}, body: '', err: err.message || String(err) })
      const statusCode = (resp && resp.statusCode) || 0
      const headers = (resp && resp.headers) || {}

      // 3xx：只取 Location，不去追
      if (statusCode >= 300 && statusCode < 400) {
        return done({ statusCode, headers, body: '', location: String(headers.location || '') })
      }

      let body = resp && resp.body
      if (body == null) body = ''
      else if (typeof body === 'object') { try { body = JSON.stringify(body) } catch { body = '' } }
      else body = String(body)

      done({ statusCode, headers, body, contentType: String(headers['content-type'] || '') })
    })
  })
}

/* ============================ URL 解析 ============================ */

/** 是否是可接受的音频直链 */
function isValidAudioUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u) && u.length > 12 && u.length <= 2048 && !/^https?:\/\/[^/]*$/i.test(u)
}

/** 从 JSON 字符串（或已解析对象）里挖 url 字段 */
function pickUrlFromJson(text) {
  let j = text
  if (typeof text === 'string') {
    const t = text.trim()
    // 有些网关返回的是 JSON 字符串字面量： "https://..."
    const unquoted = t.replace(/^["']|["']$/g, '').trim()
    if (isValidAudioUrl(unquoted)) return unquoted
    try { j = JSON.parse(t) } catch { return null }
  }
  if (!j || typeof j !== 'object') return null
  const candidates = [j.url, j.data && j.data.url, j.data, j.play_url, j.src, j.link]
  for (const c of candidates) {
    if (isValidAudioUrl(c)) return c
  }
  return null
}

/** 从可能夹带引号/换行的文本里挖出一段 http URL */
function pickUrlFromText(text) {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (isValidAudioUrl(t)) return t
  // 去掉包裹的引号 / JSON 字符串外壳
  const unquoted = t.replace(/^["']|["']$/g, '').trim()
  if (isValidAudioUrl(unquoted)) return unquoted
  const m = unquoted.match(/https?:\/\/[^\s"'<>\\]+/i)
  return m && isValidAudioUrl(m[0]) ? m[0] : null
}

/* ============================ 单网关尝试 ============================ */

/**
 * 试一个网关，返回 URL 或 null。
 * mode 决定怎么读响应。
 */
async function tryGateway(gw, id, quality, deadline) {
  const remain = deadline - Date.now()
  if (remain <= 500) return null

  let url
  try { url = gw.url(id, quality) } catch { return null }
  if (!url) return null

  const res = await fetchUrl(url, Math.min(GATEWAY_TIMEOUT, remain))
  if (res.err || res.statusCode === 0) return null // 网络层失败 → 换网关

  // 302/301：交给播放器跟随，但只接受指向音频域的可疑链接
  if (res.statusCode >= 300 && res.statusCode < 400) {
    if (!res.location) return null
    const loc = new URL(res.location, url).href
    // 明显是占位页的（如 qq 首页）不算
    if (/\/(\?|$)/.test(new URL(loc).pathname) && !/music|audio|song|stream|\.mp3|\.flac|\.m4a/i.test(loc)) return null
    return isValidAudioUrl(loc) ? loc : null
  }

  if (res.statusCode < 200 || res.statusCode >= 300) return null

  const ct = String(res.contentType || '')
  const body = res.body || ''

  // 直接就是音频（网关已内联转发）
  if (/^audio\//i.test(ct)) {
    return url
  }

  if (gw.mode === 'json') {
    return pickUrlFromJson(body)
  }
  if (gw.mode === 'text') {
    // 有些网关 JSON content-type 但 body 是一段裸 URL
    const fromJson = pickUrlFromJson(body)
    if (fromJson) return fromJson
    return pickUrlFromText(body)
  }
  return null
}

/* ============================ LX 接口实现 ============================ */

const QUALITIES = ['128k', '320k', 'flac', 'flac24bit']

/** 声明支持的源 */
function buildSources() {
  const sources = {}
  for (const p of Object.keys(GATEWAYS)) {
    sources[p] = { type: 'music', actions: ['musicUrl'], qualitys: QUALITIES }
  }
  return sources
}

lx.on(lx.EVENT_NAMES.request, ({ source, action, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error(`不支持的操作: ${action}`))

  const gws = GATEWAYS[source]
  if (!gws) return Promise.reject(new Error(`不支持的源: ${source}`))

  const picker = ID_PICKER[source]
  const id = picker ? picker(info || {}) : (info && (info.songmid || info.id))
  if (!id) return Promise.reject(new Error(`未能从歌曲信息中提取 ${source} 的 id`))

  const quality = info && info.type ? info.type : '128k'
  const q = QUALITIES.includes(quality) ? quality : '128k'

  const deadline = Date.now() + TOTAL_BUDGET
  return (async () => {
    for (const gw of gws) {
      const u = await tryGateway(gw, id, q, deadline)
      if (isValidAudioUrl(u)) return u
    }
    throw new Error(`聚合源：${source} 全部网关均未取到可用链接`)
  })()
})

lx.send(lx.EVENT_NAMES.inited, { status: true, openDevTools: false, sources: buildSources() })
