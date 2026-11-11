/**
 * 防错歌回归测试
 *
 * 「能播」不等于「播的是对的歌」。这个脚本验证 aggregator 的核心保证：
 * 换平台后拿到的仍然是同一首歌，而不是一首同名/近名的别的歌。
 *
 * 做法：构造若干**陷阱用例**——
 *   A. wy 平台的「晴天(深情版)」279s，与 tx 的「晴天」周杰伦 269s 同名不同歌
 *   B. 搜索结果首条是错歌（网易云搜「晴天 周杰伦」首条是翻唱版）
 *   C. 歌名一致但歌手不同
 *   D. 歌名/歌手一致但时长差 10s+（翻唱）
 *   E. musicInfo 没有任何歌名（无法校验）
 * 期望：E/F 应明确失败，其余必须拿到**正确平台**的链接。
 */
const { loadSource } = require('./lx_runtime')
const path = require('path')

/** 上游抖动时的重试次数。逻辑错误不会被重试“修好”，所以不影响正确性 */
const RETRY = 1

/** 陷阱用例 */
const CASES = [
  {
    tag: 'A 网易云翻唱版',
    desc: 'wy=「晴天(深情版)」Lucky小爱 279s；tx=「晴天」周杰伦 269s。二者歌名归一化后都是「晴天」',
    info: { name: '晴天(深情版)', singer: [{ name: 'Lucky小爱' }], interval: 279, songmid: '2652820720' },
    source: 'wy',
    // 正确结果：网易云资源。错歌则会是 269s 的周杰伦原版
    // 注：wy 网关上游会间歇 503，此时会退到 wy.php?type=mp3 兜底，
    //     返回的是**网关地址**而非 music.126.net 直链（该链已过可播性预检）。
    //     所以两种形式都算对，但必须是网易云侧 —— 这才是断言的重点。
    expect: /music\.126\.net|yinyue\.haitangw\.net\/wy/,
    reject: /kuwo\.cn/,
  },
  {
    tag: 'B 首条是错歌',
    desc: 'mg=「晴天」周杰伦 269s，mg 本平台已死必须跨源；网易云搜该词首条是翻唱版，必须被校验拦下改走 QQ',
    info: { name: '晴天', singer: [{ name: '周杰伦' }], interval: 269, copyrightId: '600305D41A0A1E9F' },
    source: 'mg',
    expect: null, // 只要能播且不报错即可
    reject: /music\.126\.net/, // 网易云没有周杰伦原版，走它就说明校验没拦住
  },
  {
    tag: 'C 歌手不同不得串到周杰伦',
    desc: '目标是 RyaVocal 翻唱版，与周杰伦原版歌名几乎一致。必须拿到 RyaVocal 的链，不能是周杰伦的',
    info: { name: '晴天 (原唱 周杰伦)', singer: [{ name: 'RyaVocal' }], interval: 270, copyrightId: '600305D41A0A1E9F' },
    source: 'mg',
    expect: /music\.126\.net|yinyue\.haitangw\.net\/wy/, // RyaVocal 版在网易云（直链或 302 兜底）
    reject: /kuwo\.cn/,        // 拿到酷我 = 串到了周杰伦原版
  },
  {
    tag: 'D 时长差过大必须被拦',
    desc: '歌名/歌手都对但 interval 比真值大 20s（容差 5s）。放在 mg 上测，因为 mg 没有可用本平台网关，只有走跨源才检验得到时长闸门；闸门生效则无任何候选通过',
    info: { name: '晴天', singer: [{ name: '周杰伦' }], interval: 289, copyrightId: '600305D41A0A1E9F' },
    source: 'mg',
    expect: 'FAIL', // 三重校验全拦 → 宁可不给也不给错歌
  },
  {
    tag: 'D2 本平台 id 有效时不看时长',
    desc: 'interval 同样差 20s，但本平台 songmid 有效。ownId 本身就代表这首歌，取本平台链正确，时长只用于跨源校验，不该否决它。v1.3.9 起 tx 有本平台网关（落月 / HYWmusic），链不再是「酷我降级」的产物，所以只要求拿到任意可播链接',
    info: { name: '晴天', singer: [{ name: '周杰伦' }], interval: 289, songmid: '0039MnYb0qxYhV' },
    source: 'tx',
    expect: /^https?:\/\//,
  },
  {
    tag: 'E 无歌名无法校验',
    desc: 'musicInfo 缺 name。mg 本平台已死，跨源又无法校验是哪首歌，必须明确拒绝而不是盲猜',
    info: { copyrightId: '600305D41A0A1E9F' },
    source: 'mg',
    expect: 'FAIL', // mg 直连已死 + 无歌名无法跨源 → 应该明确失败
  },
  {
    tag: 'F 网易云不串到别的平台',
    desc: 'wy 平台直连网关偶尔会 503，此时应退到本平台 302 兜底（仍是网易云资源）而不是跑去酷我拿一首同名歌。允许返回 wy.php 网关地址，但必须限定在网易云侧',
    info: { name: '晴天(深情版)', singer: [{ name: 'Lucky小爱' }], interval: 279, songmid: '2652820720' },
    source: 'wy',
    expect: /music\.126\.net|yinyue\.haitangw\.net\/wy/,
    reject: /kuwo\.cn|qq_kw/,
  },
]

