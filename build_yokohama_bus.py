# =====================================================================
# 横浜市営バスの停留所・時刻表データを作る
#
#   入力: yokohama_bus_gtfs/*.zip … 横浜市営バス GTFS（公共交通オープンデータセンター）
#           https://ckan.odpt.org/dataset/yokohama_municipal_bus
#           zip が無ければ、ODPT のアクセストークン（環境変数 ODPT_TOKEN か、ファイル .odpt_token の 1 行目）を
#           使って GTFS_DATE の版を取得して置く
#   出力: data/yokohama_bus.js … window.YOKOHAMA_BUS = { stops, patterns, fare }
#
#   便ごとに全停留所を書くと大きくなるので、「同じ系統・同じ停留所の並び・同じ所要時間」の便を
#   1 つのパターンにまとめ、パターンごとに始発の発車時刻（分）だけを持つ（平日・土休日）。
#   停留所はのりば違いを停留所名でまとめる（位置はのりばの平均）。
#
# 使い方（Python 3）
#   python build_yokohama_bus.py
# =====================================================================

import csv
import glob
import io
import json
import os
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import Counter

ROOT = os.path.dirname(os.path.abspath(__file__))
GTFS_DIR = os.path.join(ROOT, 'yokohama_bus_gtfs')
TOKEN_FILE = os.path.join(ROOT, '.odpt_token')
# ODPT の GTFS（横浜市営バス）。版（date）はデータカタログの最新のものに合わせる
GTFS_URL = 'https://api.odpt.org/api/v4/files/odpt/YokohamaMunicipal/Bus.zip'
GTFS_DATE = '20261101'
USER_AGENT = 'distortMap-data-collector/1.0 (personal, low-frequency)'
OUT_FILE = os.path.join(ROOT, 'data', 'yokohama_bus.js')
DEFAULT_FARE = 220


def odpt_token():
    token = os.environ.get('ODPT_TOKEN', '').strip()
    if not token and os.path.exists(TOKEN_FILE):
        token = open(TOKEN_FILE, encoding='utf-8').readline().strip()
    return token


def download_gtfs():
    """yokohama_bus_gtfs/ に zip が無ければ ODPT から取得する"""
    if glob.glob(os.path.join(GTFS_DIR, '*.zip')):
        return
    token = odpt_token()
    if not token:
        raise SystemExit('yokohama_bus_gtfs/ に GTFS の zip を置くか、ODPT のアクセストークンを用意してください')
    os.makedirs(GTFS_DIR, exist_ok=True)
    url = f'{GTFS_URL}?' + urllib.parse.urlencode({'date': GTFS_DATE, 'acl:consumerKey': token})
    try:
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=120) as res:
            body = res.read()
    except urllib.error.HTTPError as e:
        raise SystemExit(f'GTFS を取得できませんでした（HTTP {e.code}）。アクセストークンと GTFS_DATE を確認してください')
    except urllib.error.URLError:
        # Python の証明書ストアで TLS 検証に失敗する環境では、OS の curl で取る
        r = subprocess.run(['curl', '-sfL', '-A', USER_AGENT, url], capture_output=True)
        if r.returncode:
            raise SystemExit('GTFS を取得できませんでした。アクセストークンと GTFS_DATE を確認してください')
        body = r.stdout
    if not body.startswith(b'PK'):
        raise SystemExit('GTFS の zip ではない応答が返りました。アクセストークンと GTFS_DATE を確認してください')
    path = os.path.join(GTFS_DIR, f'YokohamaMunicipal-Bus-{GTFS_DATE}.zip')
    with open(path, 'wb') as fp:
        fp.write(body)
    print(f'  取得: ODPT の GTFS（{GTFS_DATE} 版）→ {path}')   # URL にはトークンが入るので表示しない


def minutes(hms):
    h, m, s = (int(x) for x in hms.split(':'))
    return h * 60 + m + s / 60


