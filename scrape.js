// =====================================================================
// 時間地図・運賃地図用データ収集スクリプト（1回だけ実行してファイルに保存する）
//
//   1. 駅と隣接関係 : HeartRails Express（無料・キー不要）から路線ごとの駅一覧を取得
//   2. 時間・運賃   : Yahoo!乗換案内の検索結果ページ (/search/result) を取得して解析
//
//   出力: data/network.js  … window.NETWORK = { lines, stations, edges }
//         data/routes.js   … window.ROUTES  = { "駅A|駅B": { time, fare } }
//   どちらも <script> で読み込むので、index.html をダブルクリックで開いても動きます。
//
// 使い方（Node.js 18 以上。追加パッケージ不要）
//   node scrape.js --test                 … 1区間だけ取得して解析できるか確認
//   node scrape.js                        … CENTERS の各駅から全駅への時間・運賃を取得
//   node scrape.js --center 横浜,品川      … 中心駅を指定して取得
//   node scrape.js --all                  … 全駅の組み合わせを取得（時間がかかります）
//   node scrape.js --retry                … 取得に失敗した区間をもう一度取得
//   node scrape.js --network-only         … 駅データだけ取り直す
//   node scrape.js --list-lines 神奈川県   … HeartRails での路線名の一覧を表示
//
//   途中で止めても、取得済みの区間は data/routes.js に保存されているので続きから再開します。
//   運賃・所要時間は A→B と B→A で同じとみなし、1区間につき1回だけ取得します。
//
// 注意: Yahoo!乗換案内の利用規約を確認のうえ、個人利用の範囲で使ってください。
//       サーバーに負担をかけないよう、リクエスト間隔は REQUEST_INTERVAL_MS 以上空けます。
// =====================================================================

const fs = require('fs');
const path = require('path');

// --- 設定 -------------------------------------------------------------
const LINES = ['京急本線', '京急逗子線', '京急空港線', '京急大師線', '京急久里浜線', '横浜市ブルーライン', 'グリーンライン', '金沢シーサイドライン', 'JR横須賀線', 'JR根岸線', '横浜みなとみらい線', 'JR横浜線', '東急東横線', '相模鉄道本線', '相模鉄道いずみ野線', '相模鉄道・東京急行電鉄', '東急新横浜線', 'JR東海道本線'];
// 路線の一部だけを使う場合の区間（HeartRails の駅の並びで、from の駅から to の駅まで。省略は端まで）。
// hr を書くと、HeartRails のその路線の駅の並びから取る（HeartRails に無い路線名を LINES で使うとき）
// 相模鉄道・東京急行電鉄は相鉄新横浜線（西谷〜新横浜）だけ使う
const LINE_SECTIONS = {
    'JR横須賀線': { from: '品川' },
    'JR東海道本線': { from: '品川', to: '辻堂' },
    '相模鉄道・東京急行電鉄': { from: '西谷', to: '新横浜' },      // 相鉄新横浜線
    '東急新横浜線': { hr: '相模鉄道・東京急行電鉄', from: '新横浜', to: '日吉' },
};
// HeartRails の駅の並びにない区間を足す（横浜線の列車は東神奈川から横浜へ直通する）
const EXTRA_EDGES = [{ a: '東神奈川', b: '横浜', line: 'JR横浜線' }];
const CENTERS = ['金沢八景'];
const REQUEST_INTERVAL_MS = 3000;

// 検索条件: 平日の昼（ダイヤの影響を平均的にするため固定）
const SEARCH_HOUR = 10;
const SEARCH_MINUTE = 0;

// Yahoo!乗換案内で駅名がそのままでは特定できない駅の言い換え（必要に応じて追加）
//   例: '神奈川': '神奈川(京急)'
const NAME_ALIASES = {};

const DATA_DIR = path.join(__dirname, 'data');
const NETWORK_FILE = path.join(DATA_DIR, 'network.js');
const ROUTES_FILE = path.join(DATA_DIR, 'routes.js');
const DEBUG_DIR = path.join(DATA_DIR, 'debug');
const USER_AGENT = 'distortMap-data-collector/1.0 (personal, low-frequency)';

// --- ユーティリティ ---------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pairKey = (a, b) => [a, b].sort().join('|');

function kmBetween(a, b) {
    const latMid = (a.lat + b.lat) / 2 * Math.PI / 180;
    return Math.hypot((b.lng - a.lng) * 111.32 * Math.cos(latMid), (b.lat - a.lat) * 110.57);
}

function writeJsFile(file, varName, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = `// ${new Date().toISOString()} に scrape.js で生成\nwindow.${varName} = ${JSON.stringify(obj, null, 1)};\n`;
    fs.writeFileSync(file + '.tmp', body, 'utf8');
    fs.renameSync(file + '.tmp', file);
}

