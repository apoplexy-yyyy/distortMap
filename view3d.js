// =====================================================================
// 3D 表示（three.js）
//
//   水平面（x: 東, y: 北）… 選んだモード（実地図・時間地図・運賃地図）の配置
//   高さ（z）            … 常に中心駅からの実際の距離（km）
//   背景地図も同じ規則で立体にする（実地図モードでは中心駅を頂点とする円すいになる）
//   ドラッグで回転、右ドラッグで移動、ホイールで拡大縮小
//
//   View3D.init(container, { onHover(event, station|null), onSelect(station) })
//   View3D.update({ stations, edges, centerId, lineColor, warp, rings, duration, labelOrder, landmarks })
//   View3D.setVisible(bool) / View3D.setMapOpacity(0〜1)
// =====================================================================

const View3D = (() => {
    const MAP_ZOOM = 12;          // 背景地図のタイルのズームレベル
    const MAP_SEGMENTS = 12;      // タイル 1 枚の分割数
    const MAP_MARGIN_KM = 12;     // 駅の範囲から外側に描く幅
    const NODE_SIZE = 0.006;      // 駅の球の大きさ（カメラからの距離に対する比。画面上でほぼ一定）
    const LABEL_FONT_PX = 12;

    let container, renderer, scene, camera, controls, labelLayer;
    let callbacks = {};
    let visible = false, mapOpacity = 1;
    let nodes = [];               // { d, mesh, label, from: Vector3, to: Vector3 }
    let lmNodes = [];             // ランドマーク（四角錐）{ d, mesh, label, from, to }
    let links = null, linkData = [];
    let ringGroup, axisGroup, mapGroup;
    let mapTiles = [];            // { mesh, from: Float32Array, to: Float32Array, lat: [], lng: [] }
    let overlayLabels = [];       // 同心円・高さの目盛りの文字 { el, pos }
    let centerId = null;
    let anim = { start: 0, dur: 0 };
    let frameRequested = false;
    let cameraPlaced = false;
    const raycaster = new THREE.Raycaster();
    const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);   // d3.easeCubicInOut と同じ

    // --- 初期化 -----------------------------------------------------------
    function init(el, cb) {
        container = el;
        callbacks = cb || {};
        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.setClearColor(0xffffff);
        container.appendChild(renderer.domElement);

        labelLayer = document.createElement('div');
        labelLayer.className = 'labels3d';
        container.appendChild(labelLayer);
        // 駅名の上でもホイールで拡大縮小できるよう、ホイール操作は 3D の画面に渡す
        labelLayer.addEventListener('wheel', e => {
            e.preventDefault();
            renderer.domElement.dispatchEvent(new WheelEvent('wheel', e));
        }, { passive: false });

        scene = new THREE.Scene();
        scene.add(new THREE.AmbientLight(0xffffff, 0.75));
        const sun = new THREE.DirectionalLight(0xffffff, 0.5);
        sun.position.set(-1, -2, 3);
        scene.add(sun);

        camera = new THREE.PerspectiveCamera(40, 1, 0.005, 5000);   // 近くまで寄っても切れないよう、手前の描画範囲は 5m から
        camera.up.set(0, 0, 1);   // z 軸が上
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.maxPolarAngle = Math.PI / 2;   // 真横まで。下から見上げる向きには回らない
        controls.minDistance = 0.2;             // 注視点まで 200m まで寄れる
        controls.zoomSpeed = 1.5;
        controls.addEventListener('change', requestRender);

        mapGroup = new THREE.Group();
        ringGroup = new THREE.Group();
        axisGroup = new THREE.Group();
        scene.add(mapGroup, ringGroup, axisGroup);

        // クリック（ドラッグでないとき）で中心駅に、カーソルを乗せるとツールチップ
        let down = null;
        renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
        renderer.domElement.addEventListener('pointerup', e => {
            if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
                const hit = pick(e);
                if (hit && callbacks.onSelect) callbacks.onSelect(hit.d);
            }
            down = null;
        });
        renderer.domElement.addEventListener('pointermove', e => {
            if (e.buttons) return;
            const hit = pick(e);
            if (callbacks.onHover) callbacks.onHover(e, hit ? hit.d : null);
            renderer.domElement.style.cursor = hit ? 'pointer' : '';
        });
        renderer.domElement.addEventListener('pointerleave', e => callbacks.onHover && callbacks.onHover(e, null));

        window.addEventListener('resize', resize);
        resize();
    }

    function pick(e) {
        const rect = renderer.domElement.getBoundingClientRect();
        const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(p, camera);
        const all = [...nodes, ...lmNodes];
        const hits = raycaster.intersectObjects(all.map(n => n.mesh));
        return hits.length ? all.find(n => n.mesh === hits[0].object) : null;
    }

    function resize() {
        if (!renderer) return;
        const w = container.clientWidth || 900, h = container.clientHeight || 600;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        if (links) links.material.resolution.set(w, h);
        requestRender();
    }

    // --- 位置 -------------------------------------------------------------
    // 高さ: 実際の距離（km）。中心駅より北はプラス、南はマイナス（y は南向きが正）
    const signedHeight = (ySouth, r) => (ySouth <= 0 ? r : -r);
    // 駅の 3D 位置: 水平はモードの配置（km）、高さは北が正・南が負の実際の距離
    const stationPos = s => new THREE.Vector3(s.px, -s.py, signedHeight(s.geo.y, s.geo.r));

    function update({ stations, edges, centerId: cid, lineColor, warp, rings, duration = 0, labelOrder, landmarks = [] }) {
        centerId = cid;
        const now = performance.now();
        const a = currentT(now);
        // 今見えている位置からアニメーションを始める
        const prev = new Map(nodes.map(n => [n.d.id, n.from.clone().lerp(n.to, a)]));
        rebuildNodes(stations, lineColor, labelOrder);
        nodes.forEach(n => {
            n.to = stationPos(n.d);
            n.from = duration && prev.has(n.d.id) ? prev.get(n.d.id) : n.to.clone();
        });
        rebuildLinks(edges, lineColor);
        rebuildLandmarks(landmarks, duration, a);
        rebuildRings(rings, d3.max(nodes, n => n.to.z) || 0, d3.min(nodes, n => n.to.z) || 0);
        updateMap(warp, duration ? a : 1, duration);
        anim = { start: now, dur: duration };
        if (!cameraPlaced) placeCamera(stations);
        requestRender();
    }

    function currentT(now = performance.now()) {
        return anim.dur ? ease(Math.min(1, (now - anim.start) / anim.dur)) : 1;
    }

    function placeCamera(stations) {
        const ext = d3.max(stations, s => Math.max(Math.abs(s.geo.x), Math.abs(s.geo.y))) || 30;
        const zMax = d3.max(stations, s => s.geo.r) || 30;
        controls.target.set(0, 0, 0);
        camera.position.set(ext * 1.8, -ext * 2.6, zMax * 1.2);
        controls.update();
        cameraPlaced = true;
    }

    // --- 駅 ---------------------------------------------------------------
    function rebuildNodes(stations, lineColor, labelOrder) {
        const same = nodes.length === stations.length && stations.every(s => nodes.some(n => n.d === s));
        if (!same) {
            nodes.forEach(n => { scene.remove(n.mesh); n.label.remove(); });
            const geo = new THREE.SphereGeometry(1, 16, 12);
            nodes = stations.map(d => {
                const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial());
                scene.add(mesh);
                const label = document.createElement('div');
                label.className = 'label3d';
                label.classList.toggle('transfer', !!d.transfer);
                label.textContent = d.name;
                label.addEventListener('click', () => callbacks.onSelect && callbacks.onSelect(d));
                label.addEventListener('mousemove', e => callbacks.onHover && callbacks.onHover(e, d));
                label.addEventListener('mouseleave', e => callbacks.onHover && callbacks.onHover(e, null));
                labelLayer.appendChild(label);
                return { d, mesh, label, from: new THREE.Vector3(), to: new THREE.Vector3() };
            });
        }
        nodes.forEach(n => {
            n.mesh.material.color.set(n.d.missing ? '#bbbbbb' : lineColor(n.d.colorLine || n.d.lines[0]));
            n.center = n.d.id === centerId;
            n.label.classList.toggle('center', n.center);
        });
        // ラベルを置く優先順（中心駅 → 乗換駅 → その他）
        const order = labelOrder || (() => 0);
        nodes.sort((a, b) => order(a.d, b.d));
    }

    // --- ランドマーク --------------------------------------------------------
    // 位置は背景地図と同じ歪め方（app.js が km 座標 d.km = [東, 南, 実際の距離] を入れておく）、高さは駅と同じ決め方
    function rebuildLandmarks(landmarks, duration, a) {
        const prev = new Map(lmNodes.map(n => [n.d.key, n.from.clone().lerp(n.to, a)]));
        lmNodes.forEach(n => { scene.remove(n.mesh); n.mesh.geometry.dispose(); n.label.remove(); });
        // ピンのように、先を下（地点）に向けた四角錐
        const geo = new THREE.ConeGeometry(1, 2.4, 4);
        geo.rotateX(-Math.PI / 2);
        geo.translate(0, 0, 1.2);
        lmNodes = landmarks.filter(d => d.km).map(d => {
            const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: d.color }));
            scene.add(mesh);
            const label = document.createElement('div');
            label.className = 'label3d landmark3d';
            label.textContent = d.name;
            label.addEventListener('click', () => callbacks.onSelect && callbacks.onSelect(d));
            label.addEventListener('mousemove', e => callbacks.onHover && callbacks.onHover(e, d));
            label.addEventListener('mouseleave', e => callbacks.onHover && callbacks.onHover(e, null));
            labelLayer.appendChild(label);
            const to = new THREE.Vector3(d.km[0], -d.km[1], signedHeight(d.km[1], d.km[2]));
            return { d, mesh, label, to, from: duration && prev.has(d.key) ? prev.get(d.key) : to.clone() };
        });
    }

    // --- 線路 -------------------------------------------------------------
    function rebuildLinks(edges, lineColor) {
        const byId = new Map(nodes.map(n => [n.d.id, n]));
        linkData = edges.map(e => ({ a: byId.get(e.source), b: byId.get(e.target), line: e.line })).filter(l => l.a && l.b);
        const colors = [];
        linkData.forEach(l => {
            const c = new THREE.Color(l.a.d.missing || l.b.d.missing ? '#bbbbbb' : lineColor(l.line));
            colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
        });
        if (links) { scene.remove(links); links.geometry.dispose(); }
        const geometry = new THREE.LineSegmentsGeometry();
        geometry.setPositions(new Array(linkData.length * 6).fill(0));
        geometry.setColors(colors);
        const material = new THREE.LineMaterial({ linewidth: 3, vertexColors: true });
        material.resolution.set(container.clientWidth, container.clientHeight);
        links = new THREE.LineSegments2(geometry, material);
        scene.add(links);
    }

    // --- 同心円（水平面 = モードの値）と高さの目盛り（実際の距離） ------------------
    function rebuildRings(rings, zMax, zMin) {
        overlayLabels.forEach(o => o.el.remove());
        overlayLabels = [];
        [ringGroup, axisGroup].forEach(g => { while (g.children.length) g.remove(g.children[0]); });
        const lineMat = new THREE.LineBasicMaterial({ color: 0x777777, transparent: true, opacity: 0.6, depthTest: false });
        (rings || []).forEach(r => {
            const pts = d3.range(0, 129).map(i => {
                const t = i / 128 * Math.PI * 2;
                return new THREE.Vector3(Math.cos(t) * r.r, Math.sin(t) * r.r, 0);
            });
            ringGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
            addOverlayLabel(r.label, new THREE.Vector3(0, r.r, 0), 'ring3d');
        });
        // 中心駅を通る上下の「実際の距離」の軸（上が北、下が南）
        const top = Math.max(10, Math.ceil(zMax / 10) * 10), bottom = Math.min(-10, Math.floor(zMin / 10) * 10);
        const axisMat = new THREE.LineBasicMaterial({ color: 0x333333, depthTest: false });
        axisGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
            [new THREE.Vector3(0, 0, bottom), new THREE.Vector3(0, 0, top)]), axisMat));
        for (let z = bottom; z <= top; z += 10) {
            if (!z) continue;
            axisGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
                [new THREE.Vector3(-0.8, 0, z), new THREE.Vector3(0.8, 0, z)]), axisMat));
            addOverlayLabel(`${z > 0 ? '北' : '南'}${Math.abs(z)}km`, new THREE.Vector3(0, 0, z), 'axis3d');
        }
        addOverlayLabel('高さ = 実際の距離（北 +）', new THREE.Vector3(0, 0, top + 3), 'axis3d axis-title');
        addOverlayLabel('（南 −）', new THREE.Vector3(0, 0, bottom - 3), 'axis3d axis-title');
        ringGroup.renderOrder = axisGroup.renderOrder = 10;
    }

    function addOverlayLabel(text, pos, cls) {
        const el = document.createElement('div');
        el.className = cls;
        el.textContent = text;
        labelLayer.appendChild(el);
        overlayLabels.push({ el, pos });
    }

    // --- 背景地図（立体） ---------------------------------------------------
    // 駅の範囲を覆うタイルを並べ、各頂点を「歪めた水平位置 + 実際の距離の高さ」に置く
    function updateMap(warp, a, duration) {
        if (!warp) return;
        if (!mapTiles.length) buildMapTiles(warp);
        mapTiles.forEach(t => {
            const cur = t.from.map((v, i) => v + (t.to[i] - v) * a);
            t.from = Float32Array.from(cur);
            const fromNorth = t.north;
            t.north = [];
            let k = 0;
            for (let j = 0; j <= MAP_SEGMENTS; j++) {
                for (let i = 0; i <= MAP_SEGMENTS; i++) {
                    const [x, y, r] = BaseMap.warpKm(warp, t.lat[j], t.lng[i]);
                    t.to[k++] = x; t.to[k++] = -y; t.to[k++] = signedHeight(y, r);
                    t.north.push(y <= 0);
                }
            }
            if (!duration) t.from = Float32Array.from(t.to);
            // 中心駅の東西の線をまたぐ三角形は、北（上）と南（下）で高さが飛ぶので描かない
            //（アニメーション中は前後どちらでもまたがない三角形だけ。終わったら render で finalIndex に戻す）
            const same = (p, q, s, north) => north[p] === north[q] && north[q] === north[s];
            const finalIndex = [], animIndex = [];
            for (let i = 0; i < t.baseIndex.length; i += 3) {
                const [p, q, s] = [t.baseIndex[i], t.baseIndex[i + 1], t.baseIndex[i + 2]];
                if (!same(p, q, s, t.north)) continue;
                finalIndex.push(p, q, s);
                if (!fromNorth || same(p, q, s, fromNorth)) animIndex.push(p, q, s);
            }
            t.finalIndex = finalIndex;
            t.mesh.geometry.setIndex(duration ? animIndex : finalIndex);
        });
        mapGroup.visible = mapOpacity > 0;
    }

    function buildMapTiles(warp) {
        const b = warp.bounds, z = MAP_ZOOM;
        const dLat = MAP_MARGIN_KM / 110.57, dLng = MAP_MARGIN_KM / (111.32 * Math.cos(warp.lat0 * Math.PI / 180));
        const x0 = Math.floor(BaseMap.lngTile(b.minLng - dLng, z)), x1 = Math.floor(BaseMap.lngTile(b.maxLng + dLng, z));
        const y0 = Math.floor(BaseMap.latTile(b.maxLat + dLat, z)), y1 = Math.floor(BaseMap.latTile(b.minLat - dLat, z));
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        const n = (MAP_SEGMENTS + 1) ** 2;
        const index = [];
        for (let j = 0; j < MAP_SEGMENTS; j++) {
            for (let i = 0; i < MAP_SEGMENTS; i++) {
                const p = j * (MAP_SEGMENTS + 1) + i, q = p + MAP_SEGMENTS + 1;
                index.push(p, q, p + 1, p + 1, q, q + 1);
            }
        }
        const uv = [];
        for (let j = 0; j <= MAP_SEGMENTS; j++) for (let i = 0; i <= MAP_SEGMENTS; i++) uv.push(i / MAP_SEGMENTS, 1 - j / MAP_SEGMENTS);
        for (let tx = x0; tx <= x1; tx++) {
            for (let ty = y0; ty <= y1; ty++) {
                const geometry = new THREE.BufferGeometry();
                geometry.setIndex(index);
                geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
                geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
                const material = new THREE.MeshBasicMaterial({
                    color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: mapOpacity,
                    polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,   // 駅・線路を地図より手前に
                });
                const url = BaseMap.TILE_URL.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
                loader.load(url, tex => { tex.encoding = THREE.sRGBEncoding; material.map = tex; material.needsUpdate = true; requestRender(); });
                const mesh = new THREE.Mesh(geometry, material);
                mapGroup.add(mesh);
                mapTiles.push({
                    mesh, from: new Float32Array(n * 3), to: new Float32Array(n * 3), baseIndex: index,
                    lat: d3.range(MAP_SEGMENTS + 1).map(j => BaseMap.tileLat(ty + j / MAP_SEGMENTS, z)),
                    lng: d3.range(MAP_SEGMENTS + 1).map(i => BaseMap.tileLng(tx + i / MAP_SEGMENTS, z)),
                });
            }
        }
    }

    // --- 描画 -------------------------------------------------------------
    function requestRender() {
        if (frameRequested || !visible) return;
        frameRequested = true;
        const run = () => {
            if (!frameRequested) return;
            frameRequested = false;
            render();
        };
        requestAnimationFrame(run);
        setTimeout(run, 100);   // タブが裏にあって requestAnimationFrame が止まっているとき用
    }

    function render() {
        const a = currentT();
        // 駅
        nodes.forEach(n => {
            n.cur = n.from.clone().lerp(n.to, a);
            n.mesh.position.copy(n.cur);
            const s = camera.position.distanceTo(n.cur) * NODE_SIZE * (n.center ? 1.7 : 1);
            n.mesh.scale.setScalar(s);
        });
        // ランドマーク
        lmNodes.forEach(n => {
            n.cur = n.from.clone().lerp(n.to, a);
            n.mesh.position.copy(n.cur);
            n.mesh.scale.setScalar(camera.position.distanceTo(n.cur) * NODE_SIZE * 3.2);   // 駅の球より大きく目立たせる
        });
        // 線路
        if (links) {
            const pos = [];
            linkData.forEach(l => pos.push(l.a.cur.x, l.a.cur.y, l.a.cur.z, l.b.cur.x, l.b.cur.y, l.b.cur.z));
            links.geometry.setPositions(pos);
        }
        // 地図
        mapTiles.forEach(t => {
            const attr = t.mesh.geometry.attributes.position;
            for (let i = 0; i < attr.array.length; i++) attr.array[i] = t.from[i] + (t.to[i] - t.from[i]) * a;
            attr.needsUpdate = true;
            t.mesh.geometry.computeBoundingSphere();
        });
        mapGroup.visible = mapOpacity > 0;
        renderer.render(scene, camera);
        placeLabels();
        if (a < 1) requestRender();
        else {
            nodes.forEach(n => n.from.copy(n.to));
            lmNodes.forEach(n => n.from.copy(n.to));
            mapTiles.forEach(t => {
                if (t.finalIndex) { t.mesh.geometry.setIndex(t.finalIndex); t.finalIndex = null; }
            });
        }
    }

    // 画面上の位置に駅名を置く。重なる駅名は隠す（優先度の高い駅から置く）
    function placeLabels() {
        const w = container.clientWidth, h = container.clientHeight;
        const toScreen = v => {
            const p = v.clone().project(camera);
            return { x: (p.x + 1) / 2 * w, y: (1 - p.y) / 2 * h, behind: p.z > 1 };
        };
        const placed = [];
        const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
        [...nodes, ...lmNodes].forEach(n => {
            const p = toScreen(n.cur);
            const lw = n.label.offsetWidth || n.d.name.length * LABEL_FONT_PX, lh = LABEL_FONT_PX * 1.4;
            const r = 6;
            const cands = [[p.x + r, p.y - lh / 2], [p.x - r - lw, p.y - lh / 2], [p.x - lw / 2, p.y - r - lh], [p.x - lw / 2, p.y + r]];
            let ok = null;
            if (!p.behind && p.x > -50 && p.x < w + 50 && p.y > -20 && p.y < h + 20) {
                for (const [x, y] of cands) {
                    const box = { x0: x, x1: x + lw, y0: y, y1: y + lh };
                    if (!placed.some(b => overlaps(box, b))) { ok = box; break; }
                }
            }
            if (ok) {
                placed.push(ok);
                n.label.style.display = '';
                n.label.style.transform = `translate(${ok.x0}px, ${ok.y0}px)`;
            } else {
                n.label.style.display = 'none';
            }
        });
        overlayLabels.forEach(o => {
            const p = toScreen(o.pos);
            o.el.style.display = p.behind ? 'none' : '';
            o.el.style.transform = `translate(${p.x + 4}px, ${p.y - 8}px)`;
        });
    }

    return {
        init,
        update,
        setVisible(v) {
            visible = v;
            container.style.display = v ? '' : 'none';
            if (v) { resize(); requestRender(); }
        },
        setMapOpacity(o) {
            mapOpacity = o;
            mapTiles.forEach(t => { t.mesh.material.opacity = o; });
            requestRender();
        },
    };
})();
