# =====================================================================
# 京急の運賃表・駅時刻表（PDF）から、駅間の運賃と所要時間のデータを作る
#
#   入力: keikyu_pdf/fare.pdf          … 普通旅客運賃表【IC運賃】（download_keikyu.js で取得）
#         keikyu_pdf/KK01.pdf … KK72.pdf … 各駅の標準時刻表（平日ダイヤを使用）
#   出力: data/keikyu.js  … window.KEIKYU = { stations, fares, trains, segments }
#
#   時刻表 PDF は文字がアウトライン化されているので、数字の図形（パスの命令列）で
#   0〜9 を判別し、数字の色で種別（快特・特急・急行・普通）を判別する。
#   各駅の発車時刻を「同じ色の列車が次に停まる駅の発車時刻」とつなげて列車にする。
#
# 使い方（Python 3 + PyMuPDF）
#   pip install pymupdf
#   python build_keikyu.py
# =====================================================================

import glob
import json
import math
import os
import re
import statistics
from datetime import datetime, timezone

import pymupdf

ROOT = os.path.dirname(os.path.abspath(__file__))
PDF_DIR = os.path.join(ROOT, 'keikyu_pdf')
NETWORK_FILE = os.path.join(ROOT, 'data', 'network.js')
OUT_FILE = os.path.join(ROOT, 'data', 'keikyu.js')

# --- 駅 ---------------------------------------------------------------
# 駅ナンバリング順（KK01〜KK72）。泉岳寺は都営の駅なので時刻表はない
KK = {
    1: '品川', 2: '北品川', 3: '新馬場', 4: '青物横丁', 5: '鮫洲', 6: '立会川', 7: '大森海岸',
    8: '平和島', 9: '大森町', 10: '梅屋敷', 11: '京急蒲田',
    12: '糀谷', 13: '大鳥居', 14: '穴守稲荷', 15: '天空橋', 16: '羽田空港第3ターミナル',
    17: '羽田空港第1・第2ターミナル',
    18: '雑色', 19: '六郷土手', 20: '京急川崎',
    21: '港町', 22: '鈴木町', 23: '川崎大師', 24: '東門前', 25: '大師橋', 26: '小島新田',
    27: '八丁畷', 28: '鶴見市場', 29: '京急鶴見', 30: '花月総持寺', 31: '生麦', 32: '京急新子安',
    33: '子安', 34: '神奈川新町', 35: '京急東神奈川', 36: '神奈川', 37: '横浜', 38: '戸部',
    39: '日ノ出町', 40: '黄金町', 41: '南太田', 42: '井土ヶ谷', 43: '弘明寺', 44: '上大岡',
    45: '屏風浦', 46: '杉田', 47: '京急富岡', 48: '能見台', 49: '金沢文庫', 50: '金沢八景',
    51: '六浦', 52: '神武寺', 53: '逗子・葉山',
    54: '追浜', 55: '京急田浦', 56: '安針塚', 57: '逸見', 58: '汐入', 59: '横須賀中央',
    60: '県立大学', 61: '堀ノ内', 62: '京急大津', 63: '馬堀海岸', 64: '浦賀',
    65: '新大津', 66: '北久里浜', 67: '京急久里浜', 68: 'YRP野比', 69: '京急長沢', 70: '津久井浜',
    71: '三浦海岸', 72: '三崎口',
}
SENGAKUJI = 0
KK[SENGAKUJI] = '泉岳寺'

# 上り方向（品川側）の隣の駅
UP = {1: SENGAKUJI, 12: 11, 18: 11, 21: 20, 27: 20, 51: 50, 54: 50, 65: 61}
for n in range(2, 73):
    UP.setdefault(n, n - 1)
DOWN = {}
for n, u in UP.items():
    DOWN.setdefault(u, []).append(n)

# 各ページの行き先（隣の駅）。指定のないページは 0 = 上り, 1 = 下り
PAGE_HEADING = {
    (11, 1): [18], (11, 2): [12],       # 京急蒲田: 下り横浜方面 / 羽田空港方面
    (20, 1): [27], (20, 2): [21],       # 京急川崎: 下り横浜方面 / 大師線
    (72, 1): [],                        # 三崎口: 到着電車のご案内（到着時刻）
}

