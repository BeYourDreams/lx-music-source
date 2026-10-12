# lx-music-source
洛雪音乐源，内容源于网络

---

## ⭐ 融合源 aggregator（本仓库自研，推荐直接用这个）

**网易云 · QQ · 酷我 · 酷狗 · 咪咕** 五平台通吃，源码完全可审计，不 eval 任何混淆代码。

```
https://raw.githubusercontent.com/qq458249269/lx-music-source/main/aggregator/latest.js
```

| | |
|---|---|
| 可用平台 | `wy` 网易云 / `tx` QQ / `kw` 酷我 / `kg` 酷狗 / `mg` 咪咕 |
| 实测通过 | 历史 **20/20**（5 平台 × 4 音质）；当前 **4/20** —— `haitangw.net` 网关已下线，只剩 kw（见下方网关实测表） |
| 防错歌 | 跨源后强制校验歌名 + 歌手 + 时长，宁可报错也不播错歌 |
| 保播放 | 高音质失败时自动逐级降到 320k/128k 再试，而不是直接报错 |
| 纯净度 | 手写源码，无混淆、无 eval、不做 `md5` 校验（不受 CRLF/LF 影响） |

**为什么用它**：别的源大多会把 tx/kg 降级到酷我资源，**实测会取到同名别的歌**；
融合源改为用「歌名+歌手」去目标平台搜到正确 id 再取链，并过三重校验拦下翻唱/同名歌。
即使某个平台上游挂了（如咪咕），也能自动跨源救活。

---

### 国内网络访问慢？换代理前缀

下面每个前缀都指向**同一个文件**，任选其一：

```
https://ghfast.top/https://raw.githubusercontent.com/qq458249269/lx-music-source/main/aggregator/latest.js
```

```
https://gh-proxy.com/https://raw.githubusercontent.com/qq458249269/lx-music-source/main/aggregator/latest.js
```

```
https://ghproxy.net/https://raw.githubusercontent.com/qq458249269/lx-music-source/main/aggregator/latest.js
```

> ❓ 用不了？洛雪里进入「设置 → 音源设置」，把上面的地址填进「自定义源」。
> ⚠️ 拉取失败时换另一个前缀重试，**地址里不要漏掉后面的 `https://`**。
> ❌ `ghproxy.cn` 已实测失效（返回 200 但是拦截页，不是 JS），别用。

---

## 🔄 自动更新（推荐装一次，之后不用再管）

`aggregator` 启动 5 秒后会自己检查有没有新版本，有就弹窗告诉你，点一下打开**加速源地址**下载。

但「弹窗 → 下载 → 重新导入」还是要点三次。真正省事的是用仓库里的更新器，
它**直接改写洛雪的 `user_api.json`**（等价于重新导入），零点击：

```bash
# 检查 + 更新（默认 aggregator），更新完自动重启洛雪
python UpdateInstalled.py --restart

# 只看版本不动文件
python UpdateInstalled.py --check

# 装成开机自动跑，每 6 小时检查一次
python UpdateInstalled.py --task
```

原理：自定义源脚本跑在洛雪的 `user-api` 页面里，只有 `lx.request` / `lx.send` 这一个
bridge，**没有文件读写权限、也不能重载自己**，所以「自动替换已安装的源」必须由外部程序
改 `user_api.json`（位置：`%APPDATA%/lx-music-desktop/LxDatas/user_api.json`）。
更新器沿用洛雪自己的存储格式（`gz_` + zlib + base64），写之前自动备份 `.json.bak`。

> 两个细节：更新器会按 `ghfast.top → gh-proxy.com → ghproxy.net → raw` 顺序尝试，
> 并在 URL 后加时间戳 —— 加速站会缓存 raw 响应，不打破缓存的话刚发布的版本会被当成旧版。
> 写入后必须重启洛雪才生效（`--restart` 已经代劳）。改动前会**先停洛雪再启回来**，
> 因为它把这两个文件缓存在内存里，运行中改会被它下一次写回覆盖。

---

## 🩺 音源体检：坏的自动降权，修好自动复位

更新器每次运行都会顺手体检已安装的所有自定义源，装载期有问题的源会被**自动降权**
（挪到列表末尾），生效中的源坏了会把 `config_v2.json` 里的
`common.apiSource` 切到下一个健康的源；等它修好了，下次体检又自动挪回首位。

