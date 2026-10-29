# =====================================================================
# JR 横須賀線（品川〜久里浜）・根岸線（横浜〜大船）・横浜線（東神奈川〜八王子）・東海道線（品川〜辻堂）の運賃・時刻表データを作る
#
#   入力: JR東日本 列車時刻表（平日の下り・上り）
#           https://timetables.jreast.co.jp/<版>/timetable-v/<ページ>.html
#             横須賀線: 総武線快速・横須賀線 222d1（下り）・222u1（上り）
#             根岸線  : 京浜東北線・根岸線 623d1（南行）・623u1（北行）。横浜線からの直通列車も載っている
#             横浜線  : 横浜線 608d1（下り）・608u1（上り）。桜木町・横浜からの直通列車の時刻も載っている
#             東海道線: 東海道線・伊東線・伊豆急行 101d1（下り）・101u1（上り）。品川〜辻堂の停車駅だけ使う
#           <版>（例: 2611）は毎月変わるので、取り直すときは TIMETABLE_EDITION を最新に直す
#         Wikipedia の営業キロ（横須賀線・品鶴線・根岸線・横浜線・東海道線 (JR東日本)・横須賀・総武快速線・京浜東北線 の駅一覧）
#         取得したページは jr_html/・jr_wiki/ に保存し、次回からはそれを使う（取り直すときは消す）
#   出力: data/jr.js … window.JR = { stations, km, fares, lines: { 路線名: { stations, trains } } }
#         運賃は JR の全駅どうし（路線をまたいでも 1 枚のきっぷ）、列車は路線ごと
#
#   運賃は営業キロから計算する（2026 年 3 月 14 日改定後の JR東日本 幹線 IC 運賃）。
#     - 品鶴線（西大井・武蔵小杉・新川崎）を挟む区間は、品川〜鶴見を川崎経由の 14.9km で数える
#       （経路特定区間）。営業キロのグラフで最短経路をとれば、この規則と同じになる
#     - 改定後も残る特定区間（品川〜横浜など）は、その運賃を使う
#   運賃表・特定区間の運賃は、JR東日本「運賃改定のご案内」パンフレット
#   （https://www.jreast.co.jp/2026unchin-kaitei/assets/pdf/pamphlet.pdf）の A 表と特定区間の表から写した。
#
# 使い方（Python 3）
#   python build_jr.py
# =====================================================================

import html
import json
import math
import os
import re
import subprocess
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
HTML_DIR = os.path.join(ROOT, 'jr_html')
WIKI_DIR = os.path.join(ROOT, 'jr_wiki')
OUT_FILE = os.path.join(ROOT, 'data', 'jr.js')
TIMETABLE_EDITION = '2611'
TIMETABLE_URL = 'https://timetables.jreast.co.jp/{}/timetable-v/{}.html'
WIKI_API = 'https://ja.wikipedia.org/w/api.php'
USER_AGENT = 'distortMap-data-collector/1.0 (personal, low-frequency)'
REQUEST_INTERVAL_SEC = 2

# 路線ごとの時刻表ページ（平日の下り・上り）と駅（駅名は data/network.js と同じ表記・並び順）
LINES = {
    '横須賀線': {'pages': ['222d1', '222u1'],
                 'stations': ['品川', '西大井', '武蔵小杉', '新川崎', '横浜', '保土ヶ谷', '東戸塚', '戸塚', '大船',
                              '北鎌倉', '鎌倉', '逗子', '東逗子', '田浦', '横須賀', '衣笠', '久里浜']},
    '根岸線': {'pages': ['623d1', '623u1'],
               'stations': ['横浜', '桜木町', '関内', '石川町', '山手', '根岸', '磯子', '新杉田', '洋光台',
                            '港南台', '本郷台', '大船']},
    # 横浜線の列車は桜木町・横浜まで直通するものが多いので、時刻表にある桜木町・横浜も含める
    '横浜線': {'pages': ['608d1', '608u1'],
               'stations': ['桜木町', '横浜', '東神奈川', '大口', '菊名', '新横浜', '小机', '鴨居', '中山', '十日市場',
                            '長津田', '成瀬', '町田', '古淵', '淵野辺', '矢部', '相模原', '橋本', '相原',
                            '八王子みなみ野', '片倉', '八王子']},
    # 東海道線の列車の停車駅（品川〜辻堂）。途中の駅は京浜東北線・横須賀線の駅
    '東海道線': {'pages': ['101d1', '101u1'], 'stations': ['品川', '川崎', '横浜', '戸塚', '大船', '藤沢', '辻堂']},
}
STATIONS = list(dict.fromkeys(n for line in LINES.values() for n in line['stations']))   # JR の全駅
# 時刻表・Wikipedia の表記 → network.js の表記
NAME_FIX = {'保土ケ谷': '保土ヶ谷'}