# 全列車が停まる駅（ここで発車時刻が見つからない列車は、この駅止まりとみなす）
ALL_STOP = {1, 11, 20, 37, 44, 49, 50, 59, 61, 67}

# 運賃表の駅の並び（行・列とも同じ順）
FARE_ORDER = ([0] + list(range(1, 12)) + [18, 19, 20] + list(range(27, 51)) + list(range(54, 65))
              + list(range(12, 18)) + list(range(21, 27)) + [51, 52, 53] + list(range(65, 73)))

# --- 時刻表の図形 -------------------------------------------------------
DIGITS = {
    'cccccccccccccccc': 0,
    'lcccclllll': 1,
    'ccccccclcccccclcclllc': 2,
    'cccccclcccccclccccccccccccccl': 3,
    'llllllllllllll': 4,
    'ccccccccllllllccccccccl': 5,
    'cccccccccccccccccclcccccccc': 6,
    'cccclccllll': 7,
    'cccccccccccccccccccccccccccccccc': 8,
    'ccccccccccccccclccccccccc': 9,
}
TYPE_COLORS = {
    'kaitoku': (0.0, 0.57, 0.28),   # 快特（緑）
    'tokkyu': (0.87, 0.02, 0.08),   # 特急（赤）
    'kyuko': (0.0, 0.49, 0.78),     # 急行（青）
    'futsu': (0.13, 0.09, 0.08),    # 普通（黒）
}
FIRST_HOUR = 4   # 表の 1 行目は 4 時台（全ページ 21 行 = 4〜24 時台）


def color_type(fill):
    best, bd = None, 1e9
    for name, c in TYPE_COLORS.items():
        dd = sum((a - b) ** 2 for a, b in zip(fill, c))
        if dd < bd:
            best, bd = name, dd
    return best if bd < 0.02 else None


def parse_page(page):
    """平日（左側）の表から [(時刻（0時起点の分）, 種別)] を返す"""
    W, H = page.rect.width, page.rect.height
    drawings = page.get_drawings()
    rects = sorted((x['rect'] for x in drawings
                    if len(x['items']) == 1 and x['items'][0][0] == 're' and x['rect'].width > W * 0.25
                    and 40 < x['rect'].height < 60 and x['rect'].x0 < W / 2), key=lambda r: r.y0)
    rows = []
    for r in rects:
        if not rows or abs(r.y0 - rows[-1].y0) > 5:
            rows.append(r)
    if len(rows) != 21:
        raise ValueError(f'行数が想定外: {len(rows)}')

    glyphs = []
    for x in drawings:
        fl, r = x.get('fill'), x['rect']
        if x['type'] != 'f' or not fl or not (0.011 < r.height / H < 0.016):
            continue
        sig = ''.join(i[0] for i in x['items'])
        kind = color_type(fl) if sig in DIGITS else None
        if kind:                  # 白抜き（ウィング号）などは対象外
            glyphs.append((r, DIGITS[sig], kind))

    deps = []
    for hi, row in enumerate(rows):
        hour = FIRST_HOUR + hi
        cells = sorted((g for g in glyphs if row.y0 <= (g[0].y0 + g[0].y1) / 2 <= row.y1
                        and row.x0 <= g[0].x0 <= row.x1), key=lambda g: g[0].x0)
        groups = []
        for r, dgt, kind in cells:
            g = groups[-1] if groups else None
            if g and r.x0 - g['x'] < r.height * 0.75 and kind == g['kind']:
                g['m'] = g['m'] * 10 + dgt
            else:
                groups.append({'m': dgt, 'kind': kind})
            groups[-1]['x'] = r.x0
        for g in groups:
            if g['m'] > 59:
                raise ValueError(f'{hour}時台に 59 を超える分: {g["m"]}')
            deps.append((hour * 60 + g['m'], g['kind']))
    return sorted(deps)


def load_timetables():
    pages = []   # { station, heading:[...], deps:[(t, kind)] }
    for f in sorted(glob.glob(os.path.join(PDF_DIR, 'KK*.pdf'))):
        n = int(os.path.basename(f)[2:4])
        doc = pymupdf.open(f)
        for pi, page in enumerate(doc):
            heading = PAGE_HEADING.get((n, pi))
            if heading is None:
                heading = [UP[n]] if pi == 0 else DOWN.get(n, [])
            deps = parse_page(page)
            pages.append({'station': n, 'heading': heading, 'arrival': heading == [], 'deps': deps,
                          'name': f'KK{n:02d}-{pi}'})
    return pages