```bash
python UpdateInstalled.py --dry-run   # 只体检、只报告，一个字节都不改
python UpdateInstalled.py             # 体检 + 修正（要改才停/启洛雪）
python UpdateInstalled.py --probe     # 额外对生效中的源跑一次实网深测（慢）
```

体检查三样（都来自洛雪 2.12 的真实判定规则）：

| 检查项 | 不通过的后果 |
|---|---|
| 脚本能不能解压（`gz_` + zlib） | 源直接加载不出来 |
| 开头有没有 `/*! … */` 头部注释块 | 洛雪抛「无效的自定义源文件」 |
| JS 语法（用 `node --check`） | **最阴险**：洛雪静默卡死，见下 |
| 装载体检（`tools/probe_init.js`，只警告不降权） | 洛雪会提示「初始化失败」并自动退回官方源，它自己能处理 |

> ⚠️ 为什么必须有外部兜底：洛雪加载自定义源只有一条路 —— 主进程开隐藏窗口，
> preload 把脚本 `executeJavaScript` 一把梭。脚本抛运行时错误时它会报错并自动退回
> 官方源（酷我优先）；但**语法错误**时 `executeJavaScript` 直接 reject，而洛雪的代码是
> `executeJavaScript(script).catch(e => e)` —— 错误被静默吞掉，既不提示也不回退，
> 界面永远卡在「音源初始化中」，播放永远等不到链接。
> 既然客户端不会自愈，就由更新器每 6 小时（计划任务里已包含）体检并自动降级/复位。

> 洛雪同一时间只启用**一个**源，所以「顺序」真正落地靠的是「谁生效」：
> `user_api.json` 的数组顺序只影响界面显示，生效源存在 `config_v2.json` 的
> `common.apiSource`，两者更新器都会改。


---

## ⚠️ 各源可用状态（2026-09-26 实测）

实测方法：`node tools/e2e.js --verify`（Range GET 跟随重定向，判 `content-type: audio/*`）。
注：LX 播放器**会**跟随重定向（只有脚本内的 `lx.request` 不跟随），所以 `.php` 网关链只要能跳到真音频就算可用。

| 源 | 版本 | 可用平台 | 状态 | 说明 |
|---|---|---|---|---|
| **aggregator** | 1.3.8 | **wy, tx, kw, kg, mg** | ⚠️ **本仓库自研，首选** | 不 eval 任何混淆代码；跨源降级 + 三重校验防错歌 + 音质自动降级。**当前上游 `haitangw.net` 全站 404，只剩 kw 可用**（详见下方网关实测表） |
| **qdy** | 9.3 | **wy, kw** | ✅ 推荐 | tx 返回 302 到空首页(403)；kg 返回 `{"code":201}`；mg 404 |
| **changqing** | 1.3.0 | **wy, tx, kw, kg** | ⚠️ 能播但可能错歌 | 后端会把 tx/kg 降级到酷我资源，**实测会取到同名别的歌**。想稳请用 `aggregator` |
| **sixyin** | 1.2.1 | **wy** | ⚠️ 部分可用 | 后端 `lx.itooi.cn` 已暂停；`mobi.kuwo.cn` 403，仅网易云走官方接口存活 |
| flower | 1 | — | ❌ 失效 | 后端 `97.64.37.235/flower/v1/*` 路由已移除（404） |
| grass | 1 | — | ❌ 失效 | 后端 `97.64.37.235/grass/v1/*` 路由已移除（404） |
| huanyin | 3 | — | ❌ 失效 | `music-dl.sayqz.com` 域名已删除（DNS 无解析） |
| huibq | 1.2.0 | — | ❌ 失效 | `lxmusicapi.onrender.com` 全部 503（服务已死） |
| ikun | 22 | — | ❌ 失效 | `api.ikunshare.com` 域名已删除（DNS 无解析）；且声明了非白名单的 `git` 源被 LX 丢弃 |
| juhe | 3 | — | ❌ 失效 | `api.music.lerd.dpdns.org/init.conf` 返回 429，初始化即失败 |
| lx | 6 | — | ❌ 失效 | 不注册 `request` 处理器；依赖 `88.lxmusic.中国` 服务端 |