# 営業キロのグラフの路線: 路線内の駅の並び。駅どうしの距離は累計営業キロの差
ROUTES = {
    '東海道本線': ['品川', '川崎', '鶴見', '東神奈川', '横浜', '保土ヶ谷', '東戸塚', '戸塚', '大船', '藤沢', '辻堂'],
    '品鶴線': ['品川', '西大井', '武蔵小杉', '新川崎', '鶴見'],
    '横須賀線': ['大船', '北鎌倉', '鎌倉', '逗子', '東逗子', '田浦', '横須賀', '衣笠', '久里浜'],
    '根岸線': LINES['根岸線']['stations'],
    '横浜線': LINES['横浜線']['stations'][2:],   # 営業キロ上の横浜線は東神奈川から
}

# JR東日本内の幹線の普通運賃表（A 表、改定後の IC 運賃）: (営業キロの上限, 運賃)
FARE_TABLE = [(3, 155), (6, 199), (10, 209), (15, 253), (20, 341), (25, 440), (30, 528), (35, 616),
              (40, 715), (45, 803), (50, 902), (60, 1034), (70, 1221), (80, 1408), (90, 1595), (100, 1782)]
# 改定後も残る特定区間（IC 運賃）のうち、この区間の駅どうしのもの
SPECIAL_FARES = {('品川', '横浜'): 341, ('品川', '逗子'): 803, ('横浜', '逗子'): 440,
                 ('横浜', '西大井'): 341, ('逗子', '西大井'): 803, ('品川', '東神奈川'): 341}


# --- 取得 ---------------------------------------------------------------
def fetch(url, path):
    """url を path に保存して中身を返す。保存済みならそれを使う"""
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
    with open(path, encoding='utf-8') as fp:
        return fp.read()


def wiki_text(title):
    q = urllib.parse.urlencode({'action': 'parse', 'page': title, 'prop': 'wikitext', 'redirects': 1,
                                'format': 'json', 'formatversion': 2})
    path = os.path.join(WIKI_DIR, title.replace(' ', '_') + '.json')
    return json.loads(fetch(f'{WIKI_API}?{q}', path))['parse']['wikitext']


# --- 営業キロ（Wikipedia の駅一覧） ---------------------------------------
def cumulative_km(wikitext, cell=1):
    """駅一覧の表から { 駅名: 累計営業キロ } を返す。駅名セルから cell+1 個先のセルの数値を使う
    （多くの記事は駅名の次が「駅間」、その次が「累計」）"""
    i = wikitext.find('駅一覧 ==')
    km = {}
    for row in wikitext[i:].split('\n|-'):
        lines = row.split('\n')
        for j, line in enumerate(lines):
            m = re.match(r'\|(?:[^|\[]*\|)?\s*\[\[([^\]|]+?)駅(?: \([^)]*\))?(?:\|[^\]]*)?\]\]', line)
            if not m:
                continue
            if j + 1 + cell < len(lines):
                v = re.search(r'(\d+\.\d)\s*(?:<br>.*)?$', lines[j + 1 + cell].strip())
                if v:
                    km.setdefault(NAME_FIX.get(m.group(1), m.group(1)), float(v.group(1)))
            break
    return km


def need(km, names, title):
    missing = [n for n in names if n not in km]
    if missing:
        raise ValueError(f'{title} の営業キロが読み取れません: {missing}')
    return km


