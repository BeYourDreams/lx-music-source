#!/usr/bin/env python3
"""洛雪自定义音源自动更新器 + 音源体检（自动降级 / 自动复位）

从 GitHub 拉取仓库里的 latest.js，若版本比本地已安装的新，就直接改写
洛雪的 user_api.json —— 等价于「重新导入」，但不需要点任何按钮。

为什么必须由外部程序来做：自定义源脚本运行在洛雪的 user-api 页面里，
只拿得到 lx 这一个 bridge（request/send/utils），没有文件读写、也无法重载
自身。所以「自动替换已安装的源」只能从外面改 user_api.json。

还会顺手做一件事：**体检所有已安装的源，坏的自动降权、修好后自动复位**。
原因见下面「为什么要体检」。

用法：
    python UpdateInstalled.py                # 检查并更新（默认 aggregator）+ 体检
    python UpdateInstalled.py --dry-run      # 只体检、只报告，一个字节都不改
    python UpdateInstalled.py --check        # 只看版本，不写入
    python UpdateInstalled.py --source qdy   # 更新指定源
    python UpdateInstalled.py --no-health    # 只更新，不体检
    python UpdateInstalled.py --probe        # 额外对生效中的源做一次实网深测（慢）
    python UpdateInstalled.py --task         # 注册 Windows 计划任务，每 6 小时自动跑一次
    python UpdateInstalled.py --task --remove

为什么要体检（洛雪 2.12 的真实行为，来自 app.asar 反编译）：
    洛雪同一时间只启用**一个**源，id 存在 config_v2.json 的 common.apiSource；
    user_api.json 里的数组顺序只影响界面显示顺序。
    加载自定义源只有一条路：主进程开隐藏窗口 → preload 把脚本 executeJavaScript。
    - 脚本抛运行时错误 / 未捕获 Promise → preload 把错误报回来，洛雪弹
      「音源 xx 初始化失败」并自动退回官方源（酷我优先），还能抢救；
    - 脚本有**语法错误** → executeJavaScript 直接 reject，而洛雪的代码是
      webFrame.executeJavaScript(script).catch(e => e)  ← 静默吞掉。
      结果：既不报错也不回退，界面永远卡在「音源初始化中」，播放永远等不到链接。
    所以「解析报错」必须由外部程序发现并自动降级，这就是体检存在的意义。

注意：写入后需要重启洛雪才会生效（LX 启动时才读这两个文件）。
      脚本会自动「先停洛雪 → 改文件 → 再启回来」，不用手动重启。
"""

import argparse
import base64
import binascii
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO = 'BeYourDreams/lx-music-source'
BRANCH = 'main'

# 加速源优先，直连 raw 兜底。全部指向同一个文件。
# 注意：ghproxy.cn 已失效（返回 200 但是拦截页），不要加进来。
MIRRORS: List[str] = [
    'https://ghfast.top/https://raw.githubusercontent.com/{repo}/{branch}/{path}',
    'https://gh-proxy.com/https://raw.githubusercontent.com/{repo}/{branch}/{path}',
    'https://ghproxy.net/https://raw.githubusercontent.com/{repo}/{branch}/{path}',
    'https://raw.githubusercontent.com/{repo}/{branch}/{path}',
]

TASK_NAME = 'lx-music-source-update'
UA = {'User-Agent': 'Mozilla/5.0'}

# 洛雪内置官方源的固定顺序：酷我 kw → 酷狗 kg → QQ tx → 网易 wy → 咪咕 mg → 虾米 xm。
# 洛雪自己在自定义源挂掉时也是退回「第一个未禁用的官方源」，所以我们兜底也用 kw。
FALLBACK_OFFICIAL = 'kw'

# 记「上次把哪些源降级了」，用来判断坏源修好后能不能自动复位
STATE_FILE = Path(__file__).resolve().parent / '.health_state.json'

# 洛雪判定「有效的自定义源文件」的两条硬规则（app.asar 里 parseScriptInfo 的正则）
HEADER_BLOCK_RE = re.compile(r'^\/\*[\S|\s]+?\*\/')
HEADER_FIELD_RE = re.compile(r'^\s?\*\s?@(\w+)\s(.+)$', re.M)

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')