> 📌 **首选 `aggregator`**：唯一源码完全可审计、不依赖 eval、不受脚本 md5 校验影响的源。
> `qdy` / `sixyin` 仍可用但源码是混淆的，行为不可预测。
> 其余 7 个源的上游服务均已下线，无法通过修改本地脚本修复。

### ⚠️ Windows 克隆必读

`grass` / `flower` 会对脚本内容做 md5 校验。仓库已加 `.gitattributes` 强制 LF 行尾，
若你手动改过行尾或用旧版检出过，请执行 `git checkout -- .` 重新检出，否则这两个源会报「服务器异常」。

---

## 在线导入 - 原始链接

> ⭐ **融合源 aggregator 已置顶到文首，见「⭐ 融合源 aggregator」一节。**
> 代理前缀（实测均可用，均指向同一文件）：
> `https://ghfast.top/` · `https://gh-proxy.com/` · `https://ghproxy.net/`

### QDY（网易云 + 酷我，链路最稳）
```
https://raw.githubusercontent.com/qq458249269/lx-music-source/main/qdy/latest.js
```

### ChangQing（QQ + 酷狗 + 酷我 + 网易云）
```
https://raw.githubusercontent.com/qq458249269/lx-music-source/main/changqing/latest.js
```

### SixYin（仅网易云）
```
https://raw.githubusercontent.com/qq458249269/lx-music-source/main/sixyin/latest.js
```

### 其他源（均失效，仅供参考）

<details>
<summary>展开查看所有失效源链接</summary>

```
https://raw.githubusercontent.com/qq458249269/lx-music-source/main/flower/latest.js
https://raw.githubusercontent.com/qq458249269/lx-music-source/main/grass/latest.js
https://raw.githubusercontent.com/qq458249269/lx-music-source/main/huanyin/latest.js
https://raw.githubusercontent.com/qq458249269/lx-music-source/main/huibq/latest.js
https://raw.githubusercontent.com/qq458249269/lx-music-source/main/ikun/latest.js
https://raw.githubusercontent.com/qq458249269/lx-music-source/main/juhe/latest.js
https://raw.githubusercontent.com/qq458249269/lx-music-source/main/lx/latest.js
```

</details>

## 在线导入 - 加速链接

### Aggregator（首选）
```
https://ghproxy.net/raw.githubusercontent.com/qq458249269/lx-music-source/main/aggregator/latest.js
```

### QDY（推荐）
```
https://ghproxy.net/raw.githubusercontent.com/qq458249269/lx-music-source/main/qdy/latest.js
```

### ChangQing
```
https://ghproxy.net/raw.githubusercontent.com/qq458249269/lx-music-source/main/changqing/latest.js
```

### SixYin
```
https://ghproxy.net/raw.githubusercontent.com/qq458249269/lx-music-source/main/sixyin/latest.js
```

### 其他加速站点

当以上链接无法访问时，可将链接开头的 `https://ghproxy.net/` 替换为下边任一地址，然后重试。

- https://gh.llkk.cc/
- https://github.moeyy.xyz/
- https://ghproxy.cn/
- https://gh.api.99988866.xyz/
- https://ghp.ci/
- https://gh-proxy.org/

> 加速链接仅推荐访问 GitHub 受限的用户使用，如果你的网络可以流畅访问 GitHub，建议直接使用原始链接。

---

## 本地检测（自测工具）

仓库提供了基于 Node.js 的端到端测试工具，可验证各源的加载、初始化、声明平台及取链结果：

```bash
# 安装依赖（无需，纯 Node.js 标准库）
# 运行全量测试
node tools/e2e.js

# 只测指定源
node tools/e2e.js qdy sixyin

# 只测指定平台
node tools/e2e.js qdy wy tx

# 真音频验证（Range GET 跟随重定向检查 content-type）
node tools/e2e.js --verify

# 扩到全部 4 档音质（128k/320k/flac/flac24bit）
node tools/e2e.js --verify --allq aggregator

# 防错歌回归：同名/同歌手/同时长差的陷阱用例
node tools/test_nosongmix.js

# 检查 .php 网关链接的重定向链
node tools/probe_redirect.js "http://example.com/xxx.php?type=mp3&id=xxx"

# 调试环境变量
SHOW_NET=1 node tools/e2e.js qdy          # 打印加载期间的网络请求
SHOW_BODY=1 node tools/e2e.js --verify qdy # 打印完整响应体
SHOW_STACK=1 node tools/e2e.js qdy         # 打印错误堆栈
DEBUG_REJ=1 node tools/e2e.js juhe         # 打印未捕获的 Promise 拒绝

# 单文件探测
node tools/probe_url.js "http://example.com/a.mp3"

# 网关能力矩阵（多平台 × 多网关 × type/level）
node tools/probe_gw.js wy tx

# 搜索接口可用性横向对比
node tools/probe_search.js
```

