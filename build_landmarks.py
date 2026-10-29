# =====================================================================
# 既定のマイマップ（data/landmark_presets.js）の KML を取り込んで、data/landmarks_kml.js に保存する
#
#   index.html をダブルクリックで開いたとき（file://）は、ブラウザから Google のマイマップを読めないので、
#   ここで取り込んだ KML を使う。マイマップを編集したら、もう一度実行する。
#   （python serve.py で開いているときは、サーバー経由で最新のマイマップを読む）
#
#   出力: data/landmarks_kml.js … window.LANDMARK_KML = { <mid>: { fetchedAt, kml } }
#
# 使い方（Python 3。追加パッケージ不要）
#   python build_landmarks.py
# =====================================================================

import json
import os
import re
from datetime import datetime, timezone

from serve import fetch_kml   # serve.py と同じ取り方（Google マイマップの KML）

ROOT = os.path.dirname(os.path.abspath(__file__))
PRESETS = os.path.join(ROOT, 'data', 'landmark_presets.js')
OUT_FILE = os.path.join(ROOT, 'data', 'landmarks_kml.js')


def main():
    text = open(PRESETS, encoding='utf-8').read()
    text = re.sub(r'^\s*//.*$', '', text, flags=re.M)   # コメント（例の行）は読まない
    mids = list(dict.fromkeys(re.findall(r'[?&]mid=([A-Za-z0-9_-]{10,100})', text)))
    if not mids:
        print(f'{PRESETS} にマイマップの URL がありません')
    out = {}
    for mid in mids:
        status, body = fetch_kml(mid)
        kml = body.decode('utf-8', errors='replace')
        if status != 200 or '<kml' not in kml[:2000]:
            print(f'× {mid}: 読めませんでした（HTTP {status}）。「リンクを知っている全員が閲覧可」で共有されているか確認してください')
            continue
        name = re.search(r'<Document>\s*<name>(.*?)</name>', kml, re.S)
        count = kml.count('<Point>')
        print(f'○ {mid}: {name.group(1).strip() if name else "（名前なし）"}（地点 {count} 件）')
        out[mid] = {'fetchedAt': datetime.now(timezone.utc).isoformat(), 'kml': kml}
    body = (f'// {datetime.now(timezone.utc).isoformat()} に build_landmarks.py で生成\n'
            f'window.LANDMARK_KML = {json.dumps(out, ensure_ascii=False)};\n')
    with open(OUT_FILE, 'w', encoding='utf-8') as fp:
        fp.write(body)
    print(f'出力: {OUT_FILE}')


if __name__ == '__main__':
    main()
