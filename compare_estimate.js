// =====================================================================
// 推定の時刻表（data/osm_estimate.js）と時刻表データを比べる
//
//   時刻表データのある路線（会社）ごとに、両方にある駅の組の所要時間を比べ、差の平均（分）を出す。
//   所要時間は 10〜15 時に出るどの列車で出ても、乗り換えを含めて最も早く着くときの時間（アプリの「日中の最小」と同じ）
//
//   node compare_estimate.js [駅A 駅B …]   … 駅の組を指定すると、その組の時刻表と推定も出す
//   node compare_estimate.js --top          … ずれの大きい駅の組 10 個（分の差・比率）も出す
//   EST_FILE=ファイル で推定の時刻表のファイルを変えられる（既定は data/osm_estimate.js）
// =====================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { window: {} };
vm.createContext(ctx);
for (const f of ['keikyu', 'jr', 'tokyu', 'sotetsu', 'minatomirai', 'seaside', 'yokohama', 'osm_estimate']) {
    const p = f === 'osm_estimate' && process.env.EST_FILE ? path.resolve(process.env.EST_FILE) : path.join(__dirname, 'data', f + '.js');
    if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, 'utf8'), ctx);
}
const w = ctx.window;
const normName = s => (s || '').replace(/(?<=[一-鿿])ケ(?=[一-鿿])/g, 'ヶ').replace(/\s+/g, '').replace(/駅$/, '').replace(/[（(].*?[）)]$/, '');

// 駅の組 → 所要時間（乗り換えも含む）。10〜15 時に出発駅を出るどの列車で出ても、その発車からの最も早い到着までの
// 時間を出し、その最小を使う（アプリの「日中の最小」と同じ数え方。出発駅での待ち時間は入らず、乗り換えの待ちは入る。
// 同じ駅名どうしは待ち時間なしで乗り換え）
const WINDOW = [600, 900];
function journeyTimes(sources, origins) {
    const id = new Map(), nameOf = [];
    const node = n => { if (!id.has(n)) { id.set(n, nameOf.length); nameOf.push(n); } return id.get(n); };
    const conns = [];
    let trip = 0;
    for (const src of sources) {
        const names = src.stations.map(normName);
        for (const [, st] of src.trains) {
            for (let j = 0; j + 3 < st.length; j += 2) conns.push([node(names[st[j]]), st[j + 1], node(names[st[j + 2]]), st[j + 3], trip]);
            trip++;
        }
    }
    conns.sort((a, b) => a[1] - b[1]);
    const out = new Map();
    for (const o of origins) {
        if (!id.has(o)) continue;
        const src = id.get(o), best = new Float64Array(nameOf.length).fill(Infinity);
        const departs = [...new Set(conns.filter(c => c[0] === src && c[1] >= WINDOW[0] && c[1] < WINDOW[1]).map(c => c[1]))];
        for (const t0 of departs) {
            const arr = new Float64Array(nameOf.length).fill(Infinity), on = new Uint8Array(trip);
            arr[src] = t0;
            for (const [from, dep, to, at, tr] of conns) {
                if (dep < t0) continue;
                if (dep > t0 + 180) break;
                if (on[tr] || arr[from] <= dep) { on[tr] = 1; if (at < arr[to]) arr[to] = at; }
            }
            arr.forEach((a, i) => { if (a - t0 < best[i]) best[i] = a - t0; });
        }
        best.forEach((m, i) => { if (i !== src && isFinite(m)) out.set(o + '→' + nameOf[i], m); });
    }
    return out;
}

