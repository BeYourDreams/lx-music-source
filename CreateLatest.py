#!/usr/bin/env python3
"""跨平台脚本：更新各音乐源的 latest.js 文件"""

import sys
from pathlib import Path
from typing import Dict

# Latest Version Numbers
VERSIONS: Dict[str, str] = {
    'aggregator': '1.3.8',
    'changqing': '1.3.0',
    'flower': '1',
    'grass': '1',
    'huanyin': '3',
    'huibq': '1.2.0',
    'ikun': '22',
    'lx': '6',
    'sixyin': '1.2.1',
    'juhe': '3',
    'qdy': '9.3'
}

# Windows 控制台默认 GBK，无法输出 emoji，这里强制切到 UTF-8
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def main() -> None:
    """按 VERSIONS 把各源版本文件复制为 latest.js"""
    script_dir = Path(__file__).parent.resolve()
    failed = False

    for source, version in VERSIONS.items():
        src = script_dir / source / f'{version}.js'
        dst = script_dir / source / 'latest.js'

        if not src.exists():
            print(f'❌ {source}: {version}.js 不存在')
            failed = True
            continue

        # 用 read_bytes/write_bytes 而不是 shutil.copy2，避免把 CRLF 带进 latest.js
        # （grass / flower 会对脚本内容做 md5 校验，行尾变化会导致音源直接失效）
        data = src.read_bytes()
        dst.write_bytes(data)
        print(f'✅ {source}: {version}.js → latest.js ({len(data)} 字节'
              f'{"，含 CR" if b"\\r" in data else ""})')

    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
