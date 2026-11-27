// =====================================================================
// 時刻表データ（data/keikyu.js など）を推定の答え合わせ・較正に使うための共通の部品
// （calibrate_estimate.js・compare_estimate.js で使う。推定の時刻表そのものには時刻表データを入れない）
// =====================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DATA_FILES = ['network.js', 'keikyu.js', 'jr.js', 'tokyu.js', 'sotetsu.js', 'minatomirai.js', 'seaside.js', 'yokohama.js'];
// 種別の名前 → 段（data の列車の最初の要素）: 0 = 各停、1 = 急行・快速、2 = 特急・快特など
const TYPE_TIER = { futsu: 0, local: 0, kyuko: 1, express: 1, rapid: 1, tokkyu: 2, kaitoku: 2, limited: 2, commuter: 2 };

function load(files = DATA_FILES) {
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

// 時刻表の路線と、その路線にあたる推定の路線（名前の正規表現。同じ駅を持つ別会社の路線には入れない）・路線の種類
function timetableSources(w) {
    return [
        [w.KEIKYU, /^京急線$/, 'train'],
        [w.SOTETSU, /^相鉄|^相模鉄道/, 'train'],
        [w.MINATOMIRAI, /みなとみらい/, 'subway'],
        [w.SEASIDE, /シーサイド/, 'light_rail'],
        [w.YOKOHAMA, /横浜市営地下鉄/, 'subway'],
        [w.JR?.lines?.['横須賀線'], /^横須賀線$/, 'train'],
        [w.JR?.lines?.['根岸線'], /^JR根岸線$/, 'train'],
        [w.JR?.lines?.['横浜線'], /^JR横浜線$/, 'train'],
        [w.JR?.lines?.['東海道線'], /^JR東海道本線$|^上野東京ライン$/, 'train'],
        [w.TOKYU?.lines?.['東横線'], /^東急東横線$/, 'train'],
        [w.TOKYU?.lines?.['新横浜線'], /^東急新横浜線$/, 'train'],
    ].filter(([src]) => src);
}

module.exports = { load, tierOf, timetableSources, TYPE_TIER, DATA_FILES };
