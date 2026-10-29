# =====================================================================
# 東急東横線（渋谷〜横浜）・東急新横浜線（日吉〜新横浜）の運賃・時刻表データを作る
#
#   入力: 東急電鉄「各駅時刻表（PDF版）」https://www.tokyu.co.jp/railway/timetable/
#           /railway/timetable/pdf/<改正>_<路線記号><駅番号>_<駅>_1.pdf … 上り（渋谷方面）
#           /railway/timetable/pdf/<改正>_<路線記号><駅番号>_<駅>_2.pdf … 下り（横浜・新横浜方面）
#           ただし渋谷の _1 は副都心線、横浜の _2 はみなとみらい線の時刻表なので使わない
#           （新横浜線の終点の日吉は _2、新横浜は _1 しかない）
#         東急電鉄「運賃」https://www.tokyu.co.jp/railway/ticket/fares/ （営業キロ帯ごとの IC 運賃・加算運賃）
#         Wikipedia「東急東横線」「東急新横浜線」の駅一覧（営業キロ）
#         取得したファイルは tokyu_pdf/・tokyu_html/・jr_wiki/ に保存し、次回からはそれを使う（取り直すときは消す）
#   出力: data/tokyu.js … window.TOKYU = { stations, fares, lines: { 路線名: { stations, trains } } }
#         運賃は東急の全駅どうし（路線をまたいでも 1 回の乗車）、列車は路線ごと
#
#   時刻表 PDF の数字は図形なので、図形の形で数字を読む。1 つの時刻は表の 1 マスに入っていて、
#   種別はマスの中の色・形で見分ける: 赤い数字 = 急行、橙の四角 = 特急、橙の三角 = 通勤特急、黒 = 各停。
#   同じ種別の列車が次に停まる駅の発車とつないで列車にする（build_minatomirai.py と同じ考え方）。
#
# 使い方（Python 3 + PyMuPDF）
#   python build_tokyu.py
# =====================================================================

import json
import math
import os
import re
import sys
from datetime import datetime, timezone

import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_jr import cumulative_km, wiki_text   # Wikipedia の営業キロの読み取りは JR と同じ
from build_minatomirai import fetch              # 取得して保存したファイルのパスを返す

ROOT = os.path.dirname(os.path.abspath(__file__))
PDF_DIR = os.path.join(ROOT, 'tokyu_pdf')
HTML_DIR = os.path.join(ROOT, 'tokyu_html')
OUT_FILE = os.path.join(ROOT, 'data', 'tokyu.js')
SITE = 'https://www.tokyu.co.jp'
EDITION = '202603'   # ダイヤ改正の年月（PDF のファイル名の先頭）。改正があったら直す

# 路線ごとの駅（下りの向きの順）: (駅名（network.js の表記）, PDF の駅名, 駅番号)。
#   skip … 使わない時刻表（他の路線のものや、終点で無いもの）
LINES = {
    '東横線': {
        'code': 'ty', 'wiki': '東急東横線', 'skip': {('渋谷', 'up'), ('横浜', 'down')},
        'stations': [(n, slug, i + 1) for i, (n, slug) in enumerate([
            ('渋谷', 'shibuya'), ('代官山', 'daikan-yama'), ('中目黒', 'naka-meguro'), ('祐天寺', 'yutenji'),
            ('学芸大学', 'gakugei-daigaku'), ('都立大学', 'toritsu-daigaku'), ('自由が丘', 'jiyugaoka'),
            ('田園調布', 'den-en-chofu'), ('多摩川', 'tamagawa'), ('新丸子', 'shin-maruko'),
            ('武蔵小杉', 'musashi-kosugi'), ('元住吉', 'motosumiyoshi'), ('日吉', 'hiyoshi'), ('綱島', 'tsunashima'),
            ('大倉山', 'okurayama'), ('菊名', 'kikuna'), ('妙蓮寺', 'myorenji'), ('白楽', 'hakuraku'),
            ('東白楽', 'higashi-hakuraku'), ('反町', 'tammachi'), ('横浜', 'yokohama')])],
    },
    # 駅番号は新横浜が SH01（日吉が SH03）
    '新横浜線': {
        'code': 'sh', 'wiki': '東急新横浜線', 'skip': {('日吉', 'up'), ('新横浜', 'down')},
        'stations': [('日吉', 'hiyoshi', 3), ('新綱島', 'shin-tsunashima', 2), ('新横浜', 'shin-yokohama', 1)],
    },
}
JUNCTION = '日吉'              # 東横線と新横浜線が分かれる駅
SURCHARGE_STATION = '新横浜'   # 新綱島〜新横浜を通る（＝新横浜で乗り降りする）と加算運賃がかかる
STATIONS = list(dict.fromkeys(s[0] for line in LINES.values() for s in line['stations']))   # 東急の全駅

