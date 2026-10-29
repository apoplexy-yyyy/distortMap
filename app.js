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
const DEFAULT_CENTER_NAME = '金沢八景';

// 所要時間は平日 10〜15 時台に中心駅を出る列車で計算する。
// 各時台の最短所要時間を求め、その中央値を採用（データの読み取りミスに強くするため）
const TIME_WINDOW_HOURS = [10, 11, 12, 13, 14, 15];
const DWELL_MIN = 0.5;      // 京急の時刻表は発車時刻なので、到着は発車の 30 秒前とみなす

// 事業者をまたぐ乗換にかかる時間（分）。弘明寺は京急と地下鉄の駅が離れている
const TRANSFER_MIN = { '横浜': 6, '上大岡': 4, '弘明寺': 10, '金沢八景': 4, '菊名': 3 };
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

let svg, rootLayer, ringLayer, linkSel, nodeSel, labelSel;
let landmarks = [];         // 表示中のランドマーク（landmarks.js の LandmarkStore.visibleItems() に位置・近い駅を足したもの）
let landmarkSel, landmarkLabelSel;
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
        data: { stations: l.stations, trains: l.trains, fares: data.fares, fareStations: data.stations },
    }));
}
// 事業者ごとの駅は「事業者|駅名」のノードとして扱い、同じ駅名どうしは乗換でつなぐ
const OPERATORS = [
    { key: 'keikyu', label: '京急', data: window.KEIKYU, dwell: DWELL_MIN },
    // GTFS は到着時刻が正確なので、発車＝到着として扱う
    { key: 'yokohama', label: '横浜市営地下鉄', data: window.YOKOHAMA, dwell: 0 },
    { key: 'seaside', label: 'シーサイドライン', data: window.SEASIDE, dwell: DWELL_MIN },
    { key: 'minatomirai', label: 'みなとみらい線', data: window.MINATOMIRAI, dwell: DWELL_MIN },
    { key: 'sotetsu', label: '相鉄', data: window.SOTETSU, dwell: DWELL_MIN },
    // JR・東急は路線ごとに分け（同じ駅での路線間の乗換に時間がかかるように）、運賃は会社全体で 1 回の乗車として数える
    ...lineOperators(window.TOKYU, 'tokyu', '東急'),
    ...lineOperators(window.JR, 'jr', 'JR'),
].filter(op => op.data);
// 運賃を通しで数える事業者どうしか（JR の路線どうし、東急の路線どうし）
const sameFare = (a, b) => (a.fareGroup || a.key) === (b.fareGroup || b.key);

const network = (() => {
    const nodeOf = {};          // 「事業者|駅名」 -> ノード番号
    const nodes = [];           // { op, name }
    const conns = [];
    OPERATORS.forEach(op => {
        const ids = op.data.stations.map(name => {
            const key = op.key + '|' + name;
            if (!(key in nodeOf)) { nodeOf[key] = nodes.length; nodes.push({ op, name }); }
            return nodeOf[key];
        });
        op.stationSet = new Set(op.data.fareStations || op.data.stations);   // 運賃表にある駅
        // 列車データを「駅A 発 → 駅B 着」の区間（コネクション）に分解する
        op.data.trains.forEach(([, stops], i) => {
            const trip = op.key + i;
            for (let j = 0; j + 3 < stops.length; j += 2) {
                conns.push({ from: ids[stops[j]], dep: stops[j + 1], to: ids[stops[j + 2]], arr: stops[j + 3] - op.dwell, trip });
            }
        });
    });
    conns.sort((a, b) => a.dep - b.dep);
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
    return { nodeOf, nodes, conns, transfers, byName };
})();

// 中心駅を t0 に出発したときの各ノードへの最早到着時刻（Connection Scan Algorithm）
// parent には経路をたどるための情報を残す: { src } | { walkFrom: ノード } | { enter: 乗った区間, exit: 降りた区間 }
function earliestArrivals(srcNodes, t0) {
    const arr = new Array(network.nodes.length).fill(Infinity);
    const parent = new Array(network.nodes.length).fill(null);
    const boarded = new Map();   // 列車 -> 最初に乗った区間
    const reach = (n, t, p) => {
        if (t >= arr[n]) return;
        arr[n] = t;
        parent[n] = p;
        network.transfers[n].forEach(tr => {
            if (t + tr.min < arr[tr.to]) { arr[tr.to] = t + tr.min; parent[tr.to] = { walkFrom: n }; }
        });
    };
    srcNodes.forEach(n => reach(n, t0, { src: true }));   // 中心駅から徒歩連絡の駅へ歩いて乗ることもある
    for (const c of network.conns) {
        if (c.dep < t0) continue;
        const onTrip = boarded.has(c.trip);
        if (onTrip || arr[c.from] <= c.dep) {
            if (!onTrip) boarded.set(c.trip, c);
            reach(c.to, c.arr, { enter: boarded.get(c.trip), exit: c });
        }
    }
    return { arr, parent };
}

