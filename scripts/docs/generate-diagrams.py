"""Regenerate native editable draw.io design artifacts (Python standard library only)."""
from pathlib import Path
import xml.etree.ElementTree as ET

BASE = Path(__file__).resolve().parents[2] / 'docs' / '07-diagrams'
BASE.mkdir(parents=True, exist_ok=True)
COLORS = {
    'blue': ('#dae8fc', '#6c8ebf'),
    'green': ('#d5e8d4', '#82b366'),
    'orange': ('#fff2cc', '#d6b656'),
    'red': ('#f8cecc', '#b85450'),
    'purple': ('#e1d5e7', '#9673a6'),
    'gray': ('#f5f5f5', '#666666'),
}

class Diagram:
    def __init__(self, name, width, height, subtitle):
        self.file = ET.Element('mxfile', host='app.diagrams.net', version='26.0.0')
        page = ET.SubElement(self.file, 'diagram', id=name, name=name)
        model = ET.SubElement(page, 'mxGraphModel', adaptiveColors='auto', grid='1', gridSize='10', page='1', pageScale='1', pageWidth=str(width), pageHeight=str(height))
        self.root = ET.SubElement(model, 'root')
        ET.SubElement(self.root, 'mxCell', id='0')
        ET.SubElement(self.root, 'mxCell', id='1', parent='0')
        self.count = 0
        self.node('title', name, 30, 15, width-60, 40, text=True, size=24)
        self.node('subtitle', subtitle, 30, 58, width-60, 42, text=True, size=13)

    def node(self, key, label, x, y, w=240, h=85, color='blue', diamond=False, text=False, size=15):
        fill, stroke = COLORS[color]
        style = f'rounded=1;whiteSpace=wrap;html=0;fontFamily=Microsoft YaHei;fontSize={size};fillColor={fill};strokeColor={stroke};spacing=10;'
        if diamond:
            style += 'shape=rhombus;rounded=0;'
        if text:
            style = f'text;html=0;align=left;verticalAlign=middle;whiteSpace=wrap;fontFamily=Microsoft YaHei;fontSize={size};fontStyle=1;'
        cell = ET.SubElement(self.root, 'mxCell', id=key, value=label, style=style, vertex='1', parent='1')
        ET.SubElement(cell, 'mxGeometry', x=str(x), y=str(y), width=str(w), height=str(h), **{'as': 'geometry'})

    def edge(self, source, target, label='', color='gray', points=None, dashed=False):
        self.count += 1
        stroke = COLORS[color][1]
        style = f'edgeStyle=orthogonalEdgeStyle;rounded=0;html=0;endArrow=block;endFill=1;fontFamily=Microsoft YaHei;fontSize=12;labelBackgroundColor=#ffffff;strokeColor={stroke};'
        if dashed:
            style += 'dashed=1;'
        cell = ET.SubElement(self.root, 'mxCell', id=f'e{self.count}', value=label, style=style, edge='1', parent='1', source=source, target=target)
        geo = ET.SubElement(cell, 'mxGeometry', relative='1', **{'as': 'geometry'})
        if points:
            array = ET.SubElement(geo, 'Array', **{'as': 'points'})
            for x, y in points:
                ET.SubElement(array, 'mxPoint', x=str(x), y=str(y))

    def save(self, filename):
        ET.indent(self.file)
        path = BASE / filename
        ET.ElementTree(self.file).write(path, encoding='utf-8', xml_declaration=True)
        parsed = ET.parse(path)
        cells = parsed.findall('.//mxCell')
        ids = [c.attrib['id'] for c in cells]
        assert len(ids) == len(set(ids)), filename
        for cell in cells:
            if cell.get('edge') == '1':
                assert cell.get('source') in ids and cell.get('target') in ids
                assert cell.find('mxGeometry') is not None
        print(f'{filename}: {len(cells)} cells validated')