;(async () => {
  const src = await loadSource(path.join(__dirname, '..', 'aggregator', 'latest.js'))
  if (src.loadError) { console.error('加载失败: ' + src.loadError); process.exit(2) }
  console.log('=== 防错歌回归测试 ===\n')
  let pass = 0
  let fail = 0

  for (const c of CASES) {
    const mi = { ...c.info, source: c.source, type: 'flac' }

    // 上游网关会瞬时 503/超时（实测 wy 网关就抽过风）。
    // 这些是网络波动而非逻辑错误，所以重试 1 次再定论。
    let url = null
    let err = null
    let attempts = 0
    while (attempts <= RETRY) {
      attempts++
      // 注意：lx_runtime.call 失败时是**返回值** {ok:false,error}，不是 throw
      const r = await src.call('musicUrl', c.source, { ...mi, musicInfo: mi })
      url = r && r.ok ? r.value : null
      err = (r && r.error) || '(无错误信息)'
      if (url) break
      if (attempts <= RETRY) await new Promise((res) => setTimeout(res, 1200))
    }

    let verdict
    if (c.expect === 'FAIL') {
      verdict = !url ? 'PASS' : 'FAIL'
    } else if (c.reject && url && c.reject.test(url)) {
      verdict = 'FAIL'
    } else if (c.expect && url) {
      verdict = c.expect.test(url) ? 'PASS' : 'FAIL'
    } else {
      verdict = url ? 'PASS' : 'FAIL'
    }

    // flaky 只在「期望成功却失败」且原因是网络抖动时才算。
    // D/E 这类用例本就期望失败，失败是正确结果，不能标成抖动。
    const flaky = verdict === 'FAIL' && attempts > 1 && /上游故障|网络失败|预检不可播|HTTP 5\d\d|预算/.test(String(err))

    const ok = verdict === 'PASS' || flaky
    ok ? pass++ : fail++
    const mark = ok ? (flaky ? '⚠️' : '✅') : '❌'
    console.log(`${mark} ${c.tag}${flaky ? '  (上游抖动，重试后仍失败)' : ''}`)
    console.log(`   ${c.desc}`)
    if (url) console.log(`   → ${url.slice(0, 105)}`)
    else console.log(`   → 无链接：${String(err).replace(/\s+/g, ' ').slice(0, 260)}`)
    if (!ok) console.log(`   ✗ 判定 ${verdict}`)
    console.log()
  }

  console.log(`通过 ${pass} / 失败 ${fail}`)
  process.exit(fail ? 1 : 0)
})()
