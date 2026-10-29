# =====================================================================
# みなとみらい線（横浜〜元町・中華街）の運賃・時刻表データを作る
#
#   入力: 横浜高速鉄道の各駅ページ（https://www.mm21railway.co.jp/sp/station/）
#           時刻表 PDF … /station/timestable/<駅>/pdf/<駅>_timeschedule.pdf
#           運賃       … /sp/station/<駅>/fare.html（その駅から各駅への普通旅客運賃。IC カードの欄を使う）
#         取得したファイルは mm_pdf/・mm_html/ に保存し、次回からはそれを使う（取り直すときは消す）
#   出力: data/minatomirai.js … window.MINATOMIRAI = { stations, fares, trains }
#
#   時刻表 PDF の数字は文字ではなく図形なので、図形の形（パスの命令の並び）で数字を読み、
#   色で種別を見分ける（黒: 各停、赤: 急行、橙: 特急・通勤特急・Fライナー特急、青: S-TRAIN）。
#   1 ページに「元町・中華街方面」「横浜方面」の表が上下に並び、それぞれ左半分が平日。
#   隣の駅の発車とつないで列車にする（build_seaside.py と同じ考え方）。
#   S-TRAIN は座席指定券が要るので使わない。
#
# 使い方（Python 3 + PyMuPDF）
#   python build_minatomirai.py
# =====================================================================

import json
import os
import re
import subprocess
import time
import urllib.request
from datetime import datetime, timezone

import pymupdf

ROOT = os.path.dirname(os.path.abspath(__file__))
PDF_DIR = os.path.join(ROOT, 'mm_pdf')
HTML_DIR = os.path.join(ROOT, 'mm_html')
OUT_FILE = os.path.join(ROOT, 'data', 'minatomirai.js')
SITE = 'https://www.mm21railway.co.jp'
USER_AGENT = 'distortMap-data-collector/1.0 (personal, low-frequency)'
REQUEST_INTERVAL_SEC = 2

# 横浜 → 元町・中華街 の順: (駅名（network.js の表記）, 時刻表 PDF の名前, 駅ページの名前, PDF にある表の向き)
#   down = 元町・中華街方面、up = 横浜方面。終点の駅には片方の表しかない
STATIONS = [
    ('横浜', 'yokohama', 'yokohama', ['down']),
    ('新高島', 'shintakashima', 'shintakashima', ['down', 'up']),
    ('みなとみらい', 'minatomirai', 'minatomirai', ['down', 'up']),
    ('馬車道', 'bashamichi', 'basyamichi', ['down', 'up']),
    ('日本大通り', 'nihonodori', 'nihonodori', ['down', 'up']),
    ('元町・中華街', 'motomachichukagai', 'motomachi', ['up']),
]
NAMES = [s[0] for s in STATIONS]

DIGITS = {
    'cclcclclcclc': 0, 'lclclll': 1, 'llcccclccccllll': 2, 'clccclcccllccccc': 3, 'llllllllllllll': 4,
    'clccccllllllccc': 5, 'ccccclcclcclccc': 6, 'lllllll': 7, 'cccccccccccccccc': 8, 'ccccclcclcccclc': 9,
}
TYPE_COLORS = {
    'local': (0.13, 0.09, 0.08),     # 各停（黒）
    'express': (0.90, 0.0, 0.07),    # 急行（赤）
    'limited': (0.94, 0.51, 0.0),    # 特急・通勤特急・Fライナー特急（橙）
    'strain': (0.0, 0.63, 0.91),     # S-TRAIN（青）
    'hour': (1.0, 1.0, 1.0),         # 時（青地に白抜き）
}
FIRST_HOUR = 4


def color_type(fill):
    name, c = min(TYPE_COLORS.items(), key=lambda kv: sum((a - b) ** 2 for a, b in zip(fill, kv[1])))
    return name if sum((a - b) ** 2 for a, b in zip(fill, c)) < 0.01 else None


# --- 取得 ---------------------------------------------------------------
def fetch(url, path):
    if not os.path.exists(path):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as res:
                body = res.read()
        except urllib.error.URLError:
            # Python の証明書ストアで TLS 検証に失敗する環境では、OS の curl で取る
            body = subprocess.run(['curl', '-sfL', '-A', USER_AGENT, url], capture_output=True, check=True).stdout
        with open(path, 'wb') as fp:
            fp.write(body)
        print(f'  取得: {url}')
        time.sleep(REQUEST_INTERVAL_SEC)
    return path


