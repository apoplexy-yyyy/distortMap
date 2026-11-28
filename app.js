// =====================================================================
// 時間地図・運賃地図
//   - 駅と隣接関係        : data/network.js（scrape.js で生成）
//   - 京急の駅間の時間・運賃 : data/keikyu.js（build_keikyu.py で京急の時刻表・運賃表 PDF から生成）
//   - 横浜市営地下鉄         : data/yokohama.js（build_yokohama.py で運賃表 PDF・GTFS から生成）
//   - 金沢シーサイドライン   : data/seaside.js（build_seaside.py で運賃表 PDF・各駅時刻表から生成）
//   - 相鉄線（本線・いずみ野線・相鉄新横浜線）: data/sotetsu.js（build_sotetsu.py で列車時刻表 PDF・運賃表 PDF から生成）
//   - 東急東横線（渋谷〜横浜）・東急新横浜線（日吉〜新横浜）: data/tokyu.js（build_tokyu.py で各駅の時刻表 PDF・運賃表・Wikipedia の営業キロから生成）
//   - みなとみらい線         : data/minatomirai.js（build_minatomirai.py で各駅の時刻表 PDF・運賃ページから生成）
//   - JR 横須賀線（品川〜久里浜）・根岸線（横浜〜大船）・横浜線（東神奈川〜八王子）・東海道線（品川〜辻堂）: data/jr.js（build_jr.py で JR東日本の列車時刻表・Wikipedia の営業キロから生成）
//   - 事業者・路線の間は、同じ名前の駅（品川・横浜・戸塚・大船・桜木町・関内・新杉田・上大岡・弘明寺・金沢八景）で乗り換えるものとして計算する
//
//   実地図     : 緯度経度をそのまま投影（地図と同じ配置）
//   時間地図   : 中心駅から電車でかかる時間を中心からの距離にする（方角は地図と同じ）
//   運賃地図   : 中心駅からの運賃を中心からの距離にする（方角は地図と同じ）
//   歪み強度 s : 中心からの距離 r = (1 - s) * 実距離 + s * k * 値
//                （k は全駅の平均で縮尺をそろえる係数。s=100% で r は値に正比例）
// =====================================================================

// --- 1. 設定 ---------------------------------------------------------

// 時刻表データの代わりに、OpenStreetMap の路線から推定した時刻表（data/osm_estimate.js）を使うか。
// URL の #…&src=osm で切り替える（操作バーの「データ」）。推定のときは神奈川県全域の鉄道だけで、バス・運賃は無い
const ESTIMATE = new URLSearchParams(location.hash.slice(1)).get('src') === 'osm' && !!window.OSM_EST;
if (ESTIMATE) window.NETWORK = window.OSM_EST.network;
const DEFAULT_CENTER_NAME = '金沢八景';

// 所要時間は平日 10〜15 時台に中心駅を出る列車で計算する。
// 各時台の最短所要時間を求め、その中央値を採用（データの読み取りミスに強くするため）
const TIME_WINDOW_HOURS = [10, 11, 12, 13, 14, 15];
const DWELL_MIN = 0.5;      // 京急の時刻表は発車時刻なので、到着は発車の 30 秒前とみなす

// 事業者をまたぐ乗換にかかる時間（分）。弘明寺は京急と地下鉄の駅が離れている
// センター北・センター南のブルーラインとグリーンラインは同じ駅の乗換（推定のときは別の路線になるので使う。時刻表データでは同じ事業者）
const TRANSFER_MIN = { '横浜': 6, '上大岡': 4, '弘明寺': 10, '金沢八景': 4, '菊名': 3, 'センター北': 3, 'センター南': 3 };
const TRANSFER_DEFAULT_MIN = 5;   // 品川・戸塚・大船・桜木町・関内・新杉田・日吉（JR などと他の路線）もこれを使う
// 特定の事業者の組み合わせだけ乗換時間が違う駅: 「駅名|事業者の key|事業者の key」（key は文字列順に並べる）
//   直通運転（同じ列車のまま）: 横浜の東横線とみなとみらい線、日吉の東横線と東急新横浜線、新横浜の東急新横浜線と相鉄線
//   武蔵小杉の東横線と JR 横須賀線は駅が離れている
const PAIR_TRANSFER_MIN = {
    '横浜|minatomirai|tokyu-東横線': 0, '日吉|tokyu-新横浜線|tokyu-東横線': 0, '新横浜|sotetsu|tokyu-新横浜線': 0,
    '武蔵小杉|jr-横須賀線|tokyu-東横線': 10,
};
// 駅名の違う駅どうしの徒歩連絡（分）。京急の杉田とシーサイドラインの新杉田は約 400m、
// JR の逗子と京急の逗子・葉山、JR の久里浜と京急久里浜はそれぞれ約 300m、
// みなとみらい線の元町・中華街と JR の石川町は約 500m、JR の東神奈川と京急東神奈川は連絡橋で約 200m、
// JR の川崎と京急川崎は約 400m
const WALK_TRANSFERS = [
    { a: '杉田', b: '新杉田', min: 7 },
    { a: '逗子', b: '逗子・葉山', min: 6 },
    { a: '久里浜', b: '京急久里浜', min: 6 },
    { a: '元町・中華街', b: '石川町', min: 8 },
    { a: '東神奈川', b: '京急東神奈川', min: 4 },
    { a: '川崎', b: '京急川崎', min: 6 },
];

const LINE_COLORS = {
    '横浜市ブルーライン': '#0068b7',
    'グリーンライン': '#00a960',
    '金沢シーサイドライン': '#00a3d9',
    'JR横須賀線': '#1d2a6e',   // ラインカラーの青はブルーラインと見分けにくいので紺にする
    'JR根岸線': '#e08a00',     // ラインカラーの水色はシーサイドラインと見分けにくいので橙にする
    '横浜みなとみらい線': '#9b3fb5',   // 紺は横須賀線と見分けにくいので紫にする
    'JR横浜線': '#8fc31f',
    'JR東海道本線': '#b38f00',   // ラインカラーの橙は根岸線と見分けにくいので黄土色にする
    '東急東横線': '#e85298',   // ラインカラーの赤は京急と見分けにくいので桃色にする
    '東急新横浜線': '#a3225e',   // 他の路線と見分けやすい色
    // 相鉄の紺はブルーライン・横須賀線と見分けにくいので茶色にする
    '相模鉄道本線': '#8c6239', '相模鉄道いずみ野線': '#8c6239', '相模鉄道・東京急行電鉄': '#8c6239',
    '徒歩': '#777777'
};
const LINE_DISPLAY_NAMES = {
    '横浜市ブルーライン': '横浜市営地下鉄ブルーライン',
    'グリーンライン': '横浜市営地下鉄グリーンライン',
    '金沢シーサイドライン': 'シーサイドライン',
    '横浜みなとみらい線': 'みなとみらい線',
    'JR東海道本線': 'JR東海道線'
};
const COMPANY_COLORS = [
    [/^京急/, '#E60012'],
    [/^東急/, '#da0442'],
    [/^東京メトロ/, '#149dd3'],
    [/^都営/, '#3cb371'],
    [/^JR/, '#ff6b6b']
];
const FALLBACK_COLORS = ['#45b7d1', '#4ecdc4', '#9b59b6', '#f39c12', '#16a085', '#7f8c8d'];

// --- 2. 状態 ---------------------------------------------------------
let stations = [];          // { id, name, lat, lng, prefecture, lines[] , geo:{x,y,r,angle} }
let edges = [];             // { source, target, line }
let lineNames = [];
let currentMode = 'distance';
let distortionStrength = 1;
let centerId = null;
let routeData = {};         // centerId -> { stationId: { time, fare, source } | null }
const hiddenLines = new Set();   // 凡例のクリックで隠した路線（表示用の路線名。徒歩連絡は「徒歩」）
let dayType = 'weekday';    // 'weekday'（平日ダイヤ）か 'holiday'（土休日ダイヤ）
let departTime = null;      // 出発時刻（0 時からの分。0:00〜3:59 は 24:00〜27:59）。null は日中（10〜15 時台）の値
let travel = 'train';       // 交通手段: 'train'（電車）・'car'（車。data/car.js の駅×駅の表）
let useHighway = true;      // 車で高速道路（有料）を使うか
let timeStat = 'min';       // 出発時刻を決めないときの値: 'min'（最小。既定）・'median'（平均）・'max'（最大）

let svg, rootLayer, ringLayer, linkSel, nodeSel, labelSel;
let landmarks = [];         // 表示中のランドマーク（landmarks.js の LandmarkStore.visibleItems() に位置・近い駅を足したもの）
let landmarkSel, landmarkLabelSel;
let busStops = [];          // バスの停留所 { id: ノード名, uid, name, lat, lng, routes[], label, color, isBus }
let busLinks = [];          // バスの停留所どうしの線（同じ系統で隣り合う停留所）{ s, t, label, color }
let busSel, busHitSel, busLinkSel;
let zoomBehavior = null;    // d3.zoom（共有 URL の拡大・移動を戻すときに使う）
let shareReady = false;     // 共有 URL から表示を戻し終わるまでは URL を書き換えない
let view3dReady = false;    // 3D 表示が使えるか
let zoomK = 1;              // 現在の拡大率
let zoomScale = 1;         // 1 / 拡大率（拡大時に記号・文字を小さく描いて画面上の大きさを保つ）

// --- 3. ユーティリティ -------------------------------------------------
function setStatus(text, kind = 'info') {
    const el = document.getElementById('status');
    el.textContent = text;
    el.title = text;   // 1 行に収まらず省略されたときも、マウスを乗せれば全文が見える
    el.className = 'status status-' + kind;
}

function lineColor(line) {
    if (LINE_COLORS[line]) return LINE_COLORS[line];
    for (const [re, c] of COMPANY_COLORS) if (re.test(line)) return c;
    const i = lineNames.indexOf(line);
    return FALLBACK_COLORS[(i < 0 ? 0 : i) % FALLBACK_COLORS.length];
}

// 表示用の路線名（京急の各線は「京急線」、相鉄の各線は「相鉄線」にまとめる）
const displayLine = line => (/^京急/.test(line) ? '京急線' : /^相模鉄道/.test(line) ? '相鉄線' : LINE_DISPLAY_NAMES[line] || line);
const displayLines = lines => [...new Set(lines.map(displayLine))];
// 凡例で隠した路線の駅・線は描かない（中心駅は常に描く。乗換駅はどれかの路線が出ていれば描く）
const lineShown = line => !hiddenLines.has(line === '徒歩' ? '徒歩' : displayLine(line));
const stationShown = s => s.id === centerId || s.lines.some(lineShown);
const edgeShown = (e, byId) => lineShown(e.line) && stationShown(byId[e.source]) && stationShown(byId[e.target]);