# 数字の図形（パスの命令の並び）。1 と 7 は同じ並びなので幅で見分ける
DIGITS = {
    'cccccccccccccccc': 0, 'llcccccclcccccclll': 2, 'cccclcccccclllcccccclcccccccc': 3, 'llllllllllll': 4,
    'cccclcccccccclllllcccc': 5, 'cccccccccccccclllcccc': 6, 'cccccccccccccccccccccccccccccccc': 8,
    'cccccccccclllcccccccc': 9,
}
BLACK, RED, WHITE, ORANGE = (0.14, 0.12, 0.13), (0.93, 0.21, 0.14), (1.0, 1.0, 1.0), (0.97, 0.58, 0.11)
near = lambda c, ref: c and sum((a - b) ** 2 for a, b in zip(c, ref)) < 0.01


def digit_of(sig, rect):
    if sig == 'llllll':
        return 1 if rect.width < rect.height * 0.5 else 7
    return DIGITS.get(sig)


# --- 時刻表 PDF -----------------------------------------------------------
def parse_pdf(path):
    """平日（左の表）の [(時刻(分), 種別)] を返す"""
    page = pymupdf.open(path)[0]
    W = page.rect.width
    digits, hours, seps, marks = [], [], [], []
    for x in page.get_drawings():
        fl, r = x.get('fill'), x['rect']
        if not fl or x['type'] not in ('f', 'fs'):
            continue
        sig = ''.join(i[0] for i in x['items'])
        if sig == 're' and near(fl, WHITE) and r.width < 4 and r.height > 20:
            seps.append(r)                                    # マスの区切り（白い縦線）
        elif near(fl, ORANGE) and sig in ('re', 'lll') and r.width > 20:
            marks.append((r, 'limited' if sig == 're' else 'commuter'))   # 特急の四角・通勤特急の三角
        elif 15 < r.height < 18.5 and (near(fl, BLACK) or near(fl, RED)):
            d = digit_of(sig, r)
            if d is not None:
                digits.append((r, d, 'express' if near(fl, RED) else None))
        elif 22 < r.height < 28 and near(fl, WHITE):
            d = digit_of(sig, r)
            if d is not None:
                hours.append((r, d))                          # 時（濃い地に白抜き）
    # 平日の表は左側。土曜・休日の表の「時」の列より左だけを使う
    split = min((r.x0 for r, _ in hours if r.x0 > W * 0.4), default=W / 2) - 5
    digits = [g for g in digits if g[0].x0 < split]
    hours = sorted((g for g in hours if g[0].x0 < split), key=lambda g: (round(g[0].y0), g[0].x0))
    # 時の数字を行ごとにまとめる（10 時以降は 2 桁）
    rows = []
    for r, d in hours:
        if rows and abs(rows[-1]['y'] - (r.y0 + r.y1) / 2) < 5:
            rows[-1]['h'] = rows[-1]['h'] * 10 + d
            rows[-1]['x1'] = r.x1
        else:
            rows.append({'y': (r.y0 + r.y1) / 2, 'h': d, 'x1': r.x1})
    deps = []
    for row in rows:
        hour = row['h'] if row['h'] >= 4 else row['h'] + 24   # 0 時台は 24 時台
        in_row = lambda r: abs((r.y0 + r.y1) / 2 - row['y']) < 14
        cut = sorted(r.x0 for r in seps if in_row(r) and r.x0 < split)
        cells = {}
        for r, d, kind in sorted((g for g in digits if in_row(g[0]) and g[0].x0 > row['x1']), key=lambda g: g[0].x0):
            i = sum(1 for c in cut if c <= r.x0)                # 左にある区切りの数 = マスの番号
            cell = cells.setdefault(i, {'m': 0, 'kind': None, 'x': r.x0})
            cell['m'] = cell['m'] * 10 + d
            cell['kind'] = cell['kind'] or kind
        for i, cell in cells.items():
            if cell['m'] > 59:
                raise ValueError(f'{path}: {hour}時台に 59 を超える分: {cell["m"]}')
            kind = cell['kind']
            if not kind:
                lo = cut[i - 1] if i > 0 else row['x1']
                hi = cut[i] if i < len(cut) else split
                m = [k for r, k in marks if in_row(r) and lo - 2 <= r.x0 <= hi]
                kind = m[0] if m else 'local'
            deps.append((hour * 60 + cell['m'], kind))
    return sorted(deps)