# ────────────────────────── 基础工具 ──────────────────────────

def parse_version(text: str) -> Optional[Tuple[int, int, int]]:
    """从 'v1.3.3' / '1.3.3' 里解析出 (1, 3, 3)"""
    m = re.search(r'(\d+)(?:\.(\d+))?(?:\.(\d+))?', str(text or ''))
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2) or 0), int(m.group(3) or 0))


def is_newer(a: Tuple[int, int, int], b: Tuple[int, int, int]) -> bool:
    return a > b


def script_meta(raw: bytes) -> Dict[str, str]:
    """读取音源头部注释里的 @name/@version/@description 等字段"""
    head = raw[:2000].decode('utf-8', 'replace')
    meta: Dict[str, str] = {}
    for key in ('name', 'description', 'version', 'author', 'homepage'):
        m = re.search(r'@' + key + r'\s+([^\n*]+)', head)
        meta[key] = m.group(1).strip() if m else ''
    return meta


def data_dir() -> Path:
    """定位洛雪的数据目录"""
    system = platform.system()
    if system == 'Windows':
        base = Path(os.environ.get('APPDATA', Path.home() / 'AppData/Roaming'))
    elif system == 'Darwin':
        base = Path.home() / 'Library/Application Support'
    else:
        base = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config'))
    return base / 'lx-music-desktop' / 'LxDatas'


def user_api_file() -> Path:
    return data_dir() / 'user_api.json'


def config_file() -> Path:
    """洛雪的设置文件，生效中的音源 id（common.apiSource）存在里面"""
    return data_dir() / 'config_v2.json'


def backup(path: Path) -> Path:
    """备份一份，只留最新的一份"""
    bak = path.with_name(path.name + '.bak')
    if bak.exists():
        bak.unlink()
    shutil.copy2(path, bak)
    return bak


# ────────────────────────── 下载 ──────────────────────────

def download(path: str, timeout: int = 15) -> bytes:
    """
    按加速源优先级依次尝试，返回第一个成功的文件内容。

    刻意加 `?t=<时间戳>` 打破缓存：加速站（ghfast.top 等）会缓存 raw 的响应，
    不加参数的话仓库刚推的最新版会被当成旧版，表现为「明明发布了却提示已是最新」。
    """
    errors: List[str] = []
    nonce = int(time.time())
    for tpl in MIRRORS:
        url = tpl.format(repo=REPO, branch=BRANCH, path=path) + f'?_={nonce}'
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            # 加速源失效时经常返回 200 + 拦截页，靠内容特征识别
            if b'@version' not in data[:2000] and b'@name' not in data[:2000]:
                errors.append(f'{url} → 不是音源文件（拦截页？）')
                continue
            print(f'  ✅ 来自 {url}')
            return data
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            errors.append(f'{url} → {e}')
    raise RuntimeError('所有地址都拉取失败：\n    ' + '\n    '.join(errors))


# ────────────────────────── 音源体检 ──────────────────────────

@dataclass
class SourceCheck:
    """单个已安装源的体检结果"""
    api: Dict[str, Any]
    problems: List[str] = field(default_factory=list)
    warning: str = ''

    @property
    def id(self) -> str:
        return str(self.api.get('id') or '')

    @property
    def name(self) -> str:
        return str(self.api.get('name') or self.id or '(未命名)')

    @property
    def ok(self) -> bool:
        return not self.problems


@dataclass
class HealthReport:
    """全局体检结论 + 要做的调整"""
    checks: List[SourceCheck]
    active: str
    want_order: List[str]
    want_active: str
    fixed: List[str]
    order_changed: bool = False
    active_changed: bool = False

    @property
    def changed(self) -> bool:
        return self.order_changed or self.active_changed

    def name_of(self, api_id: str) -> str:
        for c in self.checks:
            if c.id == api_id:
                return c.name
        return api_id


def unpack_script(stored: str) -> str:
    """还原 user_api.json 里的脚本明文（洛雪存的是 'gz_' + zlib deflate + base64）"""
    if not stored.startswith('gz_'):
        return stored
    return zlib.decompress(base64.b64decode(stored[3:])).decode('utf-8', 'replace')


