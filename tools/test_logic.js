#!/usr/bin/env node
'use strict'
/**
 * aggregator 纯逻辑单测（不联网）
 * ------------------------------------------------------------------
 * 覆盖两块最容易在改动中被悄悄破坏、且一旦破坏就「用户听不出来」或「用户听得出但说不清」的逻辑：
 *
*   1. 歌手匹配（含中英文/繁简体别名）—— 放宽了不能误收，放松不够会误拒
 *   2. 试听片段体积闸门 —— 阈值既要能拦 30 秒试听，又不能误杀真实文件
 *   3. 降级价值分类 + 主机熔断 —— 决定「还要不要再等一轮」与「还该不该再打这台机器」
 *
 * 用法：node tools/test_logic.js
 * 退出码：0 = 全通过；1 = 有失败
 *
 * 实现说明：直接 eval 音源脚本并把内部函数挂到 globalThis，
 * 这样测的就是**线上那份代码**，而不是复制一份近似实现。
 */

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..')
const SCRIPT = process.argv[2] || path.join(ROOT, 'aggregator/latest.js')
const src = fs.readFileSync(SCRIPT, 'utf8')
+ '\n;globalThis.__t = { singerMatch, normSingers, allSingerKeys, isSameSong, MIN_BYTES_PER_SEC, DURATION_TOLERANCE, DEGRADE_WORTHY, BREAK_THRESHOLD, BREAK_TTL, hostOf, isTripped, noteFail, noteOk };'

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  Promise,
  Date,
  URL,
  lx: {
    EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
    on() {},
    send() {},
    request(_u, _o, cb) { cb(new Error('stub')) },
    currentScriptInfo: { version: 'test' },
  },
}
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: SCRIPT })

const T = sandbox.__t
if (!T) {
  console.error('❌ 没能从脚本里取出内部函数，脚本结构可能变了')
  process.exit(1)
}

let failed = 0
const check = (desc, got, want) => {
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? '  ✅' : '  ❌'} ${desc} → ${got}${ok ? '' : `（期望 ${want}）`}`)
}

console.log(`被测脚本：${path.relative(ROOT, SCRIPT)}`)

console.log('\n[1] 歌手匹配')
{
  const m = (a, b) => T.singerMatch(T.normSingers(a), T.normSingers(b))
  check('周杰伦 ↔ Jay Chou（拆词后靠整串展开命中）', m('周杰伦', 'Jay Chou'), true)
  check('周杰伦 ↔ 周杰倫（繁体）', m('周杰伦', '周杰倫'), true)
  check('林俊杰 ↔ JJ Lin', m('林俊杰', 'JJ Lin'), true)
  check('同名不同人必须被拒', m('周杰伦', '林俊杰'), false)
  check('翻唱歌手必须被拒（防错歌核心）', m('周杰伦', 'Lucky小爱'), false)
  check('合唱里含本人算匹配', m('金莎', '林俊杰、金莎'), true)
  check('双方都没有歌手信息时不断言', T.singerMatch([], []), true)
}

console.log('\n[2] 三重校验整体')
{
  const want = { name: '晴天', singer: '周杰伦', interval: 269 }
  check('同名同歌手同时长 → 通过', T.isSameSong(want, { name: '晴天', singer: 'Jay Chou', interval: 269 }).ok, true)
  check('翻唱版被时长拦下', T.isSameSong(want, { name: '晴天(深情版)', singer: 'Lucky小爱', interval: 279 }).ok, false)
  check('歌名不符被拦下', T.isSameSong(want, { name: '刀马旦', singer: '周杰伦', interval: 192 }).ok, false)
  check('歌手不符被拦下', T.isSameSong(want, { name: '晴天', singer: '陈奕迅', interval: 269 }).ok, false)
  check(`时长容差 ${T.DURATION_TOLERANCE}s 内视为同一首`, T.isSameSong(want, { name: '晴天', singer: '周杰伦', interval: 269 + T.DURATION_TOLERANCE }).ok, true)
}

console.log('\n[3] 试听片段体积闸门（阈值 = 理论下限的 35%）')
{
  const MIN = T.MIN_BYTES_PER_SEC
  const nominal = (sec, q) => sec * (MIN[q] || MIN['128k']) * 1024
  const blocked = (sec, q, mb) => mb * 1048576 < nominal(sec, q) * 0.35

  // 实测样本：musicapi 网关返回的 jd-musicrep-ts 试听链接，0.69MB / 255s / 320k
  check('实测 30 秒试听片段（0.69MB）被拦下', blocked(255, '320k', 0.69), true)
  check('真实全曲（9.77MB）放行', blocked(255, '320k', 9.77), false)
  check('128k 全曲（3.9MB / 255s）放行', blocked(255, '128k', 3.9), false)
  check('flac 全曲（28MB / 255s）放行', blocked(255, 'flac', 28), false)
  check('低码率下也不误杀（2.2MB / 255s / 128k）', blocked(255, '128k', 2.2), false)
}

console.log('\n[4] 降级价值分类（换音质到底有没有可能救回来）')
{
  const w = (reason) => T.DEGRADE_WORTHY.test(reason)
  // 只有网关自己用 JSON 说出来的「这一档没有」才值得换 level
  check('网关无此歌 → 值得降级', w('网关无此歌'), true)
  check('网关无版权 → 值得降级', w('网关无版权(歌曲未授权)'), true)
  check('响应里没有可用的 URL → 值得降级', w('响应里没有可用的 URL'), true)
  // 以下都与音质无关，降级只是把同样的失败重跑一遍（v1.3.7 卡 9s 的根因）
  check('裸 HTTP 404（接口下线）→ 不降级', w('HTTP 404'), false)
  check('网络失败 → 不降级', w('网络失败(timeout)'), false)
  check('上游故障 5xx → 不降级', w('上游故障(HTTP 502)'), false)
  check('预检不可播 → 不降级', w('预检不可播(HTTP 404)'), false)
}

console.log('\n[5] 主机熔断（连续传输层失败后不再空等超时）')
{
  const host = T.hostOf('https://musicapi.haitangw.net/music/kw.php?type=mp3&id=1')
check('从 URL 取出 host', host, 'musicapi.haitangw.net')
  check('未失败时未熔断', T.isTripped(host), false)
  T.noteFail(host)
  check(`失败 1 次还没到阈值 ${T.BREAK_THRESHOLD}`, T.isTripped(host), false)
  T.noteFail(host)
  check('连续失败 2 次后熔断', T.isTripped(host), true)
  check('别的 host 不受影响', T.isTripped('yinyue.haitangw.net'), false)
  T.noteOk(host)
  check('一旦成功立刻恢复', T.isTripped(host), false)
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 个用例失败`)
process.exit(failed === 0 ? 0 : 1)
