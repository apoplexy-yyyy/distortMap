# =====================================================================
# 相鉄線（本線 横浜〜海老名・いずみ野線 二俣川〜湘南台・相鉄新横浜線 西谷〜新横浜）の運賃・時刻表データを作る
#
#   入力: 相鉄「駅・時刻表」https://www.sotetsu.co.jp/train/stations/ にある列車時刻表 PDF（平日ダイヤ 上り・下り）
#         相鉄「運賃表」https://www.sotetsu.co.jp/train/fare/ にある普通旅客運賃表（大人）PDF
#         どちらもページのリンクから PDF の URL を探す（ダイヤ改正で URL が変わっても追える）
#         取得したファイルは sotetsu_html/・sotetsu_pdf/ に保存し、次回からはそれを使う（取り直すときは消す）
#   出力: data/sotetsu.js … window.SOTETSU = { stations, fares, trains }
#
#   列車時刻表 PDF は文字として読めるので、左の駅名の行と上の列車番号の列から、各時刻がどの列車の
#   どの駅かを決める。1 列が 1 本の列車なので、列の時刻を時刻順に並べればそのまま列車になる。
#   相鉄線の外（JR・東急への直通区間）の駅は使わない。
#   運賃表は三角形の表で、右上が IC カード運賃、左下がきっぷ運賃。右上を使う。
#
# 使い方（Python 3 + PyMuPDF）
#   python build_sotetsu.py
# =====================================================================

import json
import os
import re
import sys
from datetime import datetime, timezone

import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_minatomirai import fetch   # 取得して保存したファイルのパスを返す

ROOT = os.path.dirname(os.path.abspath(__file__))
HTML_DIR = os.path.join(ROOT, 'sotetsu_html')
PDF_DIR = os.path.join(ROOT, 'sotetsu_pdf')
OUT_FILE = os.path.join(ROOT, 'data', 'sotetsu.js')
SITE = 'https://www.sotetsu.co.jp'
TIMETABLE_LINKS = ['平日ダイヤ 上り', '平日ダイヤ 下り']   # 駅・時刻表ページのリンクの文字
FARE_LINK = '普通旅客運賃表（大人）'

# 運賃表の対角線の駅の並び（network.js の表記）
STATIONS = ['横浜', '平沼橋', '西横浜', '天王町', '星川', '和田町', '上星川', '西谷', '鶴ヶ峰', '二俣川',
            '希望ヶ丘', '三ツ境', '瀬谷', '大和', '相模大塚', 'さがみ野', 'かしわ台', '海老名',
            '南万騎が原', '緑園都市', '弥生台', 'いずみ野', 'いずみ中央', 'ゆめが丘', '湘南台',
            '羽沢横浜国大', '新横浜']
# 相鉄の PDF の表記 → network.js の表記
NAME_FIX = {'鶴ケ峰': '鶴ヶ峰', '希望ケ丘': '希望ヶ丘'}


def pdf_link(page_url, html_name, label):
    """ページの中から、リンクの文字が label で始まる PDF の URL を探して保存し、そのパスを返す"""
    html = open(fetch(page_url, os.path.join(HTML_DIR, html_name)), encoding='utf-8').read()
    for href, text in re.findall(r'<a [^>]*href="([^"]+\.pdf)"[^>]*>(.*?)</a>', html, re.S):
        if re.sub(r'<[^>]+>|\s+', ' ', text).strip().startswith(label):
            return fetch(href, os.path.join(PDF_DIR, href.rsplit('/', 1)[-1]))
    raise ValueError(f'{page_url} に「{label}」の PDF が見つかりません')


def spans_of(page):
    out = []
    for b in page.get_text('dict')['blocks']:
        for line in b.get('lines', []):
            for s in line['spans']:
                t = s['text'].strip()
                if t:
                    x0, y0, x1, y1 = s['bbox']
                    out.append({'t': t, 'x0': x0, 'x1': x1, 'y0': y0, 'y1': y1})
    return out