// ノード target までの経路の運賃。同じ事業者の列車が続く区間は 1 回の乗車として運賃を数え、事業者ごとに足す
function journeyFare(parent, target) {
    const steps = [];   // 古い順: { op, from, to }（駅名）または { walk: 説明 }
    for (let n = target, guard = 0; guard < 200; guard++) {
        const p = parent[n];
        if (!p) return null;
        if (p.src) break;
        if (p.walkFrom != null) {
            const a = network.nodes[p.walkFrom].name, b = network.nodes[n].name;
            if (a !== b) steps.unshift({ walk: `${a}〜${b} 徒歩` });
            n = p.walkFrom;
            continue;
        }
        steps.unshift({ op: network.nodes[p.exit.to].op, from: network.nodes[p.enter.from].name, to: network.nodes[p.exit.to].name });
        n = p.enter.from;
    }
    const rides = [], ways = [];
    steps.forEach(st => {
        if (st.walk) { ways.push(st.walk); return; }
        const last = rides[rides.length - 1];
        if (last && sameFare(last.op, st.op) && last.to === st.from) last.to = st.to;
        else {
            if (last && last.to === st.from) ways.push(`${st.from}乗換`);   // 同じ駅で別の事業者に乗り換え
            rides.push({ ...st });
        }
    });
    let fare = 0;
    const parts = [];
    for (const r of rides) {
        const f = fareOf(r.op, r.from, r.to);
        if (f == null) return null;
        fare += f;
        parts.push(`${r.op.label} ${f}円`);
    }
    const how = [...new Set(ways)].join('・');
    return { fare, note: parts.join('＋') + (how ? `（${how}）` : '') };
}

// 中心駅から各駅（駅名）への最短の所要時間（分）と、その経路の運賃
function routesFrom(centerName) {
    const src = network.byName[centerName] || [];
    // 出発時刻の候補: 中心駅の発車時刻と、乗換・徒歩連絡の先の駅の発車時刻（から歩く時間を引いたもの）
    const startAt = new Map(src.map(n => [n, 0]));
    src.forEach(n => network.transfers[n].forEach(tr => {
        if (!startAt.has(tr.to) || tr.min < startAt.get(tr.to)) startAt.set(tr.to, tr.min);
    }));
    const starts = [...new Set(network.conns
        .filter(c => startAt.has(c.from) && TIME_WINDOW_HOURS.includes(Math.floor((c.dep - startAt.get(c.from)) / 60)))
        .map(c => c.dep - startAt.get(c.from)))];
    const hourlyBest = {};   // 駅名 -> { 時: { time, fare, note } }（各時台で最も速い経路。同じ速さなら安い方）
    const better = (a, b) => !b || a.time < b.time || (a.time === b.time && (a.fare ?? Infinity) < (b.fare ?? Infinity));
    starts.forEach(t0 => {
        const h = Math.floor(t0 / 60);
        const { arr, parent } = earliestArrivals(src, t0);
        arr.forEach((a, i) => {
            const name = network.nodes[i].name;
            if (!isFinite(a) || name === centerName) return;
            const best = (hourlyBest[name] = hourlyBest[name] || {});
            const cand = { time: a - t0 };
            if (!better(cand, best[h]) && !(best[h] && cand.time === best[h].time)) return;
            Object.assign(cand, journeyFare(parent, i) || { fare: null, note: null });
            if (better(cand, best[h])) best[h] = cand;
        });
    });
    // 各時台の最速の経路のうち、所要時間が中央の時台のものを採用する（データの読み取りミスに強くするため）
    const result = {};
    Object.entries(hourlyBest).forEach(([name, byHour]) => {
        const list = Object.values(byHour).sort((a, b) => a.time - b.time || (a.fare ?? Infinity) - (b.fare ?? Infinity));
        const pick = list[Math.floor((list.length - 1) / 2)];
        result[name] = { time: Math.round(pick.time), fare: pick.fare, note: pick.note };
    });
    return result;
}

