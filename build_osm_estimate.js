// =====================================================================
// OpenStreetMap の鉄道の路線から、神奈川県全域の「推定の時刻表」を作る（時刻表データの代わりに試す用）
//
//   node build_osm_estimate.js          … Overpass から取得（osm_rail/raw.json に保存）して作る
//   node build_osm_estimate.js --cached … 保存済みの osm_rail/raw.json から作り直す
//
//   入力: OSM の路線（type=route, route=train/subway/light_rail/monorail/tram）の停車駅の並び
//   推定: 駅間の所要時間 = 直線距離 × 1.15 ÷ 巡航速度 ＋ 1駅ごとの停車・加減速の時間（路線の種類ごと）
//         OSM に始発から終点までの所要時間（duration タグ）があれば、それに合うように全体を伸び縮みさせる
//         列車は 6〜20 時に一定の間隔（OSM の interval タグ、無ければ路線の種類ごとの目安）で走るものとする
//         急行・快速などの路線（停車駅の少ない relation）も OSM にあれば、そのまま速い列車として入る。
//         停車駅の多い普通列車しか無い路線には、乗換駅（2路線以上）と終点だけに止まる速い列車を足す
//   範囲: 神奈川県内に駅のある路線だけ（県内かどうかは、国土数値情報のバス停留所 P11 が 1km 以内にあるかで見る）
//   出力: data/osm_estimate.js … window.OSM_EST = { network: { lines, stations, edges }, lines: { 路線名: { stations, trains } } }
//         network は data/network.js と同じ形（駅の位置・路線のつながりの表示用）
//   データ: © OpenStreetMap contributors（ODbL）
// =====================================================================
const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, 'osm_rail', 'raw.json');
const OUT = path.join(__dirname, 'data', 'osm_estimate.js');
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
// 神奈川県とその周り（県境をまたぐ路線の東京側の駅も少し入れる）
const BBOX = { s: 35.12, w: 138.9, n: 35.68, e: 139.8 };

// 路線の種類ごとの目安：巡航速度（km/h）、1駅あたりの停車・加減速（分）、運転間隔（分）
const KIND = {
    train: { speed: 75, stop: 0.5, interval: 10 },   // 停車 0.5 分・速い列車 90km/h が時刻表データと最も合った（平均の差 4.3 分）
    subway: { speed: 55, stop: 0.7, interval: 6 },
    light_rail: { speed: 40, stop: 0.6, interval: 8 },
    monorail: { speed: 45, stop: 0.6, interval: 8 },
    tram: { speed: 25, stop: 0.5, interval: 12 },
};
// 調整用: EST_KIND='{"train":{"speed":80}}' のように上書きできる
if (process.env.EST_KIND) for (const [k, v] of Object.entries(JSON.parse(process.env.EST_KIND))) Object.assign(KIND[k], v);
// 足す速い列車（停車駅を減らした列車）: 元の路線の停車駅がこれ以上のときに足す・巡航速度・運転間隔（分）
const EXPRESS = { minStops: 12, speed: 90, interval: 15, ...(process.env.EST_EXPRESS ? JSON.parse(process.env.EST_EXPRESS) : {}) };
// 列車の種別・愛称の relation の名前を、凡例で分かりやすい路線の名前にまとめる（同じ名前の路線どうしは乗換なしで乗り継げる）
const LINE_ALIAS = [
    [/エアポート快特|京急空港線.*急行|都営浅草線快特/, '京急（快特・急行）'],
    [/^(えのしま|さがみ|はこね|スーパーはこね)$|小田急.*(通勤|準急|急行)/, '小田急（急行・特急）'],
    [/小田急電鉄各駅停車|小田急小田原線・江ノ島線/, '小田急小田原線'],
    [/^(のぞみ|こだま|ひかり)$/, '東海道新幹線'],
    [/^(踊り子|ふじさん|あずさ|ひたち)$/, n => '特急' + n],
    [/シーサイドライン/, '金沢シーサイドライン'],
    [/^JR中央線JC$/, 'JR中央線'],
    [/^横浜高速鉄道みなとみらい21線$/, 'みなとみらい線'],
];
// 県内の判定に使うバス停留所（国土数値情報 P11・神奈川県）
const KANAGAWA_STOPS = path.join(__dirname, 'ksj', 'P11-22_14_SHP');
const DAY_START = 6 * 60, DAY_END = 20 * 60;

