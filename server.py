"""词迹：本地静态服务 + RSS/网页正文转发 + OpenAI 兼容翻译转发。
仅使用 Python 标准库，便于在一台没有 Node/构建工具的机器上直接运行。
"""
import gzip
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'app')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')
BLOCK = re.compile(r'(^|\.)(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)')


def http_get(url, timeout=20, max_bytes=6 * 1024 * 1024):
    host = urllib.parse.urlparse(url).hostname or ''
    if BLOCK.search(host):
        raise ValueError('不允许访问该地址')
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        ctype = r.headers.get('Content-Type', '')
        raw = r.read(max_bytes)
    return raw, ctype


MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
}
GZ_CACHE = {}


def gz_body(path):
    if path not in GZ_CACHE:
        GZ_CACHE[path] = gzip.compress(open(path, 'rb').read(), 6)
    return GZ_CACHE[path]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/fetch':
            q = urllib.parse.parse_qs(parsed.query)
            url = (q.get('url') or [''])[0]
            if not url:
                return self._json(400, {'error': '缺少 url'})
            try:
                raw, ctype = http_get(url)
                body = raw.decode('utf-8', 'replace')
                self.send_response(200)
                self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.send_header('X-Upstream-Type', ctype[:120])
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Length', str(len(body.encode('utf-8'))))
                self.end_headers()
                self.wfile.write(body.encode('utf-8'))
            except Exception as e:
                return self._json(502, {'error': '抓取失败：%s' % e})
            return
        # 静态文件：支持 gzip，减少手机首屏流量
        rel = urllib.parse.unquote(parsed.path.lstrip('/')) or 'index.html'
        rel = os.path.normpath(rel)
        if '..' in rel:
            return self._json(404, {'error': 'not found'})
        fp = os.path.join(ROOT, rel)
        if not os.path.isfile(fp):
            if not parsed.path.endswith(('.js', '.css', '.png', '.json')):
                fp = os.path.join(ROOT, 'index.html')
            else:
                self.send_error(404)
                return
        ext = os.path.splitext(fp)[1].lower()
        body = open(fp, 'rb').read()
        use_gz = ext in ('.html', '.js', '.css', '.json', '.svg', '.txt') and 'gzip' in self.headers.get('Accept-Encoding', '')
        if use_gz:
            body = gz_body(fp)
        self.send_response(200)
        self.send_header('Content-Type', MIME.get(ext, 'application/octet-stream'))
        if use_gz:
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Vary', 'Accept-Encoding')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache' if ext == '.html' or os.path.basename(fp) in ('sw.js', 'manifest.json') else 'public, max-age=86400')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_HEAD(self):
        return self.do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != '/api/translate':
            return self._json(404, {'error': 'not found'})
        try:
            n = int(self.headers.get('Content-Length') or 0)
            data = json.loads(self.rfile.read(min(n, 2 * 1024 * 1024)) or b'{}')
        except Exception as e:
            return self._json(400, {'error': '请求体解析失败：%s' % e})

        base = (data.get('baseURL') or '').rstrip('/')
        key = data.get('key') or ''
        model = data.get('model') or ''
        texts = data.get('texts') or []
        if not (base and key and model and texts):
            return self._json(400, {'error': '翻译参数不完整'})

        out = []
        try:
            for text in texts:
                payload = {
                    'model': model,
                    'messages': [
                        {'role': 'system', 'content': 'You are a translation engine. Translate the English text into fluent, natural Simplified Chinese. Keep paragraph meaning; no explanations, no quotes, output Chinese only.'},
                        {'role': 'user', 'content': text},
                    ],
                    'temperature': 0.3,
                }
                req = urllib.request.Request(
                    base + '/chat/completions',
                    data=json.dumps(payload).encode('utf-8'),
                    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key},
                    method='POST',
                )
                with urllib.request.urlopen(req, timeout=60) as r:
                    j = json.loads(r.read().decode('utf-8', 'replace'))
                msg = (j.get('choices') or [{}])[0].get('message') or {}
                out.append((msg.get('content') or '').strip())
            return self._json(200, {'texts': out})
        except Exception as e:
            return self._json(502, {'error': '翻译接口调用失败：%s' % e})


if __name__ == '__main__':
    os.chdir(ROOT)
    print('词迹 serving on http://localhost:%d' % PORT)
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
