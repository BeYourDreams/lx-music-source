#!/usr/bin/env node
'use strict'
/**
 * 音频体积探测：给一组 URL 发 Range 请求，看 Content-Range / Content-Length 里的总大小。
 * 用来校准 checkNotPreview 的 MIN_BYTES_PER_SEC 与阈值 —— 真实全曲多大、试听片段多大。
 *
 * 用法：node tools/probe_size.js <url> [url...]
 */
const http = require('http')
const https = require('https')

function probe(url) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(url) } catch { return resolve({ url, err: 'BAD_URL' }) }
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request(u, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-1023' }, timeout: 15000 }, (res) => {
      res.destroy()
      const cr = String(res.headers['content-range'] || '')
      const total = cr.includes('/') ? Number(cr.split('/')[1]) : Number(res.headers['content-length'] || 0)
      resolve({ url, st: res.statusCode, ct: String(res.headers['content-type'] || ''), cr, total })
    })
    req.on('error', (e) => resolve({ url, err: e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ url, err: 'TIMEOUT' }) })
    req.end()
  })
}

;(async () => {
  const urls = process.argv.slice(2)
  if (!urls.length) return console.log('用法: node tools/probe_size.js <url> [url...]')
  for (const u of urls) {
    const r = await probe(u)
    const mb = r.total ? (r.total / 1048576).toFixed(2) : '?'
    console.log(`${r.err ? '❌' : '  '} ${String(r.st || '').padEnd(4)} ${String(mb).padStart(7)}MB  ${r.ct || r.err}  ${r.cr || ''}  ${u.slice(0, 80)}`)
  }
})()