def route_km():
    """路線ごとの { 駅名: 累計営業キロ }
    - 東海道本線: 「東海道線 (JR東日本)」は東海道線列車の停車駅だけなので、保土ケ谷・東戸塚は
      「横須賀・総武快速線」の「各線区毎」の列（東京からの東海道本線の営業キロ）から取る
    - 鶴見（東海道本線）は、品鶴線の記事にある「品川〜鶴見は川崎回りの営業キロで計算」の値から求める
    - 東神奈川（東海道本線）は、「京浜東北線」の「各線区毎」の列から取る"""
    tokaido = need(cumulative_km(wiki_text('東海道線 (JR東日本)')), ['品川', '川崎', '横浜', '戸塚', '大船', '藤沢', '辻堂'],
                   '東海道線')
    sobu = need(cumulative_km(wiki_text('横須賀・総武快速線'), cell=2), ['横浜', '保土ヶ谷', '東戸塚', '戸塚'],
                '横須賀・総武快速線')
    for n in ('横浜', '戸塚'):   # 2 つの記事の値が食い違っていないか
        if sobu[n] != tokaido[n]:
            raise ValueError(f'{n} の営業キロが記事によって違います: {tokaido[n]} / {sobu[n]}')
    hinkaku_text = wiki_text('品鶴線')
    m = re.search(r'川崎駅回りの東海道線と同じ営業キロ\s*\(([\d.]+)', hinkaku_text)
    if not m:
        raise ValueError('品川〜鶴見（川崎回り）の営業キロが品鶴線の記事から読み取れません')
    tokaido = {**tokaido, '保土ヶ谷': sobu['保土ヶ谷'], '東戸塚': sobu['東戸塚'],
               '鶴見': round(tokaido['品川'] + float(m.group(1)), 1)}
    keihin = need(cumulative_km(wiki_text('京浜東北線'), cell=2), ['鶴見', '東神奈川', '横浜'], '京浜東北線')
    for n in ('鶴見', '横浜'):
        if keihin[n] != tokaido[n]:
            raise ValueError(f'{n} の営業キロが記事によって違います: {tokaido[n]} / {keihin[n]}')
    tokaido['東神奈川'] = keihin['東神奈川']
    return {
        '東海道本線': tokaido,
        '品鶴線': need(cumulative_km(hinkaku_text), ROUTES['品鶴線'], '品鶴線'),
        '横須賀線': need(cumulative_km(wiki_text('横須賀線')), ROUTES['横須賀線'], '横須賀線'),
        '根岸線': need(cumulative_km(wiki_text('根岸線')), ROUTES['根岸線'], '根岸線'),
        '横浜線': need(cumulative_km(wiki_text('横浜線')), ROUTES['横浜線'], '横浜線'),
    }


def build_distances():
    """営業キロのグラフで全駅間の最短距離（km）を求める。品鶴線を挟む区間は自然に
    品川〜鶴見を川崎回り（短い方）で数えることになり、経路特定区間の規則と一致する"""
    graph = {}
    for line, km in route_km().items():
        names = ROUTES[line]
        for a, b in zip(names, names[1:]):
            d = round(abs(km[b] - km[a]), 1)
            graph.setdefault(a, {})[b] = d
            graph.setdefault(b, {})[a] = d
    dist = {}
    for s in STATIONS:
        d = {s: 0.0}
        todo = {s}
        while todo:   # 駅数が少ないので素朴な最短経路で十分
            u = min(todo, key=d.get)
            todo.remove(u)
            for v, w in graph[u].items():
                if d[u] + w < d.get(v, math.inf) - 1e-9:
                    d[v] = round(d[u] + w, 1)
                    todo.add(v)
        dist[s] = d
    return dist


def fare_for_km(km):
    k = math.ceil(round(km, 1) - 1e-9)   # 1km 未満の端数は切り上げ
    for limit, fare in FARE_TABLE:
        if k <= limit:
            return fare
    raise ValueError(f'運賃表の範囲外です: {km}km')


def build_fares(dist):
    fares = {}
    for i, a in enumerate(STATIONS):
        for b in STATIONS[i + 1:]:
            special = SPECIAL_FARES.get((a, b)) or SPECIAL_FARES.get((b, a))
            fares['|'.join(sorted([a, b]))] = special or fare_for_km(dist[a][b])
    return fares


