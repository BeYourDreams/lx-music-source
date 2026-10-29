// 验证 README 里的 raw 链接是否真的能取到脚本
const https = require('https')

const RAW = 'raw.githubusercontent.com/BeYourDreams/lx-music-source/main/aggregator/latest.js'
const urls = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      `https://${RAW}`,
      `https://ghfast.top/https://${RAW}`,
      `https://gh-proxy.com/https://${RAW}`,
      `https://ghproxy.net/https://${RAW}`,
    ]

function get(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'user-agent': 'Mozilla/5.0' } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', (e) => resolve({ err: e.message }))
    req.setTimeout(12000, () => { req.destroy(); resolve({ err: 'TIMEOUT' }) })
  })
}

;(async () => {
  for (const u of urls) {
    const r = await get(u)
    if (r.err) { console.log(`✗ ${u}\n  ${r.err}`); continue }
    const m = (r.body.match(/@version\s+(\S+)/) || [])[1]
    const host = new URL(u).host
    console.log(`${r.status === 200 ? '✓' : '✗'} ${String(r.status).padEnd(4)} ${String(m || '-').padEnd(8)} ${host}`)
  }
})()