// 事業者 op で駅 a から駅 b まで乗ったときの運賃
function fareOf(op, a, b) {
    if (!op.stationSet.has(a) || !op.stationSet.has(b)) return null;
    return a === b ? 0 : (op.data.fares[pairKey(a, b)] ?? null);
}
// 時刻表のない区間用: 中心駅から各駅への最も安い運賃（乗換は何回でも）。
// 「ある事業者に乗る駅」→「降りる駅」を 1 回の乗車（その区間の運賃）とし、乗換・徒歩連絡は 0 円でつなぐ
function cheapestFares(fromName) {
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
function computeRouteData(cid) {
    if (routeData[cid]) return routeData[cid];
    const center = stations.find(s => s.id === cid);
    const result = { [cid]: { time: 0, fare: 0 } };
    const routes = routesFrom(center.name);
    const cheap = cheapestFares(center.name);
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
            ? { time, fare: f ? f.fare : null, fareNote: f ? f.note + (time == null ? '・時刻表なしのため最安の運賃' : '') : null }
            : null;
    });
    return (routeData[cid] = result);
}

function describeData(cid) {
    const center = stations.find(s => s.id === cid);
    const total = stations.length - 1;
    const values = stations.filter(s => s.id !== cid).map(s => routeData[cid][s.id]);
    const withTime = values.filter(v => v && v.time != null).length;
    const withFare = values.filter(v => v && v.fare != null).length;
    if (!OPERATORS.length) return setStatus('時刻表・運賃のデータがありません（build_keikyu.py / build_yokohama.py を実行）', 'error');
    const noTimetable = OPERATORS.filter(op => !op.data.trains.length).map(op => op.label);
    const ok = withTime === total && withFare === total;
    setStatus(`${center.name} から: 時間 ${withTime} / ${total} 駅・運賃 ${withFare} / ${total} 駅` +
        (noTimetable.length ? `（${noTimetable.join('・')}は時刻表データ未取得）` : '') +
        (ok ? '' : '。データなしの駅は実際の位置に灰色で表示'), ok ? 'ok' : 'warn');
}

// --- 6. レイアウト計算 ---------------------------------------------------
// 中心駅を原点とした km 座標（x: 東, y: 南）
function computeGeo() {
    const c = stations.find(s => s.id === centerId);
    stations.forEach(s => {
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
        stations.forEach(s => { s.px = s.geo.x; s.py = s.geo.y; s.missing = false; });
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
            onSelect: d => (d.isLandmark ? selectLandmark(d) : selectCenter(d)),
        });
        view3dReady = true;
    }
    d3.select(mapEl).append('div').attr('class', 'attribution')
        .html('地図: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院（淡色地図）</a>');
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
        .on('click', (e, d) => selectCenter(d));

    labelSel = rootLayer.select('.labels').selectAll('text').data(stations, d => d.id).join('text')
        .attr('class', 'station-label')
        .classed('transfer', d => d.transfer)
        .attr('dy', '0.35em')   // y は文字の縦中央（位置は placeLabels で決める）
        .text(d => d.name)
        .on('mouseover', showTooltip)
        .on('mousemove', moveTooltip)
        .on('mouseout', hideTooltip)
        .on('click', (e, d) => selectCenter(d))
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

    stations.forEach(s => { s.fx = X(s); s.fy = Y(s); });   // アニメーション後の位置
    const warp = buildWarp(cx, cy, scale);
    placeLandmarks(k, warp);
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
    writeShareState();
}

// 駅名を置く優先順（中心駅 → 乗換駅 → その他）
const labelPriority = (a, b) => (b.id === centerId) - (a.id === centerId) || b.transfer - a.transfer
    || b.lines.length - a.lines.length;

