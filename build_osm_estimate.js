// =====================================================================
// OpenStreetMap の鉄道の路線から、神奈川県全域の「推定の時刻表」を作る（時刻表データの代わりに試す用）
//
//   node build_osm_estimate.js          … Overpass から取得（osm_rail/raw.json に保存）して作る
//   node build_osm_estimate.js --cached … 保存済みの osm_rail/raw.json から作り直す
//
//   入力: OSM の路線（type=route, route=train/subway/light_rail/monorail/tram）の停車駅の並び
//   推定: 駅間の所要時間 = 直線距離 × 1.15 ÷ 巡航速度 ＋ 1駅ごとの停車・加減速の時間（路線の種類ごと）
//         列車は 6〜20 時に一定の間隔（OSM の interval タグ、無ければ路線の種類ごとの目安）で走るものとする
//         急行・快速などの路線（停車駅の少ない relation）も OSM にあれば、そのまま速い列車として入る
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
    train: { speed: 75, stop: 1.0, interval: 10 },
    subway: { speed: 55, stop: 0.7, interval: 6 },
    light_rail: { speed: 40, stop: 0.6, interval: 8 },
    monorail: { speed: 45, stop: 0.6, interval: 8 },
    tram: { speed: 25, stop: 0.5, interval: 12 },
};
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
const normName = s => (s || '').replace(/\s+/g, '').replace(/駅$/, '').replace(/[（(].*?[）)]$/, '');
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
    const lineName = r => {
        const m = masterOf.get(r.id);
        const n = (m?.tags?.name || r.tags.name || r.tags.ref || '').replace(/\s*[（(][^）)]*[）)]\s*$/, '').replace(/\s*:.*$/, '').trim();
        return n;
    };

    const lines = {};      // 路線名 -> { kind, patterns: [{ stops:[名前], times:[分], interval }] }
    const stationPos = {};  // 駅名 -> { lat, lng, n }
    for (const r of routes) {
        const name = lineName(r);
        if (!name) continue;
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
        const inside = stops.filter(inBox);
        if (inside.length < 2) continue;
        // 枠の外の駅は落とす（県外の遠い区間）
        const seq = stops.filter(inBox);
        const k = KIND[kind];
        const times = [0];
        for (let i = 1; i < seq.length; i++) {
            const d = km(seq[i - 1], seq[i]) * 1.15;
            times.push(times[i - 1] + (d / k.speed) * 60 + k.stop);
        }
        const interval = Math.max(3, Math.min(30, parseInt(r.tags.interval, 10) || k.interval));
        (lines[name] = lines[name] || { kind, patterns: [] }).patterns.push({ stops: seq.map(s => s.name), times, interval });
        for (const s of seq) {
            const o = (stationPos[s.name] = stationPos[s.name] || { lat: 0, lng: 0, n: 0, lines: new Set() });
            o.lat += s.lat; o.lng += s.lng; o.n++; o.lines.add(name);
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
                trains.push(['est', p.stops.flatMap((s, i) => [idx[s], Math.round((t0 + p.times[i]) * 10) / 10])]);
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
