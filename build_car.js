// =====================================================================
// 車での駅から駅への所要時間と費用（目安）を作る → data/car.js
//
//   道路網: OpenStreetMap の幹線道路（高速・国道・県道・主な市道。© OpenStreetMap contributors, ODbL）
//   速さ:   国土交通省「令和3年度 全国道路・街路交通情勢調査（道路交通センサス）」の神奈川県の昼間（非混雑時）の
//           平均旅行速度を、道路の種類 × 地域（人口集中地区＝DID かどうか）ごとに使う（SPEED）。
//           DID は国土数値情報の人口集中地区（A16、2020 年）
//   駅:     data/network.js の駅。駅から最も近い道路まで（直線 × 1.3）は時速 ACCESS_KMH で走るとする
//   費用:   高速料金（有料道路の距離 × TOLL_PER_KM ＋ 入るたびに TOLL_BASE）＋ ガソリン代（距離 × FUEL_PER_KM）の目安
//   出力:   window.CAR = { stations: [駅名], highway: { time, cost }, local: { time, cost }, note }
//           time・cost は駅の数 × 駅の数の表（分・円）。highway = 高速道路を使う、local = 使わない
//
//   node build_car.js            … 取得済みのデータ（osm_road/・ksj/A16）を使う。無ければ取る
// =====================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROAD_DIR = path.join(__dirname, 'osm_road');
const DID_ZIP = path.join(__dirname, 'ksj', 'A16-20_14_GML.zip');
const DID_DIR = path.join(__dirname, 'ksj', 'A16-20_14');
const OUT = path.join(__dirname, 'data', 'car.js');
const USER_AGENT = 'distortMap-data-collector/1.0 (personal, low-frequency)';
const BBOX = { s: 35.12, w: 138.9, n: 35.68, e: 139.8 };
const TILES = 3;
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

// 道路交通センサス（令和3年度）神奈川県全域の昼間（非混雑時）の平均旅行速度（km/h）: [DID, DID 以外]
// DID 以外は「平地部」の値（市街部・山地部も近い値なので 1 つにまとめる）
const SPEED = {
    expressway: [66.5, 76.5],       // 高速道路計
    urbanExpressway: [65.8, 65.8],  // 都市高速道路（首都高速）
    motorroad: [55.6, 77.6],        // 一般国道の自動車専用道路
    national: [19.9, 49.3],         // 一般国道計
    major: [17.4, 29.4],            // 主要地方道計
    prefectural: [16.9, 27.4],      // 一般都道府県道
    city: [18.2, 19.2],             // 指定市の一般市道
};
// OSM の道路の種類 → センサスの道路の種類（日本の OSM の付け方: trunk = 一般国道、primary = 主要地方道、
// secondary = 一般県道、tertiary = 主な市町村道）
const CLASS_OF = tags => {
    const h = tags.highway.replace(/_link$/, '');
    if (h === 'motorway') return /首都高速|首都高/.test(tags.name || '') ? 'urbanExpressway' : 'expressway';
    if (h === 'trunk') return tags.motorroad === 'yes' ? 'motorroad' : 'national';
    return { primary: 'major', secondary: 'prefectural', tertiary: 'city' }[h];
};
const ACCESS_KMH = 15;      // 駅から幹線道路まで
const TOLL_PER_KM = 29.5;   // 高速料金（普通車・円/km、NEXCO の普通区間 24.6 円 × 1.1 ＋ 少し上乗せ）
const TOLL_BASE = 165;      // 入るたびにかかる分（ターミナルチャージ 150 円 × 1.1）
const FUEL_PER_KM = 12;     // ガソリン代（燃費 14 km/L・1 L 170 円）

const R = Math.PI / 180;
const kmOf = (a, b) => Math.hypot((b[0] - a[0]) * R * Math.cos(((a[1] + b[1]) / 2) * R), (b[1] - a[1]) * R) * 6371;

function overpass(q, file) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    for (let attempt = 0; attempt < 6; attempt++) {
        const url = ENDPOINTS[attempt % ENDPOINTS.length];
        try {
            const body = execFileSync('curl', ['-sf', '-A', USER_AGENT, '--data-urlencode', 'data@-', url], { input: q, maxBuffer: 512 << 20 }).toString('utf8');
            const j = JSON.parse(body);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(j));
            return j;
        } catch (e) {
            console.warn(`  取得に失敗（${url}）。少し待ってやり直します`);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000 * (attempt + 1));
        }
    }
    throw new Error('Overpass API から取得できませんでした');
}

