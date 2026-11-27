// =====================================================================
// Wikipedia の路線の記事から、種別（急行・快速など）ごとの停車駅と日中の本数を読む → wiki_stops.json
// （build_osm_estimate.js の推定で、速い列車の停車駅と本数に使う）
//
//   停車駅: 記事の「駅一覧」の表の、種別ごとの列（●・◎・▲ = 停車、｜・↓・↑ = 通過）
//   本数:   「運行本数」などの表で、種別の行にある「N本」（表の見出しの「40分あたり」「1時間あたり」で 1 時間あたりに直す）。
//           表の形は記事ごとにまちまちなので、読めた路線だけ（読めなければ推定の目安のまま）
//
//   出典: Wikipedia（CC BY-SA 4.0）。記事の wikitext は osm_rail/wiki/ に保存し、次からはそれを使う（--fetch で取り直す）
//
//   node build_wiki_stops.js [--fetch]
// =====================================================================
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CACHE = path.join(__dirname, 'osm_rail', 'wiki');
const OUT = path.join(__dirname, 'wiki_stops.json');
const USER_AGENT = 'distortMap-data-collector/1.0 (personal, low-frequency)';
// 推定の路線名 → Wikipedia の記事（1 つの推定の路線に記事が複数あれば停車駅を合わせる）
const ARTICLES = {
    '京急線': ['京急本線', '京急久里浜線', '京急空港線', '京急逗子線'],
    '小田急小田原線': ['小田急小田原線'],
    '小田急江ノ島線': ['小田急江ノ島線'],
    '小田急電鉄多摩線': ['小田急多摩線'],
    '京王電鉄京王線': ['京王線'],
    '京王電鉄相模原線': ['京王相模原線'],
    '東急東横線': ['東急東横線'],
    '東急田園都市線': ['東急田園都市線'],
    '東急目黒線': ['東急目黒線'],
    '東急大井町線': ['東急大井町線'],
    '東急新横浜線': ['東急新横浜線'],
    '相鉄本線': ['相鉄本線'],
    '相模鉄道いずみ野線': ['相鉄いずみ野線'],
    '相鉄新横浜線': ['相鉄新横浜線'],
    'JR横浜線': ['横浜線'],
    'JR南武線': ['南武線'],
    'JR京浜東北線': ['京浜東北線'],
    'みなとみらい線': ['横浜高速鉄道みなとみらい線'],
    '横浜市営地下鉄ブルーライン': ['横浜市営地下鉄ブルーライン'],
};
// 種別の名前（表の見出しにこのどれかが入っている列を種別の列とみなす）。各停にあたるものは停車駅に使わない
const TYPE_RE = /(エアポート快特|快特|快速特急|特急|通勤特急|アクセス特急|急行|快速急行|通勤急行|区間急行|準急|通勤準急|区間準急|快速|特別快速|通勤快速|Fライナー|Sトレイン)/;
const LOCAL_RE = /^(普通|各駅停車|各停)$/;
const STOP_MARK = /[●◎▲◆■○△]/, PASS_MARK = /[｜|↓↑│┃]/;

function fetchWikitext(title, force) {
    const file = path.join(CACHE, title.replace(/[\\/:*?"<>|]/g, '_') + '.json');
    if (!force && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).wikitext;
    const url = 'https://ja.wikipedia.org/w/api.php?action=parse&prop=wikitext&format=json&formatversion=2&redirects=1&page=' + encodeURIComponent(title);
    const body = execFileSync('curl', ['-sfL', '-A', USER_AGENT, url], { maxBuffer: 64 << 20 }).toString('utf8');
    const j = JSON.parse(body);
    if (!j.parse) throw new Error(`Wikipedia の記事が見つかりません: ${title}`);
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ title: j.parse.title, wikitext: j.parse.wikitext }));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);   // 続けて取りに行かないよう 3 秒あける
    return j.parse.wikitext;
}

