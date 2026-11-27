// =====================================================================
// 時刻表データ（data/keikyu.js など）から、路線ごと・種別ごとの「速さ」と「1 駅の停車時間」を求める
// （build_osm_estimate.js の推定で、全路線同じ値の代わりに使う）
//
//   各列車の隣り合う停車駅の区間について、所要時間 t（分）と直線距離 d（km）を集め、
//   t = d × 1.15 ÷ 速さ × 60 ＋ 停車時間 にいちばん合う速さと停車時間を最小二乗で求める。
//   区間は、両端の駅を持つ推定の路線（OSM の路線名）に入れる。種別は 0 = 各停、1 = 急行・快速、2 = 特急・快特など
//
//   戻り値: { 推定の路線名: [{ tier, speed, stop, meanKm, hops }, …] }（tier の小さい順）
// =====================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 種別の名前 → 段（data の列車の最初の要素）
const TYPE_TIER = { futsu: 0, local: 0, kyuko: 1, express: 1, rapid: 1, tokkyu: 2, kaitoku: 2, limited: 2, commuter: 2 };
const MIN_HOPS = 30;
const FAST_QUANTILE = +(process.env.FIT_QUANTILE ?? 0.25);

function load(files) {
    const ctx = { window: {} };
    vm.createContext(ctx);
    for (const f of files) {
        const p = path.join(__dirname, 'data', f);
        if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, 'utf8'), ctx);
    }
    return ctx.window;
}

// 列車の段: 種別の名前で決める。名前の無いもの（相鉄）は、区間の平均の長さが短い（各停に近い）かどうかで決める
function tierOf(type, meanHop, localHop) {
    if (type in TYPE_TIER) return TYPE_TIER[type];
    if (/^.r/.test(type)) return 1;                      // 横浜市営地下鉄の快速（br…）
    if (/^.n/.test(type)) return 0;                      // 横浜市営地下鉄の普通（bn…・gn…）
    return meanHop <= localHop * 1.25 ? 0 : 1;
}

// t = a × d ＋ b の最小二乗（a: 1km あたりの分、b: 1 駅の停車時間）。時刻表の時刻は分単位で、駅間の短い路線では
// 自由に合わせると停車時間が負になったりするので、停車時間 STOP_RANGE・速さ SPEED_RANGE の範囲で最もよく合う組を探す
const STOP_RANGE = [0.3, 1.5], SPEED_RANGE = [25, 130];
function fitLine(hops) {
    const n = hops.length;
    const meanKm = hops.reduce((s, h) => s + h.d, 0) / n;
    const aMin = 1.15 * 60 / SPEED_RANGE[1], aMax = 1.15 * 60 / SPEED_RANGE[0];
    let best = null;
    for (let b = STOP_RANGE[0]; b <= STOP_RANGE[1] + 1e-9; b += 0.05) {
        // b を決めたときの a: 所要時間の合計が時刻表と同じになる値（範囲内に収める）。
        // 何駅も乗ると誤差が積み重なるので、区間ごとの二乗誤差より合計が合うことを優先する
        const a = Math.min(aMax, Math.max(aMin, hops.reduce((s, h) => s + h.t - b, 0) / hops.reduce((s, h) => s + h.d, 0)));
        const sse = hops.reduce((s, h) => s + (h.t - a * h.d - b) ** 2, 0);
        if (!best || sse < best.sse) best = { a, b, sse };
    }
    return { a: best.a, b: best.b, meanKm, rmse: Math.sqrt(best.sse / n) };
}

// 時刻表の路線（駅の並びと列車）と、その区間を入れる推定の路線（名前の正規表現。同じ駅を持つ別会社の路線には入れない）
function timetableSources(w) {
    return [
        [w.KEIKYU, /^京急線$/],
        [w.SOTETSU, /^相鉄|^相模鉄道/],
        [w.MINATOMIRAI, /みなとみらい/],
        [w.SEASIDE, /シーサイド/],
        [w.YOKOHAMA, /横浜市営地下鉄/],
        [w.JR?.lines?.['横須賀線'], /^横須賀線$/],
        [w.JR?.lines?.['根岸線'], /^JR根岸線$/],
        [w.JR?.lines?.['横浜線'], /^JR横浜線$/],
        [w.JR?.lines?.['東海道線'], /^JR東海道本線$|^上野東京ライン$/],
        [w.TOKYU?.lines?.['東横線'], /^東急東横線$/],
        [w.TOKYU?.lines?.['新横浜線'], /^東急新横浜線$/],
    ].filter(([src]) => src);
}
const DATA_FILES = ['network.js', 'keikyu.js', 'jr.js', 'tokyu.js', 'sotetsu.js', 'minatomirai.js', 'seaside.js', 'yokohama.js'];