function fetchRoads() {
    const ways = [];
    const dLat = (BBOX.n - BBOX.s) / TILES, dLng = (BBOX.e - BBOX.w) / TILES;
    for (let i = 0; i < TILES; i++) for (let j = 0; j < TILES; j++) {
        const b = [BBOX.s + i * dLat, BBOX.w + j * dLng, BBOX.s + (i + 1) * dLat, BBOX.w + (j + 1) * dLng].map(x => x.toFixed(4)).join(',');
        const q = `[out:json][timeout:300];way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](${b});` +
            `convert way ::id=id(),::geom=geom(),highway=t["highway"],oneway=t["oneway"],toll=t["toll"],name=t["name"],motorroad=t["motorroad"];out geom;`;
        const j2 = overpass(q, path.join(ROAD_DIR, `tile_${i}_${j}.json`));
        ways.push(...j2.elements);
        console.log(`  道路 ${i * TILES + j + 1}/${TILES * TILES}: 累計 ${ways.length} 本`);
    }
    // タイルの境目で同じ道が 2 回入るので 1 つにする
    return [...new Map(ways.map(w => [w.id, w])).values()];
}

// 人口集中地区（DID）の多角形と、点が中にあるかの判定（約 1km 四方の格子で候補を絞る）
function loadDid() {
    if (!fs.existsSync(DID_DIR)) {
        if (!fs.existsSync(DID_ZIP)) execFileSync('curl', ['-sfL', '-A', USER_AGENT, '-o', DID_ZIP, 'https://nlftp.mlit.go.jp/ksj/gml/data/A16/A16-20/A16-20_14_GML.zip']);
        fs.mkdirSync(DID_DIR, { recursive: true });
        execFileSync('unzip', ['-o', '-q', DID_ZIP, '-d', DID_DIR]);
    }
    const file = (function find(d) {
        for (const f of fs.readdirSync(d)) {
            const p = path.join(d, f);
            if (fs.statSync(p).isDirectory()) { const r = find(p); if (r) return r; } else if (/\.geojson$/i.test(f)) return p;
        }
    })(DID_DIR);
    if (!file) return () => false;
    const polys = [];
    for (const f of JSON.parse(fs.readFileSync(file, 'utf8')).features) {
        const g = f.geometry;
        for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) polys.push(poly[0]);
    }
    const grid = new Map();
    polys.forEach((ring, idx) => {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        for (let gx = Math.floor(x0 * 90); gx <= Math.floor(x1 * 90); gx++) for (let gy = Math.floor(y0 * 110); gy <= Math.floor(y1 * 110); gy++) {
            const k = gx + ',' + gy;
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push(idx);
        }
    });
    const inside = (ring, x, y) => {
        let c = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
        }
        return c;
    };
    return (x, y) => (grid.get(Math.floor(x * 90) + ',' + Math.floor(y * 110)) || []).some(i => inside(polys[i], x, y));
}

// 二分ヒープ
class Heap {
    constructor() { this.a = []; }
    push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
    pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
    get size() { return this.a.length; }
}