工具文件：

| 文件 | 作用 |
|---|---|
| `tools/lx_runtime.js` | Node 复刻的 LX Music 脚本沙箱（vm + 平台/音质白名单 + 20s 超时 + 返回值校验） |
| `tools/e2e.js` | 端到端体检：加载 → 初始化 → 逐平台逐音质取链 → `--verify` 真音频验证 |
| `tools/ids.json` | 各平台真实歌曲 ID（避免拿假 ID 测试导致误判） |
| `tools/probe_url.js` | 探测单个 URL 的状态码 / content-type / Location |
| `tools/probe_redirect.js` | 跟随重定向链，验证最终是否 `audio/*` |
| `tools/probe_hash.js` | 校验 grass/flower 的 md5 签名（`md5(脚本.trim())`） |
| `tools/probe_gw.js` | 网关能力矩阵：探测各网关支持的平台/type/level 组合与返回模式（JSON / 302 / 文本） |
| `tools/test_nosongmix.js` | **防错歌回归测试**：构造同名/同歌手/同时长差的陷阱用例，验证跨源后拿到的仍是同一首歌 |
| `tools/probe_kw.js` | 探测酷我旧搜索接口的字段与相关性（结论：已排除该搜索源） |
| `tools/probe_search.js` | 搜索接口**可用性矩阵**：横向跑 8 个候选接口，看哪些能用、哪些被拒 |
| `tools/probe_search_fields.js` | 搜索接口**定位质量验证**：已选定的接口能否区分「深情版 vs 原版」并提取到正确 id |

### 判定标准

| 现象 | 含义 |
|---|---|
| `音频验证 OK 206 audio/mpeg` | ✅ 真能播 |
| `音频验证 OK 206 audio/x-flac` | ✅ 真无损 |
| `跟随1次跳转` 仍 OK | ✅ 网关链可用，播放器会跟随重定向 |
| `返回值不是合法音频URL` | ❌ 脚本返回了非 http 字符串（如 HTML/JSON） |
| `audio/*` 但 403 空响应 | ❌ 网关跳到了占位页，播不出来 |

---

## 数据来源