_NODE_OK: Optional[bool] = None


def node_available() -> bool:
    """有没有 node：有就顺手用 `node --check` 做真正的语法校验"""
    global _NODE_OK
    if _NODE_OK is None:
        _NODE_OK = shutil.which('node') is not None
    return _NODE_OK


def node_syntax_check(code: str) -> str:
    """用 node --check 校验语法，返回错误摘要（空串 = 没问题）"""
    with tempfile.TemporaryDirectory() as td:
        f = Path(td) / 'api.js'
        f.write_text(code, encoding='utf-8')
        r = subprocess.run(['node', '--check', str(f)], capture_output=True, text=True)
    if r.returncode == 0:
        return ''
    lines = [ln.strip() for ln in (r.stderr or '').splitlines() if ln.strip()]
    # node 的输出是：文件:行号 / 出错那行 / ^ / SyntaxError: xxx / 调用栈
    # 只留「哪一行 + 什么错」，栈帧对定位这个脚本没用
    where = next((Path(ln).name for ln in lines if '.js' in ln), '')
    what = next((ln for ln in lines if re.match(r'^[A-Za-z]*Error\b', ln)), '')
    return f'{where} {what}'.strip()[:200] or 'unknown error'


def check_source(api: Dict[str, Any]) -> SourceCheck:
    """只查「装载阶段」会不会失败：解压 → 头部注释 → JS 语法。不联网"""
    result = SourceCheck(api=api)
    try:
        code = unpack_script(str(api.get('script') or ''))
    except (zlib.error, binascii.Error, ValueError) as e:
        result.problems.append(f'脚本解压失败：{e}')
        return result
    if not code.strip():
        result.problems.append('脚本为空')
        return result
    # 洛雪解析头部注释：开头没有 /*! … */ 就直接抛「无效的自定义源文件」
    head = HEADER_BLOCK_RE.match(code)
    if not head:
        result.problems.append('缺少 /*! … */ 头部注释块')
    elif not HEADER_FIELD_RE.search(head.group(0)):
        # 不算致命（洛雪会自己编个名字），但这样的源更新器匹配不到，只能提醒
        result.warning = '头部注释里没有 @name / @version 字段，更新器可能匹配不上'
    if result.problems:
        return result
    if node_available():
        err = node_syntax_check(code)
        if err:
            result.problems.append(f'JS 语法错误（洛雪会静默卡死）：{err}')
            return result
        result.warning = probe_init(api)
    return result