function main() {
    const ways = fetchRoads();
    const inDid = loadDid();
    // 道路のグラフ: 点は座標（小数 5 桁）、辺は [行き先, 分, km, 有料か]
    const id = new Map(), pts = [], adj = [];
    const node = c => {
        const k = c[0].toFixed(5) + ',' + c[1].toFixed(5);
        if (!id.has(k)) { id.set(k, pts.length); pts.push(c); adj.push([]); }
        return id.get(k);
    };
    let didKm = 0, allKm = 0;
    for (const w of ways) {
        const tags = w.tags || {};
        const cls = CLASS_OF(tags);
        if (!cls || !w.geometry) continue;
        // convert で出したので geometry は GeoJSON の LineString（[経度, 緯度] の並び）
        const coords = w.geometry.type === 'LineString' ? w.geometry.coordinates : w.geometry.coordinates.flat();
        const toll = tags.toll === 'yes' || cls === 'expressway' || cls === 'urbanExpressway';
        const oneway = tags.oneway === 'yes' || tags.oneway === '1' || /^motorway/.test(tags.highway) ? 1 : tags.oneway === '-1' ? -1 : 0;
        for (let i = 1; i < coords.length; i++) {
            const a = node(coords[i - 1]), b = node(coords[i]);
            if (a === b) continue;
            const km = kmOf(pts[a], pts[b]);
            const mid = [(pts[a][0] + pts[b][0]) / 2, (pts[a][1] + pts[b][1]) / 2];
            const did = inDid(mid[0], mid[1]);
            const min = km / SPEED[cls][did ? 0 : 1] * 60;
            allKm += km; if (did) didKm += km;
            if (oneway >= 0) adj[a].push([b, min, km, toll]);
            if (oneway <= 0) adj[b].push([a, min, km, toll]);
        }
    }
    console.log(`  道路の点 ${pts.length}・延長 ${allKm.toFixed(0)} km（うち DID ${(didKm / allKm * 100).toFixed(0)}%）`);

    // 駅 → 近くの道路の点（約 1km 四方の格子）
    const grid = new Map();
    pts.forEach((c, i) => { const k = Math.floor(c[0] * 90) + ',' + Math.floor(c[1] * 110); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    const ctx = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'data', 'network.js'), 'utf8'), ctx);
    const stations = ctx.window.NETWORK.stations;
    const access = stations.map(s => {
        const c = [s.lng, s.lat], gx = Math.floor(s.lng * 90), gy = Math.floor(s.lat * 110);
        let best = -1, bd = Infinity;
        for (let r = 0; r <= 3 && best < 0; r++) for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
            for (const n of grid.get((gx + i) + ',' + (gy + j)) || []) { const d = kmOf(c, pts[n]); if (d < bd) { bd = d; best = n; } }
        }
        // 一方通行の行き止まり（入れない・出られない点）に寄せないよう、辺のある点だけを選んでいる（adj は両向きで確認）
        return { node: best, km: bd * 1.3, min: bd * 1.3 / ACCESS_KMH * 60 };
    });
    // 入ってくる辺（逆向きのグラフ）は使わない: 行きは駅 A から、帰りの表は別に計算する（一方通行があるので非対称）
    const N = stations.length;
    const run = useToll => {
        const time = [], cost = [];
        for (let si = 0; si < N; si++) {
            const src = access[si];
            const dist = new Float64Array(pts.length).fill(Infinity), km = new Float64Array(pts.length), tollKm = new Float64Array(pts.length), entries = new Uint16Array(pts.length), onToll = new Uint8Array(pts.length);
            const h = new Heap();
            dist[src.node] = src.min; h.push([src.min, src.node]);
            while (h.size) {
                const [d, u] = h.pop();
                if (d > dist[u]) continue;
                for (const [v, m, k, toll] of adj[u]) {
                    if (toll && !useToll) continue;
                    const nd = d + m;
                    if (nd < dist[v]) {
                        dist[v] = nd; km[v] = km[u] + k; tollKm[v] = tollKm[u] + (toll ? k : 0);
                        entries[v] = entries[u] + (toll && !onToll[u] ? 1 : 0); onToll[v] = toll ? 1 : 0;
                        h.push([nd, v]);
                    }
                }
            }
            time.push(access.map((a, ti) => ti === si ? 0 : Math.round(dist[a.node] + a.min)));
            cost.push(access.map((a, ti) => ti === si ? 0 : Math.round((tollKm[a.node] * TOLL_PER_KM + entries[a.node] * TOLL_BASE + (km[a.node] + src.km + a.km) * FUEL_PER_KM) / 10) * 10));
        }
        return { time, cost };
    };
    const highway = run(true), local = run(false);
    const out = {
        note: '車の所要時間（道路交通センサス 令和3年度 神奈川県の昼間の平均旅行速度で、OpenStreetMap の幹線道路を走るとした目安）と費用（高速料金・ガソリン代の目安）',
        stations: stations.map(s => s.name), highway, local,
        assumptions: { speed: SPEED, accessKmh: ACCESS_KMH, tollPerKm: TOLL_PER_KM, tollBase: TOLL_BASE, fuelPerKm: FUEL_PER_KM },
    };
    fs.writeFileSync(OUT, `// build_car.js で生成（道路: © OpenStreetMap contributors, ODbL／速さ: 国土交通省 道路交通センサス 令和3年度／人口集中地区: 国土数値情報 A16, CC BY 4.0）\nwindow.CAR = ${JSON.stringify(out)};\n`);
    const ix = n => stations.findIndex(s => s.name === n);
    for (const [a, b] of [['横浜', '金沢八景'], ['横浜', '品川'], ['金沢八景', '鎌倉'], ['横浜', '海老名']]) {
        const i = ix(a), j = ix(b);
        if (i >= 0 && j >= 0) console.log(`  ${a}→${b}: 高速あり ${highway.time[i][j]} 分・${highway.cost[i][j]} 円 / 高速なし ${local.time[i][j]} 分・${local.cost[i][j]} 円`);
    }
    console.log(`駅 ${N} → ${OUT}（${(fs.statSync(OUT).size / 1024).toFixed(0)} KB）`);
    exportGraph(pts, adj, access);
}