# --- 時刻表 ---------------------------------------------------------------
def parse_table(page):
    """列車時刻表の表を [行の見出し, 発/着, セル…] の並びで返す"""
    t = page[page.find('<table class="paper_table">'):]
    t = t[:t.find('</table>')]
    rows = []
    for r in re.findall(r'<tr[^>]*>(.*?)</tr>', t, re.S):
        rows.append([html.unescape(re.sub(r'<[^>]+>', '', c)).strip()
                     for c in re.findall(r'<t[hd][^>]*>(.*?)</t[hd]>', r, re.S)])
    return rows


def parse_trains(page, stations):
    """平日に走る普通・快速の列車を [(種別, [(駅番号, 時刻(分)), ...])] で返す（stations の停車駅だけ。駅番号は stations での位置）"""
    rows = parse_table(page)
    head = {r[0]: r[2:] for r in rows if len(r) > 2 and r[1] == ''}
    names, days = head['列車名'], head['運転日']
    stops_rows = [(stations.index(NAME_FIX.get(r[0], r[0])), r[1], r[2:]) for r in rows
                  if NAME_FIX.get(r[0], r[0]) in stations and r[1] in ('発', '着')]
    trains = []
    for col in range(len(names)):
        # 特急（料金が要る）・特定日だけの列車・日付限定の時刻変更（「時変」の列）は使わない。
        # 「快速 ラビット」「特別快速」など、料金の要らない快速は使う
        if not names[col].startswith(('普通', '快速', '特別快速')) or not days[col].startswith(('平日', '全日')):
            continue
        stops, last = [], None
        for st, kind, cells in stops_rows:
            m = re.match(r'(\d{2})(\d{2})', cells[col])
            if not m:
                continue
            t = int(m.group(1)) * 60 + int(m.group(2))
            if t < 3 * 60:
                t += 24 * 60   # 深夜 0 時台以降
            if last is not None and t < last:
                t += 24 * 60
            last = t
            if stops and stops[-1][0] == st:
                stops[-1] = (st, t)   # 同じ駅の着・発が両方ある場合は発車時刻を使う
            else:
                stops.append((st, t))
        if len(stops) >= 2:
            trains.append(('local' if names[col] == '普通' else 'rapid', stops))
    return trains


def main():
    os.makedirs(HTML_DIR, exist_ok=True)
    os.makedirs(WIKI_DIR, exist_ok=True)
    lines = {}
    for line, conf in LINES.items():
        trains = []
        for name in conf['pages']:
            page = fetch(TIMETABLE_URL.format(TIMETABLE_EDITION, name), os.path.join(HTML_DIR, name + '.html'))
            trains += parse_trains(page, conf['stations'])
        print(f'時刻表（{line}）: 列車 {len(trains)} 本')
        lines[line] = {
            'stations': conf['stations'],
            # 列車: [種別, [駅番号, 時刻(分), 駅番号, 時刻(分), ...]]（最後の駅だけ到着時刻）
            'trains': [[kind, [v for s in stops for v in s]] for kind, stops in trains],
        }
    dist = build_distances()
    fares = build_fares(dist)

    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'source': 'JR東日本 列車時刻表（総武線快速・横須賀線／京浜東北線・根岸線／横浜線／東海道線、平日）・Wikipedia の営業キロ・2026年3月改定後の幹線IC運賃',
        'stations': STATIONS,
        'km': {'|'.join(sorted([a, b])): dist[a][b] for i, a in enumerate(STATIONS) for b in STATIONS[i + 1:]},
        'fares': fares,
        'lines': lines,
    }
    body = (f'// {out["generatedAt"]} に build_jr.py で生成\n'
            f'window.JR = {json.dumps(out, ensure_ascii=False, separators=(",", ":"))};\n')
    with open(OUT_FILE, 'w', encoding='utf-8') as fp:
        fp.write(body)
    print(f'運賃: {len(fares)} 区間（品川〜久里浜 {dist["品川"]["久里浜"]}km・{fares["久里浜|品川"]}円）')
    print(f'出力: {OUT_FILE}')


if __name__ == '__main__':
    main()