function readJsFile(file) {
    if (!fs.existsSync(file)) return null;
    const src = fs.readFileSync(file, 'utf8');
    const json = src.slice(src.indexOf('=') + 1).trim().replace(/;\s*$/, '');
    return JSON.parse(json);
}

let lastRequestAt = 0;
async function politeFetch(url) {
    const wait = lastRequestAt + REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja' } });
            if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
            return res;
        } catch (e) {
            if (attempt === 3) throw e;
            console.warn(`  再試行 (${attempt}): ${e.message}`);
            await sleep(REQUEST_INTERVAL_MS * attempt * 3);
        }
    }
}

// --- 1. 駅データ（HeartRails Express） ----------------------------------
const HR_URL = 'https://express.heartrails.com/api/json';
const LINE_SEARCH_PREFECTURES = ['東京都', '神奈川県', '千葉県', '埼玉県'];
let prefectureLinesCache = null;

async function hrGet(params) {
    const res = await fetch(`${HR_URL}?${new URLSearchParams(params)}`);
    return res.json();
}

async function fetchHeartRailsStations(line) {
    const data = await hrGet({ method: 'getStations', line });
    return data.response && data.response.station && data.response.station.length ? data : null;
}

async function allLines() {
    if (prefectureLinesCache) return prefectureLinesCache;
    const set = new Set();
    for (const pref of LINE_SEARCH_PREFECTURES) {
        const data = await hrGet({ method: 'getLines', prefecture: pref });
        ((data.response && data.response.line) || []).forEach(l => set.add(l));
        await sleep(300);
    }
    return (prefectureLinesCache = [...set]);
}

// 「京急」と「京浜急行」、「線」の有無などの表記ゆれを吸収して比較する
const lineKey = s => s.normalize('NFKC')
    .replace(/京浜急行電鉄|京浜急行/g, '京急')
    .replace(/東京急行電鉄|東京急行/g, '東急')
    .replace(/^ＪＲ|^JR東日本|^JR/g, 'JR')
    .replace(/[線\s・]/g, '');

async function resolveLineName(line) {
    const lines = await allLines();
    return lines.find(l => lineKey(l) === lineKey(line)) || null;
}

async function similarLines(line) {
    const lines = await allLines();
    const k = lineKey(line);
    const company = k.slice(0, 2);
    return lines.filter(l => lineKey(l).startsWith(company) || lineKey(l).includes(k.slice(2))).slice(0, 15);
}

async function buildNetwork() {
    const stations = [];
    const byName = {};
    const edges = [];
    const edgeKeys = new Set();
    const okLines = [];

    for (const line of LINES) {
        const source = (LINE_SECTIONS[line] && LINE_SECTIONS[line].hr) || line;
        let data = await fetchHeartRailsStations(source);
        let lineName = source;
        if (!data) {
            // 名前が HeartRails の表記と違う場合は、路線一覧から近い名前を探す
            const resolved = await resolveLineName(line);
            if (resolved) {
                console.log(`  「${line}」→ HeartRails の路線名「${resolved}」を使います`);
                data = await fetchHeartRailsStations(resolved);
                lineName = resolved;
            }
        }
        if (!data) {
            const hint = await similarLines(line);
            console.warn(`× 路線「${line}」が見つかりません。${hint.length ? '候補: ' + hint.join(', ') : 'node scrape.js --list-lines 神奈川県 で路線名を確認してください。'}`);
            continue;
        }
        okLines.push(line);   // 表示・凡例には LINES に書いた名前を使う
        let list = data.response.station.map(s => ({
            name: s.name, prefecture: s.prefecture,
            lat: parseFloat(s.y), lng: parseFloat(s.x),
            next: 'next' in s ? s.next : undefined
        }));
        const section = LINE_SECTIONS[line];
        if (section) {
            const names = list.map(s => s.name);
            const from = section.from ? names.indexOf(section.from) : 0;
            const to = section.to ? names.indexOf(section.to) : names.length - 1;
            if (from < 0 || to < 0) throw new Error(`${line} に区間の端の駅（${section.from} / ${section.to}）がありません`);
            list = list.slice(from, to + 1);
        }
        const local = {};
        list.forEach(s => {
            // 同名かつ 2km 以内なら同一駅（乗換駅）として統合
            let st = (byName[s.name] || []).find(o => kmBetween(o, s) < 2);
            if (!st) {
                st = { id: 's' + stations.length, name: s.name, lat: s.lat, lng: s.lng, prefecture: s.prefecture, lines: [] };
                stations.push(st);
                (byName[s.name] = byName[s.name] || []).push(st);
            }
            if (!st.lines.includes(line)) st.lines.push(line);
            local[s.name] = st.id;
        });
        list.forEach((s, i) => {
            const nextName = s.next !== undefined ? s.next : (list[i + 1] ? list[i + 1].name : null);
            if (!nextName || !local[nextName]) return;
            const a = local[s.name], b = local[nextName];
            const key = [a, b].sort().join('|') + '|' + line;
            if (a !== b && !edgeKeys.has(key)) { edgeKeys.add(key); edges.push({ source: a, target: b, line }); }
        });
        console.log(`○ ${line}: ${list.length} 駅`);
        await sleep(500);
    }
    EXTRA_EDGES.forEach(e => {
        const a = (byName[e.a] || [])[0], b = (byName[e.b] || [])[0];
        if (!a || !b) throw new Error(`追加する区間の駅がありません: ${e.a}〜${e.b}`);
        edges.push({ source: a.id, target: b.id, line: e.line });
        [a, b].forEach(st => { if (!st.lines.includes(e.line)) st.lines.push(e.line); });
    });
    const dup = Object.entries(byName).filter(([, v]) => v.length > 1).map(([k]) => k);
    if (dup.length) console.warn('※ 同名で離れた場所にある駅があります（別の駅として扱います）:', dup.join(', '));
    return { generatedAt: new Date().toISOString(), requestedLines: LINES, lines: okLines, stations, edges };
}

