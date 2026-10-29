"""检查文档工具的回归测试；只在系统临时目录生成合成文档。"""
from contextlib import redirect_stdout
from datetime import date, timedelta
import importlib.util
from io import StringIO
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('docs_checker', Path(__file__).with_name('check-docs.py'))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class DocumentationTests(unittest.TestCase):
    def figure_result(self, stamp, preview=True):
        with tempfile.TemporaryDirectory(prefix='page-gather-doc-check-') as temp:
            root = Path(temp)
            folder = root / 'docs/07-diagrams'
            folder.mkdir(parents=True)
            name = f'FIG-001-{stamp}-synthetic.drawio'
            (folder / name).write_text('<mxGraphModel/>', encoding='utf-8')
            if preview:
                (folder / (name + '.png')).write_bytes(b'synthetic-preview-only')
            (root / 'docs/README.md').write_text(name, encoding='utf-8')
            output = StringIO()
            with patch.object(checker, 'ROOT', root), patch.object(checker.subprocess, 'check_output', return_value=b''), redirect_stdout(output):
                result = checker.main()
            return result, output.getvalue()

    def test_invalid_calendar_date_is_rejected(self):
        failed, output = self.figure_result('2026-99-99')
        self.assertTrue(failed)
        self.assertIn('图形建立日期无效', output)

    def test_future_date_is_rejected(self):
        failed, output = self.figure_result((date.today() + timedelta(days=1)).isoformat())
        self.assertTrue(failed)
        self.assertIn('晚于今天', output)

    def test_reported_future_regression(self):
        if date.today() >= date(2099, 10, 25):
            self.skipTest('固定历史复现值不再位于未来，动态未来日期用例仍有效')
        failed, _ = self.figure_result('2099-10-25')
        self.assertTrue(failed)

    def test_valid_pair_is_accepted(self):
        failed, _ = self.figure_result(date.today().isoformat())
        self.assertFalse(failed)

    def test_missing_preview_is_rejected(self):
        failed, output = self.figure_result(date.today().isoformat(), preview=False)
        self.assertTrue(failed)
        self.assertIn('缺少预览', output)

    def test_headings_and_fences(self):
        text = '# 执行计划\n## 6.3 多步骤插件：OPEN续采\n## 重复\n## 重复\n```md\n# 不是真标题\n```\n'
        self.assertEqual(checker.anchors(text), {'执行计划', '63-多步骤插件open续采', '重复', '重复-1'})


if __name__ == '__main__':
    unittest.main()