# --- 距離 -------------------------------------------------------------
def load_coords():
    src = open(NETWORK_FILE, encoding='utf-8').read()
    net = json.loads(src[src.index('=') + 1:].strip().rstrip(';'))
    by_name = {s['name']: s for s in net['stations']}
    coords = {}
    for n, name in KK.items():
        s = by_name.get(name)
        if not s:
            raise ValueError(f'network.js に駅がありません: {name}')
        coords[n] = (s['lat'], s['lng'])
    return coords


def km(a, b):
    lat = (a[0] + b[0]) / 2 * math.pi / 180
    return math.hypot((b[1] - a[1]) * 111.32 * math.cos(lat), (b[0] - a[0]) * 110.57)


# --- 列車をつなぐ -------------------------------------------------------
def build_trains(pages, coords):
    by_station = {}
    for p in pages:
        by_station.setdefault(p['station'], []).append(p)
    used = {id(p): set() for p in pages}

    def seg_km(a, b):
        return km(coords[a], coords[b]) * 1.15   # 線路の曲がりを少し見込む

    def walk(frm, nxt, dist, out):
        """frm から nxt 方向に進むときに通る駅を (駅, 累積km, 直前の駅) で列挙する"""
        d = dist + seg_km(frm, nxt)
        out.append((nxt, d, frm))
        # 分岐駅（全列車停車）より先は、その駅の発車時刻から改めてつなぐ
        onward = [m for m in ([UP.get(nxt)] + DOWN.get(nxt, [])) if m is not None and m != frm]
        if len(onward) == 1:
            walk(nxt, onward[0], d, out)

    def find_next(page, t, kind):
        cands = []
        for h in page['heading']:
            path = []
            walk(page['station'], h, 0.0, path)
            for st, d, prev in path:
                lo, hi = t + max(1, d * 0.42), t + d * 1.6 + 2.5
                targets = [q for q in by_station.get(st, []) if prev not in q['heading']]
                hit = None
                for q in targets:
                    for i, (tq, kq) in enumerate(q['deps']):
                        if kq == kind and lo <= tq <= hi and i not in used[id(q)]:
                            if hit is None or tq < hit[2]:
                                hit = (q, i, tq)
                if hit:
                    cands.append((hit, d, st))
                    break
                # 全列車が停まる駅・この種別が近い時間に停まっている駅で続きがない → ここで終点
                near = any(kq == kind and abs(tq - (t + d)) <= 6 for q in targets for tq, kq in q['deps'])
                if near or not targets or st in ALL_STOP:
                    cands.append((None, d, st))
                    break
        if not cands:
            return None
        # 複数の分岐で見つかったら、表定速度 50km/h に近いものを選ぶ
        found = [c for c in cands if c[0]]
        pool = found or cands
        return min(pool, key=lambda c: abs((c[0][2] - t if c[0] else 0) - c[1] * 1.2))

    # 列車の始まりを判定するため、まず全発車を「次の停車駅」へつなぐ
    links = {}   # (page id, index) -> (page, index) | ('end', station, dist)
    for p in pages:
        if p['arrival']:
            continue
        for i, (t, kind) in enumerate(p['deps']):
            res = find_next(p, t, kind)
            if res is None:
                continue
            hit, d, st = res
            if hit:
                q, j, _ = hit
                used[id(q)].add(j)
                links[(id(p), i)] = (q, j)
            else:
                links[(id(p), i)] = ('end', st, d)

    trains = []
    page_of = {id(p): p for p in pages}
    for p in pages:
        for i, (t, kind) in enumerate(p['deps']):
            if p['arrival'] or i in used[id(p)]:
                continue   # 途中駅の発車（前の駅からつながっている）
            stops, cur, ci = [], p, i
            while True:
                tc = cur['deps'][ci][0]
                stops.append([cur['station'], tc])
                if cur['arrival']:
                    break
                nx = links.get((id(cur), ci))
                if nx is None:
                    break
                if nx[0] == 'end':
                    stops.append([nx[1], None, nx[2]])   # 終点（到着時刻は後で推定）
                    break
                cur, ci = nx
            if len(stops) >= 2:
                trains.append({'kind': kind, 'stops': stops})
    return trains


