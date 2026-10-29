# =====================================================================
# 時間地図・運賃地図の表示用サーバー（python -m http.server の代わり）
#
#   python serve.py [ポート番号]      … 既定は 8090。http://localhost:8090/ を開く
#
#   静的ファイルを配るのに加え、Google マイマップの KML を取り次ぐ:
#     /mymaps-kml?mid=<マイマップの ID>
#       → https://www.google.com/maps/d/kml?mid=<ID>&forcekml=1 を取りに行って返す
#   ブラウザから google.com を直接読むことはできない（CORS）ので、ここで代わりに取る。
#   マイマップは「リンクを知っている全員が閲覧可」で共有しておく必要がある。
#   取りに行く先はマイマップの KML に固定し、ID は英数字・-・_ だけ受け付ける。
#
#   ついでに、すべての応答に Cache-Control: no-cache を付ける（データを作り直したとき古いファイルが使われないように）
# =====================================================================

import http.server
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

KML_URL = 'https://www.google.com/maps/d/kml?mid={}&forcekml=1'
USER_AGENT = 'distortMap/1.0 (personal)'
MID_RE = re.compile(r'[A-Za-z0-9_-]{10,100}')


def fetch_kml(mid):
    url = KML_URL.format(mid)
    try:
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except urllib.error.URLError:
        # Python の証明書ストアで TLS 検証に失敗する環境では、OS の curl で取る
        r = subprocess.run(['curl', '-sL', '-A', USER_AGENT, '-w', '\n%{http_code}', url], capture_output=True)
        body, _, code = r.stdout.rpartition(b'\n')
        return int(code or 0), body


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        parts = urllib.parse.urlsplit(self.path)
        if parts.path.rstrip('/') == '/mymaps-kml':
            return self.relay_kml(urllib.parse.parse_qs(parts.query).get('mid', [''])[0])
        return super().do_GET()

    def relay_kml(self, mid):
        if not MID_RE.fullmatch(mid):
            return self.reply(400, 'マイマップの ID（mid）が正しくありません')
        status, body = fetch_kml(mid)
        if status == 200 and b'<kml' in body[:2000]:
            return self.reply(200, body, 'application/vnd.google-earth.kml+xml; charset=utf-8')
        if status in (200, 401, 403) or 300 <= status < 400:
            # 共有されていない地図はログイン画面（HTML）などが返る
            return self.reply(403, 'マイマップを読めませんでした。「リンクを知っている全員が閲覧可」で共有されているか確認してください')
        if status == 404:
            return self.reply(404, 'マイマップが見つかりません。URL を確認してください')
        return self.reply(502, f'マイマップの取得に失敗しました（HTTP {status}）')

    def reply(self, status, body, ctype='text/plain; charset=utf-8'):
        data = body if isinstance(body, bytes) else body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'http://localhost:{port}/ で表示できます（Ctrl+C で終了）')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
