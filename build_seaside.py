# =====================================================================
# 金沢シーサイドラインの運賃・時刻表データを作る
#
#   入力: seaside_pdf/commuter_pass_normal1.pdf … 普通旅客運賃表（大人・IC運賃）・営業キロ程表
#           https://www.seasideline.co.jp/fare_ticket/document/commuter_pass_normal1.pdf
#         各駅の時刻表ページ（平日）
#           https://www.seasideline.co.jp/station_guide/time_table/<駅>.html
#           取得したページは seaside_html/ に保存し、次回からはそれを使う（取り直すときは消す）
#   出力: data/seaside.js … window.SEASIDE = { stations, fares, trains }
#
#   シーサイドラインは全列車が各駅に停まり、追い越しもないので、
#   ある駅の発車を「隣の駅で、駅間の運転時分（目安）だけ後の発車」とつないで列車を作る。
#   「●」の付いた列車は並木中央止まり。
#
# 使い方（Python 3 + PyMuPDF）
#   python build_seaside.py
# =====================================================================

import json
import os
import re
import time
import urllib.request
from datetime import datetime, timezone

import pymupdf

ROOT = os.path.dirname(os.path.abspath(__file__))
FARE_PDF = os.path.join(ROOT, 'seaside_pdf', 'commuter_pass_normal1.pdf')
HTML_DIR = os.path.join(ROOT, 'seaside_html')
OUT_FILE = os.path.join(ROOT, 'data', 'seaside.js')
BASE_URL = 'https://www.seasideline.co.jp/station_guide/time_table/{}.html'
USER_AGENT = 'distortMap-data-collector/1.0 (personal, low-frequency)'
REQUEST_INTERVAL_SEC = 2

# 新杉田 → 金沢八景 の順（駅名は data/network.js と同じ表記）
STATIONS = [
    ('新杉田', 'shin_sugita'), ('南部市場', 'nambu_shijyo'), ('鳥浜', 'torihama'),
    ('並木北', 'namiki_kita'), ('並木中央', 'namiki_chuo'), ('幸浦', 'sachiura'),
    ('産業振興センター', 'sangyo_shinko_center'), ('福浦', 'fukuura'), ('市大医学部', 'shidai_igakubu'),
    ('八景島', 'hakkei_jima'), ('海の公園柴口', 'umino_koen_shibaguchi'),
    ('海の公園南口', 'umino_koen_minamiguchi'), ('野島公園', 'nojima_koen'), ('金沢八景', 'kanazawa_hakkei'),
]
NAMES = [n for n, _ in STATIONS]
TURNBACK = NAMES.index('並木中央')   # 「●」の列車の終点