- [SixYin](https://www.sixyin.com/)
- [Huibq/keep-alive](https://github.com/Huibq/keep-alive/)
- [LX](https://www.lxmusic.cc/)
- [ikun](https://github.com/MeoProject/lx-music-api-server)
- ChangQing（长青SVIP音源 by 元力菌）
- HuanYin（幻音音源 by 竹佀）

## 本仓库自研：`aggregator`

`aggregator/` 是本仓库唯一从零手写、不经混淆/eval 的音源。

### 核心权衡：「优先保证播放」 vs 「别播错歌」

这两个目标天然矛盾。把 tx 的 `songmid` 直接丢给 kw 网关，数字对不上，
拿回来的就是**另一首同名歌**；而一味不降级，遇到某平台没版权就彻底播不出。

v1.3.0 用两条规则同时满足：

| 规则 | 做法 |
|---|---|
| **1. 跨源只能走「搜索」，不能走「换 id」** | 用 歌名+歌手 去目标平台**搜**，拿到那边**正确的 id** 再取链。这样跨源后拿到的仍是同一首歌 |
| **2. 搜索结果必须过三重校验** | 歌名相似度 ≥0.7（去括号去标点）+ 歌手匹配 + 时长差 ≤5s，三条全过才采纳。宁可报「未找到匹配歌曲」，也不返回错歌 |
| **3. 音质失败要降级** | 高音质取不到链时，按 flac24bit → flac → 320k → 128k 逐级重试。**但只有「网关说这一档没有」（无此歌/无版权/响应里没 URL）才降级** —— 网络失败、5xx、搜索无匹配与音质无关，降级只是把同样的失败重跑一遍（v1.3.8 修，实测省下最多 9s） |

时长是最强判别器。实测：网易云搜「晴天 周杰伦」首条是
**「晴天(深情版)」- Lucky小爱 278s**，而原版是 269s —— 歌名几乎一样、
差 9s。光看歌名分不开，加了时长校验后被准确拦下，改走 QQ 拿到真正的原版。

### 洛雪「换源失败」到底是怎么抛出来的

这一节是从洛雪安装包 `app.asar` 里逆向出来的（`_dist_user-api-preload.js` +
`_dist_renderer.js`），排查报错时很有用：

1. **自定义源只提供 `musicUrl`。** 洛雪把自定义源**顶替**内置源（`apis[source]` 不与内置对象合并），
   但内置源对象长这样：
   ```js
   wy: {
     getMusicUrl: (e,t) => api("wy").getMusicUrl(e,t),  // ← 委托给自定义源
     getLyric:     e => builtinWyLyric(e.songmid),       // ← 内置实现，不委托
     getPic:       e => builtinWyPic(e.songmid),         // ← 内置实现，不委托
   }
   ```
   preload 的白名单也印证了这点：`m = { wy:["musicUrl"], tx:["musicUrl"], kw:["musicUrl"],
   kg:["musicUrl"], mg:["musicUrl"], local:["musicUrl","lyric","pic"] }`。
   **所以歌词/封面永远不会因为自定义源而失败**，只有 `musicUrl` 会。

2. **「换源失败」只有一个抛出点，且发生在脚本被调用之前。**
   ```js
   for (; u = e.shift(); )
     if (!sources.includes(u.source) && (api(u.source) && (p = t ?? b(playQuality, u), u.meta._qualitys[p]))) break
   if (!u || !p) throw new Error(t('toggle_source_failed'))
   ```
   `_qualitys` 来自**内置**搜索结果（自定义源没有 `search`，搜索永远走内置源）。
   也就是说：**这首歌在内置搜索结果里没有可用的音质时，脚本压根不会被调用**，
   这也正是报错「瞬间弹出」的原因。

3. **常见触发场景：歌曲的 `_qualitys` 是空的。** 注意这和「音质设太高」**不是一回事**——
   降级函数 `b()` 是从请求音质**往下**找的：

   ```js
   b = (e,t) => { let n = "128k"
     if (w.includes(e)) { let i = u7.value[t.source]
       let s = w.slice(w.indexOf(e)).find(e => t.meta._qualitys[e] && i?.includes(e)); s && (n = s) }
     return n }
   ```

   所以只要 `_qualitys` 里**有任意一档**，它就会自动降级到那一档并正常播放；
   **只有 `{}` 空对象才会报错**，而且此时把播放音质调到 128k 也救不了（查 `{}['128k']` 仍是 undefined）。

   什么时候会是空的？——**从搜索结果之外的途径添加的歌**（排行榜、歌单、导入），
   其 `meta` 可能不带音质信息。实测网易云搜索接口本身是正常的
   （10/10 都带完整 `privilege.plLevel/flLevel`），所以**在搜索页重新搜一次这首歌再播**即可修复，
   洛雪那句报错提示说的就是这件事。**换源在这里没用。**

4. 声明的 `qualitys` 会被洛雪用来做品质降级的候选集（上面 `b()` 里的 `u7.value`），
   所以**不要少声明**——少声明会让本来能降级成功的歌也播不了。

### 取链的三阶段

按**错歌风险由低到高**依次尝试：

1. **本平台直连网关** —— 错歌风险 0（id 天然就是本平台的）。仅 wy/kw 有
2. **跨源搜索 + 目标平台取链** —— 错歌风险低（过了三重校验）
3. **本平台降级网关** —— 错歌风险中（网关内部做了平台映射）

所以 `tx` / `kg` / `mg` 通过跨源拿到的网易云/酷我链，比它们自己网关给的
酷我链**更正确**，而耗时相当。

### 质量约束

| 原则 | 落地方式 |
|---|---|
| **不信任远端脚本** | 不 eval 任何混淆代码，只发固定形状的 HTTP 请求 |
| **不受行尾影响** | 不做 `md5(脚本内容)` 校验，Windows 的 CRLF/LF 差异不会导致失效 |
| **严格校验返回值** | 只有 `^https?`、长度 ≤2048、非空路径的字符串才算成功，避免把 JSON 错误体当 URL 返回 |
| **可播性预检** | 网关有时只把 302 目标吐在 body 里，这种链先用 Range GET 手动跟完跳转，确认 `content-type: audio/*` 才返回 |
| **有总预算** | `TOTAL_BUDGET = 8000ms`，防止多网关叠加撞上主进程 20s 硬超时；预算不足时**跳过跨源直接降级**，把时间留给还能出结果的路 |
| **搜索只搜一次** | 搜索只跟「歌名+歌手」有关、与音质无关，所以**整个降级链共用一次搜索结果**（v1.3.8 修：原先每降一档就重搜一次，QQ 搜索 2~3s × 4 轮 = 9s 纯等待） |
| **主机熔断** | 同一主机连续 2 次**传输层失败**（网络错误/超时/5xx/裸 404）就熔断 60s，期间直接跳过不再空等超时；任一成功立即恢复（v1.3.8 新增） |
| **区分失败原因** | 上游 5xx → 上游故障（换网关）；网关 404 → 无此歌；JSON 里有 msg → 无版权（换平台） |

网关实测行为（决定了代码里的 `mode` 字段）：

| 平台 | 网关 | 返回模式 | 备注 |
|---|---|---|---|
| wy | `yinyue.haitangw.net/wy/wy.php?type=flac` | **JSON** `{code,data:{url}}` | `type=flac` 才能拿直链；音质靠 `level`。唯一返回**真网易云链**的路径。支持 `hiLossless`（实测 56MB / 24bit） |
| kw | `musicapi.haitangw.net/music/kw.php?type=mp3` | **302 跳转** | 真酷我。依赖播放器跟随重定向 |
| tx | `yinyue.haitangw.net/qq/qq_kw.php?type=mp3` | 裸 URL 文本 | 降级到酷我 |
| kg | `yinyue.haitangw.net/kg/kg_song_kw.php?type=mp3` | 裸 URL 文本 | 降级到酷我 |
| mg | `yinyue.haitangw.net/mg/migu.php` | JSON 500 | **上游已死**：所有歌曲均返回「歌曲下线暂不支持播放」。靠跨源救活 |

> ⚠️ **2026-10 实测**：`yinyue.haitangw.net` 的 `wy.php` / `qq_kw.php` / `kg_kw.php` / `migu.php`
> 现在**全部返回裸 404（nginx 直接回、body 为空）= 接口下线**，
> 所以 wy/tx/kg/mg 暂时都取不到链（`musicapi.haitangw.net` 的 kw 仍正常）。
> 脚本据此做了两件事：裸 404 **不当作「这首歌没版权」**（不去换音质空降级），
> 并对该主机熔断 60s —— 失效的网关会在几十毫秒内直接跳过，而不是每首歌都等它超时。

搜索接口只选相关性可靠的两个：

| 平台 | 接口 | 耗时 | 备注 |
|---|---|---|---|
| wy | `music.163.com/api/search/get`（`limit=20`） | ~0.2~1.3s | 相关性一般，常被翻唱版占据首条，靠三重校验挡。**未登录时不返回 VIP 歌曲** —— 想让 wy 当跨源主力，请在脚本头部填自己的 `MUSIC_U` |
| tx | `c.y.qq.com/soso/fcgi-bin/client_search_cp` | ~2.2s | 相关性最好 |
| ~~kw~~ | `search.kuwo.cn/r.s` | — | **已排除**：搜「晴天 周杰伦」首条是 KTV 伴唱，且新旧 id 格式不通用 |
| ~~kg~~ | `mobilecdn.kugou.com/api/v3/search/song` | — | **已排除**：需 `kg_music` token，IP 被 Access Deny |
| ~~mg~~ | 咪咕官方域名 | — | **已排除**：DNS 无解析 |

> ⚠️ 网关本身也会抽风：实测 wy 网关对 `level=320k` 返过
> `{"code":502,"msg":"上游返回不是有效 JSON","raw":"<html>503..."}`。
> 所以 20s 硬超时下不能死磕单一网关，必须有降级与跨源。

## 项目地址

- [lx-music-desktop](https://github.com/lyswhut/lx-music-desktop)
- [lx-music-mobile](https://github.com/lyswhut/lx-music-mobile)
- [lx-music-sync-server](https://github.com/lyswhut/lx-music-sync-server)
- [any-listen](https://github.com/any-listen/any-listen)