def probe_init(api: Dict[str, Any], timeout: int = 30) -> str:
    """
    装载体检：跑 tools/probe_init.js，只跑到 inited，不联网。

    只当**警告**：这类错误洛雪自己是能处理的（会弹「初始化失败」并退回官方源），
    而语法错误那种它处理不了的，才由上面的 node --check 判定为「坏源」自动降权。
    """
    script = Path(__file__).resolve().parent / 'tools' / 'probe_init.js'
    if not script.exists() or not node_available():
        return ''
    with tempfile.TemporaryDirectory() as td:
        f = Path(td) / 'api.js'
        f.write_text(unpack_script(str(api.get('script') or '')), encoding='utf-8')
        try:
            r = subprocess.run(['node', str(script), str(f)],
                               capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return '装载体检超时（inited 没回来）'
    if r.returncode == 0:
        return ''
    return f'装载体检失败（洛雪会提示初始化失败并退回官方源）：{(r.stdout or "").strip()[:160]}'


def probe_source(api: Dict[str, Any], timeout: int = 180) -> str:
    """
    深度体检：跑 tools/e2e.js 实测取链。返回空串 = 通过。

    只在 --probe 时用：需要 node + 网络，比较慢。退出码约定见 e2e.js：
    0 = 全平台可用，1 = 部分失败（只警告，不降级），2 = 脚本装载失败（算坏）。
    """
    script = Path(__file__).resolve().parent / 'tools' / 'e2e.js'
    if not script.exists() or not node_available():
        return ''
    with tempfile.TemporaryDirectory() as td:
        f = Path(td) / 'api.js'
        f.write_text(unpack_script(str(api.get('script') or '')), encoding='utf-8')
        try:
            r = subprocess.run(['node', str(script), '--file', str(f)],
                               capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return '实网深测超时'
    if r.returncode == 0:
        return ''
    if r.returncode == 2:
        return '实网深测：脚本装载失败'
    tail = [ln for ln in (r.stdout or '').splitlines() if ln.strip()]
    return '实网深测：部分平台取链失败' + (f'（{tail[-1].strip()[:120]}）' if tail else '')


def load_state() -> Dict[str, Any]:
    try:
        state = json.loads(STATE_FILE.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return {'demoted': []}
    return state if isinstance(state, dict) else {'demoted': []}


def save_state(state: Dict[str, Any]) -> None:
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')


def read_setting() -> Dict[str, Any]:
    """读 config_v2.json 里的 setting 段（读不到就当空）"""
    try:
        data = json.loads(config_file().read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return {}
    setting = data.get('setting')
    return setting if isinstance(setting, dict) else {}


def health_report(probe: bool = False) -> HealthReport:
    """
    体检全部已安装的自定义源，算出「按什么顺序摆、该用哪一个」。

    规则：
      1. 装载期有问题的源一律沉到列表末尾（降权），洛雪的界面顺序就是它；
      2. 生效中的源（common.apiSource）坏了 → 切到第一个健康的自定义源，
         一个健康的都没有就退回官方源 kw（和洛雪自己的兜底一致）；
      3. 上次降级过、这次体检通过的源复位到列表首位；如果生效的源是我们上次降级过的
         （或已经退到官方源了），把生效源抢回它；用户自己挑的其他好源不动。
    """
    apis = read_user_api().get('userApis', [])
    checks = [check_source(api) for api in apis]
    by_id = {c.id: c for c in checks}
    state = load_state()
    demoted = [i for i in state.get('demoted', []) if isinstance(i, str)]

    # 上次坏的、这次好的 → 复位到最前；其余按原相对顺序；坏的沉底
    fixed = [c for c in checks if c.ok and c.id in demoted]
    healthy = [c for c in checks if c.ok]
    broken = [c for c in checks if not c.ok]
    ordered = fixed + [c for c in healthy if c.id not in demoted] + broken
    want_order = [c.id for c in ordered]

    active = str(read_setting().get('common.apiSource') or '')
    want_active = active
    if active.startswith('user_api'):
        current = by_id.get(active)
        if current is None:
            print(f'⚠️  生效中的源 {active} 已不在 user_api.json 里')
        elif not current.ok:
            ok_ids = [c.id for c in ordered if c.ok]
            want_active = ok_ids[0] if ok_ids else FALLBACK_OFFICIAL
    # 上次降级的源这次修好了 → 把生效源抢回它。条件卡紧：
    # 只在「现在生效的不是用户自己挑的另一个好源」时才抢：
    #   - 生效的是官方源：多半就是我们上次退回去的，直接抢回来；
    #   - 生效的也是我们降过的（那就是另一个坏源，现在更坏了）→ 同样抢回来。
    # 用户手动选的自定义源一律不动，不跟他们抢。
    if fixed and (not want_active.startswith('user_api')
                  or want_active in demoted or want_active not in by_id):
        want_active = fixed[0].id

    if probe:
        target = by_id.get(active)
        if target is not None and target.ok:
            target.warning = probe_source(target.api)

    return HealthReport(
        checks=checks,
        active=active,
        want_order=want_order,
        want_active=want_active,
        fixed=[c.id for c in fixed],
        order_changed=want_order != [c.id for c in checks],
        active_changed=want_active != active,
    )


def print_health(report: HealthReport) -> None:
    if not report.checks:
        print('ℹ️  没有已安装的自定义源')
        return
    print('音源体检：')
    for c in report.checks:
        flags = []
        if c.id == report.active:
            flags.append('生效中')
        if c.id in report.fixed:
            flags.append('已修复，待复位')
        if not c.ok:
            flags.append('将降权')
        tail = f'（{" / ".join(flags)}）' if flags else ''
        print(f'  {"✅" if c.ok else "❌"} {c.name} {c.api.get("version") or ""}'.rstrip() + tail)
        for p in c.problems:
            print(f'      └ ❗ {p}')
        if c.warning:
            print(f'      └ ⚠️  {c.warning}')
    if report.order_changed:
        names = ' → '.join(report.name_of(i) for i in report.want_order)
        print(f'  🔀 建议顺序：{names}')
    if report.active_changed:
        print(f'  🔀 建议生效源：{report.name_of(report.active) or report.active or "(空)"}'
              f' → {report.name_of(report.want_active) or report.want_active}')
    if not report.changed:
        print('  ✅ 顺序与生效源都正常')


def apply_health(report: HealthReport) -> None:
    """按体检结论改 user_api.json（顺序）和 config_v2.json（生效源）"""
    if report.order_changed:
        f = user_api_file()
        data = read_user_api()
        by_id = {str(a.get('id')): a for a in data.get('userApis', [])}
        data['userApis'] = [by_id[i] for i in report.want_order if i in by_id]
        backup(f)
        f.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'✅ 已按体检结果调整 {f.name} 里的音源顺序')
    if report.active_changed:
        write_setting('common.apiSource', report.want_active)
    save_state({'demoted': [c.id for c in report.checks if not c.ok]})


# ────────────────────────── 写入 ──────────────────────────

def pack_script(raw: bytes) -> str:
    """
    按洛雪的存储格式打包：'gz_' + zlib deflate + base64
    （洛雪的 userApi/utils.ts 用 pako deflate 压缩后存 base64，读取时 inflate）
    """
    # 用 zlib 默认压缩级别，与洛雪自己存储时的输出一致（避免无谓的体积差异）
    return 'gz_' + base64.b64encode(zlib.compress(raw)).decode()


def read_user_api() -> Dict[str, Any]:
    f = user_api_file()
    if not f.exists():
        raise FileNotFoundError(f'找不到 {f}，请先在洛雪里导入一次音源')
    try:
        return json.loads(f.read_text(encoding='utf-8'))
    except json.JSONDecodeError as e:
        raise RuntimeError(f'{f} 不是合法 JSON：{e}') from e


def find_target(apis: List[Dict[str, Any]], meta: Dict[str, str]) -> Optional[Dict[str, Any]]:
    """按名字匹配已安装的源；匹配不到就取唯一那个（只装了一个源时）"""
    for api in apis:
        if meta.get('name') and api.get('name') == meta['name']:
            return api
    return apis[0] if len(apis) == 1 else None


def write_setting(key: str, value: str) -> None:
    """改 config_v2.json 里的某项设置（洛雪只在启动时读，所以改完要重启）"""
    f = config_file()
    if not f.exists():
        print(f'⚠️  找不到 {f}，跳过生效源切换')
        return
    data = json.loads(f.read_text(encoding='utf-8'))
    setting = data.setdefault('setting', {})
    if setting.get(key) == value:
        return
    backup(f)
    setting[key] = value
    f.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'✅ 已把 {key} 切到 {value}（{f.name}.bak 是备份）')


def apply_install(data: Dict[str, Any], target: Dict[str, Any],
                  meta: Dict[str, str], raw: bytes) -> None:
    """把新脚本写进 user_api.json（等价于重新导入）"""
    f = user_api_file()
    backup(f)
    print(f'🔄 更新 {target.get("name")}：{target.get("version")} → {meta["version"]}')
    target['name'] = meta.get('name') or target.get('name')
    target['description'] = meta.get('description') or ''
    target['version'] = meta.get('version') or ''
    target['author'] = meta.get('author') or ''
    target['homepage'] = meta.get('homepage') or ''
    target['script'] = pack_script(raw)
    # 允许脚本弹更新提示，否则 in-script 的自更新提示会被静默丢弃
    target['allowShowUpdateAlert'] = True
    f.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'✅ 已写入 {f}（原文件备份为 {f.name}.bak）')


# ────────────────────────── 启停洛雪 ──────────────────────────

def lx_running() -> bool:
    """洛雪是否正在运行"""
    system = platform.system()
    try:
        if system == 'Windows':
            r = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq lx-music-desktop.exe'],
                               capture_output=True, text=True)
            return 'lx-music-desktop.exe' in (r.stdout or '')
        if system == 'Darwin':
            r = subprocess.run(['pgrep', '-x', 'lx-music-desktop'], capture_output=True, text=True)
        else:
            r = subprocess.run(['pgrep', '-f', 'lx-music-desktop'], capture_output=True, text=True)
        return bool((r.stdout or '').strip())
    except OSError:
        return False