// --- 2. 時間・運賃（Yahoo!乗換案内の検索結果ページ） -------------------
function nextWeekdayDate() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d;
}
const SEARCH_DATE = nextWeekdayDate();

function buildSearchUrl(from, to) {
    const p = new URLSearchParams({
        from: NAME_ALIASES[from] || from,
        to: NAME_ALIASES[to] || to,
        y: String(SEARCH_DATE.getFullYear()),
        m: String(SEARCH_DATE.getMonth() + 1).padStart(2, '0'),
        d: String(SEARCH_DATE.getDate()).padStart(2, '0'),
        hh: String(SEARCH_HOUR).padStart(2, '0'),
        m1: String(Math.floor(SEARCH_MINUTE / 10)),
        m2: String(SEARCH_MINUTE % 10),
        type: '1',          // 出発時刻指定
        ticket: 'normal',   // きっぷ（現金）運賃
        expkind: '1',
        ws: '3',
        s: '0',             // 到着が早い順
        al: '0', shin: '0', ex: '0', hb: '0', lb: '0', sr: '0'  // 飛行機・新幹線・有料特急・バス・フェリーを使わない
    });
    return 'https://transit.yahoo.co.jp/search/result?' + p.toString();
}

function htmlToText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(li|div|p|dd|dt|tr|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&yen;|&#165;|￥/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/[ \t\r]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n');
}

function toMinutes(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }

// 検索結果のテキストから、各ルートの所要時間（分）と運賃（円）を取り出す
function parseRoutes(text) {
    const routes = [];
    const chunks = text.split(/ルート\s*\d+/).slice(1);
    (chunks.length ? chunks : [text]).forEach(chunk => {
        let time = null, fare = null;
        // 例: 「10:03発→10:41着38分（乗車33分）」「10:03発→11:15着1時間12分」
        const t = chunk.match(/(\d{1,2}:\d{2})\s*発\s*→\s*(\d{1,2}:\d{2})\s*着\s*(?:(\d+)\s*時間)?\s*(\d+)\s*分/);
        if (t) {
            time = (t[3] ? +t[3] * 60 : 0) + +t[4];
        } else {
            const t2 = chunk.match(/(\d{1,2}:\d{2})\s*発\s*→\s*(\d{1,2}:\d{2})\s*着/);
            if (t2) time = (toMinutes(t2[2]) - toMinutes(t2[1]) + 1440) % 1440;
        }
        // 例: 「現金優先：330円」「IC優先：327円」「運賃 330円」
        const f = chunk.match(/(?:現金優先|IC優先|片道)\s*[：:]\s*([\d,]+)\s*円/) || chunk.match(/運賃[^\d\n]{0,8}([\d,]+)\s*円/);
        if (f) fare = +f[1].replace(/,/g, '');
        if (time != null || fare != null) routes.push({ time, fare });
    });
    if (!routes.length) return null;
    const times = routes.map(r => r.time).filter(v => v != null);
    const fares = routes.map(r => r.fare).filter(v => v != null && v > 0);
    return {
        time: times.length ? Math.min(...times) : null,
        fare: fares.length ? Math.min(...fares) : null,
        routes: routes.length
    };
}