// 文字の飾りを除く: {{縦書き|急行|…}} → 急行、[[リンク|表示]] → 表示、<br> → 空、''' など
function plain(s) {
    return s
        .replace(/\{\{縦書き\|([^|}]*)[^}]*\}\}/g, '$1')
        .replace(/\{\{[^{}]*\}\}/g, '')
        .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
        .replace(/<br\s*\/?>/g, '').replace(/<[^>]+>/g, '').replace(/'''?/g, '').replace(/&nbsp;/g, ' ').trim();
}
// 表のセル: 「属性|中身」の属性（rowspan・colspan）と中身。[[ ]]・{{ }} の中の | は区切りではない
function splitCell(raw) {
    let depth = 0;
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i], n = raw[i + 1];
        if ((c === '[' && n === '[') || (c === '{' && n === '{')) { depth++; i++; continue; }
        if ((c === ']' && n === ']') || (c === '}' && n === '}')) { depth--; i++; continue; }
        if (c === '|' && depth === 0 && n !== '|') {
            const attr = raw.slice(0, i);
            if (/^\s*(style|rowspan|colspan|class|align|bgcolor|width|scope)\s*=/.test(attr) || /(rowspan|colspan|style)\s*=/.test(attr))
                return { attr, text: raw.slice(i + 1) };
            return { attr: '', text: raw };
        }
    }
    return { attr: '', text: raw };
}
// 1 行の中のセルを分ける（行頭の | ・ ! と、行の中の || ・ !!）
function rowCells(rowText) {
    const cells = [];
    for (const line of rowText.split('\n')) {
        if (!/^[|!]/.test(line) || /^\|[-}+]/.test(line)) { if (cells.length && line && !/^\|[-}]/.test(line)) cells[cells.length - 1].raw += '\n' + line; continue; }
        const header = line[0] === '!';
        for (const part of line.slice(1).split(header ? /!!|\|\|/ : /\|\|/)) cells.push({ raw: part, header });
    }
    return cells.map(c => {
        const { attr, text } = splitCell(c.raw);
        return { text, header: c.header, rowspan: +(attr.match(/rowspan\s*=\s*"?(\d+)/)?.[1] || 1), colspan: +(attr.match(/colspan\s*=\s*"?(\d+)/)?.[1] || 1) };
    });
}
// 表を、rowspan・colspan を広げた格子にする
function tableGrid(tableText) {
    const rows = tableText.split(/\n\|-[^\n]*/).slice(1);
    const grid = [], hold = [];   // hold[列] = { left: 残りの行数, cell }
    for (const r of rows) {
        const cells = rowCells(r), out = [];
        let col = 0;
        const fillHeld = () => { while (hold[col]?.left > 0) { out[col] = hold[col].cell; hold[col].left--; col++; } };
        for (const c of cells) {
            fillHeld();
            for (let k = 0; k < c.colspan; k++) {
                out[col] = c;
                if (c.rowspan > 1) hold[col] = { left: c.rowspan - 1, cell: c };
                col++;
            }
        }
        fillHeld();
        grid.push(out);
    }
    return grid;
}
// 駅名: [[○○駅]] のリンク先から「駅」と「(…)」を除く
const stationName = cell => {
    const m = cell && cell.text.match(/\[\[([^|\]]+?)駅(?:\s*\([^)]*\))?(?:\|[^\]]*)?\]\]/);
    return m ? m[1].replace(/\s*\(.*\)$/, '').trim() : null;
};

// 「駅一覧」の表から { 種別: Set(停車駅) }
function readStops(wikitext) {
    const start = wikitext.search(/\n==\s*駅一覧\s*==/);
    if (start < 0) return {};
    const end = wikitext.slice(start + 5).search(/\n==[^=]/);
    const sec = wikitext.slice(start, end < 0 ? undefined : start + 5 + end);
    const result = {};
    for (const m of sec.matchAll(/\{\|[\s\S]*?\n\|\}/g)) {
        const grid = tableGrid(m[0]);
        // 見出しの行と、種別の列
        let typeCols = null;
        for (let r = 0; r < Math.min(4, grid.length) && !typeCols; r++) {
            const cols = [];
            grid[r].forEach((c, i) => {
                if (!c || !c.header) return;
                const t = plain(c.text).replace(/\s/g, '');
                if (TYPE_RE.test(t) && !LOCAL_RE.test(t) && t.length <= 10 && c.colspan === 1) cols.push([i, t]);
            });
            if (cols.length) typeCols = { row: r, cols };
        }
        if (!typeCols) continue;
        for (let r = typeCols.row + 1; r < grid.length; r++) {
            const row = grid[r];
            const name = row.map(stationName).find(Boolean);
            if (!name) continue;
            for (const [i, t] of typeCols.cols) {
                const v = row[i] ? plain(row[i].text) : '';
                if (STOP_MARK.test(v) && !PASS_MARK.test(v.replace(STOP_MARK, ''))) (result[t] = result[t] || new Set()).add(name);
                else (result[t] = result[t] || new Set());
            }
        }
    }
    return result;
}

// 「運行本数」の表から { 種別: 1 時間あたりの本数 }（片方向）。読めなければ空
function readFrequency(wikitext) {
    const out = {};
    for (const m of wikitext.matchAll(/\{\|[\s\S]*?\n\|\}/g)) {
        const tbl = m[0];
        const caption = (tbl.match(/\n\|\+([^\n]*)/) || [])[1] || '';
        const before = wikitext.slice(Math.max(0, m.index - 300), m.index);
        if (!/本数/.test(caption + before) || !/(日中|昼間|データイム)/.test(caption + before)) continue;
        const per = +(caption.match(/(\d+)\s*分(?:間)?あたり/) || before.match(/(\d+)\s*分(?:間)?あたり/) || [])[1] || 60;
        for (const r of tbl.split(/\n\|-[^\n]*/).slice(1)) {
            const cells = rowCells(r).map(c => plain(c.text).replace(/\s/g, ''));
            const type = cells.find(t => TYPE_RE.test(t) && t.length <= 8);
            if (!type) continue;
            const counts = cells.map(t => +(t.match(/^(\d+)本$/) || [])[1]).filter(n => n > 0);
            if (!counts.length) continue;
            const key = type.match(TYPE_RE)[1];
            out[key] = Math.max(out[key] || 0, Math.max(...counts) * 60 / per);
        }
    }
    return out;
}

function main() {
    const force = process.argv.includes('--fetch');
    const out = { note: 'Wikipedia（CC BY-SA 4.0）の路線の記事の駅一覧・運行本数から（build_wiki_stops.js）', lines: {} };
    for (const [line, titles] of Object.entries(ARTICLES)) {
        const types = {}, freq = {};
        for (const title of titles) {
            let wt;
            try { wt = fetchWikitext(title, force); } catch (e) { console.warn('  ' + e.message); continue; }
            for (const [t, set] of Object.entries(readStops(wt))) (types[t] = types[t] || new Set()).forEach ? set.forEach(s => types[t].add(s)) : null;
            Object.assign(freq, readFrequency(wt));
        }
        const list = Object.entries(types).filter(([, s]) => s.size >= 2).map(([name, s]) => ({ name, stops: [...s], perHour: freq[name.match(TYPE_RE)?.[1]] || null }));
        out.lines[line] = { articles: titles, types: list };
        console.log(`${line}: ` + (list.map(t => `${t.name} ${t.stops.length}駅${t.perHour ? `・毎時${+t.perHour.toFixed(1)}本` : ''}`).join('、') || '（種別の列なし）'));
    }
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
    console.log('→', OUT);
}

main();
