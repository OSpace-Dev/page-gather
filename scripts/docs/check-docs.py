#!/usr/bin/env python3
"""只读检查文档命名、登记、元数据、本地链接/锚点与图形配对。"""
from datetime import date
from pathlib import Path
import re
import subprocess
import sys
import unicodedata
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
FOLDERS = {
    '01-requirements': 'REQ', '02-design': 'DES', '03-planning': 'PLAN',
    '04-delivery': 'RUN', '05-verification': 'VER', '06-reviews': 'REV',
    '07-diagrams': 'FIG',
}
NAME = re.compile(r'^(REQ|DES|PLAN|RUN|VER|REV)-(\d{3})-(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$')
FIGURE = re.compile(r'^FIG-(\d{3})-(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.drawio$')
LINK = re.compile(r'!?\[[^\]\n]*\]\(([^)\n]+)\)')


def prose(text):
    """代码块内的语法示例不作为实际Markdown链接或标题。"""
    lines = []
    fence = None
    for line in text.splitlines():
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            char = marker.group(1)[0]
            if fence is None:
                fence = char
            elif fence == char:
                fence = None
            lines.append('')
        else:
            lines.append(line if fence is None else '')
    return '\n'.join(lines)


def anchors(text):
    found = set()
    counts = {}
    for line in prose(text).splitlines():
        match = re.match(r'^#{1,6}\s+(.+?)\s*#*$', line)
        if not match:
            continue
        title = re.sub(r'<[^>]*>', '', match.group(1)).strip().lower()
        title = re.sub(r'!?\[([^]]+)\]\([^)]+\)', r'\1', title)
        title = ''.join(c for c in title if c in '-_' or c.isspace() or unicodedata.category(c)[0] in 'LNM')
        slug = re.sub(r'\s', '-', title)
        duplicate = counts.get(slug, 0)
        counts[slug] = duplicate + 1
        found.add(f'{slug}-{duplicate}' if duplicate else slug)
    found.update(re.findall(r'<a\s+(?:id|name)=[\'"]([^\'"]+)', text))
    return found


def main():
    errors = []
    docs = ROOT / 'docs'
    index = (docs / 'README.md').read_text(encoding='utf-8')
    seen = set()
    formal_count = 0
    figure_count = 0
    for path in sorted(docs.rglob('*')):
        if path.is_dir():
            if path.parent != docs or path.name not in FOLDERS:
                errors.append(f'{path.relative_to(ROOT).as_posix()}: 非约定文档目录')
            continue
        relative = path.relative_to(ROOT).as_posix()
        if path.name == 'README.md':
            if path.parent not in [docs, docs / '07-diagrams']:
                errors.append(f'{relative}: 未登记的导航文件')
            continue
        if path.suffix == '.md':
            match = NAME.fullmatch(path.name)
            if not match or FOLDERS.get(path.parent.name) != match.group(1):
                errors.append(f'{relative}: 文档文件名或分类不合规')
                continue
            identity = f'{match.group(1)}-{match.group(2)}'
            if identity in seen:
                errors.append(f'{relative}: 文档编号冲突')
            seen.add(identity)
            text = path.read_text(encoding='utf-8')
            for field in ['文档编号：', '建立日期：', '最后更新：', '类型：', '状态：']:
                if field not in '\n'.join(text.splitlines()[:8]):
                    errors.append(f'{relative}: 文档头缺少{field}')
            if f'文档编号：{identity}' not in text or f'建立日期：{match.group(3)}' not in text:
                errors.append(f'{relative}: 编号/建立日期与文件名不一致')
            try:
                created = date.fromisoformat(match.group(3))
                updated = date.fromisoformat(re.search(r'最后更新：(\d{4}-\d{2}-\d{2})', text).group(1))
                if not created <= updated <= date.today():
                    raise ValueError()
            except (ValueError, AttributeError):
                errors.append(f'{relative}: 日期格式、先后顺序或未来日期错误')
            if path.name not in index:
                errors.append(f'{relative}: 未在文档总导航登记')
            formal_count += 1
        elif path.name.endswith('.drawio.png') or path.name.endswith('.drawio.svg'):
            source = path.with_name(path.name.rsplit('.', 1)[0])
            if not source.is_file():
                errors.append(f'{relative}: 缺少同名编辑源')
        elif path.suffix == '.drawio':
            match = FIGURE.fullmatch(path.name)
            if not match or path.parent.name != '07-diagrams':
                errors.append(f'{relative}: 图形文件名或目录不合规')
                continue
            try:
                if date.fromisoformat(match.group(2)) > date.today():
                    raise ValueError()
            except ValueError:
                errors.append(f'{relative}: 图形建立日期无效或晚于今天')
            identity = f'FIG-{match.group(1)}'
            if identity in seen:
                errors.append(f'{relative}: 图形编号冲突')
            seen.add(identity)
            if not any(path.with_name(path.name + ext).is_file() for ext in ['.png', '.svg']):
                errors.append(f'{relative}: 缺少预览')
            if path.name not in index:
                errors.append(f'{relative}: 图源未在总导航登记')
            figure_count += 1
        else:
            errors.append(f'{relative}: 非文档产物应移至源码/工具目录')
    output = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT)
    markdown = {ROOT / s for s in output.decode('utf-8').split('\0') if s.endswith('.md') and (ROOT / s).is_file()}
    link_count = 0
    for path in sorted(markdown):
        text = prose(path.read_text(encoding='utf-8'))
        for match in LINK.finditer(text):
            raw = match.group(1)
            if re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', raw) or raw.startswith('//'):
                continue
            dest, _, fragment = raw.partition('#')
            if dest.startswith('/'):
                errors.append(f'{path.relative_to(ROOT).as_posix()}: 禁止绝对本地链接')
                continue
            target = (path.parent / unquote(dest)).resolve() if dest else path
            try:
                target.relative_to(ROOT)
            except ValueError:
                errors.append(f'{path.relative_to(ROOT).as_posix()}: 链接越出仓库')
                continue
            if not target.exists():
                errors.append(f'{path.relative_to(ROOT).as_posix()}: 目标不存在 {raw}')
            elif fragment and target.suffix == '.md' and unquote(fragment) not in anchors(target.read_text(encoding='utf-8')):
                errors.append(f'{path.relative_to(ROOT).as_posix()}: 标题锚点不存在 {raw}')
            link_count += 1
    for error in errors:
        print(error)
    print(f'文档检查：{formal_count}份正式文档、{figure_count}张图、{link_count}处本地链接，{len(errors)}项错误。')
    return bool(errors)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