# --- 時刻表 PDF -----------------------------------------------------------
def read_numbers(page):
    """平日（左側の表）の数字を、隣り合う同じ色の数字ごとにまとめて [{x, x1, y, v, kind}] で返す"""
    W = page.rect.width
    glyphs = []
    for x in page.get_drawings():
        fl = x.get('fill')
        if x['type'] != 'f' or not fl:
            continue
        sig = ''.join(i[0] for i in x['items'])
        kind = color_type(fl) if sig in DIGITS else None
        if kind:
            glyphs.append((x['rect'], DIGITS[sig], kind))
    # 数字の高さ（最も多いもの）より極端に小さい図形は数字ではない（記号の一部など）
    hs = sorted(round(g[0].height, 1) for g in glyphs)
    h = hs[len(hs) // 2]
    glyphs = [g for g in glyphs if abs(g[0].height - h) < h * 0.15]
    # 平日の表は中央線を少し越えることがあるので、土曜・休日の表の「時」の列の手前までを平日とする
    right_hours = [g[0].x0 for g in glyphs if g[2] == 'hour' and g[0].x0 > W * 0.4]
    split = min(right_hours) - h * 0.5 if right_hours else W / 2
    glyphs = [g for g in glyphs if g[0].x0 < split]
    # 行ごとにまとめる（y の中心が近いものを同じ行に。丸めで分けると行の途中で切れることがある）
    glyphs.sort(key=lambda g: (g[0].y0 + g[0].y1) / 2)
    lines, top = [], None
    for g in glyphs:
        yc = (g[0].y0 + g[0].y1) / 2
        if top is None or yc - top > h * 0.3:
            lines.append([])
            top = yc
        lines[-1].append(g)
    glyphs = [g for line in lines for g in sorted(line, key=lambda g: g[0].x0)]
    nums = []
    for r, d, kind in glyphs:
        yc = (r.y0 + r.y1) / 2
        last = nums[-1] if nums else None
        if last and last['kind'] == kind and abs(last['y'] - yc) < h * 0.3 and 0 <= r.x0 - last['x1'] < h * 0.35:
            last['v'] = last['v'] * 10 + d
            last['x1'] = r.x1
        else:
            nums.append({'x': r.x0, 'x1': r.x1, 'y': yc, 'v': d, 'kind': kind})
    return nums, h


def parse_pdf(path, directions):
    """{ 向き: [(時刻(分), 種別)] }。時の数字（白抜き）の並びで表を分ける"""
    nums, h = read_numbers(pymupdf.open(path)[0])
    hours = sorted((n for n in nums if n['kind'] == 'hour'), key=lambda n: n['y'])
    # 時が 4 から始まるたびに新しい表
    tables, cur = [], None
    for n in hours:
        if n['v'] == FIRST_HOUR:
            cur = []
            tables.append(cur)
        if cur is None or (cur and n['v'] != cur[-1]['v'] + 1):
            raise ValueError(f'{path}: 時の並びが想定外です（{n["v"]}）')
        cur.append(n)
    if len(tables) != len(directions):
        raise ValueError(f'{path}: 表の数が想定外です: {len(tables)}')
    result = {}
    for d, rows in zip(directions, tables):
        deps = []
        for row in rows:
            for n in nums:
                if n['kind'] != 'hour' and abs(n['y'] - row['y']) < h * 0.4 and n['x'] > row['x1']:
                    if n['v'] > 59:
                        raise ValueError(f'{path}: {row["v"]}時台に 59 を超える分: {n["v"]}')
                    t = row['v'] * 60 + n['v']
                    deps.append((t if row['v'] >= FIRST_HOUR else t + 24 * 60, n['kind']))
        result[d] = sorted(deps)
    return result


def local_run_times(tables, order, d):
    """各停の隣の駅までの所要時間（分）の中央値。order は進む向きの駅番号の並び"""
    runs = {}
    for a, b in zip(order, order[1:]):
        if d not in tables[NAMES[a]] or d not in tables[NAMES[b]]:
            continue
        nb = [t for t, k in tables[NAMES[b]][d] if k == 'local']
        diffs = sorted(min((tb - ta for tb in nb if 0 < tb - ta <= 6), default=None) or 99
                       for ta, k in tables[NAMES[a]][d] if k == 'local')
        diffs = [x for x in diffs if x < 99]
        runs[(a, b)] = diffs[len(diffs) // 2]
    return runs


def build_trains(tables):
    """発車時刻を、同じ種別の次の停車駅の発車とつないで列車にする。戻り値: [(種別, [(駅番号, 時刻)])]
    各停以外は通過駅があるので、先の駅へ順に探す（予想時刻 = 各停の所要時間の合計、少し早くてもよい）。
    終点（元町・中華街行きの元町・中華街、横浜方面の横浜）は表がないので、到着時刻は各停の所要時間から決める"""
    trains = []
    for d, order in (('down', list(range(len(NAMES)))), ('up', list(range(len(NAMES) - 1, -1, -1)))):
        runs = local_run_times(tables, order, d)
        # 終点の手前の区間は表がないので、反対向きの所要時間を使う
        back = local_run_times(tables, order[::-1], 'down' if d == 'up' else 'up')
        for (a, b), r in back.items():
            runs.setdefault((b, a), r)
        used = {i: set() for i in order}
        deps = {i: tables[NAMES[i]].get(d, []) for i in order}
        for si, start in enumerate(order):
            for idx, (t0, kind) in enumerate(deps[start]):
                if idx in used[start]:
                    continue
                stops, cur, ct = [(start, t0)], si, t0
                while cur + 1 < len(order):
                    found, run = None, 0
                    for nj in range(cur + 1, len(order)):
                        run += runs[(order[nj - 1], order[nj])]
                        st = order[nj]
                        if not deps[st]:                      # 終点（表なし）
                            found = (nj, ct + run, None)
                            break
                        cands = [(abs(t - (ct + run)), j, t) for j, (t, k) in enumerate(deps[st])
                                 if k == kind and j not in used[st] and ct + run - 2 <= t <= ct + run + 2]
                        if cands:
                            _, j, t = min(cands)
                            found = (nj, t, j)
                            break
                        if kind == 'local':
                            break                             # 各停は通過しない
                    if not found:
                        break
                    nj, t, j = found
                    if j is not None:
                        used[order[nj]].add(j)
                    stops.append((order[nj], t))
                    cur, ct = nj, t
                    if j is None:
                        break
                if len(stops) >= 2:
                    trains.append((kind, stops))
    return trains


# --- 運賃（各駅の運賃ページ） ----------------------------------------------
def read_fares():
    fares = {}
    for name, _, slug, _ in STATIONS:
        path = fetch(f'{SITE}/sp/station/{slug}/fare.html', os.path.join(HTML_DIR, slug + '_fare.html'))
        page = open(path, encoding='utf-8').read()
        table = page[page.find('<table'):page.find('</table>')]   # 最初の表が普通旅客運賃
        for row in re.findall(r'<tr>(.*?)</tr>', table, re.S):
            cells = [re.sub(r'<[^>]+>', '', c).strip() for c in re.findall(r'<t[hd][^>]*>(.*?)</t[hd]>', row, re.S)]
            if len(cells) != 4 or not cells[3].isdigit():
                continue
            to = cells[0].removesuffix('駅').replace('･', '・')
            if to not in NAMES:
                raise ValueError(f'運賃表の駅名が想定外です: {cells[0]}')
            key = '|'.join(sorted([name, to]))
            if key in fares and fares[key] != int(cells[3]):
                raise ValueError(f'{key} の運賃が駅によって違います: {fares[key]} / {cells[3]}')
            fares[key] = int(cells[3])   # IC カード
    n = len(NAMES)
    if len(fares) != n * (n - 1) // 2:
        raise ValueError(f'運賃の区間数が想定外です: {len(fares)}')
    return fares


def main():
    os.makedirs(PDF_DIR, exist_ok=True)
    os.makedirs(HTML_DIR, exist_ok=True)
    tables = {}
    for name, pdf, _, dirs in STATIONS:
        path = fetch(f'{SITE}/station/timestable/{pdf}/pdf/{pdf}_timeschedule.pdf', os.path.join(PDF_DIR, pdf + '.pdf'))
        tables[name] = parse_pdf(path, dirs)
    trains = [(k, s) for k, s in build_trains(tables) if k != 'strain']   # S-TRAIN は座席指定券が要る
    fares = read_fares()

    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'source': '横浜高速鉄道 みなとみらい線 各駅の時刻表 PDF（平日）・各駅の運賃（IC カード）',
        'stations': NAMES,
        'fares': fares,
        # 列車: [種別, [駅番号, 時刻(分), 駅番号, 時刻(分), ...]]（最後の駅だけ到着時刻）
        'trains': [[kind, [v for s in stops for v in s]] for kind, stops in trains],
    }
    body = (f'// {out["generatedAt"]} に build_minatomirai.py で生成\n'
            f'window.MINATOMIRAI = {json.dumps(out, ensure_ascii=False, separators=(",", ":"))};\n')
    with open(OUT_FILE, 'w', encoding='utf-8') as fp:
        fp.write(body)
    deps = sum(len(v) for t in tables.values() for v in t.values())
    kinds = {}
    for k, _ in trains:
        kinds[k] = kinds.get(k, 0) + 1
    print(f'時刻表: 発車 {deps} 本 → 列車 {len(trains)} 本 {kinds}')
    print(f'運賃: {len(fares)} 区間')
    print(f'出力: {OUT_FILE}')


if __name__ == '__main__':
    main()