// 問い合わせごとの結果を保存しておき、途中で失敗しても次は続きから取る（サーバーが混んでいて失敗しやすいため）
async function overpass(q) {
    const file = path.join(__dirname, 'osm_rail', 'q_' + require('crypto').createHash('md5').update(q).digest('hex').slice(0, 12) + '.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    const els = await overpassFetch(q);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(els));
    return els;
}

async function overpassFetch(q) {
    let last;
    for (const ep of ENDPOINTS) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                console.log('Overpass:', ep);
                const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'distortMap-osm-estimate/0.1' } });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const j = await res.json();
                if (!j.elements) throw new Error('結果がありません');
                return j.elements;
            } catch (e) {
                console.warn('  失敗:', e.message);
                last = e;
                await new Promise(r => setTimeout(r, 15000 * (attempt + 1)));
            }
        }
    }
    throw last;
}

// 1回の問い合わせが重いと時間切れになるので、路線・停車位置・駅の3回に分けて取る
async function fetchRaw() {
    const bbox = `${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}`;
    const routes = await overpass(`[out:json][timeout:180];
relation["type"="route"]["route"~"^(train|subway|light_rail|monorail|tram)$"](${bbox})->.r;
.r out body;
relation["type"="route_master"](br.r);
out body;`);
    console.log('  路線', routes.length);
    const ids = routes.filter(e => e.tags?.type === 'route').map(e => e.id);
    const stops = [];
    for (let i = 0; i < ids.length; i += 60) {
        const part = await overpass(`[out:json][timeout:180];relation(id:${ids.slice(i, i + 60).join(',')})->.r;node(r.r);out body qt;`);
        stops.push(...part);
        console.log('  停車位置', stops.length);
    }
    const stations = await overpass(`[out:json][timeout:180];node["railway"="station"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});out body qt;`);
    console.log('  駅', stations.length);
    const j = { elements: [...routes, ...stops, ...stations] };
    fs.mkdirSync(path.dirname(RAW), { recursive: true });
    fs.writeFileSync(RAW, JSON.stringify(j));
    return j;
}

const km = (a, b) => {
    const r = Math.PI / 180;
    const x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r);
    const y = (b.lat - a.lat) * r;
    return Math.hypot(x, y) * 6371;
};
// OSM の時間のタグ（"40"・"01:28"・"1:00:00"）を分に
const minutesOf = v => {
    if (!v) return null;
    const p = String(v).trim().split(':').map(Number);
    if (p.some(x => !isFinite(x))) return null;
    return p.length === 1 ? p[0] : p.length === 2 ? p[0] * 60 + p[1] : p[0] * 60 + p[1] + p[2] / 60;
};
// 県内のバス停留所が 1km（約 0.01 度）以内にあるか
function kanagawaTest() {
    const find = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? find(path.join(d, e.name)) : e.name.endsWith('.geojson') ? [path.join(d, e.name)] : []);
    const grid = new Set();
    for (const f of JSON.parse(fs.readFileSync(find(KANAGAWA_STOPS)[0], 'utf8')).features) {
        const [lng, lat] = f.geometry.coordinates;
        grid.add(Math.round(lat * 100) + ',' + Math.round(lng * 100));
    }
    return p => {
        const y = Math.round(p.lat * 100), x = Math.round(p.lng * 100);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (grid.has(y + dy + ',' + (x + dx))) return true;
        return false;
    };
}
// 「鶴ケ峰」「保土ケ谷」は時刻表データ・駅の一覧の「ヶ」にそろえる
const normName = s => (s || '').replace(/(?<=[一-鿿])ケ(?=[一-鿿])/g, 'ヶ').replace(/\s+/g, '').replace(/駅$/, '').replace(/[（(].*?[）)]$/, '');
// 駅の並びの、始発からの所要時間（分）: 直線距離 × 1.15 ÷ 巡航速度 ＋ 1駅ごとの停車・加減速
const runTimes = (list, speed, stop) => {
    const t = [0];
    for (let i = 1; i < list.length; i++) t.push(t[i - 1] + (km(list[i - 1], list[i]) * 1.15 / speed) * 60 + stop);
    return t;
};
const inBox = p => p.lat >= BBOX.s && p.lat <= BBOX.n && p.lng >= BBOX.w && p.lng <= BBOX.e;