// 背景地図の歪め方: 駅ごとの伸縮率（歪めた後の距離 ÷ 実際の距離）と、画面への縮尺
function buildWarp(cx, cy, scale) {
    const center = stations.find(s => s.id === centerId);
    const points = stations
        .filter(s => s.id !== centerId && !s.missing && s.geo.r > 0.05)   // データなしの駅は歪めに使わない
        .map(s => ({ x: s.geo.x, y: s.geo.y, s: Math.hypot(s.px, s.py) / s.geo.r }));
    return {
        lat0: center.lat, lng0: center.lng, cx, cy, scale, points,
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
            info += `<div class="tooltip-info"><strong>${center.name}から:</strong> ${rd.time != null ? rd.time + '分' : '—'} / ${rd.fare != null ? rd.fare + '円' : '—'}</div>`;
            if (rd.fareNote) info += `<div class="tooltip-hint">運賃（IC）: ${rd.fareNote}</div>`;
        } else {
            info += '<div class="tooltip-info">時間・運賃データなし</div>';
        }
    }
    d3.select('body').append('div').attr('class', 'tooltip').html(`
        <div class="tooltip-title">${d.name}</div>
        <div class="tooltip-info"><strong>路線:</strong> ${displayLines(d.lines).join('・')}</div>
        ${info}
        <div class="tooltip-hint">駅または駅名のクリックで中心駅に設定</div>`);
    moveTooltip(event);
}
function moveTooltip(event) {
    d3.select('.tooltip').style('left', (event.pageX + 12) + 'px').style('top', (event.pageY - 12) + 'px');
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
        const walk = `${a.station.name}${a.station.id === centerId ? '（中心駅）' : '駅'}から徒歩 約${Math.round(a.walk)}分`;
        info = `<div class="tooltip-info"><strong>${center.name}から:</strong> ${a.time != null ? Math.round(a.time) + '分' : '—'} / ${a.fare != null ? a.fare + '円' : '—'}</div>
            <div class="tooltip-hint">${walk}（直線距離の1.3倍を分速80mで歩くとして計算）</div>`;
    }
    d3.select('body').append('div').attr('class', 'tooltip').html(`
        <div class="tooltip-title">${escapeHtml(d.name)}</div>
        ${where ? `<div class="tooltip-info">${where}</div>` : ''}
        ${d.note ? `<div class="tooltip-hint">${escapeHtml(d.note)}</div>` : ''}
        ${info}
        ${a ? `<div class="tooltip-hint">クリックで${a.station.name}を中心駅に設定</div>` : ''}`);
    moveTooltip(event);
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
    return (near.length ? near : all.slice(0, 1)).map(n => ({ ...n, walk: n.km * 1000 * WALK_DETOUR / WALK_M_PER_MIN }));
}

// 中心駅からの時間（電車＋徒歩）が最も短い近い駅。時間が分からなければ最も近い駅
function landmarkAccess(lm) {
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
// 方角は実際の方角のまま、中心からの距離を「自分の値（時間＝最寄り駅までの時間＋徒歩、運賃＝その駅の運賃）」にする。
// 値が分からないランドマークは、背景地図と同じ歪め方の位置に置く
function placeLandmarks(k, warp) {
    const center = stations.find(s => s.id === centerId);
    const t = distortionStrength;
    landmarks.forEach(lm => {
        const latMid = (lm.lat + center.lat) / 2 * Math.PI / 180;
        const gx = (lm.lng - center.lng) * 111.32 * Math.cos(latMid);
        const gy = -(lm.lat - center.lat) * 110.57;
        const gr = Math.hypot(gx, gy);
        const a = currentMode === 'distance' ? null : landmarkAccess(lm);
        const v = a ? (currentMode === 'time' ? a.time : a.fare) : null;
        if (currentMode === 'distance' || k == null || v == null) {
            lm.km = currentMode === 'distance' ? [gx, gy, gr] : BaseMap.warpKm(warp, lm.lat, lm.lng);
            return;
        }
        const r = (1 - t) * gr + t * k * v;
        const angle = Math.atan2(gy, gx);
        lm.km = [Math.cos(angle) * r, Math.sin(angle) * r, gr];
    });
}

function selectLandmark(d) {
    const a = landmarkAccess(d);
    if (a) selectCenter(a.station);
}

// 表示するランドマークを読み直して、記号と名前を作る（位置は updateLayout で決める）
function renderLandmarks() {
    landmarks = typeof LandmarkStore !== 'undefined' ? LandmarkStore.visibleItems() : [];
    landmarks.forEach(lm => { lm.isLandmark = true; lm.near = nearStations(lm); });
    const on = sel => sel
        .on('mouseover', showLandmarkTooltip)
        .on('mousemove', moveTooltip)
        .on('mouseout', hideTooltip)
        .on('click', (e, d) => selectLandmark(d))
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
        const def = stations.find(s => s.name === DEFAULT_CENTER_NAME) || stations[0];
        centerSelect.value = def.id;
        updateModeAvailability();
        changeCenter(def.id);
    });

    document.getElementById('shareBtn').addEventListener('click', copyShareUrl);
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
    }
    renderLandmarks();
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
