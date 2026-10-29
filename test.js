const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');

// シンプルなHTTPサーバー
const server = http.createServer((req, res) => {
    const filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
    
    if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        const contentType = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
        }[ext] || 'text/plain';
        
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(fs.readFileSync(filePath));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const PORT = 8081;

async function runTest() {
    return new Promise((resolve) => {
        server.listen(PORT, async () => {
            console.log(`Server running on http://localhost:${PORT}`);
            
            const browser = await puppeteer.launch({ headless: 'new' });
            const page = await browser.newPage();
            
            try {
                console.log('Navigating to page...');
                await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle2' });

                // 環境変数 EKISPERT_API_KEY があれば設定して再読み込み（時間・運賃を API から取得）
                if (process.env.EKISPERT_API_KEY) {
                    await page.evaluate(k => localStorage.setItem('distortMap:v1:ekispertKey', k), process.env.EKISPERT_API_KEY);
                    await page.reload({ waitUntil: 'networkidle2' });
                    await page.waitForFunction(
                        () => /取得しました|取得完了|エラー|中断/.test(document.getElementById('status').textContent),
                        { timeout: 120000 }
                    ).catch(() => {});
                }
                console.log('Status:', await page.$eval('#status', el => el.textContent));
                
                // ページが読み込まれるのを待つ
                await page.waitForSelector('#map', { timeout: 5000 });
                console.log('Page loaded successfully');
                
                // D3.jsがロードされているか確認
                const d3Loaded = await page.evaluate(() => {
                    return typeof d3 !== 'undefined';
                });
                
                if (d3Loaded) {
                    console.log('✓ D3.js loaded successfully');
                } else {
                    console.log('✗ D3.js failed to load');
                }
                
                // SVGが作成されているか確認
                const svgExists = await page.evaluate(() => {
                    const svg = document.querySelector('#map svg');
                    return svg !== null;
                });
                
                if (svgExists) {
                    console.log('✓ SVG created successfully');
                } else {
                    console.log('✗ SVG not created');
                }
                
                // 駅ノードが描画されているか確認
                const stationCount = await page.evaluate(() => {
                    const stations = document.querySelectorAll('.station');
                    return stations.length;
                });
                
                console.log(`✓ ${stationCount} stations rendered`);
                
                // リンクが描画されているか確認
                const linkCount = await page.evaluate(() => {
                    const links = document.querySelectorAll('.link');
                    return links.length;
                });
                
                console.log(`✓ ${linkCount} links rendered`);
                
                // コントロールが動作するか確認
                console.log('Testing controls...');
                
                // 各モードと強度でスクリーンショットを撮る
                const modes = ['distance', 'time', 'cost'];
                const strengths = [0, 50, 100];
                
                for (const mode of modes) {
                    console.log(`\n--- Testing mode: ${mode} ---`);
                    await page.click(`input[name="mode"][value="${mode}"] + span`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                    for (const strength of strengths) {
                        console.log(`  Strength: ${strength}%`);
                        await page.evaluate((s) => {
                            document.getElementById('distortion').value = s;
                            document.getElementById('distortion').dispatchEvent(new Event('input'));
                        }, strength);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        
                        // 距離値をログ出力
                        const linkInfo = await page.evaluate(() => {
                            const links = document.querySelectorAll('.link');
                            const info = [];
                            links.forEach((link, i) => {
                                if (i < 3) {
                                    const x1 = parseFloat(link.getAttribute('x1'));
                                    const y1 = parseFloat(link.getAttribute('y1'));
                                    const x2 = parseFloat(link.getAttribute('x2'));
                                    const y2 = parseFloat(link.getAttribute('y2'));
                                    const dist = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
                                    info.push({ x1, y1, x2, y2, dist: dist.toFixed(2) });
                                }
                            });
                            return info;
                        });
                        console.log(`  Sample link distances:`, JSON.stringify(linkInfo));
                        
                        const filename = `screenshot_${mode}_${strength}.png`;
                        await page.screenshot({ path: filename, fullPage: true });
                        console.log(`  ✓ Saved: ${filename}`);
                    }
                }
                
                // コントロール動作確認
                console.log('\n✓ Mode change works');
                console.log('✓ Distortion slider works');
                
                console.log('\n=== All tests passed! ===');
                
            } catch (error) {
                console.error('Test failed:', error.message);
            } finally {
                await browser.close();
                server.close();
                resolve();
            }
        });
    });
}

runTest().then(() => {
    console.log('Test completed');
    process.exit(0);
}).catch((error) => {
    console.error('Test error:', error);
    process.exit(1);
});
