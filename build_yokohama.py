# =====================================================================
# 横浜市営地下鉄（ブルーライン・グリーンライン）の運賃・時刻表データを作る
#
#   入力: yokohama_pdf/fare.pdf … 普通旅客運賃表（横浜市交通局）
#           https://www.city.yokohama.lg.jp/kotsu/sub/unchin/sub_unchin.files/0012_20230927.pdf
#         yokohama_gtfs/*.zip  … 横浜市営地下鉄 GTFS（公共交通オープンデータセンター）
#           https://ckan.odpt.org/dataset/yokohama_municipal_train
#           yokohama_gtfs/ に zip が無ければ、ODPT のアクセストークン（環境変数 ODPT_TOKEN か、
#           ファイル .odpt_token の 1 行目）を使って GTFS_DATE の版を取得して置く。
#           トークンが無ければ手動でダウンロードして置く（どちらも無い場合は運賃だけ出力）
#   出力: data/yokohama.js … window.YOKOHAMA = { stations, fares, trains }
#
#   運賃表 PDF は画像なので、マスを切り出して数字の形をまとめ（同じ形 = 同じ数字）、
#   目で読んだいくつかのマスを手がかりに 0〜9 を割り当てる。
#   表の右上が IC 運賃、左下がきっぷ運賃なので、両者の対応で読み取り結果を検証する。
#
# 使い方（Python 3 + PyMuPDF + Pillow + NumPy）
#   pip install pymupdf pillow numpy
#   python build_yokohama.py
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
from datetime import date, datetime, timezone

import numpy as np
import pymupdf
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
FARE_PDF = os.path.join(ROOT, 'yokohama_pdf', 'fare.pdf')
GTFS_DIR = os.path.join(ROOT, 'yokohama_gtfs')
TOKEN_FILE = os.path.join(ROOT, '.odpt_token')
# ODPT の GTFS（横浜市営地下鉄）。版（date）はデータカタログの最新のものに合わせる
GTFS_URL = 'https://api.odpt.org/api/v4/files/odpt/YokohamaMunicipal/Train.zip'
GTFS_DATE = '20251226'
USER_AGENT = 'distortMap-data-collector/1.0 (personal, low-frequency)'
OUT_FILE = os.path.join(ROOT, 'data', 'yokohama.js')

# 運賃表の対角線に並ぶ駅（上から順）。センター南・北はブルーラインとグリーンラインの両方に出てくる
FARE_ORDER = ('あざみ野 中川 センター北 センター南 仲町台 新羽 北新横浜 新横浜 岸根公園 片倉町 三ツ沢上町 '
              '三ツ沢下町 横浜 高島町 桜木町 関内 伊勢佐木長者町 阪東橋 吉野町 蒔田 弘明寺 上大岡 港南中央 '
              '上永谷 下永谷 舞岡 戸塚 踊場 中田 立場 下飯田 湘南台 '
              '中山 川和町 都筑ふれあいの丘 センター南 センター北 北山田 東山田 高田 日吉本町 日吉').split()

IC = [210, 242, 272, 304, 335, 367, 398, 430, 462, 492, 524, 555]     # IC 運賃（1 円単位）
TICKET = [210, 250, 280, 310, 340, 370, 400, 430, 470, 500, 530, 560]  # きっぷ運賃（10 円単位）
IC_TO_TICKET = dict(zip(IC, TICKET))

# 表のマス目（埋め込み画像 2382×1684 px 上の位置）
GRID_X0, GRID_DX = 83, 54
GRID_Y0, GRID_Y1 = 136, 1476
N = len(FARE_ORDER)

# 目で読んで確かめたマス（行, 列）: 値 … 数字の形に 0〜9 を割り当てる手がかり
ANCHORS = {
    (0, 1): 210, (0, 2): 242, (0, 5): 272, (0, 8): 304, (0, 10): 335,
    (1, 0): 210, (2, 0): 250, (5, 0): 280,
}


# --- 運賃表（画像）の読み取り ------------------------------------------------
def load_fare_image():
    doc = pymupdf.open(FARE_PDF)
    xref = doc[0].get_images()[0][0]
    pix = pymupdf.Pixmap(doc, xref)
    img = Image.open(io.BytesIO(pix.tobytes('png'))).convert('L')
    return np.asarray(img).astype(int)


