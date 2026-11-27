// =====================================================================
// OpenStreetMap の鉄道の路線から、神奈川県全域の「推定の時刻表」を作る（時刻表データの代わりに試す用）
//
//   node build_osm_estimate.js          … Overpass から取得（osm_rail/raw.json に保存）して作る
//   node build_osm_estimate.js --cached … 保存済みの osm_rail/raw.json から作り直す
//
//   入力: OSM の路線（type=route, route=train/subway/light_rail/monorail/tram）の停車駅の並び
//   推定: 駅間の所要時間 = a × 線路に沿った距離 ＋ b（停車・加減速） ＋ c × カーブの量（鉄道・地下鉄）
//         線路の距離とカーブは国土数値情報の線路の形（N02）から（track_geometry.js）。a・b・c は路線の種類と
//         各停／速い列車ごとに、calibrate_estimate.js で時刻表データから一度だけ求めた値（est_calibration.json）。
//         時刻表データは較正と答え合わせ（compare_estimate.js）にだけ使い、推定の停車駅・時刻には入れない。
//         線路の形が無い区間と、路面電車・モノレール・新交通は 直線距離 × 1.15 ÷ 巡航速度 ＋ 1駅ごとの停車時間
//         OSM に始発から終点までの所要時間（duration タグ）があれば、それに合うように全体を伸び縮みさせる
//         列車は 6〜20 時に一定の間隔（OSM の interval タグ、無ければ路線の種類ごとの目安）で走るものとする
//         急行・快速などの路線（停車駅の少ない relation）も OSM にあれば、そのまま速い列車として入る。
//         停車駅の多い普通列車しか無い路線には、乗降客数の多い駅・乗換駅・分岐駅・終点に止まる速い列車を足す（駅別乗降客数 S12）
//   範囲: 神奈川県内に駅のある路線だけ（県内かどうかは、国土数値情報のバス停留所 P11 が 1km 以内にあるかで見る）
//   出力: data/osm_estimate.js … window.OSM_EST = { network: { lines, stations, edges }, lines: { 路線名: { stations, trains } } }
//         network は data/network.js と同じ形（駅の位置・路線のつながりの表示用）
//   データ: © OpenStreetMap contributors（ODbL）、国土数値情報（駅別乗降客数 S12・バス停留所 P11、CC BY 4.0）
// =====================================================================
const fs = require('fs');
const path = require('path');
const { loadTrack } = require('./track_geometry');

const RAW = path.join(__dirname, 'osm_rail', 'raw.json');
const OUT = path.join(__dirname, 'data', 'osm_estimate.js');
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
// 神奈川県とその周り（県境をまたぐ路線の東京側の駅も少し入れる）
const BBOX = { s: 35.12, w: 138.9, n: 35.68, e: 139.8 };