const pairKey = (a, b) => [a, b].sort().join('|');
const median = arr => {
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// --- 4. 時刻表・運賃データ（事業者ごと） ----------------------------------
// 路線ごとの列車と、会社全体の運賃表を持つデータ（data/jr.js・data/tokyu.js）を、路線ごとの事業者に分ける
function lineOperators(data, key, label) {
    return Object.entries((data && data.lines) || {}).map(([line, l]) => ({
        key: key + '-' + line, label, fareGroup: key, dwell: DWELL_MIN,
        data: { stations: l.stations, trains: l.trains, trainsHoliday: l.trainsHoliday, fares: data.fares, fareStations: data.stations },
    }));
}
// バス（data/yokohama_bus.js・data/keikyu_bus.js）。停留所のノード名は「bus:停留所名」（同じ名前の駅とはまとめない。
// 別の事業者の同じ名前の停留所どうしは乗換でつながる）。同じ事業者に同じ名前の停留所が離れて 2 つ以上あれば「#番号」を付けて分ける。
// パターン（同じ停留所の並び・所要時間の便）を便ごとの列車データの形に広げる
const BUS_SOURCES = [
    { key: 'bus', label: '市営バス', color: '#2b8a3e', data: window.YOKOHAMA_BUS },
    // 京急バスは時刻表のオープンデータが無いので、国土数値情報の系統・運行本数から推定した時刻（build_keikyu_bus.py）
    { key: 'kbus', label: '京急バス（推定）', color: '#e8590c', data: window.KEIKYU_BUS },
].filter(b => b.data && !ESTIMATE);
BUS_SOURCES.forEach(b => {
    const count = {};
    b.data.stops.forEach(s => (count[s[0]] = (count[s[0]] || 0) + 1));
    b.nodeNames = b.data.stops.map((s, i) => 'bus:' + s[0] + (count[s[0]] > 1 ? '#' + i : ''));
});
const BUS_TRANSFER_KM = 0.8;   // 駅からこの距離（直線）までのバス停に歩いて乗り換えられる
const BUS_WALK_KM = 0.4;       // バス停どうしは、この距離（直線）まで歩ける
const BUS_LINK_DETOUR = 1.3;
const nodeLabel = name => name.replace(/^bus:/, '').replace(/#\d+$/, '');
function busTrains(data, day) {
    const trains = [];
    data.patterns.forEach(p => p[day].forEach(t0 => trains.push([p.route, p.stops.flatMap((s, i) => [s, t0 + p.offsets[i]])])));
    return trains;
}

// 事業者ごとの駅は「事業者|駅名」のノードとして扱い、同じ駅名どうしは乗換でつなぐ
const OPERATORS = (ESTIMATE ? estimateOperators() : [
    { key: 'keikyu', label: '京急', data: window.KEIKYU, dwell: DWELL_MIN },
    // GTFS は到着時刻が正確なので、発車＝到着として扱う
    { key: 'yokohama', label: '横浜市営地下鉄', data: window.YOKOHAMA, dwell: 0 },
    { key: 'seaside', label: 'シーサイドライン', data: window.SEASIDE, dwell: DWELL_MIN },
    { key: 'minatomirai', label: 'みなとみらい線', data: window.MINATOMIRAI, dwell: DWELL_MIN },
    { key: 'sotetsu', label: '相鉄', data: window.SOTETSU, dwell: DWELL_MIN },
    // JR・東急は路線ごとに分け（同じ駅での路線間の乗換に時間がかかるように）、運賃は会社全体で 1 回の乗車として数える
    ...lineOperators(window.TOKYU, 'tokyu', '東急'),
    ...lineOperators(window.JR, 'jr', 'JR'),
    // バスは均一運賃で、乗るたびに払う
    ...BUS_SOURCES.map(b => ({ key: b.key, label: b.label, kind: 'bus', dwell: 0, flatFare: b.data.fare,
        data: { stations: b.nodeNames, trains: busTrains(b.data, 'weekday'), trainsHoliday: busTrains(b.data, 'holiday') } })),
]).filter(op => op && op.data);
// 推定の時刻表（OSM の路線ごと。運賃は無い）
function estimateOperators() {
    return Object.entries(window.OSM_EST.lines).map(([line, l]) => ({
        key: 'osm-' + line, label: line, dwell: 0,
        data: { stations: l.stations, trains: l.trains, trainsHoliday: l.trainsHoliday || l.trains, fares: {} },
    }));
}
// 運賃を通しで数える事業者どうしか（JR の路線どうし、東急の路線どうし。バスは 1 回ごと）
const sameFare = (a, b) => a.flatFare == null && (a.fareGroup || a.key) === (b.fareGroup || b.key);

const network = (() => {
    const nodeOf = {};          // 「事業者|駅名」 -> ノード番号
    const nodes = [];           // { op, name }
    const conns = { weekday: [], holiday: [] };   // 平日・土休日ダイヤそれぞれの区間
    OPERATORS.forEach(op => {
        const ids = op.data.stations.map(name => {
            const key = op.key + '|' + name;
            if (!(key in nodeOf)) { nodeOf[key] = nodes.length; nodes.push({ op, name }); }
            return nodeOf[key];
        });
        op.stationSet = new Set(op.data.fareStations || op.data.stations);   // 運賃表にある駅
        // 列車データを「駅A 発 → 駅B 着」の区間（コネクション）に分解する。
        // 土休日の列車データが無い事業者は、平日のもので代わりにする
        op.holidayFallback = !(op.data.trainsHoliday && op.data.trainsHoliday.length) && op.data.trains.length > 0;
        [['weekday', op.data.trains], ['holiday', op.holidayFallback ? op.data.trains : op.data.trainsHoliday || []]]
            .forEach(([day, trains]) => trains.forEach(([, stops], i) => {
                const trip = `${op.key}${day[0]}${i}`;
                for (let j = 0; j + 3 < stops.length; j += 2) {
                    conns[day].push({ from: ids[stops[j]], dep: stops[j + 1], to: ids[stops[j + 2]], arr: stops[j + 3] - op.dwell, trip });
                }
            }));
    });
    // 乗換: 同じ駅名のノードどうしと、徒歩連絡の駅どうし
    const transfers = nodes.map(() => []);
    const byName = {};
    nodes.forEach((n, i) => (byName[n.name] = byName[n.name] || []).push(i));
    Object.entries(byName).forEach(([name, ids]) => {
        ids.forEach(a => ids.forEach(b => {
            if (a === b) return;
            const pair = [name, ...[nodes[a].op.key, nodes[b].op.key].sort()].join('|');
            transfers[a].push({ to: b, min: PAIR_TRANSFER_MIN[pair] ?? TRANSFER_MIN[name] ?? TRANSFER_DEFAULT_MIN });
        }));
    });
    WALK_TRANSFERS.forEach(w => {
        (byName[w.a] || []).forEach(a => (byName[w.b] || []).forEach(b => {
            transfers[a].push({ to: b, min: w.min });
            transfers[b].push({ to: a, min: w.min });
        }));
    });
    // 駅と近くのバス停（直線 BUS_TRANSFER_KM 以内）を歩いてつなぐ（道なりは直線の 1.3 倍・分速 80 m、最低 2 分）
    if (window.NETWORK) BUS_SOURCES.forEach(src => {
        src.data.stops.forEach(([, lat, lng], i) => {
            const b = nodeOf[src.key + '|' + src.nodeNames[i]];
            window.NETWORK.stations.forEach(s => {
                const km = kmBetween({ lat, lng }, s);
                if (km > BUS_TRANSFER_KM) return;
                const min = Math.max(2, km * 1000 * 1.3 / 80);
                (byName[s.name] || []).forEach(a => {
                    if (nodes[a].op.kind === 'bus') return;
                    transfers[a].push({ to: b, min });
                    transfers[b].push({ to: a, min });
                });
            });
        });
    });
    // 近くのバス停どうし（直線 BUS_WALK_KM 以内）も歩いてつなぐ（本数の少ない系統しか来ない停留所へ、隣の停留所から歩けるように）
    const busPts = BUS_SOURCES.flatMap(src => src.data.stops.map(([, lat, lng], i) => ({ lat, lng, n: nodeOf[src.key + '|' + src.nodeNames[i]] })));
    busPts.sort((p, q) => p.lat - q.lat);
    const dLat = BUS_WALK_KM / 110.57;
    for (let i = 0; i < busPts.length; i++) {
        for (let j = i + 1; j < busPts.length && busPts[j].lat - busPts[i].lat <= dLat; j++) {
            const p = busPts[i], q = busPts[j];
            if (p.n === q.n) continue;
            const km = kmBetween(p, q);
            if (km > BUS_WALK_KM) continue;
            const min = Math.max(1, km * 1000 * 1.3 / 80);
            transfers[p.n].push({ to: q.n, min });
            transfers[q.n].push({ to: p.n, min });
        }
    }
    // 経路探索で何十万回も読むので、区間と乗換は数値だけの配列（型付き配列）にする。
    // 区間は発車順に並べ、列車は 0 からの番号にする
    const tripNo = new Map();
    const pack = list => {
        list.sort((a, b) => a.dep - b.dep);
        const n = list.length;
        const c = { n, from: new Int32Array(n), to: new Int32Array(n), dep: new Float64Array(n), arr: new Float64Array(n), trip: new Int32Array(n) };
        list.forEach((x, k) => {
            if (!tripNo.has(x.trip)) tripNo.set(x.trip, tripNo.size);
            c.from[k] = x.from; c.to[k] = x.to; c.dep[k] = x.dep; c.arr[k] = x.arr; c.trip[k] = tripNo.get(x.trip);
        });
        return c;
    };
    const packed = { weekday: pack(conns.weekday), holiday: pack(conns.holiday) };
    const trOff = new Int32Array(nodes.length + 1);
    transfers.forEach((list, i) => { trOff[i + 1] = trOff[i] + list.length; });
    const trTo = new Int32Array(trOff[nodes.length]), trMin = new Float64Array(trOff[nodes.length]);
    transfers.forEach((list, i) => list.forEach((tr, k) => { trTo[trOff[i] + k] = tr.to; trMin[trOff[i] + k] = tr.min; }));
    // ノードの駅名を番号にしておく（日中の値の計算で、駅名ごとに最も早い到着をまとめるのに使う）
    const names = Object.keys(byName);
    const nameNo = Object.fromEntries(names.map((name, i) => [name, i]));
    const nodeName = Int32Array.from(nodes, n => nameNo[n.name]);
    return { nodeOf, nodes, conns: packed, tripCount: tripNo.size, transfers, trOff, trTo, trMin, byName, names, nameNo, nodeName };
})();

// 中心駅を t0 に出発したときの各ノードへの最早到着時刻（Connection Scan Algorithm）
// parent には経路をたどるための情報を残す（数値の配列）: kind[n] = 1 中心駅 / 2 徒歩（a = 歩き始めたノード）/
// 3 乗車（a = 乗った区間、b = 降りた区間）
const P_SRC = 1, P_WALK = 2, P_RIDE = 3;
function earliestArrivals(srcNodes, t0) {
    const N = network.nodes.length;
    const { trOff, trTo, trMin } = network;
    const arr = new Float64Array(N).fill(Infinity);
    const kind = new Int8Array(N), pa = new Int32Array(N), pb = new Int32Array(N);
    const boarded = new Int32Array(network.tripCount).fill(-1);   // 列車 -> 最初に乗った区間
    const reach = (n, t, k, a, b) => {
        if (t >= arr[n]) return;
        arr[n] = t; kind[n] = k; pa[n] = a; pb[n] = b;
        for (let e = trOff[n]; e < trOff[n + 1]; e++) {
            const m = trTo[e], tt = t + trMin[e];
            if (tt < arr[m]) { arr[m] = tt; kind[m] = P_WALK; pa[m] = n; }
        }
    };
    srcNodes.forEach(n => reach(n, t0, P_SRC, 0, 0));   // 中心駅から徒歩連絡の駅へ歩いて乗ることもある
    // 区間は発車順なので、t0 に発車する最初の区間を二分探索で探してそこから見る
    const c = network.conns[dayType];
    let lo = 0, hi = c.n;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (c.dep[mid] < t0) lo = mid + 1; else hi = mid;
    }
    const until = t0 + 240;   // 4 時間より先は使わない
    for (let k = lo; k < c.n; k++) {
        const dep = c.dep[k];
        if (dep > until) break;
        const trip = c.trip[k];
        if (boarded[trip] >= 0 || arr[c.from[k]] <= dep) {
            if (boarded[trip] < 0) boarded[trip] = k;
            reach(c.to[k], c.arr[k], P_RIDE, boarded[trip], k);
        }
    }
    return { arr, parent: { kind, pa, pb } };
}

// ノード target までの経路（乗車と徒歩）と運賃。同じ事業者の列車が続く区間は 1 回の乗車として運賃を数え、事業者ごとに足す。
// 候補がとても多いので、説明の文字列はここでは作らず fareNote で作る
function journeyRides(parent, target) {
    const { kind, pa, pb } = parent;
    const c = network.conns[dayType];
    const steps = [];   // 新しい順: { op, from, to }（駅名）または { walk: [駅名, 駅名] }
    for (let n = target, guard = 0; guard < 200; guard++) {
        const k = kind[n];
        if (!k) return null;
        if (k === P_SRC) break;
        if (k === P_WALK) {
            const a = network.nodes[pa[n]].name, b = network.nodes[n].name;
            if (a !== b) steps.push({ walk: [a, b] });
            n = pa[n];
            continue;
        }
        const to = c.to[pb[n]], from = c.from[pa[n]];
        steps.push({ op: network.nodes[to].op, from: network.nodes[from].name, to: network.nodes[to].name });
        n = from;
    }
    const rides = [], ways = [];   // ways: { walk: [a, b] } か { change: 駅名 }
    for (let k = steps.length - 1; k >= 0; k--) {
        const st = steps[k];
        if (st.walk) { ways.push(st); continue; }
        const last = rides[rides.length - 1];
        if (last && sameFare(last.op, st.op) && last.to === st.from) last.to = st.to;
        else {
            if (last && last.to === st.from) ways.push({ change: st.from });   // 同じ駅で別の事業者に乗り換え
            rides.push({ op: st.op, from: st.from, to: st.to });
        }
    }
    let fare = 0;
    for (const r of rides) {
        r.fare = fareOf(r.op, r.from, r.to);
        if (r.fare == null) return null;
        fare += r.fare;
    }
    return { fare, rides, ways };
}
// 運賃の内訳の説明（例「京急 300円＋市営バス 220円（横浜〜横浜駅前 徒歩）」）
function fareNote(j) {
    const parts = j.rides.map(r => `${r.op.label} ${r.fare}円`);
    const how = [...new Set(j.ways.map(w => (w.walk ? `${nodeLabel(w.walk[0])}〜${nodeLabel(w.walk[1])} 徒歩` : `${nodeLabel(w.change)}乗換`)))].join('・');
    return (parts.join('＋') || '徒歩のみ') + (how ? `（${how}）` : '');
}
function journeyFare(parent, target) {
    const j = journeyRides(parent, target);
    return j && { fare: j.fare, note: fareNote(j) };
}

// 中心駅から各駅（駅名）への最短の所要時間（分）と、その経路の運賃。
// 出発時刻が無いときは { min, median, max }（日中の最小・平均・最大）をまとめて返す
function routesFrom(centerName) {
    const src = network.byName[centerName] || [];
    // 出発時刻の指定があるとき: その時刻に中心駅にいて、最初の電車を待つ時間も含めた所要時間
    if (departTime != null) {
        const { arr, parent } = earliestArrivals(src, departTime);
        const result = {};
        arr.forEach((a, i) => {
            const name = network.nodes[i].name;
            if (!isFinite(a) || name === centerName) return;
            const time = a - departTime, prev = result[name];
            if (prev && prev.exact <= time) return;
            const f = journeyFare(parent, i) || { fare: null, note: null };
            result[name] = { exact: time, time: Math.round(time), fare: f.fare, note: f.note };
        });
        return result;
    }
    // 出発時刻の候補: 中心駅の発車時刻と、乗換・徒歩連絡の先の駅の発車時刻（から歩く時間を引いたもの）
    const startAt = new Map(src.map(n => [n, 0]));
    src.forEach(n => network.transfers[n].forEach(tr => {
        if (!startAt.has(tr.to) || tr.min < startAt.get(tr.to)) startAt.set(tr.to, tr.min);
    }));
    const c = network.conns[dayType];
    const startSet = new Set();
    for (let k = 0; k < c.n; k++) {
        const from = c.from[k];
        if (!startAt.has(from) || network.nodes[from].op.kind === 'bus') continue;
        const t = c.dep[k] - startAt.get(from);
        if (TIME_WINDOW_HOURS.includes(Math.floor(t / 60))) startSet.add(t);
    }
    const starts = [...startSet];
    const N = network.nodes.length, M = network.names.length, nodeName = network.nodeName;
    const nameNodes = network.names.map(name => network.byName[name]);
    const centerNo = network.nameNo[centerName];
    // 駅名（番号）ごとの候補 { time, fare, j: journeyRides の結果 }
    const hourly = new Array(M);   // 駅名 -> { 時: 候補 }（各時台で最も速い経路。同じ速さなら安い方）
    const lo = new Array(M), hi = new Array(M);   // 最小・最大のときの経路（どの発車で出ても、その発車からの最も早い到着で数える）
    const better = (a, b) => !b || a.time < b.time || (a.time === b.time && (a.fare ?? Infinity) < (b.fare ?? Infinity));
    const worse = (a, b) => !b || a.time > b.time || (a.time === b.time && (a.fare ?? Infinity) < (b.fare ?? Infinity));
    const minArr = new Float64Array(M);
    starts.forEach(t0 => {
        const h = Math.floor(t0 / 60);
        const { arr, parent } = earliestArrivals(src, t0);
        // この発車での各駅名への最も早い到着（同じ駅名の事業者ごとのノードのうち最も早いもの）
        minArr.fill(Infinity);
        for (let i = 0; i < N; i++) if (arr[i] < minArr[nodeName[i]]) minArr[nodeName[i]] = arr[i];
        const seen = new Uint8Array(M);
        for (let i = 0; i < N; i++) {
            const m = nodeName[i];
            if (m === centerNo || seen[m] || arr[i] === Infinity || arr[i] !== minArr[m]) continue;
            seen[m] = 1;
            const time = arr[i] - t0;
            const byHour = hourly[m] || (hourly[m] = {});
            const needHour = !byHour[h] || time <= byHour[h].time;
            const needLo = !lo[m] || time <= lo[m].time;
            const needHi = !hi[m] || time >= hi[m].time;
            if (!needHour && !needLo && !needHi) continue;
            // 運賃は必要なときだけ計算する（同じ到着のノードが複数あれば安い方）
            let cand = null;
            for (const i2 of nameNodes[m]) {
                if (arr[i2] !== minArr[m]) continue;
                const jr = journeyRides(parent, i2);
                const f = { time, fare: jr ? jr.fare : null, j: jr };
                if (better(f, cand)) cand = f;
            }
            if (needHour && better(cand, byHour[h])) byHour[h] = cand;
            if (needLo && better(cand, lo[m])) lo[m] = cand;
            if (needHi && worse(cand, hi[m])) hi[m] = cand;
        }
    });
    const out = e => ({ time: Math.round(e.time), fare: e.fare, note: e.j ? fareNote(e.j) : null });
    const result = { min: {}, median: {}, max: {} };
    for (let m = 0; m < M; m++) {
        const name = network.names[m];
        if (lo[m]) result.min[name] = out(lo[m]);
        if (hi[m]) result.max[name] = out(hi[m]);
        // 平均: 各時台の最速の経路のうち、所要時間が中央の時台のもの（データの読み取りミスに強くするため）
        if (hourly[m]) {
            const list = Object.values(hourly[m]).sort((a, b) => a.time - b.time || (a.fare ?? Infinity) - (b.fare ?? Infinity));
            result.median[name] = out(list[Math.floor((list.length - 1) / 2)]);
        }
    }
    return result;
}

// 事業者 op で駅 a から駅 b まで乗ったときの運賃
function fareOf(op, a, b) {
    if (op.flatFare != null) return a === b ? 0 : op.flatFare;
    if (!op.stationSet.has(a) || !op.stationSet.has(b)) return null;
    return a === b ? 0 : (op.data.fares[pairKey(a, b)] ?? null);
}
// 時刻表のない区間用: 中心駅から各駅への最も安い運賃（乗換は何回でも）。
// 「ある事業者に乗る駅」→「降りる駅」を 1 回の乗車（その区間の運賃）とし、乗換・徒歩連絡は 0 円でつなぐ
function cheapestFares(fromName) {
    if (ESTIMATE) return {};   // 推定のときは運賃が無い
    const N = network.nodes.length;
    const board = new Array(N).fill(Infinity), alight = new Array(N).fill(Infinity);
    const boardPrev = new Array(N).fill(null), alightPrev = new Array(N).fill(null);
    const done = { board: new Set(), alight: new Set() };
    const src = network.byName[fromName] || [];
    src.forEach(n => { board[n] = 0; });
    // 中心駅から歩いて行ける駅（徒歩連絡）からも 0 円で乗れる
    src.forEach(n => network.transfers[n].forEach(tr => {
        if (board[tr.to] > 0) { board[tr.to] = 0; boardPrev[tr.to] = n; }
    }));
    for (;;) {
        // まだ確定していない中で最も安い状態を選ぶ（駅数が少ないので単純な方法で十分）
        let best = null;
        for (let i = 0; i < N; i++) {
            if (!done.board.has(i) && board[i] < Infinity && (!best || board[i] < best.v)) best = { kind: 'board', i, v: board[i] };
            if (!done.alight.has(i) && alight[i] < Infinity && (!best || alight[i] < best.v)) best = { kind: 'alight', i, v: alight[i] };
        }
        if (!best) break;
        done[best.kind].add(best.i);
        const node = network.nodes[best.i];
        if (best.kind === 'board') {
            network.nodes.forEach((m, j) => {
                if (!sameFare(m.op, node.op) || m.name === node.name) return;
                const f = fareOf(node.op, node.name, m.name);
                if (f != null && best.v + f < alight[j]) { alight[j] = best.v + f; alightPrev[j] = best.i; }
            });
        } else {
            network.transfers[best.i].forEach(tr => {
                if (best.v < board[tr.to]) { board[tr.to] = best.v; boardPrev[tr.to] = best.i; }
            });
        }
    }
    // 駅名ごとに最も安いものと、その内訳
    const result = {};
    alight.forEach((v, j) => {
        const name = network.nodes[j].name;
        if (v === Infinity || name === fromName || (result[name] && result[name].fare <= v)) return;
        const parts = [], ways = [];
        for (let n = j, guard = 0; n != null && guard < 50; guard++) {
            const from = alightPrev[n];
            parts.unshift(`${network.nodes[n].op.label} ${fareOf(network.nodes[n].op, network.nodes[from].name, network.nodes[n].name)}円`);
            const before = boardPrev[from];
            if (before == null) break;
            const a = network.nodes[before].name, b = network.nodes[from].name;
            ways.unshift(a === b ? `${a}乗換` : `${a}〜${b} 徒歩`);
            n = src.includes(before) ? null : before;   // 中心駅から歩いて乗ったところまで戻ったら終わり
        }
        result[name] = { fare: v, note: parts.join('＋') + (ways.length ? `（${[...new Set(ways)].join('・')}）` : '') };
    });
    return result;
}

// --- 5. 中心駅から各駅への時間・運賃 --------------------------------------
// 経路探索の結果は「ダイヤ・出発時刻・中心駅」ごとに覚えておく（日中の最小・平均・最大の切り替えは計算し直さない）
const routeCache = new Map();
const ROUTE_CACHE_MAX = 40;
function routesFor(centerName) {
    const key = `${dayType}|${departTime}|${centerName}`;
    let c = routeCache.get(key);
    if (!c) {
        c = { routes: routesFrom(centerName), cheap: cheapestFares(centerName) };
        routeCache.set(key, c);
        if (routeCache.size > ROUTE_CACHE_MAX) routeCache.delete(routeCache.keys().next().value);
    }
    return { routes: departTime != null ? c.routes : c.routes[timeStat], cheap: c.cheap };
}
function computeRouteData(cid) {
    if (routeData[cid]) return routeData[cid];
    if (travel === 'car' && window.CAR) return (routeData[cid] = carRouteData(cid));
    const center = stations.find(s => s.id === cid);
    const result = { [cid]: { time: 0, fare: 0 } };
    const { routes, cheap } = routesFor(center.name);
    stations.forEach(s => {
        const r = routes[s.name];
        if (s.id === cid) return;
        // 時刻表で経路が分かれば、最も速い経路の運賃。分からない駅（時刻表のない区間）は最も安い運賃
        if (r && r.fare != null) {
            result[s.id] = { time: r.time, fare: r.fare, fareNote: r.note };
            return;
        }
        const f = cheap[s.name];
        const time = r ? r.time : null;
        result[s.id] = (f || time != null)
            ? { time, fare: f ? f.fare : null,
                fareNote: f ? f.note + (time != null ? '' : departTime != null ? '・この時刻からは電車で行けません（最安の運賃）' : '・時刻表なしのため最安の運賃') : null }
            : null;
    });
    busStops.forEach(b => {
        const r = routes[b.id];
        result[b.id] = r ? { time: r.time, fare: r.fare, fareNote: r.note } : null;
    });
    return (routeData[cid] = result);
}

// 車: data/car.js の駅×駅の表（所要時間・費用の目安）から。バス停は使わない
function carRouteData(cid) {
    const C = window.CAR, tbl = useHighway ? C.highway : C.local;
    const idx = Object.fromEntries(C.stations.map((n, i) => [n, i]));
    const i = idx[stations.find(s => s.id === cid).name];
    const result = { [cid]: { time: 0, fare: 0 } };
    stations.forEach(s => {
        if (s.id === cid) return;
        const j = idx[s.name];
        result[s.id] = i == null || j == null ? null
            : { time: tbl.time[i][j], fare: tbl.cost[i][j], fareNote: useHighway ? '高速料金とガソリン代の目安' : 'ガソリン代の目安（高速道路を使わない）' };
    });
    busStops.forEach(b => { result[b.id] = null; });
    return result;
}

// 時間の基準の表示（例「 8:30 発（土休日）」。日中の平均なら土休日のときだけ「（土休日）」）
const DAY_NAMES = { weekday: '平日', holiday: '土休日' };
function fmtClock(min) {
    const m = ((Math.round(min) % 1440) + 1440) % 1440;
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
const STAT_NAMES = { min: '', median: '日中の平均', max: '日中の最大' };   // 既定の最小は書かない
function timeBasis() {
    if (travel === 'car') return `（車${useHighway ? '' : '・高速なし'}）`;
    if (departTime != null) return ` ${fmtClock(departTime)} 発（${DAY_NAMES[dayType]}）`;
    const parts = [STAT_NAMES[timeStat], dayType === 'holiday' ? '土休日' : ''].filter(Boolean);
    return parts.length ? `（${parts.join('・')}）` : '';
}

function describeData(cid) {
    const center = stations.find(s => s.id === cid);
    const total = stations.length - 1;
    const values = stations.filter(s => s.id !== cid).map(s => routeData[cid][s.id]);
    const withTime = values.filter(v => v && v.time != null).length;
    if (travel === 'car') {
        return setStatus(`車（OpenStreetMap の幹線道路を、道路交通センサスの神奈川県の昼間の平均速度で走るとした目安。渋滞の時間帯の違いは入らない）` +
            `: ${center.name}${timeBasis()} から 時間 ${withTime} / ${total} 駅`, 'ok');
    }
    if (ESTIMATE) {
        return setStatus(`推定（OpenStreetMap の路線と国土数値情報の線路の形から。所要時間は線路の距離・カーブ・停車駅数から、運転間隔は目安で計算）` +
            `: ${center.name}${timeBasis()} から 時間 ${withTime} / ${total} 駅` +
            (withTime === total ? '' : '。行けない駅は実際の位置に灰色で表示'), 'ok');
    }
    const withFare = values.filter(v => v && v.fare != null).length;
    if (!OPERATORS.length) return setStatus('時刻表・運賃のデータがありません（build_keikyu.py / build_yokohama.py を実行）', 'error');
    const noTimetable = OPERATORS.filter(op => !op.data.trains.length).map(op => op.label);
    const ok = withTime === total && withFare === total;
    const fallback = dayType === 'holiday' ? OPERATORS.filter(op => op.holidayFallback).map(op => op.label) : [];
    setStatus(`${center.name}${timeBasis()} から: 時間 ${withTime} / ${total} 駅・運賃 ${withFare} / ${total} 駅` +
        (noTimetable.length ? `（${noTimetable.join('・')}は時刻表データ未取得）` : '') +
        (fallback.length ? `（${[...new Set(fallback)].join('・')}は土休日の時刻表が無いので平日で計算）` : '') +
        (busStops.length ? `・バス停 ${busStops.filter(b => routeData[cid][b.id] && routeData[cid][b.id].time != null).length} / ${busStops.length}` : '') +
        (ok ? '' : '。データなしの駅は実際の位置に灰色で表示'), ok ? 'ok' : 'warn');
}

// --- 6. レイアウト計算 ---------------------------------------------------
// 中心駅を原点とした km 座標（x: 東, y: 南）
function computeGeo() {
    const c = stations.find(s => s.id === centerId);
    [...stations, ...busStops].forEach(s => {
        const latMid = (s.lat + c.lat) / 2 * Math.PI / 180;
        const x = (s.lng - c.lng) * 111.32 * Math.cos(latMid);
        const y = -(s.lat - c.lat) * 110.57;
        s.geo = { x, y, r: Math.hypot(x, y), angle: Math.atan2(y, x) };
    });
}

function valueOf(s) {
    const d = routeData[centerId] && routeData[centerId][s.id];
    if (!d) return null;
    const v = currentMode === 'time' ? d.time : d.fare;
    return v == null ? null : v;
}

// 戻り値: { k } … 値 1 単位あたりの km（同心円の描画に使用）
function computePositions() {
    computeGeo();
    if (currentMode === 'distance') {
        [...stations, ...busStops].forEach(s => { s.px = s.geo.x; s.py = s.geo.y; s.missing = false; });
        return { k: null };
    }
    // 縮尺合わせ: 全駅の「実距離の合計」と「値×k の合計」が等しくなる k
    let sumR = 0, sumV = 0;
    stations.forEach(s => {
        const v = valueOf(s);
        if (s.id !== centerId && v != null && v > 0) { sumR += s.geo.r; sumV += v; }
    });
    const k = sumV > 0 ? sumR / sumV : null;
    const t = distortionStrength;
    stations.forEach(s => {
        const v = valueOf(s);
        if (s.id === centerId) { s.px = 0; s.py = 0; s.missing = false; return; }
        if (v == null || k == null) {
            s.px = s.geo.x; s.py = s.geo.y; s.missing = true; return;
        }
        const r = (1 - t) * s.geo.r + t * k * v;
        s.px = Math.cos(s.geo.angle) * r;
        s.py = Math.sin(s.geo.angle) * r;
        s.missing = false;
    });
    // バス停も同じ式で（縮尺 k は駅だけで決める）。値の無い停留所は実際の位置
    busStops.forEach(b => {
        const v = valueOf(b);
        const r = v == null || k == null ? b.geo.r : (1 - t) * b.geo.r + t * k * v;
        b.px = Math.cos(b.geo.angle) * r;
        b.py = Math.sin(b.geo.angle) * r;
        b.missing = v == null || k == null;
    });
    return { k };
}

// --- 7. 描画 -------------------------------------------------------------
function mapSize() {
    const el = document.getElementById('map');
    return { width: el.clientWidth || 900, height: el.clientHeight || 600 };
}

function initSvg() {
    const { width, height } = mapSize();
    d3.select('#map').selectAll('*').remove();
    svg = d3.select('#map').append('svg')
        .attr('width', '100%').attr('height', '100%')
        .attr('viewBox', `0 0 ${width} ${height}`);
    rootLayer = svg.append('g');
    // 背景地図（basemap.js）は SVG の下の canvas に描く
    const mapEl = document.getElementById('map');
    BaseMap.init(mapEl);
    // 3D 表示（view3d.js）。three.js が読み込めないときは 2D だけで動かす
    if (window.THREE && THREE.OrbitControls && typeof View3D !== 'undefined') {
        const el3d = document.createElement('div');
        el3d.id = 'view3d';
        mapEl.appendChild(el3d);
        View3D.init(el3d, {
            onHover: (e, d) => (!d ? hideTooltip() : d.isLandmark ? showLandmarkTooltip(e, d) : showTooltip(e, d)),
            onSelect: d => (d.isLandmark ? openLandmarkLink(d) : selectCenter(d)),
        });
        view3dReady = true;
    }
    d3.select(mapEl).append('div').attr('class', 'attribution')
        .html('地図: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院（淡色地図）</a>'
            + ' / ランドマークの一部: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>'
            + ' / 京急バス: <a href="https://nlftp.mlit.go.jp/ksj/" target="_blank" rel="noopener">国土数値情報（バス停留所・バスルート）</a>（国土交通省）を加工して作成'
            // 推定の時刻表: OSM の路線、国土数値情報の線路の形・駅別乗降客数、Wikipedia の種別ごとの停車駅・本数
            + (ESTIMATE ? ' / 推定: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>・'
                + '<a href="https://nlftp.mlit.go.jp/ksj/" target="_blank" rel="noopener">国土数値情報（鉄道・駅別乗降客数）</a>・'
                + '<a href="https://ja.wikipedia.org/" target="_blank" rel="noopener">Wikipedia</a>（CC BY-SA、各路線の記事の停車駅）' : ''));
    zoomBehavior = d3.zoom().scaleExtent([0.3, 64]).on('end', writeShareState).on('zoom', e => {
        rootLayer.attr('transform', e.transform);
        BaseMap.setTransform(e.transform);
        if (e.transform.k === zoomK) return;   // 移動だけなら配置は変わらない
        // 拡大しても文字・駅・線は画面上で同じ大きさに保つ（縮小時は地図と一緒に小さくする）
        zoomK = e.transform.k;
        zoomScale = 1 / Math.max(zoomK, 1);
        svg.style('--text-scale', zoomScale);
        applyZoomScale();
        placeLabels();
        labelSel.attr('x', d => d.lx).attr('y', d => d.ly).attr('visibility', d => (d.lx == null ? 'hidden' : null));
        if (landmarkLabelSel) landmarkLabelSel.attr('x', d => d.lx).attr('y', d => d.ly).attr('visibility', d => (d.lx == null ? 'hidden' : null));
    });
    svg.call(zoomBehavior);
    ringLayer = rootLayer.append('g').attr('class', 'rings');
    rootLayer.append('g').attr('class', 'links');
    rootLayer.append('g').attr('class', 'bus-links');   // バスの線・停留所は駅の下
    rootLayer.append('g').attr('class', 'bus-stops');
    rootLayer.append('g').attr('class', 'nodes');
    rootLayer.append('g').attr('class', 'landmarks');        // ランドマークは駅の上（駅の丸に隠れないように）
    rootLayer.append('g').attr('class', 'landmark-labels');
    rootLayer.append('g').attr('class', 'labels');
}

function render() {
    const byId = Object.fromEntries(stations.map(s => [s.id, s]));
    const linkData = edges.map(e => ({ ...e, s: byId[e.source], t: byId[e.target] }));

    linkSel = rootLayer.select('.links').selectAll('line').data(linkData).join('line')
        .attr('class', 'link')
        .attr('stroke', d => lineColor(d.line))
        .attr('stroke-width', 3);

    nodeSel = rootLayer.select('.nodes').selectAll('circle').data(stations, d => d.id).join('circle')
        .attr('class', 'station')
        .attr('stroke', '#fff')
        .attr('stroke-width', 1.5)
        .on('mouseover', showTooltip)
        .on('mousemove', moveTooltip)
        .on('mouseout', hideTooltip)
        .on('click', (e, d) => tapOrSelect(e, d, showTooltip, selectCenter));

    busLinkSel = rootLayer.select('.bus-links').selectAll('line').data(busLinks).join('line')
        .attr('class', 'bus-link')
        .attr('stroke', d => d.color);
    // 停留所の丸は小さいので、見えない大きめの丸でマウス・タップを受ける
    busSel = rootLayer.select('.bus-stops').selectAll('circle.bus-stop').data(busStops, d => d.uid).join('circle')
        .attr('class', 'bus-stop');
    busHitSel = rootLayer.select('.bus-stops').selectAll('circle.bus-hit').data(busStops, d => d.uid).join('circle')
        .attr('class', 'bus-hit')
        .on('mouseover', (e, d) => { busSel.classed('hl', x => x === d); showBusTooltip(e, d); })
        .on('mousemove', moveTooltip)
        .on('mouseout', () => { busSel.classed('hl', false); hideTooltip(); })
        .on('click', (e, d) => tapOrSelect(e, d, showBusTooltip, () => {}));

    labelSel = rootLayer.select('.labels').selectAll('text').data(stations, d => d.id).join('text')
        .attr('class', 'station-label')
        .classed('transfer', d => d.transfer)
        .attr('dy', '0.35em')   // y は文字の縦中央（位置は placeLabels で決める）
        .text(d => d.name)
        .on('mouseover', showTooltip)
        .on('mousemove', moveTooltip)
        .on('mouseout', hideTooltip)
        .on('click', (e, d) => tapOrSelect(e, d, showTooltip, selectCenter))
        .on('dblclick', e => e.stopPropagation());   // 駅名の上では地図のダブルクリック拡大をしない

    updateLegend();
    updateStats();
}

// animate: 動かして変える（duration ミリ秒）か、すぐ変えるか
function updateLayout(animate = true, duration = 600) {
    if (!stations.length || !centerId) return;
    const { k } = computePositions();
    const { width, height } = mapSize();
    const pad = 50;

    // 画面に収まるよう縮尺を決める（中心駅は画面中央に固定）
    const shown = stations.filter(stationShown);   // 表示している駅が画面に収まるように
    const maxX = d3.max(shown, s => Math.abs(s.px)) || 1;
    const maxY = d3.max(shown, s => Math.abs(s.py)) || 1;
    const scale = Math.min((width / 2 - pad) / maxX, (height / 2 - pad) / maxY);
    const cx = width / 2, cy = height / 2;
    const X = s => cx + s.px * scale;
    const Y = s => cy + s.py * scale;

    const dur = animate ? duration : 0;
    const tr = sel => (dur ? sel.transition().duration(dur) : sel);

    tr(linkSel)
        .attr('x1', d => X(d.s)).attr('y1', d => Y(d.s))
        .attr('x2', d => X(d.t)).attr('y2', d => Y(d.t));
    linkSel.attr('stroke-dasharray', d => (d.line === '徒歩' ? '2 3' : d.s.missing || d.t.missing ? '4 3' : null));
    const byId = Object.fromEntries(stations.map(s => [s.id, s]));
    linkSel.style('display', d => (edgeShown(d, byId) ? null : 'none'));
    nodeSel.style('display', d => (stationShown(d) ? null : 'none'));

    stations.forEach(s => { s.colorLine = s.lines.find(lineShown) || s.lines[0]; });   // 駅の色は表示している路線の色
    nodeSel
        .attr('fill', d => (d.missing ? '#bbb' : lineColor(d.colorLine)))
        .classed('center', d => d.id === centerId);
    applyZoomScale();
    tr(nodeSel).attr('cx', X).attr('cy', Y);
    const busShown = d => (travel === 'car' || hiddenLines.has(d.label) ? 'none' : null);   // 車のときはバスを出さない
    busSel.style('display', busShown).attr('fill', d => (d.missing ? '#bbb' : d.color));
    busHitSel.style('display', busShown);
    busLinkSel.style('display', busShown);
    tr(busSel).attr('cx', X).attr('cy', Y);
    tr(busHitSel).attr('cx', X).attr('cy', Y);
    tr(busLinkSel).attr('x1', d => X(d.s)).attr('y1', d => Y(d.s)).attr('x2', d => X(d.t)).attr('y2', d => Y(d.t));

    stations.forEach(s => { s.fx = X(s); s.fy = Y(s); });   // アニメーション後の位置
    placeLandmarks(k);                       // 値の分かるランドマークの位置（背景の歪めにも使う）
    const warp = buildWarp(cx, cy, scale);
    placeLandmarks(k, warp);                 // 地図上の位置は背景と同じ歪め方で（海の上などに出ない）
    landmarks.forEach(lm => {
        lm.fx = cx + lm.km[0] * scale;
        lm.fy = cy + lm.km[1] * scale;
    });
    if (landmarkSel) tr(landmarkSel).attr('transform', d => `translate(${d.fx},${d.fy})`);
    labelSel.classed('center', d => d.id === centerId);
    // 表示中だった駅名は新しい位置へ動かし、新しく表示する駅名はその場で（駅が動き終わってから）浮かび上がらせる
    labelSel.each(function (d) { d.wasShown = this.hasAttribute('x') && this.getAttribute('visibility') !== 'hidden'; });
    placeLabels();
    labelSel.attr('visibility', d => (d.lx == null ? 'hidden' : null));
    tr(labelSel.filter(d => d.lx != null && d.wasShown)).attr('x', d => d.lx).attr('y', d => d.ly);
    const appearing = labelSel.filter(d => d.lx != null && !d.wasShown)
        .attr('x', d => d.lx).attr('y', d => d.ly);
    if (dur) {
        appearing.style('opacity', 0)
            .transition('fade').delay(dur).duration(200).style('opacity', 1);
    }
    if (landmarkLabelSel) {
        landmarkLabelSel.attr('visibility', d => (d.lx == null ? 'hidden' : null));
        tr(landmarkLabelSel.filter(d => d.lx != null)).attr('x', d => d.lx).attr('y', d => d.ly);
    }

    const rings = drawRings(k, scale, cx, cy, dur);
    BaseMap.setWarp(warp, dur);
    if (view3dReady) {
        View3D.update({
            stations: shown, edges: edges.filter(e => edgeShown(e, byId)), centerId, lineColor, warp, duration: dur,
            rings: rings.map(d => ({ r: d.r / scale, label: d.label })),   // 3D は km 単位
            labelOrder: labelPriority, landmarks,
        });
    }
    renderLandmarkRanking();
    writeShareState();
}

// 駅名を置く優先順（中心駅 → 乗換駅 → その他）
const labelPriority = (a, b) => (b.id === centerId) - (a.id === centerId) || b.transfer - a.transfer
    || b.lines.length - a.lines.length;

// 背景地図の歪め方: 駅ごとの伸縮率（歪めた後の距離 ÷ 実際の距離）と、画面への縮尺
const WARP_BUS_CELL_KM = 0.3;
function buildWarp(cx, cy, scale) {
    const center = stations.find(s => s.id === centerId);
    const points = stations
        .filter(s => s.id !== centerId && !s.missing && s.geo.r > 0.05)   // データなしの駅は歪めに使わない
        .map(s => ({ x: s.geo.x, y: s.geo.y, s: Math.hypot(s.px, s.py) / s.geo.r }));
    // 表示中のバス停も使う（使わないと、駅から離れたバス停が歪めた地図の海の上などに出る）。
    // 数が多いと背景の描画が重くなるので、WARP_BUS_CELL_KM 四方に 1 つまでにする
    const cells = new Set();
    const busPoints = busStops
        .filter(b => !b.missing && !hiddenLines.has(b.label) && b.geo.r > 0.05)
        .filter(b => {
            const key = Math.floor(b.geo.x / WARP_BUS_CELL_KM) + ',' + Math.floor(b.geo.y / WARP_BUS_CELL_KM);
            if (cells.has(key)) return false;
            cells.add(key);
            return true;
        })
        .map(b => ({ x: b.geo.x, y: b.geo.y, s: Math.hypot(b.px, b.py) / b.geo.r }));
    // 表示中のランドマークも使う（値の分かるもの。使わないと、海沿いのランドマークが歪めた地図の海の上などに出る）。
    // バス停と同じく WARP_BUS_CELL_KM 四方に 1 つまで
    const lmCells = new Set();
    const landmarkPoints = landmarks
        .filter(lm => lm.radial && lm.radial[2] > 0.05)
        .filter(lm => {
            const key = Math.floor(lm.radial[3] / WARP_BUS_CELL_KM) + ',' + Math.floor(lm.radial[4] / WARP_BUS_CELL_KM);
            if (lmCells.has(key)) return false;
            lmCells.add(key);
            return true;
        })
        .map(lm => ({ x: lm.radial[3], y: lm.radial[4], s: Math.hypot(lm.radial[0], lm.radial[1]) / lm.radial[2] }));
    return {
        lat0: center.lat, lng0: center.lng, cx, cy, scale, points: points.concat(busPoints, landmarkPoints),
        typicalScale: points.length ? median(points.map(p => p.s)) : 1,
        bounds: {
            minLat: d3.min(stations, s => s.lat), maxLat: d3.max(stations, s => s.lat),
            minLng: d3.min(stations, s => s.lng), maxLng: d3.max(stations, s => s.lng),
        },
    };
}

// 駅の大きさ・線の太さを拡大率に合わせる（文字の大きさは CSS の --text-scale）
function applyZoomScale() {
    if (!nodeSel) return;
    nodeSel.attr('r', d => nodeRadius(d) * zoomScale).attr('stroke-width', 1.5 * zoomScale);
    linkSel.attr('stroke-width', 3 * zoomScale);
    if (busSel) {
        busSel.attr('r', 2.2 * zoomScale);
        busHitSel.attr('r', 7 * zoomScale);
        busLinkSel.attr('stroke-width', 0.8 * zoomScale);
    }
    if (landmarkSel) landmarkSel.select('g.pin').attr('transform', `scale(${zoomScale})`);
}

const nodeRadius = d => (d.id === centerId ? 9 : 5);

// --- 7.5 駅名の配置（重ならないように） ------------------------------------
// 画面上の座標で考える。駅の位置は拡大率 zoomK 倍、文字と駅の丸は min(zoomK, 1) 倍の大きさ
const LABEL_CANDIDATES = [   // [横, 縦]: -1 = 左/上, 0 = 中央, 1 = 右/下
    [1, 0], [-1, 0], [1, -1], [1, 1], [-1, -1], [-1, 1], [0, -1], [0, 1]
];
let measureCtx = null;

function labelSize(d) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    if (d.isLandmark) {   // style.css の .landmark-label と同じ大きさ
        measureCtx.font = `italic 10px ${getComputedStyle(document.body).fontFamily}`;
        return { w: measureCtx.measureText(d.name).width + 2, h: 14 };
    }
    const center = d.id === centerId;
    const fs = center ? 14 : d.transfer ? 13 : 11;   // style.css の .station-label と同じ大きさ
    measureCtx.font = `${center || d.transfer ? 'bold ' : ''}${fs}px ${getComputedStyle(document.body).fontFamily}`;
    return { w: measureCtx.measureText(d.name).width + 2, h: fs * 1.4 };   // 高さは描画時の行の高さ相当
}

// 中心駅 → 乗換駅 → その他の順に、空いている位置に置く。置けない駅名は隠す（ツールチップで見られる）
function placeLabels() {
    const k = zoomK, sz = Math.min(k, 1), gap = 2 * sz;
    const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    const nodeBoxes = stations.filter(stationShown).map(s => {
        const r = nodeRadius(s) * sz, x = s.fx * k, y = s.fy * k;
        return { id: s.id, x0: x - r, x1: x + r, y0: y - r, y1: y + r };
    });
    const placed = [];
    // 点 d（半径 radius の記号）の周りの空いている位置に名前を置く。置けなければ d.lx = null
    // dy … 記号の中心が点より上にあるとき（ランドマークのピンの頭）の高さ
    const place = (d, radius, avoidNodes, dy = 0) => {
        const { w, h } = labelSize(d);
        const lw = w * sz, lh = h * sz, r = radius * sz + gap;
        const x = d.fx * k, y = d.fy * k - dy * sz;
        d.lx = d.ly = null;
        for (const [hx, vy] of LABEL_CANDIDATES) {
            // ラベルの左端と縦中央（斜めの位置は丸に沿うよう少し内側に寄せる）
            const diag = hx !== 0 && vy !== 0 ? 0.7 : 1;
            const left = hx > 0 ? x + r * diag : hx < 0 ? x - r * diag - lw : x - lw / 2;
            const midY = vy > 0 ? y + r * diag + lh / 2 : vy < 0 ? y - r * diag - lh / 2 : y;
            const box = { x0: left, x1: left + lw, y0: midY - lh / 2, y1: midY + lh / 2 };
            const hitsNode = avoidNodes && nodeBoxes.some(b => b.id !== d.id && overlaps(box, b));
            if (placed.some(b => overlaps(box, b)) || hitsNode) continue;
            placed.push(box);
            d.lx = left / k;
            d.ly = midY / k;
            return;
        }
    };
    [...stations].sort(labelPriority).forEach(d => {
        if (!stationShown(d)) { d.lx = d.ly = null; return; }
        place(d, nodeRadius(d), d.id !== centerId);   // 中心駅の名前は必ず出す（周りの駅の丸に重なってもよい）
    });
    // ランドマークの名前は駅名より後（空いているところだけ）
    landmarks.forEach(d => (d.fx == null ? (d.lx = d.ly = null) : place(d, PIN_HEAD_R, true, PIN_HEAD_Y)));
}

// 歪み 100% のときは「中心から○分 / ○円」の同心円を描く
function drawRings(k, scale, cx, cy, dur) {
    let data = [];
    if (currentMode !== 'distance' && k && distortionStrength >= 0.999) {
        const maxV = d3.max(stations, s => (s.missing ? 0 : valueOf(s) || 0));
        data = d3.ticks(0, maxV, 5).filter(v => v > 0)
            .map(v => ({ v, r: v * k * scale, label: currentMode === 'time' ? `${v}分` : `${v}円` }));
    } else if (currentMode === 'distance') {
        const maxR = d3.max(stations, s => s.geo.r);
        data = d3.ticks(0, maxR, 5).filter(v => v > 0)
            .map(v => ({ v, r: v * scale, label: `${v}km` }));
    }
    const g = ringLayer.selectAll('g.ring').data(data, d => d.label).join(
        enter => {
            const e = enter.append('g').attr('class', 'ring').style('opacity', 0);
            e.append('circle');
            e.append('text');
            return e;
        }
    );
    g.select('circle').attr('cx', cx).attr('cy', cy).attr('r', d => d.r);
    g.select('text').attr('x', cx + 4).attr('y', d => cy - d.r - 3).text(d => d.label);
    (dur ? g.transition().duration(dur) : g).style('opacity', 1);
    return data;
}

// --- 8. ツールチップ・凡例・統計 ---------------------------------------
function showTooltip(event, d) {
    hideTooltip();
    const center = stations.find(s => s.id === centerId);
    const rd = routeData[centerId] && routeData[centerId][d.id];
    let info = '';
    if (d.id === centerId) {
        info = '<div class="tooltip-info">（中心駅）</div>';
    } else {
        info += `<div class="tooltip-info"><strong>直線距離:</strong> ${d.geo.r.toFixed(1)} km</div>`;
        if (rd) {
            info += `<div class="tooltip-info"><strong>${center.name}${timeBasis()}から:</strong> ${rd.time != null ? rd.time + '分' : '—'} / ${rd.fare != null ? rd.fare + '円' : '—'}</div>`;
            if (rd.fareNote) info += `<div class="tooltip-hint">${travel === 'car' ? '費用' : '運賃（IC）'}: ${rd.fareNote}</div>`;
        } else {
            info += '<div class="tooltip-info">時間・運賃データなし</div>';
        }
    }
    d3.select('body').append('div').attr('class', 'tooltip').html(`
        <div class="tooltip-title">${d.name}</div>
        <div class="tooltip-info"><strong>路線:</strong> ${displayLines(d.lines).join('・')}</div>
        ${info}
        <div class="tooltip-hint">${IS_TOUCH ? 'もう一度タップで中心駅に設定' : '駅または駅名のクリックで中心駅に設定'}</div>`);
    moveTooltip(event);
}
function showBusTooltip(event, d) {
    hideTooltip();
    const center = stations.find(s => s.id === centerId);
    const rd = routeData[centerId] && routeData[centerId][d.id];
    const routes = d.routes.length > 8 ? d.routes.slice(0, 8).join('・') + ` ほか${d.routes.length - 8}系統` : d.routes.join('・');
    const value = rd
        ? `<div class="tooltip-info"><strong>${center.name}${timeBasis()}から:</strong> ${rd.time != null ? rd.time + '分' : '—'} / ${rd.fare != null ? rd.fare + '円' : '—'}</div>
            ${rd.fareNote ? `<div class="tooltip-hint">運賃（IC）: ${rd.fareNote}</div>` : ''}`
        : '<div class="tooltip-info">この時刻からは行けません</div>';
    d3.select('body').append('div').attr('class', 'tooltip').html(`
        <div class="tooltip-title">${escapeHtml(d.name)}（バス停）</div>
        <div class="tooltip-info"><strong>${d.label}:</strong> ${escapeHtml(routes)}</div>
        <div class="tooltip-info"><strong>直線距離:</strong> ${d.geo.r.toFixed(1)} km</div>
        ${value}
        ${d.estimated ? `<div class="tooltip-hint">時刻は推定: ${escapeHtml(d.estimated.note)}</div>` : ''}`);
    moveTooltip(event);
}
function moveTooltip(event) {
    const tip = d3.select('.tooltip');
    if (tip.empty()) return;
    // 画面の右端・下端からはみ出さないように（スマホでは特に）
    const { width, height } = tip.node().getBoundingClientRect();
    const left = Math.max(4, Math.min(event.pageX + 12, window.scrollX + window.innerWidth - width - 4));
    const top = Math.max(4, Math.min(event.pageY - 12, window.scrollY + window.innerHeight - height - 4));
    tip.style('left', left + 'px').style('top', top + 'px');
}

// タッチ操作（マウスのない端末）では、1 回目のタップで情報を出し、同じものをもう一度タップしたら
// 中心駅にする（ランドマークはホームページなどを開く）
const IS_TOUCH = window.matchMedia && window.matchMedia('(hover: none)').matches;
let tapPreview = null;
function tapOrSelect(event, d, show, select) {
    if (IS_TOUCH && tapPreview !== d) {
        tapPreview = d;
        show(event, d);
        return;
    }
    tapPreview = null;
    hideTooltip();
    select(d);
}
function hideTooltip() { d3.selectAll('.tooltip').remove(); }
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showLandmarkTooltip(event, d) {
    hideTooltip();
    const center = stations.find(s => s.id === centerId);
    const a = landmarkAccess(d);
    const where = [d.mapTitle, d.layerName].filter(Boolean).map(escapeHtml).join(' / ');
    let info = '';
    if (a) {
        info = `<div class="tooltip-info"><strong>${center.name}${timeBasis()}から:</strong> ${a.time != null ? Math.round(a.time) + '分' : '—'} / ${a.fare != null ? a.fare + '円' : '—'}</div>
            <div class="tooltip-hint">${landmarkWay(a, true)}${a.car ? '（費用は高速料金とガソリン代の目安）' : '（直線距離の1.3倍を分速80mで歩くとして計算）'}</div>`;
    }
    d3.select('body').append('div').attr('class', 'tooltip').html(`
        <div class="tooltip-title">${escapeHtml(d.name)}</div>
        ${where ? `<div class="tooltip-info">${where}</div>` : ''}
        ${d.note ? `<div class="tooltip-hint">${escapeHtml(d.note)}</div>` : ''}
        ${info}
        <div class="tooltip-hint">${IS_TOUCH ? 'もう一度タップで' : 'クリックで'}${landmarkLink(d).label}を開く</div>
`);
    moveTooltip(event);
}

// ランドマークをクリックしたときに開くページ: 説明欄のホームページ。なければ Google マップで名前を検索する
function landmarkLink(d) {
    if (d.url) return { href: d.url, label: 'ホームページ' };
    const named = d.name && !/^[（(]名[前称]なし[)）]$/.test(d.name);
    return {
        href: named ? `https://www.google.com/maps/search/${encodeURIComponent(d.name)}/@${d.lat},${d.lng},17z`
            : `https://www.google.com/maps?q=${d.lat},${d.lng}`,
        label: 'Google マップ',
    };
}
function openLandmarkLink(d) {
    window.open(landmarkLink(d).href, '_blank', 'noopener');
}

// 凡例: 項目をクリックするとその路線の表示・非表示を切り替える
function updateLegend() {
    const box = d3.select('#legendItems');
    box.selectAll('*').remove();
    const addItem = (key, label, mark) => {
        const item = box.append('button').attr('type', 'button').attr('class', 'legend-item legend-toggle')
            .classed('off', hiddenLines.has(key))
            .attr('aria-pressed', String(!hiddenLines.has(key)))
            .attr('title', 'クリックで表示・非表示を切り替え')
            .on('click', () => {
                if (hiddenLines.has(key)) hiddenLines.delete(key); else hiddenLines.add(key);
                updateLegend();
                updateLayout();
            });
        mark(item);
        item.append('span').text(label);
    };
    displayLines(lineNames).forEach(name => {
        const line = lineNames.find(l => displayLine(l) === name);
        addItem(name, name, item => item.append('div').attr('class', 'legend-color').style('background', lineColor(line)));
    });
    if (edges.some(e => e.line === '徒歩')) addItem('徒歩', '徒歩連絡', item => item.append('div').attr('class', 'legend-walk'));
    BUS_SOURCES.forEach(b => addItem(b.label, `${b.label}（停留所）`, item => item.append('div').attr('class', 'legend-bus').style('background', b.color)));
}

function updateStats() {
    document.getElementById('stationCount').textContent = stations.length;
    document.getElementById('lineCount').textContent = displayLines(lineNames).length;
}

// --- 9. コントロール --------------------------------------------------
function populateCenterSelect() {
    const sel = document.getElementById('centerStation');
    sel.innerHTML = '';
    [...stations].sort((a, b) => a.name.localeCompare(b.name, 'ja')).forEach(s => {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name;
        sel.appendChild(o);
    });
    sel.value = centerId;
}

function updateModeAvailability() {
    document.getElementById('distortion').disabled = currentMode === 'distance';
}

function changeCenter(id, animate = true) {
    centerId = id;
    computeRouteData(centerId);
    describeData(centerId);
    updateLayout(animate);
}

// 2D（SVG と平面の背景地図）と 3D（view3d.js）を切り替える
function setView(view) {
    const use3d = view === '3d' && view3dReady;
    svg.style('display', use3d ? 'none' : null);
    d3.select('#map .basemap').style('display', use3d ? 'none' : null);
    if (view3dReady) View3D.setVisible(use3d);
    hideTooltip();
    writeShareState();
}

// 時刻入力（"HH:MM"）を分に。0:00〜3:59 は深夜（前日の 24:00〜27:59）として扱う。空なら null
function parseClock(v) {
    const m = /^(\d{1,2}):(\d{2})/.exec(v || '');
    if (!m) return null;
    const t = +m[1] * 60 + +m[2];
    return t < 4 * 60 ? t + 24 * 60 : t;
}
let departTimer = null;   // 出発時刻を進めている setInterval
function setDepartPlayButton(playing) {
    const btn = document.getElementById('departPlay');
    btn.textContent = playing ? '⏸' : '▶';
    btn.title = playing ? '止める' : '1 秒で 1 分ずつ出発時刻を進める';
    btn.classList.toggle('playing', playing);
}
function stopDepartPlay() {
    clearInterval(departTimer);
    departTimer = null;
    setDepartPlayButton(false);
}
// 車のときは出発時刻・ダイヤ（電車の時刻表の設定）を隠し、高速道路の切り替えを出す。推定（電車だけ）や
// 車のデータが無いときは車を選べない
function updateTravelUI() {
    const car = travel === 'car';
    document.querySelector('.depart-group').hidden = car;
    document.getElementById('highwayToggle').hidden = !car;
    const carInput = document.querySelector('input[name="travel"][value="car"]');
    carInput.disabled = !window.CAR || ESTIMATE;
}
function updateDepartLabel() {
    document.getElementById('departClear').hidden = departTime == null;
    document.getElementById('timeStat').hidden = departTime != null;   // 時刻を決めたときは、その時刻の値なので使わない
}

// 地図上の駅（丸・駅名のクリック）を中心駅にする
function selectCenter(d) {
    document.getElementById('centerStation').value = d.id;
    changeCenter(d.id);
}

// --- 9.5 ランドマーク -------------------------------------------------
// 近い駅まで歩くとして、中心駅からの時間・運賃を出す
// 地図上の記号: Google マップのようなピン（先が地点。頭の円の半径と、頭の中心の地点からの高さ）
const PIN_HEAD_R = 7;
const PIN_HEAD_Y = 15;
const PIN_PATH = `M0,0 C-2,-5 ${-PIN_HEAD_R},-9 ${-PIN_HEAD_R},${-PIN_HEAD_Y} `
    + `A${PIN_HEAD_R},${PIN_HEAD_R} 0 1,1 ${PIN_HEAD_R},${-PIN_HEAD_Y} C${PIN_HEAD_R},-9 2,-5 0,0 Z`;
const WALK_NEAR_KM = 1.5;           // この距離（直線）までの駅を、歩いて行く駅の候補にする
const WALK_DETOUR = 1.3;            // 道なりの距離 ≒ 直線距離 × 1.3
const WALK_M_PER_MIN = 80;

function kmBetween(a, b) {
    const latMid = (a.lat + b.lat) / 2 * Math.PI / 180;
    return Math.hypot((b.lng - a.lng) * 111.32 * Math.cos(latMid), (b.lat - a.lat) * 110.57);
}

// 近い駅（直線 WALK_NEAR_KM 以内を近い順に 3 駅まで。無ければ最も近い 1 駅）と徒歩時間（分）
function nearStations(lm) {
    const all = stations.map(s => ({ station: s, km: kmBetween(lm, s) })).sort((a, b) => a.km - b.km);
    const near = all.filter(n => n.km <= WALK_NEAR_KM).slice(0, 3);
    // バス停も近い順に 3 つまで候補にする
    const bus = busStops.map(s => ({ station: s, km: kmBetween(lm, s) })).filter(n => n.km <= WALK_NEAR_KM)
        .sort((a, b) => a.km - b.km).slice(0, 3);
    return [...(near.length ? near : all.slice(0, 1)), ...bus].map(n => ({ ...n, walk: n.km * 1000 * WALK_DETOUR / WALK_M_PER_MIN }));
}
// 「〜駅」「〜（中心駅）」「〜（バス停）」
const placeName = s => s.name + (s.isBus ? '（バス停）' : s.id === centerId ? '（中心駅）' : '駅');

// --- 車のときのランドマーク: 道路網（data/car_graph.js）で、中心駅からランドマークの近くの道路まで走る時間を計算する ---
// 道路網は大きいので、車でランドマークを出すときに初めて読む
let carGraph = null, carGraphLoading = false;
const carRuns = new Map();   // 「中心駅|高速の有無」 -> 道路網の各点までの { dist, km, tollKm, entries }
function ensureCarGraph() {
    if (carGraph || carGraphLoading) return;
    if (window.CAR_GRAPH) { carGraph = decodeCarGraph(window.CAR_GRAPH); return; }
    carGraphLoading = true;
    const sc = document.createElement('script');
    sc.src = 'data/car_graph.js';
    sc.onload = () => { carGraph = decodeCarGraph(window.CAR_GRAPH); carGraphLoading = false; updateLayout(false); };
    sc.onerror = () => { carGraphLoading = false; setStatus('車の道路網（data/car_graph.js）を読めませんでした', 'error'); };
    document.head.appendChild(sc);
}
function decodeCarGraph(g) {
    const dec = (s, T) => {
        const b = atob(s), u = new Uint8Array(b.length);
        for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
        return new T(u.buffer);
    };
    const G = { ...g, lat: dec(g.lat, Int32Array), lng: dec(g.lng, Int32Array), off: dec(g.off, Int32Array), to: dec(g.to, Int32Array),
        min: dec(g.min, Float32Array), km: dec(g.km, Float32Array), tollKm: dec(g.tollKm, Float32Array), flag: dec(g.flag, Uint8Array), grid: new Map() };
    for (let i = 0; i < G.n; i++) {
        const k = Math.floor(G.lng[i] / 1e5 * 90) + ',' + Math.floor(G.lat[i] / 1e5 * 110);
        if (!G.grid.has(k)) G.grid.set(k, []);
        G.grid.get(k).push(i);
    }
    return G;
}
// 中心駅から道路網の各点までの最短時間（Dijkstra）。有料の区間の距離・入った回数も数える（費用の目安用）
function carRun(cid) {
    const key = cid + '|' + useHighway;
    if (carRuns.has(key)) return carRuns.get(key);
    const G = carGraph, si = window.CAR.stations.indexOf(stations.find(s => s.id === cid).name);
    const src = si >= 0 ? G.stationNode[si] : -1;
    if (src < 0) return null;
    const dist = new Float64Array(G.n).fill(Infinity), km = new Float64Array(G.n), tollKm = new Float64Array(G.n);
    const entries = new Uint16Array(G.n), lastToll = new Uint8Array(G.n);
    const heap = [[G.stationAccess[si][0], src]];
    dist[src] = G.stationAccess[si][0]; km[src] = G.stationAccess[si][1];
    const push = x => { heap.push(x); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    while (heap.length) {
        const [d, u] = pop();
        if (d > dist[u]) continue;
        for (let e = G.off[u]; e < G.off[u + 1]; e++) {
            if (!useHighway && G.tollKm[e] > 0) continue;
            const v = G.to[e], nd = d + G.min[e];
            if (nd < dist[v]) {
                dist[v] = nd; km[v] = km[u] + G.km[e]; tollKm[v] = tollKm[u] + G.tollKm[e];
                entries[v] = entries[u] + ((G.flag[e] & 1) && !lastToll[u] ? 1 : 0);
                lastToll[v] = G.flag[e] & 2 ? 1 : 0;
                push([nd, v]);
            }
        }
    }
    const r = { dist, km, tollKm, entries };
    carRuns.set(key, r);
    if (carRuns.size > 20) carRuns.delete(carRuns.keys().next().value);
    return r;
}
// ランドマークに最も近い道路網の点（約 3km まで）と、そこまでの時間（直線 × 1.3 を駅と同じ速さで）
function carSnap(lm) {
    if (lm.carSnap !== undefined) return lm.carSnap;
    const G = carGraph, gx = Math.floor(lm.lng * 90), gy = Math.floor(lm.lat * 110);
    let best = -1, bd = Infinity;
    for (let r = 0; r <= 3 && best < 0; r++) for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
        for (const n of G.grid.get((gx + i) + ',' + (gy + j)) || []) {
            const d = kmBetween(lm, { lat: G.lat[n] / 1e5, lng: G.lng[n] / 1e5 });
            if (d < bd) { bd = d; best = n; }
        }
    }
    return (lm.carSnap = best < 0 ? null : { node: best, km: bd * 1.3, min: bd * 1.3 / G.accessKmh * 60 });
}
function carLandmarkAccess(lm) {
    ensureCarGraph();
    if (!carGraph) return null;   // 読み込み中（読めたら描き直す）
    const r = carRun(centerId), sn = carSnap(lm);
    if (!r || !sn || !isFinite(r.dist[sn.node])) return { car: true, time: null, fare: null, walk: sn ? sn.min : 0 };
    const G = carGraph, n = sn.node;
    const fare = Math.round((r.tollKm[n] * G.tollPerKm + r.entries[n] * G.tollBase + (r.km[n] + sn.km) * G.fuelPerKm) / 10) * 10;
    return { car: true, time: r.dist[n] + sn.min, fare, walk: sn.min };
}
// ランドマークまでの行き方の説明（「〜駅から徒歩◯分」・車のときは「車で最寄りの道路から◯分」）
const landmarkWay = (a, long) => (a.car ? `車（最後は幹線道路から約${Math.round(a.walk)}分）`
    : `${placeName(a.station)}から徒歩${long ? ' 約' : ''}${Math.round(a.walk)}分`);

// 中心駅からの時間（電車＋徒歩）が最も短い近い駅。時間が分からなければ最も近い駅。車のときは車でランドマークまで
function landmarkAccess(lm) {
    if (travel === 'car' && window.CAR) return carLandmarkAccess(lm);
    if (!lm.near || !lm.near.length) return null;
    const rd = routeData[centerId] || {};
    const valueAt = s => (s.id === centerId ? { time: 0, fare: 0 } : rd[s.id]);
    let best = null;
    lm.near.forEach(n => {
        const v = valueAt(n.station);
        if (!v || v.time == null) return;
        const time = v.time + n.walk;
        if (!best || time < best.time) best = { station: n.station, walk: n.walk, time, fare: v.fare };
    });
    if (best) return best;
    const n = lm.near[0], v = valueAt(n.station);
    return { station: n.station, walk: n.walk, time: null, fare: v ? v.fare : null };
}

// ランドマークの位置（中心駅からの km 座標 lm.km = [東, 南, 実際の距離]）。駅と同じ決め方で、
// 方角は実際の方角のまま、中心からの距離を「自分の値（時間＝最寄り駅までの時間＋徒歩、運賃＝その駅の運賃）」にした点を
// 背景地図の歪めの手がかりにし、地図上には背景と同じ歪め方の位置に置く。
// 2 回呼ぶ: warp なし … 値の分かるランドマークの位置（lm.radial = [x, y, 実際の距離, 実際の x, 実際の y]）を決める
//（buildWarp が背景の歪めに使う）。warp あり … lm.km を決める
function placeLandmarks(k, warp) {
    const center = stations.find(s => s.id === centerId);
    const t = distortionStrength;
    landmarks.forEach(lm => {
        const latMid = (lm.lat + center.lat) / 2 * Math.PI / 180;
        const gx = (lm.lng - center.lng) * 111.32 * Math.cos(latMid);
        const gy = -(lm.lat - center.lat) * 110.57;
        const gr = Math.hypot(gx, gy);
        if (!warp) {
            const a = currentMode === 'distance' ? null : landmarkAccess(lm);
            const v = a ? (currentMode === 'time' ? a.time : a.fare) : null;
            if (currentMode === 'distance' || k == null || v == null) { lm.radial = null; return; }
            const r = (1 - t) * gr + t * k * v;
            const angle = Math.atan2(gy, gx);
            lm.radial = [Math.cos(angle) * r, Math.sin(angle) * r, gr, gx, gy];
            return;
        }
        // 背景と同じ歪め方の位置に置く（背景地図の上の本当の場所に出るので、海の上などに飛び出さない）。
        // 値の分かるランドマークは背景の歪めに使っているので、ほぼ自分の値の距離になる
        //（近くに値の大きく違う駅・バス停・ランドマークがあるときだけ、背景に合わせて少しずれる）
        lm.km = currentMode === 'distance' ? [gx, gy, gr] : BaseMap.warpKm(warp, lm.lat, lm.lng);
    });
}

// 表示中のランドマークを中心駅から近い順に並べた表（右上）。「近い」はモードに合わせる:
// 時間地図 = 所要時間（電車＋徒歩）、運賃地図 = 運賃（同じなら時間）、実地図 = 直線距離
let rankingCollapsed = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;   // スマホでは初めは閉じる

function renderLandmarkRanking() {
    const box = d3.select('#landmarkRanking');
    if (box.empty()) return;
    if (!landmarks.length) { box.attr('hidden', true); return; }
    const center = stations.find(s => s.id === centerId);
    const rows = landmarks.map(lm => {
        const a = landmarkAccess(lm);
        const km = lm.km ? lm.km[2] : kmBetween(lm, center);
        return { lm, a, km };
    });
    const big = 1e9;
    const key = currentMode === 'time' ? r => [r.a && r.a.time != null ? r.a.time : big, r.km]
        : currentMode === 'cost' ? r => [r.a && r.a.fare != null ? r.a.fare : big, r.a && r.a.time != null ? r.a.time : big]
            : r => [r.km, 0];
    rows.sort((x, y) => { const a = key(x), b = key(y); return a[0] - b[0] || a[1] - b[1]; });
    const fmtTime = a => (a && a.time != null ? `${Math.round(a.time)}分` : '—');
    const fmtFare = a => (a && a.fare != null ? `${a.fare}円` : '—');
    const main = r => (currentMode === 'time' ? fmtTime(r.a) : currentMode === 'cost' ? fmtFare(r.a) : `${r.km.toFixed(1)}km`);
    const sub = r => {
        const parts = [currentMode === 'time' ? fmtFare(r.a) : fmtTime(r.a)];
        if (currentMode !== 'distance') parts.push(`${r.km.toFixed(1)}km`);
        if (r.a) parts.push(landmarkWay(r.a, false));
        return parts.join(' ・ ');
    };
    const basis = { time: '所要時間', cost: '運賃', distance: '直線距離' }[currentMode];

    // 作り直す前の各行の位置（順位が変わった行を、前の位置から動かして見せる）
    const oldList = box.select('.lr-list').node();
    const oldTop = new Map(), oldRank = new Map();
    box.selectAll('.lr-row').each(function (r, i) { oldTop.set(r.lm.key, this.offsetTop); oldRank.set(r.lm.key, i); });
    const scrollTop = oldList ? oldList.scrollTop : 0;

    box.attr('hidden', null).classed('lr-collapsed', rankingCollapsed).html('');
    const head = box.append('div').attr('class', 'lr-head').attr('title', 'クリックで開く・閉じる')
        .on('click', () => { rankingCollapsed = !rankingCollapsed; renderLandmarkRanking(); writeShareState(); });
    head.append('strong').text('近いランドマーク');
    head.append('span').attr('class', 'lr-basis').text(`${center.name}${timeBasis()}から・${basis}順（${rows.length}件）`);
    head.append('span').attr('class', 'lr-toggle').text(rankingCollapsed ? '▼' : '▲');
    const li = box.append('ol').attr('class', 'lr-list').selectAll('li').data(rows).join('li').attr('class', 'lr-row')
        .attr('title', r => `クリックで${landmarkLink(r.lm).label}を開く`)
        .on('mouseenter', (e, r) => landmarkSel && landmarkSel.classed('hl', d => d === r.lm))
        .on('mouseleave', () => landmarkSel && landmarkSel.classed('hl', false))
        .on('click', (e, r) => openLandmarkLink(r.lm));
    li.append('span').attr('class', 'lr-rank').text((r, i) => i + 1);
    const name = li.append('span').attr('class', 'lr-name').attr('title', r => r.lm.name);
    name.append('i').style('background', r => r.lm.color);
    name.append('span').text(r => r.lm.name);
    li.append('span').attr('class', 'lr-value').text(main);
    li.append('span').attr('class', 'lr-sub').text(sub);

    box.select('.lr-list').node().scrollTop = scrollTop;
    li.each(function (r, i) {
        const top = oldTop.get(r.lm.key);
        if (top == null || top === this.offsetTop || !this.animate) return;
        this.animate([{ transform: `translateY(${top - this.offsetTop}px)` }, { transform: 'none' }],
            { duration: 500, easing: 'ease-in-out' });
        // 上がった行は緑、下がった行は赤で少しの間色を付ける
        const up = i < oldRank.get(r.lm.key);
        this.animate([{ backgroundColor: up ? '#d3f9d8' : '#ffe3e3' }, { backgroundColor: 'transparent' }],
            { duration: 1200, easing: 'ease-out' });
    });
}

// 表示するランドマークを読み直して、記号と名前を作る（位置は updateLayout で決める）
function renderLandmarks() {
    landmarks = typeof LandmarkStore !== 'undefined' ? LandmarkStore.visibleItems() : [];
    landmarks.forEach(lm => { lm.isLandmark = true; lm.near = nearStations(lm); });
    const on = sel => sel
        .on('mouseover', showLandmarkTooltip)
        .on('mousemove', moveTooltip)
        .on('mouseout', hideTooltip)
        .on('click', (e, d) => tapOrSelect(e, d, showLandmarkTooltip, openLandmarkLink))
        .on('dblclick', e => e.stopPropagation());
    landmarkSel = on(rootLayer.select('.landmarks').selectAll('g.landmark').data(landmarks, d => d.key).join(enter => {
        const g = enter.append('g').attr('class', 'landmark');
        const pin = g.append('g').attr('class', 'pin');   // 拡大しても画面上の大きさを保つため、この中だけ縮める
        pin.append('path').attr('d', PIN_PATH);
        pin.append('circle').attr('class', 'pin-dot').attr('cy', -PIN_HEAD_Y).attr('r', 2.6);
        return g;
    }));
    landmarkSel.select('path').attr('fill', d => d.color).attr('stroke-width', 1.2);
    landmarkLabelSel = on(rootLayer.select('.landmark-labels').selectAll('text').data(landmarks, d => d.key).join('text')
        .attr('class', 'landmark-label').attr('dy', '0.35em').text(d => d.name));
    applyZoomScale();
    if (!landmarks.length) renderLandmarkRanking();
}

function setupControls() {
    const modeGroup = document.getElementById('mode');   // ラジオボタン 3 つ（change はここまで伝わる）
    const slider = document.getElementById('distortion');
    const sliderValue = document.getElementById('distortionValue');
    const centerSelect = document.getElementById('centerStation');

    modeGroup.addEventListener('change', e => {
        currentMode = e.target.value;
        updateModeAvailability();
        updateLayout(true);
    });

    // データ：時刻表 ⇔ 推定（OSM）。URL の src を書き換えて開き直す（路線網ごと入れ替わるため）
    const srcGroup = document.getElementById('dataSrc');
    if (srcGroup) {
        srcGroup.querySelector(`input[value="${ESTIMATE ? 'osm' : 'timetable'}"]`).checked = true;
        if (!window.OSM_EST) srcGroup.querySelector('input[value="osm"]').disabled = true;
        srcGroup.addEventListener('change', e => {
            writeShareState();
            const p = new URLSearchParams(location.hash.slice(1));
            if (e.target.value === 'osm') p.set('src', 'osm');
            else p.delete('src');
            location.hash = p.toString();   // hashchange で開き直す
        });
    }
    // 推定には運賃が無いので、運賃地図は選べない
    if (ESTIMATE) {
        const cost = modeGroup.querySelector('input[value="cost"]');
        cost.disabled = true;
        if (cost.checked) {
            modeGroup.querySelector('input[value="time"]').checked = true;
            currentMode = 'time';
        }
    }

    slider.addEventListener('input', e => {
        distortionStrength = e.target.value / 100;
        sliderValue.textContent = e.target.value + '%';
        updateLayout(false);
    });

    centerSelect.addEventListener('change', e => changeCenter(e.target.value));

    // 背景地図の濃さ（0% で非表示）
    const basemapOpacity = document.getElementById('basemapOpacity');
    const applyBasemapOpacity = () => {
        const o = basemapOpacity.value / 100;
        document.getElementById('basemapOpacityValue').textContent = basemapOpacity.value + '%';
        BaseMap.setOpacity(o);
        if (view3dReady) View3D.setMapOpacity(o);
        writeShareState();
    };
    basemapOpacity.addEventListener('input', applyBasemapOpacity);
    applyBasemapOpacity();

    document.getElementById('view').addEventListener('change', e => setView(e.target.value));

    document.getElementById('resetBtn').addEventListener('click', () => {
        modeGroup.querySelector('input[value="distance"]').checked = true;
        slider.value = 100;
        sliderValue.textContent = '100%';
        currentMode = 'distance';
        distortionStrength = 1;
        hiddenLines.clear();   // 凡例で隠した路線・バスもすべて表示に戻す
        updateLegend();
        const def = stations.find(s => s.name === DEFAULT_CENTER_NAME) || stations[0];
        centerSelect.value = def.id;
        updateModeAvailability();
        changeCenter(def.id);
    });

    document.getElementById('shareBtn').addEventListener('click', copyShareUrl);

    // 出発時刻・平日/土休日を変えたら、時間・運賃を計算し直す
    const recompute = () => { routeData = {}; updateDepartLabel(); changeCenter(centerId); };
    document.getElementById('departTime').addEventListener('change', e => {
        departTime = parseClock(e.target.value);
        recompute();
    });
    document.getElementById('departClear').addEventListener('click', () => {
        stopDepartPlay();
        document.getElementById('departTime').value = '';
        departTime = null;
        recompute();
    });
    // ▶: 1 秒ごとに出発時刻を 1 分進める（空欄なら今の時刻から。27:59 の次は 4:00 に戻る）
    document.getElementById('departPlay').addEventListener('click', () => {
        if (departTimer) { stopDepartPlay(); return; }
        if (departTime == null) {
            const now = new Date();
            departTime = parseClock(`${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`);
            document.getElementById('departTime').value = fmtClock(departTime).padStart(5, '0');
            recompute();
        }
        setDepartPlayButton(true);
        departTimer = setInterval(() => {
            departTime = departTime + 1 >= 28 * 60 ? 4 * 60 : departTime + 1;
            document.getElementById('departTime').value = fmtClock(departTime).padStart(5, '0');
            routeData = {};
            updateDepartLabel();
            computeRouteData(centerId);
            describeData(centerId);
            updateLayout(true, 500);
        }, 1000);
    });
    document.getElementById('day').addEventListener('change', e => { dayType = e.target.value; recompute(); });
    document.getElementById('timeStat').addEventListener('change', e => { timeStat = e.target.value; recompute(); });
    // 交通手段（電車／車）と、車の高速道路の有無
    document.getElementById('travel').addEventListener('change', e => {
        travel = e.target.value;
        stopDepartPlay();
        updateTravelUI();
        recompute();
    });
    document.getElementById('useHighway').addEventListener('change', e => { useHighway = e.target.checked; recompute(); });

    // スマホ: 「設定」で操作バーの残りの項目、「凡例」で凡例を開く（地図の高さが変わるので描き直す）
    const toggleOpen = (btn, el) => btn.addEventListener('click', () => {
        const open = !el.classList.contains('open');
        el.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', String(open));
        window.dispatchEvent(new Event('resize'));
    });
    toggleOpen(document.getElementById('menuBtn'), document.getElementById('toolbar'));
    toggleOpen(document.getElementById('legendBtn'), document.getElementById('legend'));
    // 地図の何もないところをタップしたら、出していた情報を消す
    svg.on('click.tooltip', e => {
        if (!e.target.closest('.station, .station-label, .bus-hit, .landmark, .landmark-label')) { tapPreview = null; hideTooltip(); }
    });
    // 共有 URL を同じタブに貼って開き直したときは、その表示にする
    window.addEventListener('hashchange', () => location.reload());

    window.addEventListener('resize', () => {
        const { width, height } = mapSize();
        svg.attr('viewBox', `0 0 ${width} ${height}`);
        updateLayout(false);
    });
}

// --- 10. 共有 URL（表示の状態を URL の # 以降に入れる） ----------------------
//   m=モード  s=歪み(%)  c=中心駅  v=2d|3d  bg=背景地図の濃さ(%)  hide=隠した路線（,区切り）
//   lm=表示中のマイマップの mid（,区切り）  z=拡大率,横,縦（2D の拡大・移動）
//   lr=open|closed（近いランドマークの表の開閉。無ければパソコンは開く・スマホは閉じる）  lp=1（ランドマークの設定パネルを開く）
//   dt=HHMM（出発時刻。無ければ日中の値）  day=holiday（土休日ダイヤ。無ければ平日）
//   st=median|max（出発時刻が無いときの日中の平均・最大。無ければ最小）
//   src=osm（時刻表の代わりに OSM の路線から推定した時刻表を使う。無ければ時刻表）
function readShareState() {
    const p = new URLSearchParams(location.hash.slice(1));
    const num = (k, lo, hi) => (p.has(k) && isFinite(+p.get(k)) ? Math.min(hi, Math.max(lo, +p.get(k))) : null);
    const list = k => (p.get(k) || '').split(',').map(x => x.trim()).filter(Boolean);
    const z = list('z').map(Number);
    return {
        mode: ['distance', 'time', 'cost'].includes(p.get('m')) ? p.get('m') : null,
        distortion: num('s', 0, 100),
        center: p.get('c'),
        view: ['2d', '3d'].includes(p.get('v')) ? p.get('v') : null,
        basemap: num('bg', 0, 100),
        hide: list('hide'),
        landmarks: list('lm'),
        zoom: z.length === 3 && z.every(isFinite) && z[0] > 0 ? z : null,
        ranking: ['open', 'closed'].includes(p.get('lr')) ? p.get('lr') : null,
        landmarkPanel: p.get('lp') === '1',
        travel: p.get('tr') === 'car' ? 'car' : 'train',
        highway: p.get('hw') !== '0',
        departTime: /^\d{4}$/.test(p.get('dt') || '') ? parseClock(`${p.get('dt').slice(0, 2)}:${p.get('dt').slice(2)}`) : null,
        day: p.get('day') === 'holiday' ? 'holiday' : 'weekday',
        timeStat: ['median', 'max'].includes(p.get('st')) ? p.get('st') : 'min',
    };
}

function writeShareState() {
    if (!shareReady || !centerId) return;
    const p = new URLSearchParams();
    p.set('m', currentMode);
    p.set('s', Math.round(distortionStrength * 100));
    p.set('c', stations.find(s => s.id === centerId).name);
    p.set('v', document.querySelector('input[name="view"]:checked').value);
    p.set('bg', document.getElementById('basemapOpacity').value);
    if (hiddenLines.size) p.set('hide', [...hiddenLines].join(','));
    const mids = typeof LandmarkStore !== 'undefined' ? LandmarkStore.activeMids() : [];
    if (mids.length) p.set('lm', mids.join(','));
    if (landmarks.length) p.set('lr', rankingCollapsed ? 'closed' : 'open');   // 表はランドマークを出しているときだけある
    if (!document.getElementById('landmarkPanel').hidden) p.set('lp', '1');
    if (departTime != null) p.set('dt', fmtClock(departTime).padStart(5, '0').replace(':', ''));
    if (dayType === 'holiday') p.set('day', 'holiday');
    if (timeStat !== 'min') p.set('st', timeStat);
    if (travel === 'car') p.set('tr', 'car');
    if (travel === 'car' && !useHighway) p.set('hw', '0');
    if (ESTIMATE) p.set('src', 'osm');
    const t = d3.zoomTransform(svg.node());
    if (t.k !== 1 || t.x || t.y) p.set('z', [+t.k.toFixed(3), Math.round(t.x), Math.round(t.y)].join(','));
    history.replaceState(null, '', '#' + p.toString());
}

// 今の表示の URL をコピーする（コピーできない環境では URL を表示して選んでもらう）
async function copyShareUrl() {
    writeShareState();
    const url = location.href;
    try {
        await navigator.clipboard.writeText(url);
        setStatus('この表示の URL をコピーしました（貼り付けて共有できます）', 'ok');
    } catch (e) {
        window.prompt('この URL をコピーして共有してください', url);
    }
}

function init() {
    // 共有 URL の状態を、操作バーに反映してから描き始める
    const share = readShareState();
    if (share.mode) document.querySelector(`input[name="mode"][value="${share.mode}"]`).checked = true;
    if (share.distortion != null) document.getElementById('distortion').value = share.distortion;
    if (share.view) document.querySelector(`input[name="view"][value="${share.view}"]`).checked = true;
    if (share.basemap != null) document.getElementById('basemapOpacity').value = share.basemap;
    share.hide.forEach(name => hiddenLines.add(name));
    if (share.ranking) rankingCollapsed = share.ranking === 'closed';
    dayType = share.day;
    departTime = share.departTime;
    timeStat = share.timeStat;
    travel = window.CAR && !ESTIMATE ? share.travel : 'train';
    useHighway = share.highway;
    document.querySelector(`input[name="travel"][value="${travel}"]`).checked = true;
    document.getElementById('useHighway').checked = useHighway;
    updateTravelUI();
    document.getElementById('timeStat').value = timeStat;
    document.querySelector(`input[name="day"][value="${dayType}"]`).checked = true;
    document.getElementById('departTime').value = departTime != null ? fmtClock(departTime).padStart(5, '0') : '';
    updateDepartLabel();
    const slider = document.getElementById('distortion');
    distortionStrength = slider.value / 100;
    document.getElementById('distortionValue').textContent = slider.value + '%';
    currentMode = document.querySelector('input[name="mode"]:checked').value;
    initSvg();
    setupControls();

    const net = window.NETWORK;
    if (!net) {
        setStatus('data/network.js がありません。node scrape.js --network-only を実行してください', 'error');
        return;
    }
    stations = net.stations.map(s => ({ ...s }));
    edges = [...net.edges];
    // 徒歩連絡も線で結ぶ（灰色の点線）
    const byName = Object.fromEntries(stations.map(s => [s.name, s]));
    WALK_TRANSFERS.forEach(w => {
        if (byName[w.a] && byName[w.b]) edges.push({ source: byName[w.a].id, target: byName[w.b].id, line: '徒歩' });
    });
    // 乗換駅は駅名を大きく描く: 表示上の路線が 2 つ以上、線路が分かれる駅（隣の駅が 3 つ以上。京急川崎など）、
    // 徒歩連絡のある駅。HeartRails では金沢文庫も京急逗子線に入っているので、路線の数だけでは決めない
    const walkNames = new Set(WALK_TRANSFERS.flatMap(w => [w.a, w.b]));
    const neighbors = {};
    net.edges.forEach(e => {
        (neighbors[e.source] = neighbors[e.source] || new Set()).add(e.target);
        (neighbors[e.target] = neighbors[e.target] || new Set()).add(e.source);
    });
    stations.forEach(s => {
        s.transfer = displayLines(s.lines).length > 1 || (neighbors[s.id] || new Set()).size >= 3 || walkNames.has(s.name);
    });
    lineNames = net.lines;
    busStops = BUS_SOURCES.flatMap(src => {
        const routesAt = src.data.stops.map(() => new Set());
        src.data.patterns.forEach(p => p.stops.forEach(i => p.route && routesAt[i].add(p.route)));
        return src.data.stops.map(([name, lat, lng], i) => ({
            id: src.nodeNames[i], uid: src.key + '|' + i, name, lat, lng, isBus: true,
            label: src.label, color: src.color, estimated: src.data.estimated ? src.data : null,
            routes: [...routesAt[i]].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true })),
        }));
    });
    // 同じ系統で隣り合う停留所を細い線で結ぶ（同じ 2 つの停留所の線は 1 本）
    const stopByUid = Object.fromEntries(busStops.map(b => [b.uid, b]));
    const linkSeen = new Set();
    busLinks = BUS_SOURCES.flatMap(src => src.data.patterns.flatMap(p => p.stops.slice(1).map((s, j) => {
        const a = p.stops[j], key = src.key + '|' + Math.min(a, s) + '|' + Math.max(a, s);
        if (a === s || linkSeen.has(key)) return null;
        linkSeen.add(key);
        return { s: stopByUid[src.key + '|' + a], t: stopByUid[src.key + '|' + s], label: src.label, color: src.color };
    }).filter(Boolean)));
    // 停留所を飛ばす便（急行や一方通行の循環など）の A–C の線は、間に A–B・B–C とつながる停留所 B が
    // ほぼ通り道にある（遠回りが BUS_LINK_DETOUR 倍まで）なら描かない（三角形だらけで見づらいため。経路の計算には使う）
    const linkNeighbors = new Map();
    busLinks.forEach(l => {
        if (!linkNeighbors.has(l.s)) linkNeighbors.set(l.s, new Set());
        if (!linkNeighbors.has(l.t)) linkNeighbors.set(l.t, new Set());
        linkNeighbors.get(l.s).add(l.t);
        linkNeighbors.get(l.t).add(l.s);
    });
    busLinks = busLinks.filter(l => {
        const direct = kmBetween(l.s, l.t);
        return ![...linkNeighbors.get(l.s)].some(b => b !== l.t && linkNeighbors.get(b).has(l.t)
            && kmBetween(l.s, b) + kmBetween(b, l.t) <= direct * BUS_LINK_DETOUR);
    });
    centerId = (stations.find(s => s.name === share.center) || stations.find(s => s.name === DEFAULT_CENTER_NAME) || stations[0]).id;
    populateCenterSelect();
    render();
    // ランドマーク（landmarks.js）。設定が変わったら描き直す
    if (typeof LandmarkStore !== 'undefined') {
        LandmarkStore.init({
            button: document.getElementById('landmarkBtn'),
            panel: document.getElementById('landmarkPanel'),
            setStatus,
            active: share.landmarks,
            onChange: () => { renderLandmarks(); updateLayout(false); },
        });
        // 設定パネルの開閉も URL に入れる（開閉は landmarks.js がボタンのクリックで行う）
        const landmarkBtn = document.getElementById('landmarkBtn');
        landmarkBtn.addEventListener('click', () => writeShareState());
        if (share.landmarkPanel) landmarkBtn.click();
    }
    renderLandmarks();
    // 右上のランドマークの列（.map-side）は凡例の上で止める。凡例の高さは折り返しや開閉で変わるので測って CSS に渡す
    const legendEl = document.getElementById('legend');
    if (legendEl) {
        const setLegendHeight = () => legendEl.parentElement.style.setProperty('--legend-h', `${Math.ceil(legendEl.getBoundingClientRect().height)}px`);
        setLegendHeight();
        window.addEventListener('resize', setLegendHeight);
        if (window.ResizeObserver) new ResizeObserver(setLegendHeight).observe(legendEl);
        else document.getElementById('legendBtn')?.addEventListener('click', () => setTimeout(setLegendHeight));
    }
    updateModeAvailability();
    // 時間地図・運賃地図で開いたときは、まず実地図（歪み 0%）で描き、指定の歪みまでゆっくり歪める
    const targetDistortion = distortionStrength;
    const intro = currentMode !== 'distance' && targetDistortion > 0
        && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (intro) distortionStrength = 0;
    changeCenter(centerId, false);   // 最初の表示はアニメーションしない
    setView(document.querySelector('input[name="view"]:checked').value);
    if (share.zoom) svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(share.zoom[1], share.zoom[2]).scale(share.zoom[0]));
    if (intro) {
        slider.value = 0;
        document.getElementById('distortionValue').textContent = '0%';
        setTimeout(() => playIntro(targetDistortion), INTRO_DELAY_MS);   // URL は動き始めてから書く（歪み 0% を書かない）
        return;
    }
    shareReady = true;
    writeShareState();
}

// 開いたときの「実地図 → 歪めた地図」の動き
const INTRO_DELAY_MS = 500;      // 背景地図が読み込まれるのを少し待つ
const INTRO_DURATION_MS = 2000;

function playIntro(target) {
    const slider = document.getElementById('distortion');
    const label = document.getElementById('distortionValue');
    distortionStrength = target;
    shareReady = true;
    updateLayout(true, INTRO_DURATION_MS);   // 駅・線・背景地図・ランドマークを歪めた位置へ動かす（URL も最終の歪みで書く）
    // 歪みのスライダーも 0% から一緒に動かす（途中で操作されたらそちらを優先）
    d3.select(slider).transition('intro').duration(INTRO_DURATION_MS).ease(d3.easeCubicInOut)
        .tween('value', () => {
            const i = d3.interpolateNumber(0, target * 100);
            return t => { slider.value = Math.round(i(t)); label.textContent = slider.value + '%'; };
        });
    slider.addEventListener('input', () => d3.select(slider).interrupt('intro'), { once: true });
}

document.addEventListener('DOMContentLoaded', init);