d = Diagram('系统架构 · 个人每日自动化', 1320, 920, '单服务器 Docker Compose；中心模块化单体；Chrome 人工登录与自动执行复用同一持久化档案')
d.node('user', '个人用户\n桌面浏览器 / iPhone PWA', 40, 135, 250, 90, 'purple')
d.node('proxy', '现有 NGINX / 域名 / TLS\nVue 3 静态前端 / API 代理', 380, 135, 270, 90)
d.node('center', 'server 容器 / Node.js\n配置 · 调度 · 任务协调\n入库 · 变化判断 · 通知', 380, 310, 270, 130)
d.node('db', 'SQLite（中心服务内嵌）\n本地持久化卷 / WAL\n任务 / 数据 / 通知 / Outbox', 40, 330, 250, 110, 'green')
d.node('worker', 'browser-worker 容器\n直接 CDP + 可信代码插件\nChrome / 桌面 / 执行器', 780, 310, 290, 130, 'orange')
d.node('chrome', '有界面 Google Chrome\n持久化用户目录\n同一环境：人工登录 / 自动执行', 780, 550, 290, 110, 'orange')
d.node('manual', '受保护的远程桌面\nnoVNC + Xvfb\n人工模式持有浏览器锁', 780, 135, 290, 100, 'purple')
d.node('site', '目标网站\n个人登录账号\n采集 / 查询 / 少量签到', 780, 760, 290, 100, 'gray')
d.node('push', 'Web Push 服务\nVAPID + 设备订阅\nApple 设备使用其推送设施', 380, 550, 270, 110, 'purple')
d.node('storage', '持久化卷\nChrome 档案 / spool\n截图 / trace（限期保留）', 1100, 330, 190, 160, 'green')
d.node('note', '运行边界\n1. 人工与自动互斥\n2. 不公开 CDP/VNC\n3. 推送不等于已读\n4. 登录可过期', 40, 580, 250, 160, 'gray')
d.edge('user', 'proxy', 'HTTPS')
d.edge('proxy', 'center', 'API')
d.edge('center', 'db', '进程内事务访问')
d.edge('worker', 'center', '领取 / 心跳 / 数据上报')
d.edge('worker', 'chrome', '控制同一浏览器')
d.edge('manual', 'worker', '请求 / 释放人工模式')
d.edge('manual', 'chrome', '人工桌面', points=[(735, 185), (735, 605)], dashed=True)
d.edge('chrome', 'site', '授权会话访问')
d.edge('worker', 'storage', '暂存 / 附件')
d.edge('chrome', 'storage', '用户目录', points=[(1195, 605)])
d.edge('center', 'push', '事务 Outbox → 发送')
d.edge('push', 'user', '系统通知', points=[(330, 605), (330, 260), (165, 260)], dashed=True)
d.edge('user', 'manual', '受控管理入口', points=[(165, 110), (925, 110)], dashed=True)
d.save('FIG-001-2026-10-25-architecture.drawio')

d = Diagram('核心流程 · 每日运行与异常恢复', 1460, 1320, '任务领取前获得浏览器独占权；采集重传与页面重跑分离；签到不确定时只读核验')
d.node('start', '每日到期 / 手动触发\n持久化执行记录并幂等去重', 70, 125, 270, 85)
d.node('claim', '领取任务 + 租约\n确认非人工模式 / 锁定档案', 70, 265, 270, 85)
d.node('session', '检查登录状态', 90, 405, 230, 110, 'orange', diamond=True)
d.node('login', '等待用户\n暂停档案 → 人工登录\n退出人工模式并重新检查', 450, 415, 290, 100, 'red')
d.node('action', '启用签到？', 90, 575, 230, 110, 'orange', diamond=True)
d.node('verify', '只读检查当天签到状态\n已完成跳过；未完成记录意图', 450, 575, 290, 100, 'orange')
d.node('click', '点击并核验结果\n操作键唯一 / 点击前记日志', 450, 735, 290, 85, 'orange')
d.node('unknown', '超时 / 断联 / 结果不确定\n先只读核验，仍未知则等待用户\n禁止盲目再次点击', 900, 735, 350, 100, 'red')
d.node('collect', '登记不可变 collection_seq\n刷新页面后采集 / 校验完整性', 70, 900, 270, 90)
d.node('spool', '原子保存结果到 spool\n固定 collection / 提交 ID / hash', 450, 900, 290, 90, 'green')
d.node('commit', '事务检查档案提交水位\n新结果应用 / 旧批次仅归档\n数据与收据、水位原子提交', 900, 900, 350, 90, 'green')
d.node('retry', '上报失败：只重传暂存结果\n不重新采集，不重复签到\n旧租约先走恢复协议', 900, 1070, 350, 100, 'red')
d.node('finish', '确认收据 → 清理 spool\n记录终态 / 释放浏览器\n后台投递 Web Push', 450, 1090, 290, 100, 'green')
d.node('crash', '执行器失联\n先确认旧进程停止，再恢复\n有副作用先核验', 900, 290, 350, 100, 'red')
d.node('note', '只读错误：有限重试\n页面改版：修插件\n部分数据：不推断删除', 900, 480, 350, 100, 'gray')
d.edge('start', 'claim')
d.edge('claim', 'session')
d.edge('session', 'login', '失效 / 验证码')
d.edge('login', 'claim', '检查通过后恢复', points=[(595, 240), (205, 240)], dashed=True)
d.edge('session', 'action', '有效')
d.edge('action', 'collect', '否')
d.edge('action', 'verify', '是')
d.edge('verify', 'click', '明确未完成')
d.edge('verify', 'collect', '已完成', points=[(400, 620), (400, 865), (205, 865)])
d.edge('click', 'unknown', '结果不确定')
d.edge('click', 'collect', '已核验', points=[(595, 860), (205, 860)])
d.edge('collect', 'spool', '有效结果')
d.edge('spool', 'commit', '提交')
d.edge('commit', 'retry', '失败 / 响应丢失')
d.edge('retry', 'commit', '相同提交幂等重传', points=[(1320, 1120), (1320, 945)], dashed=True)
d.edge('commit', 'finish', 'APPLIED 或 STALE 归档确认', points=[(820, 945), (820, 1135)])
d.edge('claim', 'crash', '租约异常', points=[(365, 305), (365, 230), (1075, 230)], dashed=True)
d.save('FIG-002-2026-10-25-execution-flow.drawio')