// 路線の種類ごとの目安：巡航速度（km/h）、1駅あたりの停車・加減速（分）、運転間隔（分）
const KIND = {
    train: { speed: 65, stop: 0.5, interval: 10 },   // 65km/h・停車 0.5 分が時刻表データと最も合った（平均の差 2.6 分）
    subway: { speed: 55, stop: 0.7, interval: 6 },
    light_rail: { speed: 40, stop: 0.6, interval: 8 },
    monorail: { speed: 45, stop: 0.6, interval: 8 },
    tram: { speed: 25, stop: 0.5, interval: 12 },
};
// 調整用: EST_KIND='{"train":{"speed":80}}' のように上書きできる
if (process.env.EST_KIND) for (const [k, v] of Object.entries(JSON.parse(process.env.EST_KIND))) Object.assign(KIND[k], v);
// 足す速い列車（停車駅を減らした列車）: 元の路線の停車駅がこれ以上のときに足す・巡航速度・運転間隔（分）
// share: 乗降客数が路線の駅のうち上位この割合の駅に止まる。transfer: 乗換駅（2路線以上）にも必ず止まるか
const EXPRESS = { minStops: 12, speed: 75, interval: 15, share: 0.4, transfer: true, ...(process.env.EST_EXPRESS ? JSON.parse(process.env.EST_EXPRESS) : {}) };
// もう 1 段速い列車（快特にあたる）: 停車駅の多い長い路線（minStops 以上）に、乗降客数が上位 share の駅だけに止まる列車も足す。
// 長い区間は停車駅の少ないこちらが速く、所要時間の計算では区間ごとに速い方が使われる
// stop: 1 駅ごとの停車・加減速（分）。長めにして速さを上げると、止まらずに走る長い区間ほど速くなる
const EXPRESS2 = { minStops: 25, speed: 90, stop: 1.5, interval: 20, share: 0.2, transfer: false, ...(process.env.EST_EXPRESS2 ? JSON.parse(process.env.EST_EXPRESS2) : {}) };
// 列車の種別・愛称の relation の名前を、凡例で分かりやすい路線の名前にまとめる（同じ名前の路線どうしは乗換なしで乗り継げる）
const LINE_ALIAS = [
    // 京急は本線・支線・快特などを 1 つの路線にまとめる（時刻表データの京急と同じく、乗り換えずに乗り継げる）
    [/エアポート快特|京急空港線.*急行|都営浅草線快特|^京浜急行電鉄|^京急/, '京急線'],
    [/^(えのしま|さがみ|はこね|スーパーはこね)$|小田急.*(通勤|準急|急行)/, '小田急（急行・特急）'],
    [/小田急電鉄各駅停車|小田急小田原線・江ノ島線/, '小田急小田原線'],
    [/^(のぞみ|こだま|ひかり)$/, '東海道新幹線'],
    [/^(踊り子|ふじさん|あずさ|ひたち)$/, n => '特急' + n],
    [/シーサイドライン/, '金沢シーサイドライン'],
    [/^JR中央線JC$/, 'JR中央線'],
    [/^横須賀・総武快速線$/, '横須賀線'],   // OSM では東京〜大船と大船〜久里浜が別の路線
    [/^横浜高速鉄道みなとみらい21線$/, 'みなとみらい線'],
];
// 路線をまたぐ直通運転: [路線, 路線, つなぐ駅]
const THROUGH = [
    ['相鉄新横浜線', '相鉄本線', '西谷'],
    ['東急新横浜線', '東急東横線', '日吉'],
    ['東急新横浜線', '東急目黒線', '日吉'],
    ['相鉄新横浜線', '東急新横浜線', '新横浜'],
    ['みなとみらい線', '東急東横線', '横浜'],
];
// 線を描かない路線（所要時間の計算には使う）
const HIDDEN_LINES = /新幹線/;
// 直通運転の列車の運転間隔（分）。実際は今ある列車の一部が直通するので、本数を増やしすぎないように少なめにする
const THROUGH_INTERVAL = 30;
// 駅別乗降客数（国土数値情報 S12・2023 年度版、CC BY 4.0）。速い列車の停車駅を選ぶのに使う
const RIDERSHIP = path.join(__dirname, 'ksj', 'S12-23', 'UTF-8', 'S12-23_NumberOfPassengers.geojson');
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
// 駅名と位置から乗降客数（同じ名前で 1.5km 以内の駅のうち最も多いもの。事業者ごとに分かれているため）
function ridershipLookup() {
    if (!fs.existsSync(RIDERSHIP)) { console.warn('駅別乗降客数が無いので、速い列車は乗換駅だけに止める:', RIDERSHIP); return () => null; }
    const byName = {};
    for (const f of JSON.parse(fs.readFileSync(RIDERSHIP, 'utf8')).features) {
        const pr = f.properties;
        // 年度ごとに 4 列ずつ並び、乗降客数は S12_009・013・…・053。新しい年度の値を使う
        let n = null;
        for (let k = 53; k >= 9 && n == null; k -= 4) n = pr['S12_0' + String(k).padStart(2, '0')] ?? null;
        if (!n) continue;
        const [lng, lat] = f.geometry.coordinates[0];
        (byName[normName(pr.S12_001)] = byName[normName(pr.S12_001)] || []).push({ lat, lng, n });
    }
    return (name, pos) => {
        let best = null;
        for (const s of byName[name.replace(/（.*$/, '')] || []) if (km(s, pos) < 1.5 && (best == null || s.n > best)) best = s.n;
        return best;
    };
}
const normName = s => (s || '').replace(/(?<=[一-鿿])ケ(?=[一-鿿])/g, 'ヶ').replace(/\s+/g, '').replace(/駅$/, '').replace(/[（(].*?[）)]$/, '');
// 駅の並びの、始発からの所要時間（分）: 直線距離 × 1.15 ÷ 巡航速度 ＋ 1駅ごとの停車・加減速
// 較正した式（est_calibration.json）と線路の形（build の始めに読む）
const CALIB = fs.existsSync(path.join(__dirname, 'est_calibration.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'est_calibration.json'), 'utf8')) : {};
let TRACK = null;
// kind・tier（'local' / 'fast'）の較正があれば、線路に沿った距離とカーブの式で。無ければ直線距離と速さの目安で
const runTimes = (list, speed, stop, kind = null, tier = 'local') => {
    const m = kind && (CALIB[kind]?.[tier] || CALIB[kind]?.local);
    const t = [0];
    for (let i = 1; i < list.length; i++) {
        const straight = km(list[i - 1], list[i]);
        if (!m) { t.push(t[i - 1] + (straight * 1.15 / speed) * 60 + stop); continue; }
        const g = TRACK && TRACK.hop(list[i - 1], list[i]);
        const ok = g && g.km <= straight * 1.8 + 0.5;   // 線路でつながらない・遠回りしすぎのときは直線距離から
        t.push(t[i - 1] + (ok ? m.a * g.km + m.b + m.c * g.turn : m.a * straight * 1.15 + m.b));
    }
    return t;
};
// OSM の停車駅の並びが崩れている relation を直す（相模線・東海道線などで、並びがばらばらだったり、
// 別の路線の駅が末尾に付いていたりする）。1 区間だけ極端に長い（区間の中央値の 4 倍かつ 3km 以上）並びが対象:
//   1. 同じ駅を 1 回にし、端の駅（全体の重心から最も遠い駅）から近い順につなぎ直す（向きは元の始発に近い方から）
//   2. それでも前後の区間が極端に長い駅（飛び離れた駅）は除く
function fixOrder(stops) {
    const longHop = list => {
        const hops = list.slice(1).map((s, i) => km(list[i], s));
        const med = [...hops].sort((a, b) => a - b)[Math.floor(hops.length / 2)] || 0;
        const lim = Math.max(3, med * 4);
        return { hops, lim, bad: hops.some(h => h > lim) };
    };
    // 同じ駅が 2 回あれば最初の 1 回だけにする（いずみ野線の末尾に「星川」がもう一度ある、など）
    const uniq = [...new Map(stops.map(s => [s.name, s])).values()];
    // 端の駅が途中の駅の間に入る方が道のりが短ければ、そこへ移す（池上線の末尾に「戸越銀座」がある、など）
    // 末尾に紛れた駅が続くこともある（大井町線の「…大井町 中延 大岡山」）ので、動かなくなるまで繰り返す
    for (let n = 0, moved = true; moved && n < 6; n++) for (const end of [0, 1]) {
        if (uniq.length < 4) break;
        if (end === 0) moved = false;
        const i = end ? uniq.length - 1 : 0;
        const t = uniq[i], hop = km(t, uniq[end ? i - 1 : 1]);
        const rest = uniq.filter((_, j) => j !== i);
        let best = -1, cost = hop * 0.5;
        for (let j = 1; j < rest.length; j++) {
            const c = km(rest[j - 1], t) + km(t, rest[j]) - km(rest[j - 1], rest[j]);
            if (c < cost) { cost = c; best = j; }
        }
        if (best > 0) { rest.splice(best, 0, t); uniq.splice(0, uniq.length, ...rest); moved = true; }
    }
    if (uniq.length < 3 || !longHop(uniq).bad) return uniq;
    const c = { lat: uniq.reduce((a, s) => a + s.lat, 0) / uniq.length, lng: uniq.reduce((a, s) => a + s.lng, 0) / uniq.length };
    let cur = uniq.reduce((a, s) => (km(s, c) > km(a, c) ? s : a));
    const rest = new Set(uniq);
    const out = [];
    while (rest.size) {
        rest.delete(cur);
        out.push(cur);
        let next = null;
        for (const s of rest) if (!next || km(cur, s) < km(cur, next)) next = s;
        cur = next;
        if (!cur) break;
    }
    if (km(out[0], stops[0]) > km(out[out.length - 1], stops[0])) out.reverse();
    // 飛び離れた駅を除く（端なら外側の区間、途中なら前後の区間がどちらも長い駅）
    let list = out;
    for (let pass = 0; pass < 3; pass++) {
        const { hops, lim, bad } = longHop(list);
        if (!bad) break;
        list = list.filter((s, i) => {
            const before = i > 0 ? hops[i - 1] : null, after = i < hops.length ? hops[i] : null;
            if (before == null) return after <= lim;
            if (after == null) return before <= lim;
            return !(before > lim && after > lim);
        });
    }
    return list;
}
const inBox = p => p.lat >= BBOX.s && p.lat <= BBOX.n && p.lng >= BBOX.w && p.lng <= BBOX.e;

function build(raw) {
    TRACK = loadTrack(BBOX);
    if (!TRACK) console.warn('  ksj/N02 の線路のデータが無いので、直線距離で計算します');
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
    const riders = ridershipLookup();

    const lines = {};      // 路線名 -> { kind, patterns: [{ stops:[名前], times:[分], interval }] }
    const stationPos = {};  // 駅名 -> { lat, lng, n }
    // 同じ名前でも 3km 以上離れた駅は別の駅にする（御殿場線の足柄（静岡県）と小田急の足柄（小田原市）など）。
    // 最初に見つかった駅はそのままの名前、離れた駅は「足柄（御殿場線）」のように路線名を付ける
    const sameName = {};   // 駅名 -> [{ name, lat, lng }]
    const distinctName = (nm, pos, line) => {
        const list = (sameName[nm] = sameName[nm] || []);
        const hit = list.find(s => km(s, pos) < 3);
        if (hit) return hit.name;
        const name = list.length ? `${nm}（${line}）` : nm;
        list.push({ name, ...pos });
        return name;
    };
    for (const r of routes) {
        const name = lineName(r);
        if (!name || isThrough(r)) continue;
        const kind = KIND[r.tags.route] ? r.tags.route : 'train';
        let stops = [];
        for (const mem of r.members) {
            if (mem.type !== 'node' || !/^(stop|stop_entry_only|stop_exit_only|platform|platform_entry_only|platform_exit_only)$/.test(mem.role)) continue;
            const n = nodes.get(mem.ref);
            if (!n) continue;
            const p = { lat: n.lat, lng: n.lon };
            let nm = normName(n.tags?.name);
            const st = nearestStation(p);
            if (st) nm = normName(st.tags.name);   // 駅の名前にそろえる（停車位置の名前は「横浜（東海道線）」などまちまち）
            if (!nm) continue;
            const pos = st ? { lat: st.lat, lng: st.lon } : p;
            nm = distinctName(nm, pos, name);
            if (stops.length && stops[stops.length - 1].name === nm) continue;   // 停車位置とホームが両方ある
            stops.push({ name: nm, ...pos });
        }
        stops = fixOrder(stops);
        // 枠の外の駅は落とす（県外の遠い区間）。県内に駅が無い路線は使わない
        const seq = stops.filter(inBox);
        if (seq.length < 2 || !seq.some(inKanagawa)) continue;
        const k = KIND[kind];
        // OSM の所要時間（始発〜終点）があれば、全区間の推定がそれに合うように伸び縮みさせる（極端な値は使わない）
        const full = runTimes(stops, k.speed, k.stop, kind);
        const dur = minutesOf(r.tags.duration);
        const f = dur && full[full.length - 1] > 0 ? dur / full[full.length - 1] : 1;
        const scale = f >= 0.6 && f <= 1.6 ? f : 1;
        const times = runTimes(seq, k.speed, k.stop, kind).map(t => t * scale);
        const interval = Math.max(3, Math.min(30, Math.round(minutesOf(r.tags.interval) || k.interval)));
        (lines[name] = lines[name] || { kind, patterns: [] }).patterns.push({ stops: seq.map(s => s.name), times, interval, pts: seq, tagged: !!minutesOf(r.tags.interval) });
        for (const s of seq) {
            const o = (stationPos[s.name] = stationPos[s.name] || { lat: 0, lng: 0, n: 0, lines: new Set() });
            o.lat += s.lat; o.lng += s.lng; o.n++; o.lines.add(name);
        }
    }

    // 本数: OSM の interval は路線（その向き）全体の間隔と考え、同じ駅を同じ向きに半分以上通る relation が複数あれば分け合う
    // （横浜線は東神奈川発・桜木町発の各停と快速の 3 つにどれも 8 分とあり、そのままだと 1 時間に 20 本以上になる）。
    // interval の無い relation は路線の種類ごとの目安のまま
    const sameWay = (p, q) => {
        const common = p.stops.filter(s => q.stops.includes(s));
        if (common.length < Math.min(p.stops.length, q.stops.length) * 0.5 || common.length < 2) return false;
        return q.stops.indexOf(common[0]) < q.stops.indexOf(common[common.length - 1]);
    };
    for (const L of Object.values(lines))
        for (const p of L.patterns) if (p.tagged) p.share = L.patterns.filter(q => q.tagged && sameWay(p, q)).length;
    for (const L of Object.values(lines)) for (const p of L.patterns) if (p.share > 1) p.interval = Math.min(60, p.interval * p.share);

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
            p.times = runTimes(pts, k.speed, k.stop, L.kind);
        }
    }

    // 速い列車を足す: 停車駅の多い relation しか無い長い路線に、乗換駅と終点だけに止まる列車を足す。
    // 乗換駅 = 2つ以上の路線が止まる駅
    // 各駅停車しか走らない路線には足さない
    const LOCAL_ONLY = /根岸線|京浜東北|鶴見線|相模線|御殿場線|江ノ島電鉄|こどもの国線|大雄山線|箱根登山|多摩川線|池上線|世田谷線|南武支線|大師線|逗子線|多摩線/;
    for (const [name, L] of Object.entries(lines)) {
        if (L.kind !== 'train' || EXPRESS.speed <= 0 || LOCAL_ONLY.test(name)) continue;
        // 停車駅の多い列車ごとに、その列車の停車駅だけを通る停車駅の少ない列車（急行など）が OSM にまだ無ければ足す
        // 駅名 -> この路線で隣になる駅（どれかの列車で間に駅がある組は、急行が飛ばしているので数えない）
        const far = new Set();
        for (const q of L.patterns) q.stops.forEach((x, i) => q.stops.slice(i + 2).forEach(y => far.add(x + '|' + y).add(y + '|' + x)));
        const nb = {};
        for (const q of L.patterns) q.stops.forEach((x, i) => [q.stops[i - 1], q.stops[i + 1]].forEach(y => y && !far.has(x + '|' + y) && (nb[x] = nb[x] || new Set()).add(y)));

        for (const p of [...L.patterns]) {
            if (p.stops.length < EXPRESS.minStops) continue;
            // 路線の 6 割以上を通る列車だけを数える（「矢向〜川崎」のような短い区間の列車は急行ではない）
            // p の区間に重なる部分だけで見る（横浜線の快速は桜木町・横浜も通るが、東神奈川発の各停の快速でもある）
            // q が base より停車駅の少ない列車か
            const isFaster = (q, base) => {
                const idx = q.stops.map(s => base.stops.indexOf(s)).filter(i => i >= 0);
                if (idx.length < 3) return false;
                const span = Math.abs(idx[idx.length - 1] - idx[0]);
                return span >= base.stops.length * 0.6 && idx.length <= (span + 1) * 0.75;
            };
            if (L.patterns.some(q => q !== p && !q.express && isFaster(q, p))) continue;
            // p 自体が急行・快速の relation なら足さない（横浜線の快速から、さらに速い列車を作らない）
            if (L.patterns.some(q => q !== p && !q.express && isFaster(p, q))) continue;
            // 止まる駅: 始発・終点、乗換駅（2つ以上の路線が止まる駅）、同じ路線の分岐駅（隣の駅が 3 つ以上）
            //   ＋ 乗降客数が多い駅（この列車の駅のうち上位 share）。乗降客数の分からない駅は数えない
            const counts = p.pts.map(s => riders(s.name, s)).filter(n => n != null).sort((a, b) => b - a);
            const added = new Set();
            for (const X of [EXPRESS, EXPRESS2]) {
                if (p.stops.length < X.minStops || X.speed <= 0) continue;
                const cut = counts.length ? counts[Math.max(0, Math.ceil(counts.length * X.share) - 1)] : Infinity;
                const keep = p.pts.filter((s, i) => i === 0 || i === p.pts.length - 1 || (X.transfer && stationPos[s.name].lines.size >= 2) ||
                    (nb[s.name]?.size || 0) >= 3 || (riders(s.name, s) ?? -1) >= cut);
                const key = keep.map(s => s.name).join('|');
                if (keep.length < 3 || keep.length > p.stops.length * 0.8 || added.has(key)) continue;
                added.add(key);
                const t = runTimes(keep, X.speed, X.stop ?? KIND.train.stop, 'train', 'fast');
                // 普通列車より遅くならないように
                const local = Object.fromEntries(p.stops.map((s, i) => [s, p.times[i]]));
                const times = keep.map((s, i) => Math.min(t[i], local[s.name] - local[keep[0].name]));
                L.patterns.push({ stops: keep.map(s => s.name), times, interval: X.interval, express: true });
            }
        }
    }

    // 直通運転: 駅 J で、列車 p（J まで）と J から出る列車 q をつないだ列車を足す（乗り換えずに乗り継げる）。
    //   ・同じ路線の分岐駅: 京急の本線と久里浜線（堀ノ内）など。OSM では別の relation になっている
    //   ・路線をまたぐもの（THROUGH）: 相鉄新横浜線と相鉄本線（西谷）など
    // 足した列車（through）は所要時間の計算だけに使い、線は描かない
    // midway: q が J を途中で通る列車でもよい（路線をまたぐ直通。相鉄本線の列車は横浜・海老名から出て西谷を通る）
    const joinAt = (A, P, Q, J, midway = false) => {
        const out = [];
        for (const p of P) {
            const i = p.stops.indexOf(J);
            if (i <= 0) continue;
            for (const q of Q) {
                const j = q.stops.indexOf(J);
                if (q === p || j < 0 || j === q.stops.length - 1 || (j > 0 && !midway)) continue;
                const head = p.stops.slice(0, i + 1), tail = q.stops.slice(j + 1);
                if (tail.some(s => head.includes(s))) continue;                       // 来た方へ折り返す
                if (tail.every(s => p.stops.slice(i + 1).includes(s))) continue;      // p がそのまま走る区間
                const t0 = p.times[i] - q.times[j];
                out.push({ stops: [...head, ...tail], times: [...p.times.slice(0, i + 1), ...q.times.slice(j + 1).map(t => t + t0)],
                    interval: THROUGH_INTERVAL, express: p.express, through: true });
            }
        }
        // 同じ並びの列車は 1 つだけ（本数を水増ししない）
        const have = new Set(A.patterns.map(p => p.stops.join("|")));
        for (const o of out) { const k = o.stops.join("|"); if (!have.has(k)) { have.add(k); A.patterns.push(o); } }
    };
    for (const L of Object.values(lines)) {
        const starts = new Set(L.patterns.map(q => q.stops[0]));
        for (const J of starts)
            // J を途中で通る列車か、J で終わる列車があれば（横須賀線の東京〜大船と大船〜久里浜など）
            if (L.patterns.some(p => p.stops.indexOf(J) > 0)) joinAt(L, [...L.patterns], [...L.patterns], J);
    }
    for (const [a, b, J] of THROUGH) {
        if (!lines[a] || !lines[b]) { console.warn('直通運転の路線が見つかりません:', a, b); continue; }
        const A = [...lines[a].patterns], B = [...lines[b].patterns];   // つないだ列車もさらにつなぐ（相鉄本線〜西谷〜新横浜〜新綱島）
        joinAt(lines[a], A, B, J, true);   // a から b へ
        joinAt(lines[a], B, A, J, true);   // b から a へ（a の列車として持つ）
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
    // 線は各駅停車の区間だけ描く: どれかの列車で間に駅がある 2 駅（急行・特急が駅を飛ばす区間）は結ばない。
    // 東海道線の横浜〜川崎のように並行する各駅停車の路線（京浜東北線）がある区間も、そちらの線で描く
    const skip = new Set();
    for (const L of Object.values(lines))
        for (const p of L.patterns) if (!p.through) p.stops.forEach((x, i) => p.stops.slice(i + 2).forEach(y => { if (y !== x) skip.add([x, y].sort().join('|')); }));
    const edgeSeen = new Set();
    const edges = [];
    const dropped = [];
    for (const [name, L] of Object.entries(lines))
        for (const p of L.patterns.filter(p => !p.through && !HIDDEN_LINES.test(name)))
            for (let i = 1; i < p.stops.length; i++) {
                const pair = [p.stops[i - 1], p.stops[i]].sort().join('|');
                const a = sid[p.stops[i - 1]], b = sid[p.stops[i]];
                const key = name + '|' + pair;
                if (a === b || edgeSeen.has(key)) continue;
                edgeSeen.add(key);
                (skip.has(pair) ? dropped : edges).push({ source: a, target: b, line: name });
            }
    // 同じ 2 駅の間は 1 本だけ描く（快特・急行の路線が各駅停車と同じ区間に重ならないように）。
    // 快特・急行・特急・直通などの種別の路線より普通の路線を、その中では区間の多い路線（本線）を残す
    const SERVICE = /（|^特急|新幹線|湘南新宿|上野東京|直通線|成田エクスプレス/;   // 「京浜急行電鉄」は種別ではない
    const lineSize = {};
    edges.forEach(e => (lineSize[e.line] = (lineSize[e.line] || 0) + 1));
    for (const n in lineSize) if (SERVICE.test(n)) lineSize[n] -= 10000;
    const byPair = new Map();
    for (const e of edges) {
        const pair = [e.source, e.target].sort().join('|');
        const cur = byPair.get(pair);
        if (!cur || lineSize[e.line] > lineSize[cur.line]) byPair.set(pair, e);
    }
    edges.splice(0, edges.length, ...byPair.values());
    // 結ばなかった 2 駅が、描く線でつながっていなければ知らせる（OSM の停車駅の並びの誤りなど）
    const adj = {};
    edges.forEach(e => { (adj[e.source] = adj[e.source] || []).push(e.target); (adj[e.target] = adj[e.target] || []).push(e.source); });
    const linked = (a, b) => {
        const seen = new Set([a]);
        let front = [a];
        for (let hop = 0; hop < 40 && front.length; hop++) {
            front = front.flatMap(x => adj[x] || []).filter(y => !seen.has(y) && seen.add(y));
            if (seen.has(b)) return true;
        }
        return false;
    };
    const idName = Object.fromEntries(stations.map(s => [s.id, s.name]));
    const gaps = dropped.filter(e => !linked(e.source, e.target));
    if (gaps.length) console.warn('描く線でつながらない区間:', gaps.map(e => `${e.line} ${idName[e.source]}-${idName[e.target]}`).join('、'));
    const drawn = new Set(edges.map(e => e.line));
    return { network: { generatedAt: new Date().toISOString(), source: 'OpenStreetMap（推定）', lines: Object.keys(outLines).filter(n => drawn.has(n)), stations, edges }, lines: outLines };
}

(async () => {
    const raw = process.argv.includes('--cached') && fs.existsSync(RAW) ? JSON.parse(fs.readFileSync(RAW, 'utf8')) : await fetchRaw();
    const out = build(raw);
    fs.writeFileSync(OUT, `// ${new Date().toISOString()} に build_osm_estimate.js で生成（© OpenStreetMap contributors, ODbL／国土数値情報 駅別乗降客数 S12・バス停留所 P11, CC BY 4.0）\nwindow.OSM_EST = ${JSON.stringify(out)};\n`);
    const nTrains = Object.values(out.lines).reduce((a, l) => a + l.trains.length, 0);
    console.log(`路線 ${out.network.lines.length}・駅 ${out.network.stations.length}・区間 ${out.network.edges.length}・列車 ${nTrains} → ${OUT}（${(fs.statSync(OUT).size / 1024).toFixed(0)}KB）`);
    console.log(out.network.lines.join('、'));
})().catch(e => {
    console.error(e);
    process.exit(1);
});
