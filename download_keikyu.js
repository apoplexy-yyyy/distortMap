// 京急公式サイトから「各駅掲示時刻表（PDF）」と「運賃表（PDF）」をダウンロードする
//   node download_keikyu.js
// 保存先: keikyu_pdf/KK01.pdf … KK72.pdf, keikyu_pdf/fare.pdf
// すでにあるファイルはスキップします（取り直すときはフォルダごと消してください）

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'keikyu_pdf');
const BASE = 'https://www.keikyu.co.jp';
const INTERVAL_MS = 1500;

const files = [{ url: `${BASE}/ride/ticket/pdf/tetsudoueigyou_15.pdf`, name: 'fare.pdf' }];
for (let i = 1; i <= 72; i++) {
    const code = 'KK' + String(i).padStart(2, '0');
    files.push({ url: `${BASE}/ride/kakueki/pdf/timetable/${code}.pdf`, name: `${code}.pdf` });
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    let n = 0;
    for (const f of files) {
        n++;
        const dest = path.join(OUT, f.name);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { console.log(`[${n}/${files.length}] ${f.name} (既存)`); continue; }
        try {
            const res = await fetch(f.url, { headers: { 'User-Agent': 'distortMap-data-collector/1.0 (personal)' } });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
            console.log(`[${n}/${files.length}] ${f.name} ${Math.round(fs.statSync(dest).size / 1024)}KB`);
        } catch (e) {
            console.warn(`[${n}/${files.length}] ${f.name} 失敗: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, INTERVAL_MS));
    }
    console.log('完了: ' + OUT);
})();