d = Diagram('核心数据关系 · 概念模型', 1450, 1100, '连线标注基数；仅展示主要关系，字段、唯一约束与完整表清单见 DES-002 插件数据契约')
d.node('profile', 'browser_profile\n人工模式 / 登录状态\ncommitted_collection_seq', 40, 150, 300, 90, 'purple')
d.node('plugin', 'plugin_installation\nplugin_id + version / 能力 / Schema', 40, 345, 300, 90, 'purple')
d.node('task', 'task\n插件版本 / 档案 / 参数\n本地时间 / 时区 / 下一次时间', 460, 150, 300, 110)
d.node('baseline', 'task_baseline\n任务 + scope_key 唯一\n最近完整采集基线', 920, 150, 330, 110, 'green')
d.node('run', 'task_run\n计划执行唯一 / 状态 / 阶段\nattempt / 租约 / fencing token', 460, 345, 300, 110)
d.node('submission', 'collection / run_submission / run_attempt\n采集序号 / 不可变收据 / 过期归档\n每次尝试的错误与证据', 920, 345, 330, 110)
d.node('action', 'action_execution\n档案 + 插件 + 操作 + 业务日期唯一\n意图 / 点击中 / 核验 / 未知', 40, 550, 300, 120, 'orange')
d.node('entity', 'entity → entity_version\n来源 + 档案 + 类型 + 来源键\n当前内容指纹 / 变化版本历史', 460, 550, 300, 120, 'green')
d.node('event', 'change_event\n每个新版本对应唯一事件\n新增 / 重要字段变化', 920, 550, 330, 120, 'green')
d.node('notification', 'notification / outbox\n站内记录 + 事务待发送事件\n通知去重 / 已读状态', 920, 770, 330, 120, 'purple')
d.node('delivery', 'push_delivery\n通知 + 设备订阅唯一\n接受 / 重试 / 永久失败', 460, 770, 300, 120, 'purple')
d.node('subscription', 'push_subscription\n个人账号 / 多设备\nendpoint 唯一 / 公钥与认证信息', 40, 770, 300, 120, 'purple')
d.node('note', '规则：新采集 A→B→A 保留版本；旧结果按档案水位拒绝应用，仅保留归档。\n人工与自动共用档案锁；签到键跨版本稳定；未出现不代表删除。', 40, 970, 1300, 70, text=True, size=16)
d.edge('profile', 'task', '1 : N')
d.edge('plugin', 'task', '1 : N', points=[(390, 390), (390, 205)])
d.edge('task', 'baseline', '1 : N')
d.edge('task', 'run', '1 : N')
d.edge('run', 'submission', '1 : N')
d.edge('run', 'action', '1 : N', points=[(390, 400), (390, 610)])
d.edge('run', 'entity', '采集 / 生成版本')
d.edge('entity', 'event', '版本 1 : 0..1')
d.edge('event', 'notification', '匹配关注规则')
d.edge('notification', 'delivery', '1 : N')
d.edge('subscription', 'delivery', '1 : N')
d.save('FIG-003-2026-10-25-data-model.drawio')
