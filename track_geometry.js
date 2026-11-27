// =====================================================================
// 線路の形（国土数値情報 鉄道 N02、CC BY 4.0）から、駅と駅の間の「線路に沿った距離」と「カーブの量」を求める
// （build_osm_estimate.js・calibrate_estimate.js で使う）
//
//   線路の区間（LineString）の点をつないだグラフを作り、駅の位置に最も近い点どうしの最短の道のりをたどる。
//   カーブの量は、たどった線路の向きの変わり方の合計（ラジアン）。曲がりが多いほど遅くなる手がかりにする
//
//   データ: https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-24/N02-24_GML.zip を ksj/N02/ に展開する（ksj/ はリポジトリに入れない）
// =====================================================================
const fs = require('fs');
const path = require('path');

const N02 = path.join(__dirname, 'ksj', 'N02', 'UTF-8', 'N02-24_RailroadSection.geojson');
const N02_STATION = path.join(__dirname, 'ksj', 'N02', 'UTF-8', 'N02-24_Station.geojson');   // 駅の中の線路（区間は駅で切れている）
const SNAP_KM = 0.4;          // 駅からこの距離までの線路の点に寄せる
const MAX_KM = 60;            // これより遠い駅どうしは探さない
const MIN_STEP_KM = 0.02;     // 向きの変わり方を数えるときに無視する短い区間
const JOIN_KM = 0.05;

const R = Math.PI / 180;
const kmOf = (a, b) => Math.hypot((b[0] - a[0]) * R * Math.cos(((a[1] + b[1]) / 2) * R), (b[1] - a[1]) * R) * 6371;

function loadTrack(bbox) {
    if (!fs.existsSync(N02)) return null;
    const feats = [N02, N02_STATION].filter(f => fs.existsSync(f)).flatMap(f => JSON.parse(fs.readFileSync(f, 'utf8')).features);
    const id = new Map(), pts = [], adj = [], lineOf = [];
    let curLine = '';
    const node = c => {
        const k = c[0].toFixed(5) + ',' + c[1].toFixed(5);
        if (!id.has(k)) { id.set(k, pts.length); pts.push(c); adj.push([]); lineOf.push(curLine); }
        return id.get(k);
    };
    const inBox = c => c[1] >= bbox.s - 0.05 && c[1] <= bbox.n + 0.05 && c[0] >= bbox.w - 0.05 && c[0] <= bbox.e + 0.05;
    for (const f of feats) {
        curLine = f.properties.N02_004 + '|' + f.properties.N02_003;   // 会社と路線
        const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const line of lines) {
            if (!line.some(inBox)) continue;
            for (let i = 1; i < line.length; i++) {
                const a = node(line[i - 1]), b = node(line[i]);
                if (a === b) continue;
                const d = kmOf(pts[a], pts[b]);
                adj[a].push([b, d]); adj[b].push([a, d]);
            }
        }
    }
    // 近い点を探すための格子（約 1km 四方）
    const grid = new Map();
    const cell = c => Math.floor(c[0] * 90) + ',' + Math.floor(c[1] * 110);
    pts.forEach((c, i) => { const k = cell(c); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    // 区間の端（つながりが 1 つの点）は、JOIN_KM 以内の別の点とつなぐ（区間の端の座標がわずかにずれていて切れているため）
    const ends = [];
    adj.forEach((list, i) => { if (list.length === 1) ends.push(i); });
    for (const e of ends) {
        const c = pts[e], gx = Math.floor(c[0] * 90), gy = Math.floor(c[1] * 110);
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
            for (const n of grid.get((gx + i) + ',' + (gy + j)) || []) {
                if (n === e || adj[e].some(x => x[0] === n)) continue;
                const d = kmOf(c, pts[n]);
                if (d <= JOIN_KM) { adj[e].push([n, d]); adj[n].push([e, d]); }
            }
        }
    }
    // 駅の近く（SNAP_KM 以内）の線路の点: 路線ごとに最も近い点。駅の近くを別の会社の線路が通っていても
    // （上大岡の京急と地下鉄など）、相手の駅と同じ路線の線路を選べるように
    const snap = (lat, lng) => {
        const c = [lng, lat], gx = Math.floor(lng * 90), gy = Math.floor(lat * 110);
        const best = new Map();   // 路線 -> [点, 距離]
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
            for (const n of grid.get((gx + i) + ',' + (gy + j)) || []) {
                const d = kmOf(c, pts[n]);
                if (d < SNAP_KM && !(best.get(lineOf[n])?.[1] <= d)) best.set(lineOf[n], [n, d]);
            }
        }
        return best;
    };

    // 出発点ごとの最短の道のり（Dijkstra）を覚えておく
    const cache = new Map();
    const fromNode = src => {
        if (cache.has(src)) return cache.get(src);
        const dist = new Map([[src, 0]]), prev = new Map();
        const heap = [[0, src]];
        const push = x => { heap.push(x); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
        const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
        while (heap.length) {
            const [d, u] = pop();
            if (d > dist.get(u) || d > MAX_KM) continue;
            for (const [v, w] of adj[u]) {
                const nd = d + w;
                if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); push([nd, v]); }
            }
        }
        const r = { dist, prev };
        cache.set(src, r);
        if (cache.size > 400) cache.delete(cache.keys().next().value);
        return r;
    };
    // 2 地点の間の線路に沿った距離（km）とカーブの量（ラジアン）。線路でつながらなければ null
    const hop = (a, b) => {
        const S = snap(a.lat, a.lng), T = snap(b.lat, b.lng);
        // 両方の駅の近くの線路の点の組のうち、道のりが最も短いもの（同じ路線の組を先に、無ければどの組でも）
        let s = -1, t = -1, bestKm = Infinity;
        const tryPairs = same => {
            for (const [k, [sn, sd]] of S) for (const [k2, [tn, td]] of T) {
                if (same && k !== k2) continue;
                const d = sn === tn ? 0 : fromNode(sn).dist.get(tn);
                if (d != null && d + sd + td < bestKm) { bestKm = d + sd + td; s = sn; t = tn; }
            }
        };
        tryPairs(true);
        if (s < 0) tryPairs(false);
        if (s < 0) return null;
        if (s === t) return { km: kmOf([a.lng, a.lat], [b.lng, b.lat]), turn: 0 };
        const { dist, prev } = fromNode(s);
        // 道のりをたどって向きの変わり方を足す
        const seq = [t];
        for (let u = t; u !== s; u = prev.get(u)) seq.push(prev.get(u));
        seq.reverse();
        let turn = 0, lastAng = null, acc = 0, from = pts[seq[0]];
        for (let i = 1; i < seq.length; i++) {
            const p = pts[seq[i]];
            acc = kmOf(from, p);
            if (acc < MIN_STEP_KM) continue;
            const ang = Math.atan2((p[1] - from[1]), (p[0] - from[0]) * Math.cos(p[1] * R));
            if (lastAng != null) { let dA = Math.abs(ang - lastAng); if (dA > Math.PI) dA = 2 * Math.PI - dA; turn += dA; }
            lastAng = ang; from = p;
        }
        return { km: dist.get(t), turn };
    };
    return { hop, nodes: pts.length };
}

module.exports = { loadTrack };