// ブラウザでランドマークまでの経路を計算するための、道路網の軽い版 → data/car_graph.js（車でランドマークを出すときだけ読む）
// 交差点（つながる点が 2 つでない点）と駅の近くの点だけを残し、間の点は 1 本の辺にまとめる
function exportGraph(pts, adj, access) {
    const und = adj.map(() => new Set());
    adj.forEach((list, u) => list.forEach(([v]) => { und[u].add(v); und[v].add(u); }));
    const keep = new Uint8Array(pts.length);
    und.forEach((s, i) => { if (s.size !== 2) keep[i] = 1; });
    access.forEach(a => { if (a.node >= 0) keep[a.node] = 1; });
    const kid = new Int32Array(pts.length).fill(-1);
    let K = 0;
    keep.forEach((k, i) => { if (k) kid[i] = K++; });
    // 辺: [元, 先, 分, km, 有料の km, 印（1: 最初が有料、2: 最後が有料）]
    const edges = [];
    for (let u = 0; u < pts.length; u++) {
        if (!keep[u]) continue;
        for (const [v0, m0, k0, t0] of adj[u]) {
            let prev = u, v = v0, min = m0, km = k0, tk = t0 ? k0 : 0, last = t0, guard = 0;
            while (!keep[v] && guard++ < 100000) {
                const nx = adj[v].find(([w]) => w !== prev);
                if (!nx) break;
                prev = v; v = nx[0]; min += nx[1]; km += nx[2]; if (nx[3]) tk += nx[2]; last = nx[3];
            }
            if (keep[v] && v !== u) edges.push([kid[u], kid[v], min, km, tk, (t0 ? 1 : 0) | (last ? 2 : 0)]);
        }
    }
    edges.sort((a, b) => a[0] - b[0]);
    const off = new Int32Array(K + 1);
    for (const e of edges) off[e[0] + 1]++;
    for (let i = 0; i < K; i++) off[i + 1] += off[i];
    const enc = arr => Buffer.from(arr.buffer).toString('base64');
    const lat = new Int32Array(K), lng = new Int32Array(K);
    keep.forEach((k, i) => { if (k) { lng[kid[i]] = Math.round(pts[i][0] * 1e5); lat[kid[i]] = Math.round(pts[i][1] * 1e5); } });
    const out = {
        n: K, lat: enc(lat), lng: enc(lng), off: enc(off),
        to: enc(Int32Array.from(edges, e => e[1])),
        min: enc(Float32Array.from(edges, e => e[2])),
        km: enc(Float32Array.from(edges, e => e[3])),
        tollKm: enc(Float32Array.from(edges, e => e[4])),
        flag: enc(Uint8Array.from(edges, e => e[5])),
        stationNode: access.map(a => (a.node >= 0 ? kid[a.node] : -1)),
        stationAccess: access.map(a => [+a.min.toFixed(2), +a.km.toFixed(3)]),
        accessKmh: ACCESS_KMH, tollPerKm: TOLL_PER_KM, tollBase: TOLL_BASE, fuelPerKm: FUEL_PER_KM,
    };
    const file = path.join(__dirname, 'data', 'car_graph.js');
    fs.writeFileSync(file, `// build_car.js で生成（道路: © OpenStreetMap contributors, ODbL／速さ: 国土交通省 道路交通センサス 令和3年度）。` +
        `数値の配列は base64（lat・lng は 10 万倍の整数）\nwindow.CAR_GRAPH = ${JSON.stringify(out)};\n`);
    console.log(`  ブラウザ用の道路網: 点 ${K}・辺 ${edges.length} → ${file}（${(fs.statSync(file).size / 1024).toFixed(0)} KB）`);
}

main();