# --- 時刻表ページ -------------------------------------------------------
def fetch_pages():
    os.makedirs(HTML_DIR, exist_ok=True)
    pages = {}
    for name, slug in STATIONS:
        path = os.path.join(HTML_DIR, slug + '.html')
        if not os.path.exists(path):
            req = urllib.request.Request(BASE_URL.format(slug), headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as res:
                body = res.read().decode('utf-8')
            with open(path, 'w', encoding='utf-8') as fp:
                fp.write(body)
            print(f'  取得: {name}')
            time.sleep(REQUEST_INTERVAL_SEC)
        pages[name] = open(path, encoding='utf-8').read()
    return pages


def parse_weekday(html):
    """平日の表から { 'up': [(分, 並木中央止まり?)], 'down': [...] } を返す（上り = 新杉田方面）"""
    m = re.search(r'<table id="weekday">(.*?)</table>', html, re.S)
    if not m:
        raise ValueError('平日の時刻表が見つかりません')
    result = {'up': [], 'down': []}
    for row in re.findall(r'<tr>(.*?)</tr>', m.group(1), re.S):
        cells = re.findall(r'<td class="([^"]*)">(.*?)</td>', row, re.S)
        if len(cells) != 4 or 'time' not in cells[0][0] or not cells[0][1].strip().isdigit():
            continue
        for (_, hour), (_, mins), key in ((cells[0], cells[1], 'up'), (cells[2], cells[3], 'down')):
            h = int(hour)
            text = re.sub(r'<[^>]+>', ' ', mins)
            for mm, mark in re.findall(r'(\d{1,2})\s*(●?)', text):
                result[key].append(((h if h >= 4 else h + 24) * 60 + int(mm), bool(mark)))
    for k in result:
        result[k].sort()
    return result


def parse_run_times(html):
    """ページ内の「各駅間の運転時分（目安）」: 新杉田側から順に 13 区間の分数"""
    i = html.find('運転時分')
    text = re.sub(r'<[^>]+>', ' ', html[i:i + 6000])
    mins = [int(x) for x in re.findall(r'(\d+)分', text)][:len(NAMES) - 1]
    if len(mins) != len(NAMES) - 1:
        raise ValueError(f'駅間の運転時分が読み取れません: {mins}')
    return mins


def build_trains(tables, run):
    """隣の駅の発車とつないで列車にする。戻り値: [[(駅番号, 時刻)], ...]"""
    used = {(n, d): set() for n in range(len(NAMES)) for d in ('up', 'down')}
    trains = []
    for d, step in (('down', 1), ('up', -1)):
        order = range(len(NAMES)) if step > 0 else range(len(NAMES) - 1, -1, -1)
        for start in order:
            for i, (t, short) in enumerate(tables[NAMES[start]][d]):
                if i in used[(start, d)]:
                    continue   # 前の駅からつながっている
                stops = [(start, t)]
                cur, ct, ci = start, t, i
                while True:
                    nxt = cur + step
                    if nxt < 0 or nxt >= len(NAMES):
                        break
                    r = run[min(cur, nxt)]
                    if short and nxt == TURNBACK:
                        stops.append((nxt, ct + r))   # 並木中央止まり
                        break
                    cands = [(abs(tn - (ct + r)), j, tn) for j, (tn, _) in enumerate(tables[NAMES[nxt]][d])
                             if ct <= tn <= ct + r + 3 and j not in used[(nxt, d)]]
                    if not cands:
                        stops.append((nxt, ct + r))   # 終点（到着時刻は運転時分から）
                        break
                    _, j, tn = min(cands)
                    used[(nxt, d)].add(j)
                    stops.append((nxt, tn))
                    cur, ct, ci = nxt, tn, j
                    short = tables[NAMES[nxt]][d][j][1]
                if len(stops) >= 2:
                    trains.append(stops)
    return trains


# --- 運賃表（PDF） -------------------------------------------------------
def read_fares():
    """テキストは「駅名, その駅から先の駅への運賃…, 次の駅の営業キロ…, 次の駅名…」の順に並ぶ"""
    text = pymupdf.open(FARE_PDF)[0].get_text()
    tokens = text.split()
    nums = [t for t in tokens if re.fullmatch(r'\d+(\.\d+)?', t)]
    fares, k = {}, 0
    for i in range(len(NAMES)):
        # 前の駅までの営業キロ（i 個）を読み飛ばし、先の駅への運賃（N-1-i 個）を読む
        km = nums[k:k + i]
        if any('.' not in x for x in km):
            raise ValueError(f'運賃表の並びが想定外です（{NAMES[i]} の営業キロ）: {km}')
        k += i
        row = nums[k:k + len(NAMES) - 1 - i]
        if any('.' in x for x in row):
            raise ValueError(f'運賃表の並びが想定外です（{NAMES[i]} の運賃）: {row}')
        k += len(row)
        for j, v in enumerate(row):
            fares['|'.join(sorted([NAMES[i], NAMES[i + 1 + j]]))] = int(v)
    return fares


def main():
    pages = fetch_pages()
    tables = {name: parse_weekday(pages[name]) for name in NAMES}
    run = parse_run_times(pages[NAMES[0]])
    trains = build_trains(tables, run)
    fares = read_fares()

    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'source': '横浜シーサイドライン 普通旅客運賃表（大人・IC運賃）・各駅時刻表（平日）',
        'stations': NAMES,
        'fares': fares,
        # 列車: [種別, [駅番号, 時刻(分), 駅番号, 時刻(分), ...]]（最後の駅だけ到着時刻）
        'trains': [['local', [v for s in stops for v in s]] for stops in trains],
    }
    body = (f'// {out["generatedAt"]} に build_seaside.py で生成\n'
            f'window.SEASIDE = {json.dumps(out, ensure_ascii=False, separators=(",", ":"))};\n')
    with open(OUT_FILE, 'w', encoding='utf-8') as fp:
        fp.write(body)
    deps = sum(len(t[d]) for t in tables.values() for d in ('up', 'down'))
    print(f'運賃: {len(fares)} 区間')
    print(f'時刻表: 発車 {deps} 本 → 列車 {len(trains)} 本（駅間の運転時分: {run}）')
    print(f'出力: {OUT_FILE}')


if __name__ == '__main__':
    main()
