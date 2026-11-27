// =====================================================================
// 推定の所要時間の式を、時刻表データで一度だけ較正する → est_calibration.json
//
//   推定（build_osm_estimate.js）は、どの路線でも取れるデータ（OSM の駅の並び、国土数値情報 N02 の線路の形）だけで作る。
//   その所要時間の式
//       駅間の所要時間（分） = a × 線路に沿った距離（km） ＋ b ＋ c × カーブの量（ラジアン）
//   の a・b・c を、時刻表データのある路線の駅間（各停・速い列車ごと）に合わせて決める。
//   時刻表データは答え合わせにだけ使い、推定の中身（停車駅・時刻）には入れない
//
//   node calibrate_estimate.js
// =====================================================================
const fs = require('fs');
const path = require('path');
const { load, tierOf, timetableSources } = require('./timetable_sources');
const { loadTrack } = require('./track_geometry');

const OUT = path.join(__dirname, 'est_calibration.json');
const BBOX = { s: 35.12, w: 138.9, n: 35.68, e: 139.8 };
const FAST_QUANTILE = 0.25;   // 同じ駅間の列車のうち速い方から 25%（通過待ちで止まっている各停を除くため）
const KINDS = ['train', 'subway'];   // 較正する路線の種類（路面電車・モノレール・新交通は時刻表データが少ないので目安のまま）
const normName = s => (s || '').replace(/(?<=[一-鿿])ケ(?=[一-鿿])/g, 'ヶ').replace(/\s+/g, '').replace(/駅$/, '').replace(/[（(].*?[）)]$/, '');

// 最小二乗（正規方程式）。x: 説明変数の配列、y: 目的
function leastSquares(rows) {
    const k = rows[0].x.length;
    const A = Array.from({ length: k }, () => new Array(k).fill(0)), B = new Array(k).fill(0);
    for (const { x, y } of rows) for (let i = 0; i < k; i++) { B[i] += x[i] * y; for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j]; }
    // ガウスの消去法
    for (let i = 0; i < k; i++) {
        let p = i;
        for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
        [A[i], A[p]] = [A[p], A[i]]; [B[i], B[p]] = [B[p], B[i]];
        for (let r = 0; r < k; r++) {
            if (r === i || !A[i][i]) continue;
            const f = A[r][i] / A[i][i];
            for (let c = i; c < k; c++) A[r][c] -= f * A[i][c];
            B[r] -= f * B[i];
        }
    }
    return B.map((b, i) => b / A[i][i]);
}

function main() {
    const w = load();
    const track = loadTrack(BBOX);
    if (!track) throw new Error('ksj/N02 の線路のデータがありません');
    const pos = Object.fromEntries(w.NETWORK.stations.map(s => [normName(s.name), s]));
    const samples = {};   // 種類|段 -> 駅の組 -> { km, turn, ts: [] }
    for (const [src, , kind] of timetableSources(w)) {
        if (!KINDS.includes(kind)) continue;
        const names = src.stations.map(normName);
        const trains = src.trains.map(([type, st]) => {
            const hops = [];
            for (let j = 0; j + 3 < st.length; j += 2) {
                const A = names[st[j]], B = names[st[j + 2]];
                const t = st[j + 3] - st[j + 1];
                if (pos[A] && pos[B] && t > 0 && t < 40) hops.push({ A, B, t });
            }
            return { type, hops };
        }).filter(x => x.hops.length);
        // 区間の平均の長さ（直線）で段を決める列車用
        const straight = (A, B) => Math.hypot((pos[B].lng - pos[A].lng) * 91, (pos[B].lat - pos[A].lat) * 111);
        const means = trains.map(x => x.hops.reduce((s, h) => s + straight(h.A, h.B), 0) / x.hops.length).sort((a, b) => a - b);
        const localHop = means[Math.floor(means.length * 0.25)];
        for (const tr of trains) {
            const mean = tr.hops.reduce((s, h) => s + straight(h.A, h.B), 0) / tr.hops.length;
            const tier = tierOf(tr.type, mean, localHop) > 0 ? 'fast' : 'local';
            const S = (samples[kind + '|' + tier] = samples[kind + '|' + tier] || new Map());
            for (const h of tr.hops) {
                const key = h.A + '|' + h.B;
                if (!S.has(key)) {
                    const g = track.hop(pos[h.A], pos[h.B]);
                    if (!g || g.km > straight(h.A, h.B) * 1.8 + 0.5) { S.set(key, null); continue; }   // 線路でつながらない・遠回りしすぎ
                    S.set(key, { km: g.km, turn: g.turn, ts: [] });
                }
                S.get(key)?.ts.push(h.t);
            }
        }
    }
    const out = { note: '駅間の所要時間（分） = a × 線路に沿った距離（km） ＋ b ＋ c × カーブの量（ラジアン）。calibrate_estimate.js で時刻表データから求めた値', created: new Date().toISOString() };
    for (const [key, S] of Object.entries(samples)) {
        const rows = [...S.values()].filter(Boolean).map(s => {
            s.ts.sort((a, b) => a - b);
            return { x: [s.km, 1, s.turn], y: s.ts[Math.floor((s.ts.length - 1) * FAST_QUANTILE)] };
        });
        if (rows.length < 20) continue;
        let [a, b, c] = leastSquares(rows);
        if (c < 0) { [a, b] = leastSquares(rows.map(r => ({ x: [r.x[0], 1], y: r.y }))); c = 0; }   // カーブで速くなることはないので 0 にする
        const err = rows.map(r => Math.abs(a * r.x[0] + b + c * r.x[2] - r.y));
        const [kind, tier] = key.split('|');
        (out[kind] = out[kind] || {})[tier] = { a: +a.toFixed(4), b: +b.toFixed(3), c: +c.toFixed(4), hops: rows.length, meanAbsErr: +(err.reduce((s, e) => s + e, 0) / err.length).toFixed(2) };
        console.log(`${kind} ${tier}: a=${a.toFixed(3)} 分/km（${(60 / a).toFixed(0)} km/h）・b=${b.toFixed(2)} 分・c=${c.toFixed(3)} 分/rad・駅間 ${rows.length}・平均の差 ${out[kind][tier].meanAbsErr} 分`);
    }
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
    console.log('→', OUT);
}

main();