def lx_exe() -> Path:
    """定位 lx-music-desktop.exe"""
    exe = Path('D:/software/lxmusic/lx-music-desktop/lx-music-desktop.exe')
    if exe.exists():
        return exe
    cands = list(Path('C:/Program Files').glob('lx-music*/lx-music-desktop.exe'))
    return cands[0] if cands else exe


def stop_lx() -> None:
    """
    停掉洛雪。改它的数据文件前必须先停：
    user_api.json / config_v2.json 都被它缓存在内存里，运行中改会被下一次写回覆盖。
    """
    system = platform.system()
    print('↻  正在停止洛雪…')
    if system == 'Windows':
        subprocess.run(['taskkill', '/IM', 'lx-music-desktop.exe', '/F'], capture_output=True)
    elif system == 'Darwin':
        subprocess.run(['osascript', '-e', 'quit app "lx-music-desktop"'], capture_output=True)
    else:
        subprocess.run(['pkill', '-f', 'lx-music-desktop'], capture_output=True)
    for _ in range(20):  # 等它真的退干净，最多 10s
        if not lx_running():
            return
        time.sleep(0.5)
    print('⚠️  洛雪似乎没退干净，仍在继续（可能被占用）')


def start_lx() -> None:
    """启动洛雪"""
    system = platform.system()
    print('↻  正在启动洛雪…')
    if system == 'Windows':
        exe = lx_exe()
        if exe.exists():
            subprocess.Popen([str(exe)], cwd=str(exe.parent))
        else:
            print('⚠️  没找到 lx-music-desktop.exe，请手动启动')
    elif system == 'Darwin':
        subprocess.Popen(['open', '-a', 'lx-music-desktop'])
    else:
        subprocess.Popen(['lx-music-desktop'])