function build(raw) {
    const nodes = new Map();
    const routes = [];
    const masters = [];
    for (const el of raw.elements) {
        if (el.type === 'node') nodes.set(el.id, el);
        else if (el.type === 'relation' && el.tags?.type === 'route') routes.push(el);
        else if (el.type === 'relation' && el.tags?.type === 'route_master') masters.push(el);
    }
    // 駅（railway=station）の位置と名前。停車位置に名前が無いときは近くの駅の名前を使う
    const stationNodes = [...nodes.values()].filter(n => n.tags?.railway === 'station' && n.tags.name);
    const nearestStation = p => {
        let best, bd = 0.4;   // 400m 以内
        for (const s of stationNodes) {
            const d = km(p, { lat: s.lat, lng: s.lon });
            if (d < bd) { bd = d; best = s; }
        }
        return best;
    };
    // 路線（route_master）の名前：その系統をまとめる名前。無ければ relation の名前から方向（…→…）を除く
    const masterOf = new Map();
    for (const m of masters) for (const mem of m.members) if (mem.type === 'relation') masterOf.set(mem.ref, m);
    // 日本語の名前を優先する。「各駅停車」など種別だけの名前には会社名を付ける。
    // 「列車 東急東横線」の「列車」、「（北行）」「: 横浜 => 渋谷」などの方向は除く
    const jaName = t => t && (t['name:ja'] || t.name);
    const clean = n => (n || '').replace(/^列車\s*/, '').replace(/\s*[（(].*$/, '').replace(/\s*:.*$/, '').trim();
    const lineName = r => {
        const m = masterOf.get(r.id);
        let n = clean(jaName(m?.tags)) || clean(jaName(r.tags)) || r.tags.ref || '';
        if (/=>/.test(n)) n = clean(m?.tags?.official_name || r.tags.official_name || r.tags.network) || n;
        if (/^(各駅停車|普通|急行|快速|準急|特急|快速急行|通勤急行|通勤準急|区間急行)$/.test(n)) n = (r.tags['network:ja'] || r.tags.network || '') + n;
        n = n.trim();
        const to = LINE_ALIAS.find(([re]) => re.test(n))?.[1];
        return typeof to === 'function' ? to(n) : to || n;
    };
    // 直通運転の relation（各路線の relation と重なる）は使わない
    const isThrough = r => /直通|東京地下鉄の|東京地下鉄-/.test([r.tags.name, r.tags['name:ja'], masterOf.get(r.id)?.tags?.name].join(' '));
    const inKanagawa = kanagawaTest();

    const lines = {};      // 路線名 -> { kind, patterns: [{ stops:[名前], times:[分], interval }] }
    const stationPos = {};  // 駅名 -> { lat, lng, n }
    for (const r of routes) {
        const name = lineName(r);
        if (!name || isThrough(r)) continue;
        const kind = KIND[r.tags.route] ? r.tags.route : 'train';
        const stops = [];
        for (const mem of r.members) {
            if (mem.type !== 'node' || !/^(stop|stop_entry_only|stop_exit_only|platform|platform_entry_only|platform_exit_only)$/.test(mem.role)) continue;
            const n = nodes.get(mem.ref);
            if (!n) continue;
            const p = { lat: n.lat, lng: n.lon };
            let nm = normName(n.tags?.name);
            const st = nearestStation(p);
            if (st) nm = normName(st.tags.name);   // 駅の名前にそろえる（停車位置の名前は「横浜（東海道線）」などまちまち）
            if (!nm) continue;
            if (stops.length && stops[stops.length - 1].name === nm) continue;   // 停車位置とホームが両方ある
            stops.push({ name: nm, ...(st ? { lat: st.lat, lng: st.lon } : p) });
        }
        // 枠の外の駅は落とす（県外の遠い区間）。県内に駅が無い路線は使わない
        const seq = stops.filter(inBox);
        if (seq.length < 2 || !seq.some(inKanagawa)) continue;
        const k = KIND[kind];
        // OSM の所要時間（始発〜終点）があれば、全区間の推定がそれに合うように伸び縮みさせる（極端な値は使わない）
        const full = runTimes(stops, k.speed, k.stop);
        const dur = minutesOf(r.tags.duration);
        const f = dur && full[full.length - 1] > 0 ? dur / full[full.length - 1] : 1;
        const scale = f >= 0.6 && f <= 1.6 ? f : 1;
        const times = runTimes(seq, k.speed, k.stop).map(t => t * scale);
        const interval = Math.max(3, Math.min(30, Math.round(minutesOf(r.tags.interval) || k.interval)));
        (lines[name] = lines[name] || { kind, patterns: [] }).patterns.push({ stops: seq.map(s => s.name), times, interval, pts: seq });
        for (const s of seq) {
            const o = (stationPos[s.name] = stationPos[s.name] || { lat: 0, lng: 0, n: 0, lines: new Set() });
            o.lat += s.lat; o.lng += s.lng; o.n++; o.lines.add(name);
        }
    }

    // OSM の停車駅の並びが入れ違っている relation がある（相鉄新横浜線の「西谷→新横浜→羽沢横浜国大」など）。
    // 同じ路線に同じ駅の組の relation（反対向き）があり、そちらの並びの方が距離が短ければ、その逆向きの並びを使う
    const pathKm = pts => pts.slice(1).reduce((a, s, i) => a + km(pts[i], s), 0);
    for (const L of Object.values(lines)) {
        for (const p of L.patterns) {
            const set = [...p.stops].sort().join('|');
            const other = L.patterns.find(q => q !== p && [...q.stops].sort().join('|') === set && pathKm(q.pts) < pathKm(p.pts) * 0.8);
            if (!other) continue;
            const pts = [...other.pts].reverse();
            p.pts = pts;
            p.stops = pts.map(s => s.name);
            const k = KIND[L.kind];
            p.times = runTimes(pts, k.speed, k.stop);
        }
    }

    // 速い列車を足す: 停車駅の多い relation しか無い長い路線に、乗換駅と終点だけに止まる列車を足す。
    // 乗換駅 = 2つ以上の路線が止まる駅
    // 各駅停車しか走らない路線には足さない
    const LOCAL_ONLY = /根岸線|京浜東北|鶴見線|相模線|御殿場線|江ノ島電鉄|こどもの国線|大雄山線|箱根登山|多摩川線|池上線|世田谷線|南武支線|大師線|逗子線|多摩線/;
    for (const [name, L] of Object.entries(lines)) {
        if (L.kind !== 'train' || EXPRESS.speed <= 0 || LOCAL_ONLY.test(name)) continue;
        const counts = L.patterns.map(p => p.stops.length);
        if (Math.max(...counts) < EXPRESS.minStops || Math.min(...counts) < Math.max(...counts) * 0.75) continue;   // 停車駅の少ない relation がもうある
        for (const p of [...L.patterns]) {
            if (p.stops.length < EXPRESS.minStops) continue;
            const keep = p.pts.filter((s, i) => i === 0 || i === p.pts.length - 1 || stationPos[s.name].lines.size >= 2);
            if (keep.length < 3 || keep.length > p.stops.length * 0.7) continue;
            const t = runTimes(keep, EXPRESS.speed, KIND.train.stop);
            // 普通列車より遅くならないように
            const local = Object.fromEntries(p.stops.map((s, i) => [s, p.times[i]]));
            const times = keep.map((s, i) => Math.min(t[i], local[s.name] - local[keep[0].name]));
            L.patterns.push({ stops: keep.map(s => s.name), times, interval: EXPRESS.interval, express: true });
        }
    }

    // 時刻表（distortMap の形：trains = [[種別, [駅番号, 発車分, 駅番号, 発車分, …]], …]）
    const outLines = {};
    for (const [name, L] of Object.entries(lines)) {
        const stations = [...new Set(L.patterns.flatMap(p => p.stops))];
        const idx = Object.fromEntries(stations.map((s, i) => [s, i]));
        const trains = [];
        for (const p of L.patterns) {
            for (let t0 = DAY_START; t0 <= DAY_END; t0 += p.interval) {
                trains.push([p.express ? 'est-fast' : 'est', p.stops.flatMap((s, i) => [idx[s], Math.round((t0 + p.times[i]) * 10) / 10])]);
            }
        }
        outLines[name] = { stations, trains, kind: L.kind };
    }

    // 表示用の駅と路線のつながり（network.js と同じ形）
    const names = Object.keys(stationPos);
    const sid = Object.fromEntries(names.map((n, i) => [n, 's' + i]));
    const stations = names.map(n => {
        const o = stationPos[n];
        return { id: sid[n], name: n, lat: +(o.lat / o.n).toFixed(6), lng: +(o.lng / o.n).toFixed(6), lines: [...o.lines] };
    });
    const edgeSeen = new Set();
    const edges = [];
    for (const [name, L] of Object.entries(lines))
        for (const p of L.patterns)
            for (let i = 1; i < p.stops.length; i++) {
                const a = sid[p.stops[i - 1]], b = sid[p.stops[i]];
                const key = [name, ...[a, b].sort()].join('|');
                if (a === b || edgeSeen.has(key)) continue;
                edgeSeen.add(key);
                edges.push({ source: a, target: b, line: name });
            }
    return { network: { generatedAt: new Date().toISOString(), source: 'OpenStreetMap（推定）', lines: Object.keys(outLines), stations, edges }, lines: outLines };
}

(async () => {
    const raw = process.argv.includes('--cached') && fs.existsSync(RAW) ? JSON.parse(fs.readFileSync(RAW, 'utf8')) : await fetchRaw();
    const out = build(raw);
    fs.writeFileSync(OUT, `// ${new Date().toISOString()} に build_osm_estimate.js で生成（© OpenStreetMap contributors, ODbL）\nwindow.OSM_EST = ${JSON.stringify(out)};\n`);
    const nTrains = Object.values(out.lines).reduce((a, l) => a + l.trains.length, 0);
    console.log(`路線 ${out.network.lines.length}・駅 ${out.network.stations.length}・区間 ${out.network.edges.length}・列車 ${nTrains} → ${OUT}（${(fs.statSync(OUT).size / 1024).toFixed(0)}KB）`);
    console.log(out.network.lines.join('、'));
})().catch(e => {
    console.error(e);
    process.exit(1);
});
