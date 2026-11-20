# =====================================================================
# 京急バスの停留所・系統データを OpenStreetMap から作る（時刻は推定）
#
#   京急バスは時刻表のオープンデータが無く、公式の時刻表サイトは自動での収集を禁止しているため、
#   OpenStreetMap（© OpenStreetMap contributors, ODbL）の路線（route=bus）の停留所の並びと位置だけを使い、
#   時刻は次のように推定する:
#     - 停留所間の所要時間 = 直線距離 × DETOUR ÷ SPEED_KMH（最低 1 分）
#     - 便は FIRST〜LAST に HEADWAY_MIN 分おき（平日・土休日とも同じ）。待ち時間は平均で HEADWAY_MIN / 2 分
#
#   入力: keikyu_bus_osm/routes.json … Overpass API の結果（無ければ取得する）
#   出力: data/keikyu_bus.js … window.KEIKYU_BUS = { stops, patterns, fare, estimated }
#         （形は data/yokohama_bus.js と同じ。アプリは同じ処理で読む）
#
# 使い方（Python 3）
#   python build_keikyu_bus.py          # 取得済みの routes.json があればそれを使う
#   python build_keikyu_bus.py --fetch  # 取り直す
# =====================================================================

import json
import math
import os
import subprocess
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
OSM_DIR = os.path.join(ROOT, 'keikyu_bus_osm')
OSM_FILE = os.path.join(OSM_DIR, 'routes.json')
OUT_FILE = os.path.join(ROOT, 'data', 'keikyu_bus.js')
OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
USER_AGENT = 'distortMap-data-collector/1.0 (personal, low-frequency)'
BBOX = (35.15, 139.30, 35.68, 139.82)   # アプリの駅の範囲（南, 西, 北, 東）より少し広く
OPERATOR_RE = '京浜急行バス|京急バス|羽田京急バス|横浜京急バス|湘南京急バス'

SPEED_KMH = 14        # 停車も含めた平均の速さ
DETOUR = 1.3          # 道なりの距離 ≒ 直線距離 × 1.3
HEADWAY_MIN = 15      # 推定の運行間隔
FIRST, LAST = 6 * 60, 23 * 60
FARE = 220            # 横浜・川崎市内の均一運賃（区間制の路線もあるが、推定として一律にする）
MERGE_KM = 0.4        # 同じ名前で、この距離までの停留所は 1 つにまとめる
EXCLUDE_WORDS = ('リムジン', 'YCAT', '羽田空港', '国内線間')


def fetch():
    q = (f'[out:json][timeout:180];('
         f'rel["route"="bus"]["operator"~"{OPERATOR_RE}"]{BBOX};'
         f'rel["route"="bus"]["network"~"{OPERATOR_RE}"]{BBOX};'
         f');out body;node(r);out body qt;')   # 路線と、その停留所（名前つき）だけ
    body = urllib.parse.urlencode({'data': q}).encode()
    try:
        req = urllib.request.Request(OVERPASS_URL, data=body, headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=240) as res:
            raw = res.read()
    except urllib.error.URLError:
        r = subprocess.run(['curl', '-sf', '-A', USER_AGENT, '--data-binary', '@-', OVERPASS_URL],
                           input=body, capture_output=True)
        if r.returncode:
            raise SystemExit('Overpass API から取得できませんでした')
        raw = r.stdout
    os.makedirs(OSM_DIR, exist_ok=True)
    with open(OSM_FILE, 'wb') as fp:
        fp.write(raw)


def km(a, b):
    lat_mid = math.radians((a[0] + b[0]) / 2)
    return math.hypot((b[1] - a[1]) * 111.32 * math.cos(lat_mid), (b[0] - a[0]) * 110.57)


def main():
    if '--fetch' in sys.argv or not os.path.exists(OSM_FILE):
        fetch()
    data = json.load(open(OSM_FILE, encoding='utf-8'))
    nodes = {e['id']: e for e in data['elements'] if e['type'] == 'node'}
    rels = [e for e in data['elements'] if e['type'] == 'relation']

    stops = []      # [名前, lat, lng, 件数]
    by_name = {}    # 名前 -> [stops の番号]

    def stop_index(name, lat, lng):
        for i in by_name.get(name, []):
            s = stops[i]
            if km((s[1], s[2]), (lat, lng)) <= MERGE_KM:
                n = s[3]
                s[1], s[2], s[3] = (s[1] * n + lat) / (n + 1), (s[2] * n + lng) / (n + 1), n + 1
                return i
        stops.append([name, lat, lng, 1])
        by_name.setdefault(name, []).append(len(stops) - 1)
        return len(stops) - 1

    patterns = {}
    skipped = 0
    for r in rels:
        tags = r.get('tags', {})
        route = (tags.get('ref') or tags.get('name') or '').strip()
        # 空港リムジン・空港内の連絡バスは運賃も走り方も違うので入れない
        if any(w in (route + tags.get('name', '')) for w in EXCLUDE_WORDS):
            continue
        # 停留所: 役割が platform のもの（名前がある）を優先し、無ければ stop
        members = [m for m in r['members'] if m['type'] == 'node' and m['ref'] in nodes]
        plats = [m for m in members if m['role'].startswith('platform')]
        cand = plats if len(plats) >= 2 else [m for m in members if m['role'].startswith('stop')]
        seq = []
        for m in cand:
            n = nodes[m['ref']]
            name = (n.get('tags', {}).get('name') or '').strip()
            if not name:
                continue
            idx = stop_index(name, n['lat'], n['lon'])
            if not seq or seq[-1] != idx:
                seq.append(idx)
        if len(seq) < 2:
            skipped += 1
            continue
        offs, t = [0], 0.0
        for a, b in zip(seq, seq[1:]):
            d = km((stops[a][1], stops[a][2]), (stops[b][1], stops[b][2]))
            t += max(1.0, d * DETOUR / SPEED_KMH * 60)
            offs.append(round(t))
        patterns.setdefault((route, tuple(seq)), offs)

    starts = list(range(FIRST, LAST, HEADWAY_MIN))
    out_patterns = [{'route': route, 'stops': list(seq), 'offsets': offs, 'weekday': starts, 'holiday': starts}
                    for (route, seq), offs in sorted(patterns.items())]
    # 使われた停留所だけを残して番号を振り直す
    used = sorted({i for p in out_patterns for i in p['stops']})
    renum = {old: new for new, old in enumerate(used)}
    for p in out_patterns:
        p['stops'] = [renum[i] for i in p['stops']]
    stop_list = [[stops[i][0], round(stops[i][1], 6), round(stops[i][2], 6)] for i in used]

    out = {'stops': stop_list, 'patterns': out_patterns, 'fare': FARE, 'estimated': True,
           'headway': HEADWAY_MIN, 'speedKmh': SPEED_KMH}
    js = ('// 京急バスの停留所・系統（build_keikyu_bus.py で生成）。停留所と系統は © OpenStreetMap contributors（ODbL）。\n'
          f'// 時刻は推定: 停留所間は直線距離×{DETOUR}を時速{SPEED_KMH}km、{HEADWAY_MIN}分おきの運行とした\n'
          'window.KEIKYU_BUS = ' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n')
    with open(OUT_FILE, 'w', encoding='utf-8') as fp:
        fp.write(js)
    print(f'路線 {len(rels)}（停留所が足りず使わないもの {skipped}）・パターン {len(out_patterns)}・'
          f'系統 {len({p["route"] for p in out_patterns})}・停留所 {len(stop_list)} → {OUT_FILE}（{len(js.encode()) / 1e6:.2f} MB）')


if __name__ == '__main__':
    main()
