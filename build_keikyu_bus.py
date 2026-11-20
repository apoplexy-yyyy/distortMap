# =====================================================================
# 京急バスの停留所・系統データを国土数値情報から作る（時刻は推定）
#
#   京急バスは時刻表のオープンデータが無く、公式の時刻表サイトは自動での収集を禁止しているため、
#   国土交通省の国土数値情報を使う:
#     - バス停留所 P11（2022 年度・CC BY 4.0）… 停留所の位置・名前・事業者・通る系統
#     - バスルート N07（2011 年度・非商用）   … 系統ごとの経路の線と、平日・土曜・休日の 1 日の運行本数
#   系統ごとに、経路の線の近く（ROUTE_NEAR_KM 以内）にある同じ系統の停留所を集め、線に沿った道のりで
#   停留所どうしをつないで順番を決める（枝分かれする系統は、端から各終点への並びに分ける）。
#   時刻は推定:
#     - 停留所間の所要時間 = 経路に沿った道のり ÷ SPEED_KMH（最低 1 分）
#     - 便は DAY_START〜DAY_END に、その系統の 1 日の運行本数（片方向あたりとみなす）を等間隔に並べる
#
#   入力: ksj/ … 国土数値情報の神奈川県のファイル（無ければ取得する）
#           https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P11-2022.html
#           https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N07-2011.html
#   出力: data/keikyu_bus.js … window.KEIKYU_BUS = { stops, patterns, fare, estimated, note }
#         （形は data/yokohama_bus.js と同じ。アプリは同じ処理で読む）
#
# 使い方（Python 3）
#   python build_keikyu_bus.py
# =====================================================================

import glob
import heapq
import json
import math
import os
import re
import subprocess
import time
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
KSJ_DIR = os.path.join(ROOT, 'ksj')
KSJ_URL = 'https://nlftp.mlit.go.jp/ksj/gml/data/'
KSJ_FILES = ['P11/P11-22/P11-22_14_SHP.zip', 'N07/N07-11/N07-11_14_GML.zip']
USER_AGENT = 'distortMap-data-collector/1.0 (personal, low-frequency)'
OUT_FILE = os.path.join(ROOT, 'data', 'keikyu_bus.js')

OPERATOR_RE = re.compile(r'京浜急行バス|京急バス')   # 2011 年は横浜京急バス・湘南京急バス・羽田京急バスなどに分かれていた
EXCLUDE_RE = re.compile(r'号$|空港|ライナー|深夜')    # 高速・空港・深夜の路線は運賃も走り方も違うので入れない
SPEED_KMH = 14         # 停車も含めた平均の速さ
DAY_START, DAY_END = 6 * 60 + 30, 22 * 60 + 30
UNKNOWN_RUNS = 999.9   # 国土数値情報で本数不明の値。不明なら DEFAULT_RUNS 本とする
DEFAULT_RUNS = 30
ROUTE_NEAR_KM = 0.06   # 経路の線からこの距離までの停留所を、その系統の停留所とする
MERGE_KM = 0.3         # 同じ名前で、この距離までの停留所（上り・下りののりば）は 1 つにまとめる
FARE = 220             # 横浜・川崎市内の均一運賃（区間制の路線もあるが、推定として一律にする）


def download():
    os.makedirs(KSJ_DIR, exist_ok=True)
    for f in KSJ_FILES:
        path = os.path.join(KSJ_DIR, os.path.basename(f))
        if not os.path.exists(path):
            r = subprocess.run(['curl', '-sfL', '-A', USER_AGENT, '-o', path, KSJ_URL + f])
            if r.returncode:
                raise SystemExit(f'取得できませんでした: {KSJ_URL + f}')
            print(f'  取得: {os.path.basename(f)}')
            time.sleep(3)
        out = path[:-4]
        if not os.path.isdir(out):
            with zipfile.ZipFile(path) as z:
                z.extractall(out)


def km(a, b):
    lat_mid = math.radians((a[0] + b[0]) / 2)
    return math.hypot((b[1] - a[1]) * 111.32 * math.cos(lat_mid), (b[0] - a[0]) * 110.57)


def read_stops():
    """P11: 京急バスの停留所 [(名前, lat, lng, {系統})]"""
    path = glob.glob(os.path.join(KSJ_DIR, 'P11-22_14_SHP', '**', '*.geojson'), recursive=True)[0]
    out = []
    for f in json.load(open(path, encoding='utf-8'))['features']:
        p = f['properties']
        if not OPERATOR_RE.search(p.get('P11_002') or ''):
            continue
        lng, lat = f['geometry']['coordinates']
        routes = set()
        for k, v in p.items():
            if k.startswith('P11_003') and v:
                routes.update(t.strip() for t in re.split(r'[・,、，\s]+', v) if t.strip())
        out.append((p['P11_001'].strip(), lat, lng, routes))
    return out