def main():
    download_gtfs()
    path = sorted(glob.glob(os.path.join(GTFS_DIR, '*.zip')))[-1]
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())

        def table(name):
            if name not in names:
                return []
            with z.open(name) as f:
                return list(csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig')))
        stops = table('stops.txt')
        routes = table('routes.txt')
        trips = table('trips.txt')
        stop_times = table('stop_times.txt')
        calendar = table('calendar.txt')
        fare_attrs = table('fare_attributes.txt')

    # 停留所: のりば（stop_id）を停留所名でまとめる
    by_id = {s['stop_id']: s for s in stops}
    stop_name = {}
    pos = {}
    for s in stops:
        if s.get('location_type') == '1':
            continue
        name = s['stop_name'].strip()
        stop_name[s['stop_id']] = name
        pos.setdefault(name, []).append((float(s['stop_lat']), float(s['stop_lon'])))
    names_sorted = sorted(pos)
    index = {n: i for i, n in enumerate(names_sorted)}
    stop_list = [[n, round(sum(p[0] for p in pos[n]) / len(pos[n]), 6), round(sum(p[1] for p in pos[n]) / len(pos[n]), 6)]
                 for n in names_sorted]

    route_name = {r['route_id']: (r.get('route_short_name') or r.get('route_long_name') or '').strip() for r in routes}

    # 平日: 月〜金がすべて運行日のサービス。土休日: 日曜が運行日のサービス
    services = {
        'weekday': {c['service_id'] for c in calendar if all(c.get(d) == '1' for d in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday'))},
        'holiday': {c['service_id'] for c in calendar if c.get('sunday') == '1'},
    }
    trip_info = {t['trip_id']: t for t in trips}

    by_trip = {}
    for st in stop_times:
        if st['trip_id'] in trip_info:
            by_trip.setdefault(st['trip_id'], []).append(st)

    patterns = {}   # (系統, 停留所の並び, 所要時間) -> { weekday: [], holiday: [] }
    for tid, sts in by_trip.items():
        t = trip_info[tid]
        days = [d for d, ids in services.items() if t['service_id'] in ids]
        if not days:
            continue
        sts.sort(key=lambda s: int(s['stop_sequence']))
        seq = []
        for i, s in enumerate(sts):
            tm = s['departure_time'] if i < len(sts) - 1 else s['arrival_time']
            if not tm or s['stop_id'] not in stop_name:
                continue
            idx = index[stop_name[s['stop_id']]]
            if seq and seq[-1][0] == idx:
                continue
            seq.append((idx, minutes(tm)))
        if len(seq) < 2:
            continue
        start = seq[0][1]
        key = (route_name.get(t['route_id'], ''), tuple(i for i, _ in seq), tuple(round(m - start) for _, m in seq))
        p = patterns.setdefault(key, {'weekday': [], 'holiday': []})
        for d in days:
            p[d].append(round(start))

    out_patterns = []
    for (route, seq, offs), p in sorted(patterns.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        out_patterns.append({'route': route, 'stops': list(seq), 'offsets': list(offs),
                             'weekday': sorted(p['weekday']), 'holiday': sorted(p['holiday'])})

    prices = Counter(round(float(f['price'])) for f in fare_attrs if f.get('price'))
    fare = prices.most_common(1)[0][0] if prices else DEFAULT_FARE
    if len(prices) > 1:
        print(f'  運賃が均一ではありません（{dict(prices)}）。最も多い {fare} 円を使います')

    data = {'stops': stop_list, 'patterns': out_patterns, 'fare': fare}
    js = ('// 横浜市営バスの停留所・時刻表（build_yokohama_bus.py で生成。'
          f'出典: 公共交通オープンデータセンター 横浜市営バス GTFS {os.path.basename(path)}）\n'
          'window.YOKOHAMA_BUS = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n')
    with open(OUT_FILE, 'w', encoding='utf-8') as fp:
        fp.write(js)
    wd = sum(len(p['weekday']) for p in out_patterns)
    hd = sum(len(p['holiday']) for p in out_patterns)
    print(f'停留所 {len(stop_list)}・系統 {len({p["route"] for p in out_patterns})}・パターン {len(out_patterns)}・'
          f'平日 {wd} 便・土休日 {hd} 便・運賃 {fare} 円 → {OUT_FILE}（{len(js.encode()) / 1e6:.1f} MB）')


if __name__ == '__main__':
    main()