def fill_terminal_arrivals(trains, coords):
    """終点の到着時刻（時刻表に載らない）を、同じ区間の他の列車の所要時間で補う"""
    seg = {}
    for tr in trains:
        s = tr['stops']
        for a, b in zip(s, s[1:]):
            if a[1] is not None and b[1] is not None:
                key = (min(a[0], b[0]), max(a[0], b[0]), tr['kind'])
                seg.setdefault(key, []).append(b[1] - a[1])
    for tr in trains:
        last = tr['stops'][-1]
        if last[1] is not None:
            continue
        prev = tr['stops'][-2]
        a, b = min(prev[0], last[0]), max(prev[0], last[0])
        vals = seg.get((a, b, tr['kind'])) or [v for (x, y, _), vs in seg.items() if (x, y) == (a, b) for v in vs]
        dt = statistics.median(vals) if vals else max(2, round(last[2] * 1.2 + 0.5))
        tr['stops'][-1] = [last[0], prev[1] + round(dt)]
    return seg


def load_fares():
    page = pymupdf.open(os.path.join(PDF_DIR, 'fare.pdf'))[0]   # 1 ページ目 = おとな IC 運賃
    rows = {}
    for w in page.get_text('words'):
        # 駅名（文字化けする）と金額がくっついて 1 語になることがあるので、末尾の数字を取る
        m = re.search(r'(\d{3})$', w[4])   # 運賃はすべて 3 桁
        if m:
            rows.setdefault(round((w[1] + w[3]) / 2), []).append((w[0], int(m.group(1))))
    lines = [[v for x, v in sorted(l)] for k, l in sorted(rows.items())]
    lines = [l for l in lines if all(100 <= v <= 2000 for v in l)]
    lens = [len(l) for l in lines]
    n = len(FARE_ORDER)
    if lens != list(range(n - 1, 0, -1)):
        raise ValueError(f'運賃表の形が想定外: {lens}')
    fares = {}
    for i, l in enumerate(lines):
        for k, v in enumerate(l):
            a, b = FARE_ORDER[i], FARE_ORDER[i + 1 + k]
            fares['|'.join(sorted([KK[a], KK[b]]))] = v
    return fares


def main():
    coords = load_coords()
    fares = load_fares()
    pages = load_timetables()
    trains = build_trains(pages, coords)
    seg = fill_terminal_arrivals(trains, coords)

    # 泉岳寺（都営の駅）には時刻表がないので、品川始発の下り列車は泉岳寺から来るものとして補う
    sg = [tr['stops'][-1][1] - tr['stops'][-2][1] for tr in trains if tr['stops'][-1][0] == SENGAKUJI]
    dt = round(statistics.median(sg)) if sg else 2
    for tr in trains:
        if tr['stops'][0][0] == 1 and tr['stops'][1][0] != SENGAKUJI:
            tr['stops'].insert(0, [SENGAKUJI, tr['stops'][0][1] - dt])

    # 隣り合う停車駅間の所要時間（種別ごとの中央値）… 確認用
    segments = {}
    for (a, b, kind), vals in sorted(seg.items()):
        segments.setdefault(f'{KK[a]}|{KK[b]}', {})[kind] = round(statistics.median(vals), 1)

    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'source': '京急電鉄 普通旅客運賃表【IC運賃】おとな・各駅標準時刻表（平日）',
        'stations': [KK[n] for n in sorted(KK)],
        'fares': fares,
        # 列車: [種別, [駅番号, 時刻(分), 駅番号, 時刻(分), ...]]（駅番号は stations の添字）
        'trains': [[tr['kind'], [v for s in tr['stops'] for v in s[:2]]] for tr in trains],
        'segments': segments,
    }
    body = (f'// {out["generatedAt"]} に build_keikyu.py で生成\n'
            f'window.KEIKYU = {json.dumps(out, ensure_ascii=False, separators=(",", ":"))};\n')
    with open(OUT_FILE, 'w', encoding='utf-8') as fp:
        fp.write(body)

    total = sum(len(p['deps']) for p in pages)
    print(f'運賃: {len(fares)} 区間')
    print(f'時刻表: {len(pages)} ページ / 発車 {total} 本 → 列車 {len(trains)} 本')
    print(f'出力: {OUT_FILE} ({len(body) // 1024} KB)')


if __name__ == '__main__':
    main()