def read_routes():
    """N07（2011）: 京急バスの系統 { 系統名: { 'lines': [[(lat, lng), ...]], 'runs': (平日, 土曜, 休日) } }"""
    path = glob.glob(os.path.join(KSJ_DIR, 'N07-11_14_GML', '**', 'N07-11_14.xml'), recursive=True)[0]
    s = open(path, encoding='utf-8').read()
    curves = {}
    for cid, pos in re.findall(r'<gml:Curve gml:id="(\w+)">.*?<gml:posList>(.*?)</gml:posList>', s, re.S):
        v = [float(x) for x in pos.split()]
        curves[cid] = list(zip(v[0::2], v[1::2]))
    routes = {}
    pat = (r'<ksj:BusRoute gml:id="\w+">\s*<ksj:brt xlink:href="#(\w+)"/>\s*<ksj:bsc>\d</ksj:bsc>\s*'
           r'<ksj:boc>([^<]*)</ksj:boc>\s*<ksj:bln>([^<]*)</ksj:bln>\s*'
           r'<ksj:rpd>([\d.]+)</ksj:rpd>\s*<ksj:rps>([\d.]+)</ksj:rps>\s*<ksj:rph>([\d.]+)</ksj:rph>')
    for cid, op, name, rpd, rps, rph in re.findall(pat, s):
        name = name.strip()
        if not OPERATOR_RE.search(op) or EXCLUDE_RE.search(name) or not re.search(r'\d', name):
            continue
        r = routes.setdefault(name, {'lines': [], 'runs': (0.0, 0.0, 0.0)})
        if cid in curves:
            r['lines'].append(curves[cid])
        r['runs'] = tuple(max(a, float(b)) for a, b in zip(r['runs'], (rpd, rps, rph)))
    return routes


def route_graph(lines):
    """経路の線を、点（小数 5 桁で丸めた座標）と道のり（km）のグラフにする"""
    adj = {}
    for line in lines:
        pts = [(round(a, 5), round(b, 5)) for a, b in line]
        for p, q in zip(pts, pts[1:]):
            if p == q:
                continue
            d = km(p, q)
            adj.setdefault(p, []).append((q, d))
            adj.setdefault(q, []).append((p, d))
    return adj


def dijkstra(adj, src):
    dist = {src: 0.0}
    heap = [(0.0, src)]
    while heap:
        d, u = heapq.heappop(heap)
        if d > dist[u]:
            continue
        for v, w in adj.get(u, ()):
            nd = d + w
            if nd < dist.get(v, math.inf):
                dist[v] = nd
                heapq.heappush(heap, (nd, v))
    return dist


def order_stops(adj, stop_pts):
    """停留所（グラフ上の点）を、道のりの最小全域木でつなぎ、端から各終点への並びにする。
    戻り値: [[(停留所の番号, 始点からの道のり km), ...], ...]"""
    n = len(stop_pts)
    dist = [dijkstra(adj, p) for p in stop_pts]
    d = [[dist[i].get(stop_pts[j], math.inf) for j in range(n)] for i in range(n)]
    # 最小全域木（Prim）。つながらない停留所は捨てる
    tree = {0: []}
    best = {j: (d[0][j], 0) for j in range(1, n)}
    while best:
        j, (w, i) = min(best.items(), key=lambda kv: kv[1][0])
        if w == math.inf:
            break
        del best[j]
        tree.setdefault(i, []).append((j, w))
        tree.setdefault(j, []).append((i, w))
        for k in best:
            if d[j][k] < best[k][0]:
                best[k] = (d[j][k], j)

    def far(src):
        seen, prev, stack = {src: 0.0}, {src: None}, [src]
        while stack:
            u = stack.pop()
            for v, w in tree[u]:
                if v not in seen:
                    seen[v], prev[v] = seen[u] + w, u
                    stack.append(v)
        return seen, prev
    if len(tree) < 2:
        return []
    seen0, _ = far(next(iter(tree)))
    a = max(seen0, key=seen0.get)            # 木の一方の端
    seen, prev = far(a)
    leaves = [u for u in tree if len(tree[u]) == 1 and u != a]
    paths = []
    for leaf in leaves:
        path, u = [], leaf
        while u is not None:
            path.append((u, seen[u]))
            u = prev[u]
        paths.append(path[::-1])
    return paths