def local_run_times(tables, order, d):
    """各停の隣の駅までの所要時間（分）。通過待ちで長く停まる列車を除くため、中央値でなく短い方（1 割の位置）を使う"""
    runs = {}
    for a, b in zip(order, order[1:]):
        ta_list = [t for t, k in tables[a].get(d, []) if k == 'local']
        tb_list = [t for t, k in tables[b].get(d, []) if k == 'local']
        diffs = sorted(x for x in (min((tb - ta for tb in tb_list if 0 < tb - ta <= 6), default=None)
                                   for ta in ta_list) if x is not None)
        if diffs:
            runs[(a, b)] = diffs[len(diffs) // 10]
    return runs


def stop_stations(tables, d, kind):
    """種別 kind が停まる駅（その駅の時刻表にその種別が何本もある駅）"""
    counts = {i: sum(1 for _, k in tables[i].get(d, []) if k == kind) for i in tables}
    top = max(counts.values()) or 1
    return {i for i, c in counts.items() if c >= max(3, top * 0.1)}


def build_trains(tables, n):
    """発車時刻を、同じ種別の列車が次に停まる駅の発車とつないで列車にする。
    種別ごとの停車駅は時刻表から決める（その種別が載っている駅）。次の停車駅での発車を
    「各停の所要時間の合計」の前後で探す（通過する駅の分だけ早く、通過待ちの分だけ遅くてもよい）。
    見つからなければ列車はそこで終わり（日吉から東急新横浜線へ行く列車など）。
    終点（下りの横浜・上りの渋谷など）は表がないので、到着時刻は各停の所要時間から決める。n は路線の駅の数"""
    trains = []
    for d, order in (('down', list(range(n))), ('up', list(range(n - 1, -1, -1)))):
        runs = local_run_times(tables, order, d)
        back = local_run_times(tables, order[::-1], 'down' if d == 'up' else 'up')
        for (a, b), r in back.items():
            runs.setdefault((b, a), r)   # 終点の手前の区間など、この向きの表がない区間は反対向きで代用
        deps = {i: tables[i].get(d, []) for i in order}
        terminal = order[-1]             # 表のない終点
        stops_of = {k: stop_stations(tables, d, k) | {terminal} for k in ('local', 'express', 'commuter', 'limited')}
        used = {i: set() for i in order}
        for si, start in enumerate(order):
            for idx, (t0, kind) in enumerate(deps[start]):
                if idx in used[start]:
                    continue
                stops, cur, ct = [(start, t0)], si, t0
                while cur + 1 < n:
                    nj = next((j for j in range(cur + 1, n) if order[j] in stops_of[kind]), None)
                    if nj is None:
                        break
                    run = sum(runs[(order[j - 1], order[j])] for j in range(cur + 1, nj + 1))
                    skipped = nj - cur - 1
                    st = order[nj]
                    if st == terminal and not deps[st]:
                        stops.append((st, ct + run - skipped))
                        break
                    cands = [(abs(t - (ct + run)), j, t) for j, (t, k) in enumerate(deps[st])
                             if k == kind and j not in used[st] and ct + run - skipped - 2 <= t <= ct + run + 6]
                    if not cands:
                        break
                    _, j, t = min(cands)
                    used[st].add(j)
                    stops.append((st, t))
                    cur, ct = nj, t
                if len(stops) >= 2:
                    trains.append((kind, stops))
    return trains


# --- 運賃 -------------------------------------------------------------------
def fare_table():
    """運賃ページの「営業キロ・IC 運賃（大人）」の表: [(キロの上限, 運賃)]"""
    page = open(fetch(f'{SITE}/railway/ticket/fares/', os.path.join(HTML_DIR, 'fares.html')), encoding='utf-8').read()
    table = []
    for row in re.findall(r'<tr.*?</tr>', page, re.S):
        cells = [re.sub(r'<[^>]+>|\s+', '', c) for c in re.findall(r'<t[hd][^>]*>(.*?)</t[hd]>', row, re.S)]
        m = re.fullmatch(r'(\d+)～(\d+)', cells[0]) if cells else None
        if m and len(cells) == 5:
            table.append((int(m.group(2)), int(cells[3])))   # IC カード・大人
    if not table or table[0][0] != 3:
        raise ValueError(f'運賃表が読み取れません: {table}')
    return table


def surcharge():
    """東急新横浜線の加算運賃（普通旅客運賃・大人）"""
    page = open(os.path.join(HTML_DIR, 'fares.html'), encoding='utf-8').read()
    m = re.search(r'普通旅客運賃（大人）(\d+)円', re.sub(r'<[^>]+>|\s+', '', page))
    if not m:
        raise ValueError('加算運賃が読み取れません')
    return int(m.group(1))


def build_fares():
    """東急の全駅どうしの運賃。日吉で東横線と新横浜線がつながるので、路線をまたぐときは日吉までと日吉からの
    営業キロを足す。新横浜で乗り降りするときは加算運賃を足す"""
    pos = {}   # 駅 -> (路線, 路線内の累計営業キロ)
    for line, conf in LINES.items():
        km = cumulative_km(wiki_text(conf['wiki']))
        missing = [s[0] for s in conf['stations'] if s[0] not in km]
        if missing:
            raise ValueError(f'{conf["wiki"]} の営業キロが読み取れません: {missing}')
        for name, _, _ in conf['stations']:
            pos.setdefault(name, (line, km[name]))
        conf['km'] = km

    def distance(a, b):
        (la, ka), (lb, kb) = pos[a], pos[b]
        if la == lb:
            return abs(ka - kb)
        return abs(ka - LINES[la]['km'][JUNCTION]) + abs(kb - LINES[lb]['km'][JUNCTION])

    table, extra = fare_table(), surcharge()
    fares = {}
    for i, a in enumerate(STATIONS):
        for b in STATIONS[i + 1:]:
            k = math.ceil(round(distance(a, b), 1) - 1e-9)   # 1km 未満の端数は切り上げ
            f = next(f for limit, f in table if k <= limit)
            fares['|'.join(sorted([a, b]))] = f + (extra if SURCHARGE_STATION in (a, b) else 0)
    return fares


def main():
    os.makedirs(PDF_DIR, exist_ok=True)
    os.makedirs(HTML_DIR, exist_ok=True)
    lines, deps = {}, 0
    for line, conf in LINES.items():
        tables = {}
        for i, (name, slug, no) in enumerate(conf['stations']):
            tables[i] = {}
            for d, suffix in (('up', 1), ('down', 2)):
                if (name, d) in conf['skip']:
                    continue
                file = f'{EDITION}_{conf["code"]}{no:02d}_{slug}_{suffix}.pdf'
                path = fetch(f'{SITE}/railway/timetable/pdf/{file}', os.path.join(PDF_DIR, file))
                tables[i][d] = parse_pdf(path)
                deps += len(tables[i][d])
        trains = build_trains(tables, len(conf['stations']))
        kinds = {}
        for k, _ in trains:
            kinds[k] = kinds.get(k, 0) + 1
        print(f'時刻表（{line}）: 列車 {len(trains)} 本 {kinds}')
        lines[line] = {
            'stations': [s[0] for s in conf['stations']],
            # 列車: [種別, [駅番号, 時刻(分), 駅番号, 時刻(分), ...]]（最後の駅だけ到着時刻）
            'trains': [[kind, [v for s in stops for v in s]] for kind, stops in trains],
        }
    fares = build_fares()

    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'source': '東急電鉄 各駅時刻表 PDF（平日）・運賃表（IC）・加算運賃・Wikipedia の営業キロ',
        'stations': STATIONS,
        'fares': fares,
        'lines': lines,
    }
    body = (f'// {out["generatedAt"]} に build_tokyu.py で生成\n'
            f'window.TOKYU = {json.dumps(out, ensure_ascii=False, separators=(",", ":"))};\n')
    with open(OUT_FILE, 'w', encoding='utf-8') as fp:
        fp.write(body)
    print(f'時刻表: 発車 {deps} 本')
    print(f'運賃: {len(fares)} 区間（渋谷〜横浜 {fares["横浜|渋谷"]}円・渋谷〜新横浜 {fares["新横浜|渋谷"]}円）')
    print(f'出力: {OUT_FILE}')


if __name__ == '__main__':
    main()
