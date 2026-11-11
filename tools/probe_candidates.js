#!/usr/bin/env node
'use strict'
/**
 * 候选网关探测：在把新网关写进 aggregator 之前，先逐平台、逐音质地验证
 * 「返回模式（JSON / 302 / 裸 URL / 音频）」「是否全曲」「是否需要鉴权参数」。
 *
 * 用法：
 *   node tools/probe_candidates.js              # 全部候选 × 全部平台 × 128k/flac
 *   node tools/probe_candidates.js kw tx        # 只看某些平台
 *   node tools/probe_candidates.js --allq       # 扩到 4 档音质
 *
 * 输出里 ✅ 表示跟完跳转后拿到 audio/*；⚠️ 表示能出链但不是音频；❌ 表示直接失败。
 */
const http = require('http')
const https = require('https')
const IDS = require('./ids.json')

const argv = process.argv.slice(2)
const ALLQ = argv.includes('--allq')
const QUALITIES = ALLQ ? ['128k', '320k', 'flac', 'flac24bit'] : ['128k', 'flac']
const ONLY = argv.filter((a) => !a.startsWith('--'))

const SONGS = IDS.songs_wellknown || IDS.songs
const id = {
  wy: SONGS.wy.songmid,
  tx: SONGS.tx.songmid,
  kw: SONGS.kw.songmid,
  kg: SONGS.kg.hash,
  mg: SONGS.mg.copyrightId,
}
// 各家网关的音质标识不一样，各候选自己映射
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

function fetchOnce(url, { method = 'GET', headers = {}, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(url) } catch { return resolve({ st: 0, ct: 'BAD_URL', body: '', len: 0 }) }
    const lib = u.protocol === 'https:' ? https : http
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const req = lib.request(u, { method, headers: { 'User-Agent': UA, ...headers } }, (res) => {
      let body = ''
      let len = 0
      res.on('data', (c) => {
        len += c.length
        if (body.length < 3000) body += c.toString('utf8')
        if (len > 200 * 1024) res.destroy() // 只取开头，够判类型了
      })
      const finish = () => done({ st: res.statusCode, ct: String(res.headers['content-type'] || ''), loc: res.headers.location, body, len })
      res.on('end', finish)
      res.on('close', finish)
      res.on('error', finish)
    })
    req.on('error', (e) => done({ st: 0, ct: 'ERR ' + e.message, body: '', len: 0 }))
    req.setTimeout(timeout, () => { req.destroy(); done({ st: 0, ct: 'TIMEOUT', body: '', len: 0 }) })
    req.end()
  })
}

/** 跟随最多 3 次跳转，返回最终响应（用来确认是不是真音频） */
async function follow(url, depth = 0) {
  const r = await fetchOnce(url)
  if (r.st >= 300 && r.st < 400 && r.loc && depth < 3) {
    const next = new URL(r.loc, url).href
    const r2 = await follow(next, depth + 1)
    return { ...r2, hops: (r2.hops || 0) + 1 }
  }
  return r
}

/**
 * 候选网关：每个返回 { url } 或 null（不支持该平台/音质）。
 * 只写实测能用、且源码里能查到的接口形态。
 */