def cell_glyphs(im, r, c):
    """マス (r, c) の黒い部分を、左から 1 文字ずつ切り出す"""
    y0 = round(GRID_Y0 + (GRID_Y1 - GRID_Y0) / N * r)
    y1 = round(GRID_Y0 + (GRID_Y1 - GRID_Y0) / N * (r + 1))
    x0, x1 = GRID_X0 + GRID_DX * c, GRID_X0 + GRID_DX * (c + 1)
    a = im[y0 + 4:y1 - 3, x0 + 5:x1 - 4] < 110
    cols = a.any(0)
    glyphs, x = [], 0
    while x < len(cols):
        if cols[x]:
            s = x
            while x < len(cols) and cols[x]:
                x += 1
            g = a[:, s:x]
            ys = np.where(g.any(1))[0]
            g = g[ys[0]:ys[-1] + 1]
            glyphs.append(np.asarray(Image.fromarray((g * 255).astype(np.uint8)).resize((10, 16), Image.BILINEAR)) / 255)
        else:
            x += 1
    return glyphs


def read_fares():
    im = load_fare_image()
    protos, cells = [], {}
    for r in range(N):
        for c in range(N):
            if r == c:
                continue
            ids = []
            for g in cell_glyphs(im, r, c):
                d = [np.abs(g - p).mean() for p in protos]
                if d and min(d) < 0.08:
                    ids.append(int(np.argmin(d)))
                else:
                    protos.append(g)
                    ids.append(len(protos) - 1)
            cells[(r, c)] = ids
    # 同じ形のまとまりに数字を割り当てる: 手がかりのマスから決め、残りは「正しい運賃になるマスが最も多い」数字
    digit = {}
    for (r, c), v in ANCHORS.items():
        for i, ch in zip(cells[(r, c)], str(v)):
            digit[i] = int(ch)

    def value(ids, m):
        if len(ids) != 3 or any(i not in m for i in ids):
            return None
        return m[ids[0]] * 100 + m[ids[1]] * 10 + m[ids[2]]

    def score(m):
        s = 0
        for (r, c), ids in cells.items():
            v = value(ids, m)
            if v is None:
                continue
            s += 1 if v in (IC if c > r else TICKET) else -5
            if c > r and IC_TO_TICKET.get(v) == value(cells[(c, r)], m):
                s += 2
        return s

    for _ in range(3):
        for i in range(len(protos)):
            if i not in digit or (i, 'auto') in digit:
                best = max(range(10), key=lambda dg: score({**digit, i: dg}))
                digit[i] = best
                digit[(i, 'auto')] = True
    m = {k: v for k, v in digit.items() if isinstance(k, int)}

    fares = {}
    for (r, c), ids in cells.items():
        if c < r:
            continue
        if len(ids) != 3:
            continue   # 斜線のマス（センター南・北どうし = 同じ駅）
        ic, ticket = value(ids, m), value(cells[(c, r)], m)
        if ic not in IC or IC_TO_TICKET[ic] != ticket:
            raise ValueError(f'運賃の読み取りに失敗: {FARE_ORDER[r]}→{FARE_ORDER[c]} IC={ic} きっぷ={ticket}')
        a, b = FARE_ORDER[r], FARE_ORDER[c]
        if a == b:
            continue
        key = '|'.join(sorted([a, b]))
        fares[key] = min(fares.get(key, ic), ic)
    return fares


# --- 時刻表（GTFS） ---------------------------------------------------------
def odpt_token():
    token = os.environ.get('ODPT_TOKEN', '').strip()
    if not token and os.path.exists(TOKEN_FILE):
        token = open(TOKEN_FILE, encoding='utf-8').readline().strip()
    return token


def download_gtfs():
    """yokohama_gtfs/ に zip が無ければ ODPT から取得する。取得したら True"""
    if glob.glob(os.path.join(GTFS_DIR, '*.zip')):
        return False
    token = odpt_token()
    if not token:
        return False
    os.makedirs(GTFS_DIR, exist_ok=True)
    url = f'{GTFS_URL}?' + urllib.parse.urlencode({'date': GTFS_DATE, 'acl:consumerKey': token})
    try:
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as res:
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
    path = os.path.join(GTFS_DIR, f'YokohamaMunicipal-Train-{GTFS_DATE}.zip')
    with open(path, 'wb') as fp:
        fp.write(body)
    print(f'  取得: ODPT の GTFS（{GTFS_DATE} 版）→ {path}')   # URL にはトークンが入るので表示しない
    return True