def main():
    download()
    stops_raw = read_stops()
    routes = read_routes()

    # 停留所: 同じ名前で近いもの（上り・下りののりば）をまとめる
    stops, by_name = [], {}
    pole_stop = []
    for name, lat, lng, rts in stops_raw:
        idx = None
        for i in by_name.get(name, []):
            if km((stops[i][1], stops[i][2]), (lat, lng)) <= MERGE_KM:
                idx = i
                break
        if idx is None:
            stops.append([name, lat, lng, 1])
            by_name.setdefault(name, []).append(len(stops) - 1)
            idx = len(stops) - 1
        else:
            s = stops[idx]
            n = s[3]
            s[1], s[2], s[3] = (s[1] * n + lat) / (n + 1), (s[2] * n + lng) / (n + 1), n + 1
        pole_stop.append(idx)

    patterns, used_routes, no_stops = [], 0, []
    for name, r in sorted(routes.items()):
        adj = route_graph(r['lines'])
        if not adj:
            continue
        nodes = list(adj)
        # 経路の近くの、同じ系統ののりば（系統名が P11 に無い場合は近いのりばすべて）
        near = []
        for k, (sname, lat, lng, rts) in enumerate(stops_raw):
            if not any(abs(lat - p[0]) < 0.01 and abs(lng - p[1]) < 0.012 for p in nodes[::10] or nodes):
                continue
            p = min(nodes, key=lambda q: (q[0] - lat) ** 2 + ((q[1] - lng) * 0.81) ** 2)
            if km(p, (lat, lng)) <= ROUTE_NEAR_KM:
                near.append((k, p, name in rts))
        if any(m for _, _, m in near):
            near = [x for x in near if x[2]]
        # まとめた停留所ごとに 1 点（最初ののりば）
        seen, pts, ids = set(), [], []
        for k, p, _ in near:
            if pole_stop[k] in seen:
                continue
            seen.add(pole_stop[k])
            pts.append(p)
            ids.append(pole_stop[k])
        if len(ids) < 2:
            no_stops.append(name)
            continue
        used_routes += 1
        runs = [UNKNOWN_RUNS if x >= UNKNOWN_RUNS else x for x in r['runs']]
        runs = [DEFAULT_RUNS if x >= UNKNOWN_RUNS else x for x in runs]

        def starts(n):
            n = int(round(n))
            if n < 1:
                return []
            h = (DAY_END - DAY_START) / n
            return [round(DAY_START + h * (i + 0.5)) for i in range(n)]
        weekday, holiday = starts(runs[0]), starts(runs[2])
        for path in order_stops(adj, pts):
            if len(path) < 2:
                continue
            seq = [ids[i] for i, _ in path]
            offs, t = [], 0.0
            for j, (_, dk) in enumerate(path):
                if j:
                    t += max(1.0, (dk - path[j - 1][1]) / SPEED_KMH * 60)
                offs.append(round(t))
            for s_, o_ in ((seq, offs), (seq[::-1], [offs[-1] - o for o in offs[::-1]])):
                patterns.append({'route': name, 'stops': s_, 'offsets': o_, 'weekday': weekday, 'holiday': holiday})

    used = sorted({i for p in patterns for i in p['stops']})
    renum = {old: new for new, old in enumerate(used)}
    for p in patterns:
        p['stops'] = [renum[i] for i in p['stops']]
    stop_list = [[stops[i][0], round(stops[i][1], 6), round(stops[i][2], 6)] for i in used]

    note = (f'国土数値情報（バス停留所 2022 年度・バスルート 2011 年度）の系統と 1 日の運行本数から推定。'
            f'経路に沿って時速 {SPEED_KMH} km、{DAY_START // 60}時半〜{DAY_END // 60}時半に等間隔で運行するとした')
    out = {'stops': stop_list, 'patterns': patterns, 'fare': FARE, 'estimated': True, 'note': note}
    js = ('// 京急バスの停留所・系統（build_keikyu_bus.py で生成）。出典: 国土数値情報（バス停留所 P11 2022 年度 CC BY 4.0、'
          'バスルート N07 2011 年度）（国土交通省）を加工。時刻は推定\n'
          'window.KEIKYU_BUS = ' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n')
    with open(OUT_FILE, 'w', encoding='utf-8') as fp:
        fp.write(js)
    wd = sum(len(p['weekday']) for p in patterns)
    print(f'系統 {len(routes)}（停留所が見つからないもの {len(no_stops)}）・使った系統 {used_routes}・パターン {len(patterns)}・'
          f'停留所 {len(stop_list)} / のりば {len(stops_raw)}・平日 {wd} 便 → {OUT_FILE}（{len(js.encode()) / 1e6:.2f} MB）')
    if no_stops:
        print('  停留所が見つからない系統:', ' '.join(no_stops[:40]))


if __name__ == '__main__':
    main()
