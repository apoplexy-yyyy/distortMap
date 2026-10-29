// =====================================================================
// ランドマーク（Google マイマップの地点）の読み込み・保存と、設定パネル
//
//   読み込み元
//     - 既定のマイマップ（data/landmark_presets.js の window.LANDMARK_PRESETS = [{ title, url }]）
//     - パネルに貼ったマイマップの URL（serve.py の /mymaps-kml で KML を取り次いでもらう）
//     - マイマップから書き出した KML ファイル（ドロップ・ファイル選択）
//   読み込んだ地図・地点・レイヤーのオンオフはブラウザ（localStorage）に保存し、次に開いたときも使う。
//   地図ごとの表示は、開いたときはすべてオフ（共有 URL で指定されたものだけオン）
//
//   LandmarkStore.init({ button, panel, onChange, setStatus, active })   active … 表示する地図の mid の配列（共有 URL から）
//   LandmarkStore.visibleItems() … 表示中の地点 [{ key, name, lat, lng, note, mapTitle, layerName, color }]
//   LandmarkStore.activeMids()   … 表示中のマイマップの mid（共有 URL 用。KML ファイルから読んだ地図は含まない）
// =====================================================================

const LandmarkStore = (() => {
    const STORAGE_KEY = 'distortMap.landmarks.v1';
    const COLORS = ['#d6336c', '#0ca678', '#f08c00', '#7048e8', '#1c7ed6', '#e8590c', '#2b8a3e'];
    const NO_LAYER = '（レイヤーなし）';

    // { id, title, mid?, file?, preset, on, loaded, error, color, layers: [{ name, on, items: [{ name, lat, lng, note }] }] }
    let maps = [];
    let opts = {};
    let panel;

    // --- 保存 ------------------------------------------------------------
    function save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(maps.map(m => ({ ...m, error: undefined }))));
        } catch (e) { /* 保存できない環境（プライベートウィンドウなど）でも今回の表示はできる */ }
    }
    function restore() {
        try {
            const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            return Array.isArray(v) ? v.map(m => ({ ...m, loading: false })) : [];
        } catch (e) { return []; }
    }

    // --- URL・KML ----------------------------------------------------------
    // マイマップの URL（edit?mid= / viewer?mid= / embed?mid= など）から ID を取り出す
    function midOf(url) {
        const s = String(url || '').trim();
        const m = s.match(/[?&]mid=([A-Za-z0-9_-]{10,100})/);
        if (m) return m[1];
        return /^[A-Za-z0-9_-]{20,100}$/.test(s) ? s : null;
    }

    function parseKml(text) {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('KML として読めません');
        const nameOf = el => {
            const n = el && [...el.children].find(c => c.localName === 'name');
            return n ? n.textContent.trim() : '';
        };
        const plain = html => {
            if (!html) return '';
            const t = new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
            return t.replace(/\s+/g, ' ').trim().slice(0, 200);
        };
        const docEl = doc.getElementsByTagName('Document')[0];
        const layers = new Map();
        [...doc.getElementsByTagName('Placemark')].forEach(pm => {
            const point = pm.getElementsByTagName('Point')[0];
            const coord = point && point.getElementsByTagName('coordinates')[0];
            if (!coord) return;                                  // 線・面は使わない
            const [lng, lat] = coord.textContent.trim().split(',').map(Number);
            if (!isFinite(lat) || !isFinite(lng)) return;
            const folder = pm.closest('Folder');
            const layer = nameOf(folder) || NO_LAYER;
            const desc = pm.getElementsByTagName('description')[0];
            if (!layers.has(layer)) layers.set(layer, []);
            layers.get(layer).push({ name: nameOf(pm) || '（名前なし）', lat, lng, note: plain(desc && desc.textContent) });
        });
        if (!layers.size) throw new Error('地点（ピン）がありません');
        return { title: nameOf(docEl), layers: [...layers].map(([name, items]) => ({ name, items })) };
    }

    // build_landmarks.py で取り込んでおいた KML（data/landmarks_kml.js）
    const bundled = mid => window.LANDMARK_KML && window.LANDMARK_KML[mid] && window.LANDMARK_KML[mid].kml;

    async function fetchKml(mid) {
        // index.html を直接開いているとき（file://）は Google を読めないので、取り込んでおいた KML を使う
        if (location.protocol === 'file:') {
            if (bundled(mid)) return bundled(mid);
            throw new Error('index.html を直接開いているので、このマイマップを読めません。'
                + 'data/landmark_presets.js に URL を書いて python build_landmarks.py を実行するか、'
                + 'python serve.py で開くか、書き出した KML ファイルを読み込んでください');
        }
        let res;
        try {
            res = await fetch(`mymaps-kml?mid=${encodeURIComponent(mid)}`);
        } catch (e) {
            if (bundled(mid)) return bundled(mid);
            throw new Error('表示用サーバーにつながりません（python serve.py で開いてください）');
        }
        if (res.status === 404 && bundled(mid)) return bundled(mid);   // serve.py でないサーバーで開いているとき
        const text = await res.text();
        if (res.status === 404 && !/マイマップ/.test(text)) {
            throw new Error('マイマップを取り次ぐサーバーではありません。python serve.py で開いてください');
        }
        if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
        return text;
    }

    // 読み込んだ内容を地図に入れる（同じ名前のレイヤーはオンオフを引き継ぐ）
    function apply(map, parsed) {
        const prevOn = new Map((map.layers || []).map(l => [l.name, l.on]));
        map.title = map.preset && map.presetTitle ? map.presetTitle : parsed.title || map.title || 'マイマップ';
        map.layers = parsed.layers.map(l => ({ ...l, on: prevOn.has(l.name) ? prevOn.get(l.name) : true }));
        map.loaded = true;
        map.error = null;
    }

    async function load(map) {
        map.error = null;
        map.loading = true;
        render();
        try {
            apply(map, parseKml(await fetchKml(map.mid)));
            opts.setStatus && opts.setStatus(`ランドマーク: 「${map.title}」を読み込みました（${count(map)} 件）`, 'ok');
        } catch (e) {
            map.error = e.message;
            opts.setStatus && opts.setStatus(`ランドマーク: 「${map.title}」を読み込めませんでした。${e.message}`, 'warn');
        }
        map.loading = false;
        save();
        changed();
    }

    const count = m => (m.layers || []).reduce((n, l) => n + l.items.length, 0);
    const nextColor = () => COLORS[maps.length % COLORS.length];

    function addUrl(url) {
        const mid = midOf(url);
        if (!mid) {
            opts.setStatus && opts.setStatus('マイマップの URL（…mid=… を含むもの）を貼ってください', 'warn');
            return;
        }
        let map = maps.find(m => m.mid === mid);
        if (!map) {
            map = { id: 'mid:' + mid, mid, title: 'マイマップ', preset: false, on: true, color: nextColor(), layers: [] };
            maps.push(map);
        }
        map.on = true;
        load(map);
    }

    function addFiles(files) {
        [...files].forEach(file => {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const parsed = parseKml(reader.result);
                    let map = maps.find(m => m.file === file.name);
                    if (!map) {
                        map = { id: 'file:' + file.name, file: file.name, title: file.name, preset: false, on: true, color: nextColor(), layers: [] };
                        maps.push(map);
                    }
                    map.on = true;
                    apply(map, parsed);
                    opts.setStatus && opts.setStatus(`ランドマーク: 「${map.title}」を読み込みました（${count(map)} 件）`, 'ok');
                    save();
                    changed();
                } catch (e) {
                    opts.setStatus && opts.setStatus(`ランドマーク: ${file.name} を読めませんでした。${e.message}`, 'warn');
                }
            };
            reader.readAsText(file);
        });
    }

    function remove(map) {
        maps = maps.filter(m => m !== map);
        save();
        changed();
    }

    function changed() {
        render();
        opts.onChange && opts.onChange();
    }

    // --- パネル -----------------------------------------------------------
    function el(tag, attrs = {}, ...children) {
        const e = document.createElement(tag);
        Object.entries(attrs).forEach(([k, v]) => {
            if (k === 'on') Object.entries(v).forEach(([ev, fn]) => e.addEventListener(ev, fn));
            else if (k === 'class') e.className = v;
            else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
        });
        children.flat().forEach(c => c != null && e.append(c));
        return e;
    }

    function render() {
        if (!panel) return;
        panel.innerHTML = '';
        const list = el('div', { class: 'lm-list' });
        if (!maps.length) list.append(el('div', { class: 'lm-empty' }, 'まだ地図がありません。下でマイマップの URL を追加するか、KML ファイルを読み込んでください。'));
        maps.forEach(m => {
            const toggle = el('input', {
                type: 'checkbox', checked: m.on,
                on: {
                    change: e => {
                        m.on = e.target.checked;
                        save();
                        if (m.on && !m.loaded && m.mid) load(m); else changed();
                    },
                },
            });
            const status = m.loading ? '読み込み中…' : m.error ? '読み込めません' : m.loaded ? `${count(m)} 件` : '';
            const row = el('div', { class: 'lm-map' },
                el('label', { class: 'lm-map-name', title: m.error || '' },
                    toggle, el('span', { class: 'lm-swatch', style: `background:${m.color}` }), el('span', {}, m.title),
                    el('span', { class: m.error ? 'lm-count lm-error' : 'lm-count' }, status)),
                el('span', { class: 'lm-actions' },
                    m.mid ? el('button', { type: 'button', class: 'lm-small', title: 'マイマップを読み直す', on: { click: () => { m.on = true; load(m); } } }, '再読み込み') : null,
                    m.preset ? null : el('button', { type: 'button', class: 'lm-small lm-remove', title: '一覧から削除', on: { click: () => remove(m) } }, '削除')));
            list.append(row);
            if (m.error) list.append(el('div', { class: 'lm-error lm-error-msg' }, m.error));
            if (m.loaded && m.layers.length > 1) {
                const layers = el('div', { class: 'lm-layers' });
                m.layers.forEach(l => layers.append(el('label', { class: 'lm-layer' },
                    el('input', { type: 'checkbox', checked: l.on, disabled: !m.on, on: { change: e => { l.on = e.target.checked; save(); changed(); } } }),
                    el('span', {}, l.name), el('span', { class: 'lm-count' }, `${l.items.length} 件`))));
                list.append(layers);
            }
        });
        const input = el('input', { type: 'url', class: 'lm-url', placeholder: 'マイマップの URL を貼り付け' });
        const addBtn = el('button', { type: 'button', on: { click: () => { addUrl(input.value); input.value = ''; } } }, '追加');
        input.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
        const fileInput = el('input', { type: 'file', accept: '.kml,application/vnd.google-earth.kml+xml', multiple: true, hidden: true,
            on: { change: e => { addFiles(e.target.files); e.target.value = ''; } } });
        panel.append(
            el('div', { class: 'lm-head' }, el('strong', {}, 'ランドマーク'), el('span', { class: 'lm-hint' }, 'Google マイマップの地点を地図に重ねます')),
            list,
            el('div', { class: 'lm-add' }, input, addBtn),
            el('div', { class: 'lm-add' },
                el('button', { type: 'button', class: 'lm-small', on: { click: () => fileInput.click() } }, 'KML ファイルを読み込む'),
                el('span', { class: 'lm-hint' }, 'またはこのパネルにドロップ'), fileInput),
            el('div', { class: 'lm-hint' }, 'マイマップは「リンクを知っている全員が閲覧可」で共有してください。'));
    }

    // --- 初期化 -----------------------------------------------------------
    function init(o) {
        opts = o;
        panel = o.panel;
        // 開いたときは地図をすべてオフにする（読み込んだ地点は保存したものを使う）
        maps = restore().map(m => ({ ...m, on: false }));
        // 既定のマイマップを一覧に入れる（初めは表示しない。チェックすると読み込む）
        (window.LANDMARK_PRESETS || []).forEach(p => {
            const mid = midOf(p.url);
            if (!mid) return;
            const m = maps.find(x => x.mid === mid);
            if (m) { m.preset = true; m.presetTitle = p.title; m.title = p.title || m.title; }
            else maps.push({ id: 'mid:' + mid, mid, title: p.title || 'マイマップ', presetTitle: p.title, preset: true, on: false, color: nextColor(), layers: [] });
        });
        o.button.addEventListener('click', () => {
            const open = panel.hidden;
            panel.hidden = !open;
            o.button.setAttribute('aria-expanded', String(open));
        });
        panel.addEventListener('dragover', e => { e.preventDefault(); panel.classList.add('lm-drop'); });
        panel.addEventListener('dragleave', () => panel.classList.remove('lm-drop'));
        panel.addEventListener('drop', e => {
            e.preventDefault();
            panel.classList.remove('lm-drop');
            if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        });
        // 共有 URL で指定された地図を表示する（一覧に無ければ追加する）
        (o.active || []).forEach(mid => {
            if (!/^[A-Za-z0-9_-]{10,100}$/.test(mid)) return;
            let m = maps.find(x => x.mid === mid);
            if (!m) {
                m = { id: 'mid:' + mid, mid, title: 'マイマップ', preset: false, color: nextColor(), layers: [] };
                maps.push(m);
            }
            m.on = true;
        });
        render();
        // 表示する地図のうち、まだ読み込んでいないものを読み込む
        maps.filter(m => m.on && !m.loaded && m.mid).forEach(load);
    }

    const activeMids = () => maps.filter(m => m.on && m.mid).map(m => m.mid);

    function visibleItems() {
        const out = [];
        maps.filter(m => m.on && m.loaded).forEach(m => m.layers.filter(l => l.on).forEach(l => l.items.forEach((it, i) => {
            out.push({ ...it, key: `${m.id}|${l.name}|${i}`, mapTitle: m.title, layerName: l.name === NO_LAYER ? '' : l.name, color: m.color });
        })));
        return out;
    }

    return { init, visibleItems, activeMids, parseKml, midOf };
})();
