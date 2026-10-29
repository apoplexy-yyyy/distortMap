// =====================================================================
// 背景地図（国土地理院 地理院タイル・淡色地図）を駅と一緒に歪めて描く
//
//   各タイルを細かい三角形に分け、頂点ごとに「中心駅からの方角はそのまま、距離だけ伸縮」させる。
//   伸縮率は、近くの駅の伸縮率（歪めた後の距離 ÷ 実際の距離）を距離の重みで混ぜたもの。
//   駅の位置ではほぼその駅の伸縮率になるので、駅と地図がずれない。
//
//   BaseMap.init(container)          … SVG の下に canvas を作る
//   BaseMap.setWarp(warp, durationMs) … 歪め方を変える（アニメーションあり）
//   BaseMap.setTransform(t)          … d3.zoom の拡大・移動に合わせる
//   BaseMap.setOpacity(0〜1)          … 地図の濃さ（0 で描かない）
// =====================================================================

const BaseMap = (() => {
    const TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
    const MIN_Z = 8, MAX_Z = 18;   // 淡色地図はズームレベル 18 まである
    const MESH = 8;              // タイル 1 枚を MESH×MESH のマスに分ける
    const MAX_TILES = 300;       // 1 回に描くタイル数の上限
    const MAX_CANDIDATES = 2500; // 画面内か調べるタイル数の上限（超えるときはズームレベルを下げる）
    const MARGIN_KM = 30;        // 駅の範囲から外側に描く幅

    let canvas, ctx;
    let transform = { k: 1, x: 0, y: 0 };
    let warpFrom = null, warpTo = null, animStart = 0, animDur = 0;
    let opacity = 1;
    let frameRequested = false;
    const tiles = new Map();     // "z/x/y" -> { img, ok }

    // --- 座標変換 ---------------------------------------------------------
    const tileLng = (x, z) => x / 2 ** z * 360 - 180;
    const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;
    const lngTile = (lng, z) => (lng + 180) / 360 * 2 ** z;
    const latTile = (lat, z) => {
        const r = lat * Math.PI / 180;
        return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
    };

    // 緯度経度 → 歪めた後の中心駅からの km 座標 [x（東）, y（南）, 実際の距離]。app.js の computeGeo と同じ投影
    function warpKm(w, lat, lng) {
        const latMid = (lat + w.lat0) / 2 * Math.PI / 180;
        const x = (lng - w.lng0) * 111.32 * Math.cos(latMid);
        const y = -(lat - w.lat0) * 110.57;
        let s = 1;
        if (w.points.length) {
            let sw = 0, ss = 0;
            for (const p of w.points) {
                const d2 = (x - p.x) ** 2 + (y - p.y) ** 2;
                const wt = 1 / (d2 * d2 + 1e-4);     // 距離の 4 乗に反比例（駅の近くではその駅の値に近づく）
                sw += wt;
                ss += wt * p.s;
            }
            s = ss / sw;
        }
        return [x * s, y * s, Math.hypot(x, y)];
    }

    // 緯度経度 → 画面（SVG の viewBox）座標
    function warpPoint(w, lat, lng) {
        const [x, y] = warpKm(w, lat, lng);
        return [w.cx + x * w.scale, w.cy + y * w.scale];
    }

    function currentPoint(lat, lng, a) {
        const p1 = warpPoint(warpTo, lat, lng);
        if (a >= 1 || !warpFrom) return p1;
        const p0 = warpPoint(warpFrom, lat, lng);
        return [p0[0] + (p1[0] - p0[0]) * a, p0[1] + (p1[1] - p0[1]) * a];
    }

    // --- タイル -----------------------------------------------------------
    function tile(z, x, y) {
        const key = `${z}/${x}/${y}`;
        let t = tiles.get(key);
        if (!t) {
            const img = new Image();
            t = { img, ok: false };
            img.onload = () => { t.ok = true; requestDraw(); };
            img.onerror = () => { t.failed = true; };
            img.src = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
            tiles.set(key, t);
        }
        return t;
    }

    // 画面上で地図 1 ピクセルがタイル 1 ピクセル程度になるズームレベル
    function chooseZoom(w) {
        const pxPerKm = w.scale * transform.k * (w.typicalScale || 1);
        const kmPerTilePxAtZ0 = 40075 * Math.cos(w.lat0 * Math.PI / 180) / 256;
        const z = Math.round(Math.log2(kmPerTilePxAtZ0 * pxPerKm));
        return Math.max(MIN_Z, Math.min(MAX_Z, z));
    }

    // 三角形 (s0,s1,s2)（タイル画像のピクセル）を (d0,d1,d2)（画面）に貼る
    function drawTriangle(img, s0, s1, s2, d0, d1, d2) {
        // 継ぎ目が見えないよう、三角形を重心から少し広げて切り抜く
        const gx = (d0[0] + d1[0] + d2[0]) / 3, gy = (d0[1] + d1[1] + d2[1]) / 3;
        const grow = (p) => {
            const dx = p[0] - gx, dy = p[1] - gy, len = Math.hypot(dx, dy) || 1;
            const e = 0.8 / transform.k;
            return [p[0] + dx / len * e, p[1] + dy / len * e];
        };
        const [e0, e1, e2] = [grow(d0), grow(d1), grow(d2)];
        const den = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
        if (!den) return;
        const a = ((d1[0] - d0[0]) * (s2[1] - s0[1]) - (d2[0] - d0[0]) * (s1[1] - s0[1])) / den;
        const b = ((d1[1] - d0[1]) * (s2[1] - s0[1]) - (d2[1] - d0[1]) * (s1[1] - s0[1])) / den;
        const c = ((d2[0] - d0[0]) * (s1[0] - s0[0]) - (d1[0] - d0[0]) * (s2[0] - s0[0])) / den;
        const d = ((d2[1] - d0[1]) * (s1[0] - s0[0]) - (d1[1] - d0[1]) * (s2[0] - s0[0])) / den;
        const e = d0[0] - a * s0[0] - c * s0[1];
        const f = d0[1] - b * s0[0] - d * s0[1];
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(e0[0], e0[1]);
        ctx.lineTo(e1[0], e1[1]);
        ctx.lineTo(e2[0], e2[1]);
        ctx.closePath();
        ctx.clip();
        ctx.transform(a, b, c, d, e, f);
        ctx.drawImage(img, 0, 0);
        ctx.restore();
    }

    // --- 描画 -------------------------------------------------------------
    // 次のフレームで描く（タブが裏にあって requestAnimationFrame が止まっているときはタイマーで描く）
    function requestDraw() {
        if (frameRequested) return;
        frameRequested = true;
        const run = () => {
            if (!frameRequested) return;
            frameRequested = false;
            draw();
        };
        requestAnimationFrame(run);
        setTimeout(run, 100);
    }

    function draw() {
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!opacity || !warpTo) return;

        const now = performance.now();
        const a = animDur ? d3.easeCubicInOut(Math.min(1, (now - animStart) / animDur)) : 1;
        const w = warpTo;

        // 画面に見えている範囲（viewBox 座標）
        const vw = canvas.width / dpr, vh = canvas.height / dpr;
        const view = {
            x0: -transform.x / transform.k, y0: -transform.y / transform.k,
            x1: (vw - transform.x) / transform.k, y1: (vh - transform.y) / transform.k,
        };

        // 描くタイルの範囲: 見えている範囲を代表的な伸縮率で緯度経度に戻し、余裕を持たせて広げる。
        // ただし駅の範囲から MARGIN_KM より外は描かない
        const kmPerUnit = 1 / (w.scale * (w.typicalScale || 1));
        const vx0 = (view.x0 - w.cx) * kmPerUnit, vx1 = (view.x1 - w.cx) * kmPerUnit;
        const vy0 = (view.y0 - w.cy) * kmPerUnit, vy1 = (view.y1 - w.cy) * kmPerUnit;
        const padX = (vx1 - vx0) * 0.5, padY = (vy1 - vy0) * 0.5;
        const kmLat = 110.57, kmLng = 111.32 * Math.cos(w.lat0 * Math.PI / 180);
        const b = w.bounds;
        const lngMin = Math.max(w.lng0 + (vx0 - padX) / kmLng, b.minLng - MARGIN_KM / kmLng);
        const lngMax = Math.min(w.lng0 + (vx1 + padX) / kmLng, b.maxLng + MARGIN_KM / kmLng);
        const latMax = Math.min(w.lat0 - (vy0 - padY) / kmLat, b.maxLat + MARGIN_KM / kmLat);
        const latMin = Math.max(w.lat0 - (vy1 + padY) / kmLat, b.minLat - MARGIN_KM / kmLat);
        if (lngMin >= lngMax || latMin >= latMax) return;

        // タイルが多すぎるときは粗いズームレベルにする
        let z = chooseZoom(w), x0, x1, y0, y1;
        for (; ; z--) {
            x0 = Math.floor(lngTile(lngMin, z)); x1 = Math.floor(lngTile(lngMax, z));
            y0 = Math.floor(latTile(latMax, z)); y1 = Math.floor(latTile(latMin, z));
            if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_CANDIDATES || z <= MIN_Z) break;
        }

        ctx.setTransform(dpr * transform.k, 0, 0, dpr * transform.k, dpr * transform.x, dpr * transform.y);
        ctx.imageSmoothingEnabled = true;
        let count = 0;
        for (let tx = x0; tx <= x1; tx++) {
            for (let ty = y0; ty <= y1; ty++) {
                // まず四隅だけで、明らかに画面外のタイルを除く
                const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) =>
                    currentPoint(tileLat(ty + j, z), tileLng(tx + i, z), a));
                const cx0 = Math.min(...corners.map(p => p[0])), cx1 = Math.max(...corners.map(p => p[0]));
                const cy0 = Math.min(...corners.map(p => p[1])), cy1 = Math.max(...corners.map(p => p[1]));
                const px = (cx1 - cx0) * 0.5, py = (cy1 - cy0) * 0.5;
                if (cx1 + px < view.x0 || cx0 - px > view.x1 || cy1 + py < view.y0 || cy0 - py > view.y1) continue;
                // タイルの頂点を歪めた位置へ
                const grid = [];
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (let j = 0; j <= MESH; j++) {
                    const row = [];
                    const lat = tileLat(ty + j / MESH, z);
                    for (let i = 0; i <= MESH; i++) {
                        const p = currentPoint(lat, tileLng(tx + i / MESH, z), a);
                        row.push(p);
                        if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
                        if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
                    }
                    grid.push(row);
                }
                if (maxX < view.x0 || minX > view.x1 || maxY < view.y0 || minY > view.y1) continue;
                if (++count > MAX_TILES) break;
                const t = tile(z, tx, ty);
                if (!t.ok) continue;
                const step = 256 / MESH;
                for (let j = 0; j < MESH; j++) {
                    for (let i = 0; i < MESH; i++) {
                        const s00 = [i * step, j * step], s10 = [(i + 1) * step, j * step];
                        const s01 = [i * step, (j + 1) * step], s11 = [(i + 1) * step, (j + 1) * step];
                        drawTriangle(t.img, s00, s10, s11, grid[j][i], grid[j][i + 1], grid[j + 1][i + 1]);
                        drawTriangle(t.img, s00, s11, s01, grid[j][i], grid[j + 1][i + 1], grid[j + 1][i]);
                    }
                }
            }
        }
        if (a < 1) requestDraw();   // アニメーション中は毎フレーム描き直す
    }

    function resize() {
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        requestDraw();
    }

    return {
        init(container) {
            canvas = document.createElement('canvas');
            canvas.className = 'basemap';
            container.insertBefore(canvas, container.firstChild);
            ctx = canvas.getContext('2d');
            resize();
            window.addEventListener('resize', resize);
        },
        setWarp(w, duration = 0) {
            // アニメーション途中で次の変更が来たら、今見えている状態から始める（近似として直前の行き先を使う）
            warpFrom = duration && warpTo ? warpTo : null;
            warpTo = w;
            animStart = performance.now();
            animDur = duration;
            requestDraw();
        },
        setTransform(t) { transform = { k: t.k, x: t.x, y: t.y }; requestDraw(); },
        setOpacity(o) {
            opacity = o;
            if (canvas) canvas.style.opacity = o;   // 地図の下は白なので、薄くすると白に近づく
            requestDraw();
        },
        // 3D 表示（view3d.js）用
        TILE_URL, warpKm, tileLat, tileLng, lngTile, latTile,
    };
})();