const pairs = [
    ['京急', [w.KEIKYU], /^京急線$/],
    ['相鉄', [w.SOTETSU], /^相鉄|^相模鉄道/],
    ['みなとみらい線', [w.MINATOMIRAI], /みなとみらい/],
    ['シーサイドライン', [w.SEASIDE], /シーサイド/],
    ['市営地下鉄', [w.YOKOHAMA], /横浜市営地下鉄/],
    ['JR横須賀線', [w.JR?.lines?.['横須賀線']], /^横須賀線$/],
    ['JR根岸線', [w.JR?.lines?.['根岸線']], /^JR根岸線$/],
    ['JR横浜線', [w.JR?.lines?.['横浜線']], /^JR横浜線$/],
    ['JR東海道線', [w.JR?.lines?.['東海道線']], /^JR東海道本線$|^上野東京ライン$/],
    ['東急東横線', [w.TOKYU?.lines?.['東横線']], /^東急東横線$/],
    ['東急新横浜線', [w.TOKYU?.lines?.['新横浜線']], /^東急新横浜線$/],
];
let sum = 0, n = 0;
const rows = [];
const allReal = new Map(), allEst = new Map(), lineOf = new Map();
for (const [label, srcs, re] of pairs) {
    const realSrc = srcs.filter(Boolean), estSrc = Object.entries(w.OSM_EST.lines).filter(([name]) => re.test(name)).map(([, l]) => l);
    // 両方にある駅だけを出発駅にする
    const estNames = new Set(estSrc.flatMap(l => l.stations.map(normName)));
    const origins = [...new Set(realSrc.flatMap(l => l.stations.map(normName)))].filter(s => estNames.has(s));
    const real = journeyTimes(realSrc, origins), est = journeyTimes(estSrc, origins);
    let s = 0, k = 0, bias = 0;
    for (const [key, t] of real) {
        if (!est.has(key)) continue;
        s += Math.abs(est.get(key) - t); bias += est.get(key) - t; k++;
        allReal.set(key, t); allEst.set(key, est.get(key)); lineOf.set(key, label);
    }
    if (!k) continue;
    sum += s; n += k;
    rows.push(`${label.padEnd(10, '　')} 差の平均 ${(s / k).toFixed(2)} 分（推定が平均 ${(bias / k >= 0 ? '+' : '') + (bias / k).toFixed(2)} 分）・${k} 組`);
}
console.log(rows.join('\n'));
console.log(`全体: 差の平均 ${(sum / n).toFixed(2)} 分・${n} 組`);
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (process.argv.includes('--top')) {
    // 行きと帰りで同じ組は 1 つにする（差の大きい方）
    const rows = new Map();
    for (const [key, t] of allReal) {
        const e = allEst.get(key), [a, b] = key.split('→'), k = [a, b].sort().join('|');
        const r = { key, line: lineOf.get(key), real: t, est: e, diff: e - t, ratio: e / t };
        const prev = rows.get(k);
        if (!prev || Math.abs(r.diff) > Math.abs(prev.diff)) rows.set(k, r);
    }
    const fmt = (r, i) => `${String(i + 1).padStart(2)}. ${r.key}（${r.line}）時刻表 ${r.real} 分・推定 ${r.est.toFixed(1)} 分・差 ${(r.diff >= 0 ? '+' : '') + r.diff.toFixed(1)} 分・比 ${r.ratio.toFixed(2)}`;
    const list = [...rows.values()];
    console.log('\n■ 分の差が大きい組');
    list.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).slice(0, 10).forEach((r, i) => console.log(fmt(r, i)));
    // 比率は、短い区間（時刻表で 5 分未満）だと 1 分の違いでも大きく出るので除く
    console.log('\n■ 比率のずれが大きい組（時刻表で 5 分以上の組）');
    list.filter(r => r.real >= 5).sort((x, y) => Math.abs(Math.log(y.ratio)) - Math.abs(Math.log(x.ratio))).slice(0, 10).forEach((r, i) => console.log(fmt(r, i)));
}
for (let i = 0; i + 1 < args.length; i += 2) {
    const key = normName(args[i]) + '→' + normName(args[i + 1]);
    console.log(`${key}: 時刻表 ${allReal.get(key) ?? '—'} 分・推定 ${allEst.has(key) ? allEst.get(key).toFixed(1) : '—'} 分`);
}