# --- 列車時刻表 -------------------------------------------------------------
def parse_timetable(path):
    """[(種別, [(駅番号, 時刻(分)), ...])]"""
    trains = []
    for page in pymupdf.open(path):
        spans = spans_of(page)
        head = next((s for s in spans if s['t'] == '列車番号'), None)
        if not head:
            continue
        label_x1 = head['x1'] + 15   # 左の駅名の列の右端（「着」「発」の文字まで）
        # 列: 列車番号の行にある番号の x の中央
        cols = sorted((s['x0'] + s['x1']) / 2 for s in spans
                      if s['x0'] > label_x1 and abs(s['y0'] - head['y0']) < 3)
        if len(cols) < 2:
            continue
        half = min(b - a for a, b in zip(cols, cols[1:])) / 2
        kinds = {}
        kind_head = next((s for s in spans if s['t'] == '相鉄線内列車種別'), None)
        if kind_head:
            for s in spans:
                if s['x0'] > label_x1 and abs(s['y0'] - kind_head['y0']) < 3:
                    c = min(range(len(cols)), key=lambda i: abs(cols[i] - (s['x0'] + s['x1']) / 2))
                    kinds[c] = s['t']
        # 行: 左の列の駅名（「大」「和」のように分かれている文字は同じ高さのものをつなぐ）
        rows = []
        for s in sorted((s for s in spans if s['x1'] <= label_x1 and s['y0'] > head['y1']), key=lambda s: (s['y0'], s['x0'])):
            if rows and abs(rows[-1]['y0'] - s['y0']) < 2:
                rows[-1]['name'] += s['t']
                rows[-1]['y1'] = max(rows[-1]['y1'], s['y1'])
            else:
                rows.append({'name': s['t'], 'y0': s['y0'], 'y1': s['y1']})
        for r in rows:
            name = re.sub(r'[〃着発\s]', '', r['name'])
            r['st'] = STATIONS.index(NAME_FIX.get(name, name)) if NAME_FIX.get(name, name) in STATIONS else None
            r['empty'] = not name
        # 大きな字の駅（着・発の 2 段）では「着」「発」が別の文字として駅名の上下にあるので、行にしない
        rows = [r for r in rows if not r['empty']]
        # 時刻（3〜4 桁の数字）をマスに割り当てる
        cells = {}
        for s in spans:
            if not re.fullmatch(r'\d{3,4}', s['t']) or s['x0'] <= label_x1 or s['y0'] <= head['y1'] + 60:
                continue
            yc, xc = (s['y0'] + s['y1']) / 2, (s['x0'] + s['x1']) / 2
            row = next((r for r in rows if r['y0'] - 1 <= yc <= r['y1'] + 1), None)
            c = min(range(len(cols)), key=lambda i: abs(cols[i] - xc))
            if not row or row['st'] is None or abs(cols[c] - xc) > half:
                continue
            h, m = int(s['t'][:-2]), int(s['t'][-2:])
            if m > 59:
                raise ValueError(f'{path}: 時刻が読み取れません: {s["t"]}')
            cells.setdefault(c, []).append((h * 60 + m + (24 * 60 if h < 3 else 0), row['st']))
        for c, times in cells.items():
            times.sort()
            stops = []
            for t, st in times:
                if stops and stops[-1][0] == st:
                    stops[-1][2] = t           # 同じ駅の着・発: 発車時刻を残す（到着は [1]）
                else:
                    stops.append([st, t, t])
            if len(stops) < 2:
                continue
            # 途中駅は発車時刻、最後の駅は到着時刻
            seq = [(st, dep) for st, _, dep in stops[:-1]] + [(stops[-1][0], stops[-1][1])]
            trains.append((kinds.get(c, ''), seq))
    return trains


# --- 運賃表 ----------------------------------------------------------------
def parse_fares(path):
    """三角形の表の右上（IC カード運賃）を読む。数字の位置を行・列に分け、行番号 < 列番号のマスを使う"""
    nums = [s for s in spans_of(pymupdf.open(path)[0]) if re.fullmatch(r'\d{3}', s['t'])]

    def clusters(vals):
        vals = sorted(vals)
        out = [[vals[0]]]
        for v in vals[1:]:
            if v - out[-1][-1] > 4:
                out.append([])
            out[-1].append(v)
        return [sum(c) / len(c) for c in out]

    ys = clusters([(s['y0'] + s['y1']) / 2 for s in nums])
    xs = clusters([(s['x0'] + s['x1']) / 2 for s in nums])
    n = len(STATIONS)
    # 駅名のマスが 2 行分の高さなので、数字の行は駅より 1 つ多い（最後の行はきっぷ運賃だけ）。
    # 駅 r から先の駅への IC 運賃は r 行目の、r より右の列にある
    if len(ys) != n + 1 or len(xs) != n:
        raise ValueError(f'運賃表の行・列の数が想定外です: {len(ys)} 行 / {len(xs)} 列')
    fares = {}
    for s in nums:
        r = min(range(len(ys)), key=lambda i: abs(ys[i] - (s['y0'] + s['y1']) / 2))
        c = min(range(n), key=lambda i: abs(xs[i] - (s['x0'] + s['x1']) / 2))
        if r < c:
            fares['|'.join(sorted([STATIONS[r], STATIONS[c]]))] = int(s['t'])
    if len(fares) != n * (n - 1) // 2:
        raise ValueError(f'運賃の区間数が想定外です: {len(fares)}')
    return fares


def main():
    os.makedirs(HTML_DIR, exist_ok=True)
    os.makedirs(PDF_DIR, exist_ok=True)
    trains = []
    for label in TIMETABLE_LINKS:
        got = parse_timetable(pdf_link(f'{SITE}/train/stations/', 'stations.html', label))
        print(f'時刻表（{label}）: 列車 {len(got)} 本')
        trains += got
    fares = parse_fares(pdf_link(f'{SITE}/train/fare/', 'fare.html', FARE_LINK))

    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'source': '相鉄 列車時刻表 PDF（平日）・普通旅客運賃表（IC カード）',
        'stations': STATIONS,
        'fares': fares,
        # 列車: [種別, [駅番号, 時刻(分), 駅番号, 時刻(分), ...]]（最後の駅だけ到着時刻）
        'trains': [[kind, [v for s in stops for v in s]] for kind, stops in trains],
    }
    body = (f'// {out["generatedAt"]} に build_sotetsu.py で生成\n'
            f'window.SOTETSU = {json.dumps(out, ensure_ascii=False, separators=(",", ":"))};\n')
    with open(OUT_FILE, 'w', encoding='utf-8') as fp:
        fp.write(body)
    print(f'運賃: {len(fares)} 区間（横浜〜海老名 {fares["横浜|海老名"]}円・横浜〜新横浜 {fares["新横浜|横浜"]}円）')
    print(f'出力: {OUT_FILE}')


if __name__ == '__main__':
    main()