def restart_lx() -> None:
    """重启洛雪，让新脚本立刻生效"""
    stop_lx()
    time.sleep(2)
    start_lx()


# ────────────────────────── 计划任务（Windows）──────────────────────────

def register_task(interval_hours: int) -> None:
    """注册 Windows 计划任务，周期性自动更新"""
    if platform.system() != 'Windows':
        print('❌ 只有 Windows 支持 --task，其他系统请用 cron 调本脚本')
        sys.exit(1)
    script = Path(__file__).resolve()
    # 用 pythonw 避免每次弹黑框；--restart 让更新后立刻生效
    pythonw = Path(sys.executable).with_name('pythonw.exe')
    exe = str(pythonw if pythonw.exists() else Path(sys.executable))
    cmd = f'"{exe}" "{script}" --restart'

    subprocess.run(['schtasks', '/Delete', '/TN', TASK_NAME, '/F'], capture_output=True)
    every = f'{interval_hours // 24:02d}:00' if interval_hours >= 24 else None
    args = ['schtasks', '/Create', '/TN', TASK_NAME, '/TR', cmd, '/SC', 'HOURLY', '/MO', str(interval_hours), '/F']
    if every:
        args = ['schtasks', '/Create', '/TN', TASK_NAME, '/TR', cmd, '/SC', 'DAILY', '/ST', '03:30', '/F']
    r = subprocess.run(args, capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip())
    if r.returncode == 0:
        print(f'✅ 已注册计划任务「{TASK_NAME}」，每 {interval_hours} 小时检查一次')
        print('   （体检 + 降级/复位也在其中，不用人工干预）')
        print('   卸载：python UpdateInstalled.py --task --remove')


def remove_task() -> None:
    r = subprocess.run(['schtasks', '/Delete', '/TN', TASK_NAME, '/F'],
                       capture_output=True, text=True)
    print((r.stdout or r.stderr).strip())
    sys.exit(r.returncode)