def read_gtfs():
    zips = sorted(glob.glob(os.path.join(GTFS_DIR, '*.zip')))
    if not zips:
        return None
    path = zips[-1]
    with zipfile.ZipFile(path) as z:
        def table(name):
            with z.open(name) as f:
                return list(csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig')))
        names = set(z.namelist())
        stops = table('stops.txt')
        trips = table('trips.txt')
        stop_times = table('stop_times.txt')
        calendar = table('calendar.txt') if 'calendar.txt' in names else []
        calendar_dates = table('calendar_dates.txt') if 'calendar_dates.txt' in names else []

    # 駅名: 親駅（location_type=1）があればその名前、なければ停留所名。末尾の「駅」は取る
    by_id = {s['stop_id']: s for s in stops}

    def station_name(stop_id):
        s = by_id[stop_id]
        if s.get('parent_station') and s['parent_station'] in by_id:
            s = by_id[s['parent_station']]
        return s['stop_name'].strip().removesuffix('駅')

    # 平日ダイヤ: 月〜金がすべて運行日のサービス
    weekday = {c['service_id'] for c in calendar
               if all(c.get(d) == '1' for d in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday'))}
    if not weekday and calendar_dates:
        # calendar_dates.txt だけの場合: 運行日として載っている最初の水曜日のサービスを平日とみなす
        days = sorted({c['date'] for c in calendar_dates if c.get('exception_type') == '1'
                       and date(int(c['date'][:4]), int(c['date'][4:6]), int(c['date'][6:])).weekday() == 2})
        if days:
            weekday = {c['service_id'] for c in calendar_dates if c['date'] == days[0] and c.get('exception_type') == '1'}
    trip_ok = {t['trip_id']: t for t in trips if not weekday or t['service_id'] in weekday}

    def minutes(hms):
        h, m, s = (int(x) for x in hms.split(':'))
        return h * 60 + m + s / 60

    by_trip = {}
    for st in stop_times:
        if st['trip_id'] in trip_ok:
            by_trip.setdefault(st['trip_id'], []).append(st)
    trains = []
    for tid, sts in by_trip.items():
        sts.sort(key=lambda s: int(s['stop_sequence']))
        # 時刻の無い行は通過駅（快速が停まらない駅。乗り降りできない）なので使わない
        sts = [s for s in sts if s['departure_time'] and s['arrival_time']
               and not (s.get('pickup_type') == '1' and s.get('drop_off_type') == '1')]
        seq = []
        for i, s in enumerate(sts):
            t = s['departure_time'] if i < len(sts) - 1 else s['arrival_time']
            seq.append((station_name(s['stop_id']), round(minutes(t), 2)))
        if len(seq) >= 2:
            trains.append((trip_ok[tid].get('route_id', ''), seq))
    return {'file': os.path.basename(path), 'trains': trains}


def main():
    fares = read_fares()
    download_gtfs()
    gtfs = read_gtfs()

    stations = sorted(set(FARE_ORDER), key=FARE_ORDER.index)
    trains = []
    if gtfs:
        unknown = {n for _, seq in gtfs['trains'] for n, _ in seq if n not in stations}
        if unknown:
            raise ValueError(f'GTFS の駅名が運賃表と一致しません: {sorted(unknown)}')
        index = {n: i for i, n in enumerate(stations)}
        # 列車: [路線ID, [駅番号, 時刻(分), 駅番号, 時刻(分), ...]]（最後の駅だけ到着時刻）
        trains = [[route, [v for n, t in seq for v in (index[n], t)]] for route, seq in gtfs['trains']]

    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'source': '横浜市交通局 普通旅客運賃表（IC運賃）' + (f'・横浜市営地下鉄 GTFS {gtfs["file"]}（平日）' if gtfs else ''),
        'stations': stations,
        'fares': fares,
        'trains': trains,
    }
    body = (f'// {out["generatedAt"]} に build_yokohama.py で生成\n'
            f'window.YOKOHAMA = {json.dumps(out, ensure_ascii=False, separators=(",", ":"))};\n')
    with open(OUT_FILE, 'w', encoding='utf-8') as fp:
        fp.write(body)
    print(f'運賃: {len(fares)} 区間')
    print(f'時刻表: ' + (f'{gtfs["file"]} から列車 {len(trains)} 本' if gtfs
                       else f'GTFS がありません（{GTFS_DIR} に zip を置いてください）'))
    print(f'出力: {OUT_FILE}')


if __name__ == '__main__':
    main()