function fitTimetableSpeeds(estLines, normName, km) {
    const w = load(DATA_FILES);
    if (!w.NETWORK) return {};
    const pos = {};
    for (const s of w.NETWORK.stations) pos[normName(s.name)] = { lat: s.lat, lng: s.lng };
    const sources = timetableSources(w);
    // 推定の路線ごとの駅の集合
    const lineSets = Object.entries(estLines).map(([name, set]) => ({ name, set }));

    const hopsBy = {};   // 路線名 -> 段 -> [{ d, t }]
    for (const [src, lineRe] of sources) {
        const names = src.stations.map(normName);
        const targets = lineSets.filter(L => lineRe.test(L.name));
        const trains = (src.trains || []).map(([type, st]) => {
            const hops = [];
            for (let j = 0; j + 3 < st.length; j += 2) {
                const A = names[st[j]], B = names[st[j + 2]];
                if (!pos[A] || !pos[B]) continue;
                const d = km(pos[A], pos[B]), t = st[j + 3] - st[j + 1];
                if (d > 0.2 && t > 0 && t < 60) hops.push({ A, B, d, t });
            }
            return { type, hops, mean: hops.length ? hops.reduce((s, h) => s + h.d, 0) / hops.length : 0 };
        }).filter(x => x.hops.length);
        if (!trains.length) continue;
        const means = trains.map(x => x.mean).sort((a, b) => a - b);
        const localHop = means[Math.floor(means.length * 0.25)];
        for (const tr of trains) {
            const tier = tierOf(tr.type, tr.mean, localHop);
            for (const h of tr.hops) {
                for (const L of targets) {
                    if (!L.set.has(h.A) || !L.set.has(h.B)) continue;
                    ((hopsBy[L.name] = hopsBy[L.name] || {})[tier] = hopsBy[L.name][tier] || []).push(h);
                }
            }
        }
    }
    const out = {};
    for (const [name, tiers] of Object.entries(hopsBy)) {
        const list = [];
        for (const [tier, all] of Object.entries(tiers)) {
            if (all.length < MIN_HOPS) continue;
            // 同じ区間（駅の組）ごとに、速い方から FAST_QUANTILE の所要時間を 1 つ使う。各停は急行の通過待ちで
            // 止まっている列車も多いが、経路の計算では待たない列車が選ばれやすいので、それに合わせる
            const byPair = new Map();
            for (const h of all) {
                const k = h.A + '|' + h.B;
                if (!byPair.has(k)) byPair.set(k, { d: h.d, ts: [] });
                byPair.get(k).ts.push(h.t);
            }
            const hops = [...byPair.values()].map(({ d, ts }) => {
                ts.sort((x, y) => x - y);
                return { d, t: ts[Math.floor((ts.length - 1) * FAST_QUANTILE)] };
            });
            const { a, b, meanKm, rmse } = fitLine(hops);
            list.push({ tier: +tier, speed: +(1.15 * 60 / a).toFixed(1), stop: +b.toFixed(2), meanKm: +meanKm.toFixed(2), hops: all.length, rmse: +rmse.toFixed(2) });
        }
        if (list.length) out[name] = list.sort((x, y) => x.tier - y.tier);
    }
    return out;
}

// 時刻表の列車から、推定の路線の列車の型（停車駅の並び・各駅までの所要時間・運転間隔）を作る。
//   停車駅の並びが同じ列車をまとめ、WINDOW（10〜15 時）に始発駅を出た本数から運転間隔を、
//   所要時間はその列車たちの中央値を使う。推定の路線の駅の 8 割以上が時刻表にある路線だけが対象（COVER）。
//   1 つの推定の路線の駅だけを通る列車はその路線の列車に、複数の路線にまたがる列車（相鉄の横浜〜湘南台など）は
//   最初の区間の路線の「直通」の列車（線は描かない）にする
//   戻り値: { 推定の路線名: [{ stops, times, interval, first（最初の発車分）, express, through }] }
const WINDOW = [600, 900], COVER = 0.8;
function timetablePatterns(estLines, normName) {
    const w = load(DATA_FILES);
    const out = {};
    for (const [src, lineRe] of timetableSources(w)) {
        const names = src.stations.map(normName);
        const realSet = new Set(names);
        const lines = Object.entries(estLines).filter(([n, set]) => lineRe.test(n) && [...set].filter(s => realSet.has(s)).length >= set.size * COVER);
        if (!lines.length) continue;
        const allowed = new Set(lines.flatMap(([, set]) => [...set]));
        const lineOf = (a, b) => lines.find(([, set]) => set.has(a) && set.has(b))?.[0];
        // 列車ごとの停車駅（推定の路線にある駅だけ）
        const groups = new Map();
        const trains = (src.trains || []).map(([type, st]) => {
            const stops = [], times = [];
            for (let j = 0; j < st.length; j += 2) {
                const n = names[st[j]];
                if (!allowed.has(n) || stops[stops.length - 1] === n) continue;
                stops.push(n); times.push(st[j + 1]);
            }
            return { type, stops, times };
        }).filter(t => t.stops.length >= 2);
        for (const t of trains) {
            if (t.times[0] < WINDOW[0] || t.times[0] >= WINDOW[1]) continue;
            const key = t.stops.join('|');
            if (!groups.has(key)) groups.set(key, { stops: t.stops, runs: [], types: [] });
            const g = groups.get(key);
            g.runs.push(t.times.map(x => x - t.times[0]));
            g.types.push(t.type);
            g.first = Math.min(g.first ?? Infinity, t.times[0]);
        }
        for (const g of groups.values()) {
            const times = g.stops.map((_, i) => {
                const v = g.runs.map(r => r[i]).sort((a, b) => a - b);
                return v[Math.floor((v.length - 1) / 2)];
            });
            const interval = Math.max(3, Math.min(120, (WINDOW[1] - WINDOW[0]) / g.runs.length));
            const types = g.types.filter(x => x in TYPE_TIER);
            const express = types.length ? types.some(x => TYPE_TIER[x] > 0) : g.stops.length < Math.max(...trains.map(t => t.stops.length)) * 0.75;
            // 1 つの路線に収まるか
            const home = lines.find(([, set]) => g.stops.every(s => set.has(s)))?.[0];
            const name = home || lineOf(g.stops[0], g.stops[1]);
            if (!name) continue;
            (out[name] = out[name] || []).push({ stops: g.stops, times, interval, first: g.first, express, through: !home });
        }
        for (const [n] of lines) out[n] = out[n] || [];
    }
    return out;
}

module.exports = { fitTimetableSpeeds, timetablePatterns };