# ────────────────────────── 入口 ──────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description='洛雪自定义音源自动更新器 + 音源体检')
    ap.add_argument('--source', default='aggregator', help='要更新的源目录名（默认 aggregator）')
    ap.add_argument('--check', action='store_true', help='只检查，不写入')
    ap.add_argument('--restart', action='store_true', help='写入后自动重启洛雪')
    ap.add_argument('--task', action='store_true', help='注册/卸载 Windows 计划任务')
    ap.add_argument('--remove', action='store_true', help='配合 --task 卸载计划任务')
    ap.add_argument('--hours', type=int, default=6, help='计划任务间隔小时数（默认 6）')
    ap.add_argument('--dry-run', action='store_true', help='体检后只报告，不改任何文件')
    ap.add_argument('--no-health', action='store_true', help='跳过音源体检（不降级也不复位）')
    ap.add_argument('--probe', action='store_true', help='额外对生效中的源做实网深测（慢）')
    args = ap.parse_args()

    if args.task:
        if args.remove:
            remove_task()
        register_task(args.hours)
        return

    # ── 1. 体检（只读，先看清楚再动文件）
    report: Optional[HealthReport] = None
    try:
        if not args.no_health:
            report = health_report(probe=args.probe)
            print_health(report)
    except (RuntimeError, FileNotFoundError) as e:
        print(f'⚠️  体检跳过：{e}')

    # ── 2. 看线上有没有新版
    print(f'检查 {args.source}/latest.js …')
    try:
        raw = download(f'{args.source}/latest.js')
    except RuntimeError as e:
        print(f'❌ {e}')
        sys.exit(1)

    meta = script_meta(raw)
    print(f'  线上版本：{meta.get("name")} {meta.get("version")}')

    # ── 3. 算清楚要不要写盘
    try:
        data = read_user_api()
        target = find_target(data.get('userApis', []), meta)
        if target is None:
            raise RuntimeError(f'在 user_api.json 里找不到名为「{meta.get("name")}」的源')
        new_ver = parse_version(meta.get('version', ''))
        if not new_ver:
            raise RuntimeError(f'无法解析新脚本版本号：{meta.get("version")!r}')
        old_ver = parse_version(target.get('version', ''))
        need_update = old_ver is None or is_newer(new_ver, old_ver)
    except (RuntimeError, FileNotFoundError) as e:
        print(f'❌ {e}')
        sys.exit(1)

    if args.check:
        for api in data.get('userApis', []):
            local = parse_version(api.get('version', '')) or (0, 0, 0)
            mark = '⬅ 需更新' if api is target and need_update else ''
            print(f'  本地：{api.get("name")} {api.get("version")} {mark}'.rstrip())
        return

    if not need_update:
        print(f'✅ 已是最新：{target.get("name")} {target.get("version")}')
    if not need_update and (report is None or not report.changed):
        print('ℹ️  音源顺序与生效源都正常，无需改动')
        return

    if args.dry_run:
        print('ℹ️  --dry-run：只报告，不写入')
        if need_update:
            print(f'   将更新 {target.get("name")} {target.get("version")} → {meta.get("version")}')
        if report is not None and report.changed:
            if report.active_changed:
                print(f'   将切生效源：{report.name_of(report.active) or report.active or "(空)"}'
                      f' → {report.name_of(report.want_active) or report.want_active}')
            if report.order_changed:
                print(f'   将调整顺序：{" → ".join(report.name_of(i) for i in report.want_order)}')
        return

    # ── 4. 动文件：先停洛雪（它缓存着这两个文件），写完再启回来
    was_running = lx_running()
    if was_running:
        stop_lx()
    try:
        if need_update:
            apply_install(data, target, meta, raw)
        # 脚本可能刚被换掉，重新体检一次再决定降级/复位
        if not args.no_health:
            fresh = health_report()
            if fresh.changed:
                print_health(fresh)
                apply_health(fresh)
    except Exception as e:  # noqa: BLE001
        print(f'❌ {e}')
        if was_running:
            start_lx()
        sys.exit(1)

    if was_running or args.restart:
        start_lx()
    else:
        print('ℹ️  需重启洛雪后生效；想自动重启请加 --restart')


if __name__ == '__main__':
    main()