const CANDIDATES = {
  // 星海主后端（jiexiang / xinghai 在用）：带歌名+歌手+时长，返回 {code:200,url}
  'zddyr/api': (p, q) => {
    const s = SONGS[p]
    if (!s) return null
    const qs = [['source', p], ['songmid', id[p]], ['quality', q], ['name', s.name], ['singer', s.singer], ['interval', s.interval]]
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    return { url: `https://yy.zddyr.top/lx/api/?${qs}`, expect: 'json' }
  },
  // 星海备用后端
  'zrcdy/api': (p, q) => {
    const s = SONGS[p]
    if (!s) return null
    const qs = [['source', p], ['songmid', id[p]], ['quality', q], ['name', s.name], ['singer', s.singer], ['interval', s.interval]]
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    return { url: `https://zrcdy.dpdns.org/lx/api/api.php?${qs}`, expect: 'json' }
  },
  // HYWmusic 公益版：/api/music/url，需要 key（公开卡密）
  'hyw/music': (p, q) => {
    const s = SONGS[p]
    if (!s) return null
    const params = { platform: p, source: p, quality: q, key: '6C1F-53W0-GRKI-EVFG' }
    const fields = ['albumAudioId', 'strMediaMid', 'mediaMid', 'copyrightId', 'rid', 'musicId', 'songmid', 'hash', 'id']
    for (const f of fields) if (s[f] != null && s[f] !== '') params[f] = s[f]
    params[({ wy: 'songmid', tx: 'songmid', kw: 'songmid', kg: 'hash', mg: 'copyrightId' })[p]] = id[p]
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    return { url: `https://103.79.184.97/api/music/url?${qs}`, expect: 'json' }
  },
  // 落月 QQ（vkeys）：mid + quality 数字
  'vkeys/tx': (p, q) => {
    if (p !== 'tx') return null
    const qmap = { '128k': 6, '320k': 8, flac: 10, flac24bit: 10 }
    return { url: `https://api.vkeys.cn/v2/music/tencent/geturl?mid=${encodeURIComponent(id.tx)}&quality=${qmap[q]}`, expect: 'json' }
  },
  // 网易云官方外链（无需 key，但受版权/会员限制）
  'music163/outer': (p, q) => (p === 'wy' ? { url: `https://music.163.com/song/media/outer/url?id=${id.wy}.mp3` } : null),
  // 对照组：旧 haitangw 网关
  'haitangw/qq_kw': (p, q) => (p === 'tx' ? { url: `https://yinyue.haitangw.net/qq/qq_kw.php?type=mp3&id=${id.tx}&level=${{ '128k': 'standard', '320k': '320k', flac: 'lossless', flac24bit: 'hiLossless' }[q]}` } : null),
  'haitangw/kg_kw': (p, q) => (p === 'kg' ? { url: `https://yinyue.haitangw.net/kg/kg_song_kw.php?type=mp3&id=${id.kg}&level=${{ '128k': 'standard', '320k': '320k', flac: 'lossless', flac24bit: 'hiLossless' }[q]}` } : null),
}

function classify(r) {
  if (r.ct && r.ct.startsWith('audio/')) return { ok: true, mode: 'AUDIO', url: null, note: r.ct }
  const t = (r.body || '').trim()
  if (/^https?:\/\/\S+$/.test(t) && t.length < 2048) return { ok: true, mode: 'TEXT', url: t, note: t.slice(0, 60) }
  if (/^[[{]/.test(t)) {
    let j = null
    try { j = JSON.parse(t) } catch { /* 半截 body 也正常 */ }
    const cand = j?.data?.url || j?.url || (typeof j?.data === 'string' ? j.data : '') || j?.link
    if (typeof cand === 'string' && /^https?:/.test(cand)) return { ok: true, mode: 'JSON', url: cand, note: cand.slice(0, 60) }
    return { ok: false, mode: 'JSON', note: String(j?.msg || j?.message || t).replace(/\s+/g, ' ').slice(0, 70) }
  }
  return { ok: false, mode: `HTTP${r.st} ${r.ct}`, note: t.replace(/\s+/g, ' ').slice(0, 70) }
}

async function main() {
  const platforms = ONLY.length ? ONLY : ['wy', 'tx', 'kw', 'kg', 'mg']
  console.log(`样本歌：${SONGS.name || '(wellknown)'}  音质：${QUALITIES.join('/')}\n`)
  const tally = {}

  for (const [name, make] of Object.entries(CANDIDATES)) {
    for (const p of platforms) {
      for (const q of QUALITIES) {
        const spec = make(p, q)
        if (!spec) continue
        const t0 = Date.now()
        const r = await fetchOnce(spec.url)
        const c = classify(r)
        const ms = Date.now() - t0
        const key = `${name} ${p}/${q}`
        if (c.ok) {
          const target = c.url || spec.url
          const v = await follow(target)
          const audio = v.ct && v.ct.startsWith('audio/')
          if (audio) tally[name] = (tally[name] || 0) + 1
          console.log(`${audio ? '✅' : '⚠️'} ${key.padEnd(24)} ${String(ms).padStart(6)}ms  ${c.mode.padEnd(5)} ${audio ? v.ct : `跟随后 ${v.st} ${v.ct}`}  ${c.note}`)
        } else {
          console.log(`❌ ${key.padEnd(24)} ${String(ms).padStart(6)}ms  ${c.mode.padEnd(5)} ${c.note}`)
        }
      }
    }
  }

  console.log('\n================ 真音频通过数 ================')
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k}: ${v}`)
}

main()