async function fetchRoute(from, to, { debug = false } = {}) {
    const url = buildSearchUrl(from, to);
    const res = await politeFetch(url);
    const html = await res.text();
    const result = parseRoutes(htmlToText(html));
    if (debug || !result) {
        fs.mkdirSync(DEBUG_DIR, { recursive: true });
        const f = path.join(DEBUG_DIR, `${from}_${to}.html`.replace(/[\\/:*?"<>|]/g, '_'));
        fs.writeFileSync(f, html, 'utf8');
        if (!result) console.warn(`  解析できませんでした（HTML を ${path.relative(__dirname, f)} に保存）`);
    }
    return result ? { time: result.time, fare: result.fare } : null;
}

// --- メイン -----------------------------------------------------------
function parseArgs() {
    const args = process.argv.slice(2);
    const opt = { test: false, all: false, retry: false, networkOnly: false, centers: CENTERS };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--test') opt.test = true;
        else if (args[i] === '--all') opt.all = true;
        else if (args[i] === '--retry') opt.retry = true;
        else if (args[i] === '--list-lines') opt.listLines = args[++i] || '神奈川県';
        else if (args[i] === '--network-only') opt.networkOnly = true;
        else if (args[i] === '--center') opt.centers = (args[++i] || '').split(/[,、]/).map(s => s.trim()).filter(Boolean);
    }
    return opt;
}

async function main() {
    const opt = parseArgs();

    if (opt.listLines) {
        const data = await hrGet({ method: 'getLines', prefecture: opt.listLines });
        console.log(((data.response && data.response.line) || []).join('\n') || '見つかりません');
        return;
    }

    if (opt.test) {
        const [a, b] = opt.centers.length >= 2 ? opt.centers : ['金沢八景', '横浜'];
        console.log(`テスト: ${a} → ${b}\n  ${buildSearchUrl(a, b)}`);
        const r = await fetchRoute(a, b, { debug: true });
        console.log('  結果:', r);
        console.log(r && r.time && r.fare ? '○ 解析できました。本番を実行してください。' : '× 解析に失敗しました。data/debug の HTML を確認してください。');
        return;
    }

    let network = readJsFile(NETWORK_FILE);
    const linesChanged = network && JSON.stringify(network.requestedLines || network.lines) !== JSON.stringify(LINES);
    if (!network || opt.networkOnly || linesChanged || network.lines.length < LINES.length) {
        console.log('駅データを取得します…');
        network = await buildNetwork();
        writeJsFile(NETWORK_FILE, 'NETWORK', network);
        console.log(`→ ${path.relative(__dirname, NETWORK_FILE)}（${network.stations.length} 駅・${network.edges.length} 区間）`);
        if (network.lines.length < LINES.length) {
            console.error('\n取得できなかった路線があるため中断しました。scrape.js の LINES を上の候補の名前に直して、もう一度実行してください。');
            return;
        }
        if (opt.networkOnly) return;
    }

    const names = [...new Set(network.stations.map(s => s.name))];
    const routes = readJsFile(ROUTES_FILE) || {};
    const centers = opt.all ? names : opt.centers;
    const missing = centers.filter(c => !names.includes(c));
    if (missing.length) console.warn('※ 駅データにない中心駅:', missing.join(', '));

    const todo = [];
    centers.filter(c => names.includes(c)).forEach(c => {
        names.forEach(n => {
            const k = pairKey(c, n);
            if (n !== c && (!(k in routes) || (opt.retry && routes[k] === null)) && !todo.some(t => t.key === k)) todo.push({ key: k, from: c, to: n });
        });
    });
    const eta = Math.ceil(todo.length * REQUEST_INTERVAL_MS / 60000);
    console.log(`未取得の区間: ${todo.length} 件（目安 約 ${eta} 分）`);

    let saved = 0, failed = 0;
    for (let i = 0; i < todo.length; i++) {
        const { key, from, to } = todo[i];
        let r = null;
        try {
            r = await fetchRoute(from, to);
        } catch (e) {
            console.warn(`  ${from} → ${to}: ${e.message}`);
        }
        routes[key] = r;   // 失敗は null として記録（--retry で再取得）
        if (!r) failed++;
        console.log(`[${i + 1}/${todo.length}] ${from} → ${to}: ${r ? `${r.time}分 / ${r.fare}円` : '取得失敗'}`);
        if (++saved % 5 === 0 || i === todo.length - 1) writeJsFile(ROUTES_FILE, 'ROUTES', routes);
    }
    writeJsFile(ROUTES_FILE, 'ROUTES', routes);
    console.log(`完了: ${path.relative(__dirname, ROUTES_FILE)}（失敗 ${failed} 件）`);
    if (failed) console.log('失敗した駅は NAME_ALIASES に Yahoo!乗換案内での駅名を書き、node scrape.js --retry で再取得してください。');
}

if (require.main === module) {
    main().catch(e => { console.error(e); process.exit(1); });
}
module.exports = { parseRoutes, htmlToText, buildSearchUrl };
