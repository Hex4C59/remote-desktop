import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { viewer:{type:'string'}, 'deps-dir':{type:'string'}, browser:{type:'string'},
             'page-index':{type:'string',default:'0'}, overwrite:{type:'boolean'} },
});
const [input, output] = positionals;

// 与官方 export-png.mjs 的区别：按画布范围导出，而不是按内容 getBBox 裁切。
// draw.io 的查看器会在 SVG 内保留离屏层，getBBox 的并集因此可能算出
// 上万个单位的虚假包围盒（本项目实测 21497×20712），导致 Page.captureScreenshot
// 直接失败，或按错误原点裁掉左侧文字。画布范围由 mxGraphModel 的
// pageWidth/pageHeight 显式给出，稳定可控。
if (positionals.length !== 2 || !values.viewer || !values['deps-dir'] || !values.browser) {
  console.error('usage: node export-png-local.mjs IN.drawio OUT.png --viewer PATH --deps-dir PATH --browser PATH [--overwrite]');
  process.exit(2);
}
const xml = await fs.readFile(input, 'utf8');
const requireFrom = createRequire(path.resolve(values['deps-dir'], 'package.json'));
const puppeteer = requireFrom('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: path.resolve(values.browser), headless: true,
  args: ['--disable-background-networking','--no-sandbox','--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1800, height: 1400, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name:'prefers-color-scheme', value:'light' }]);
  await page.setRequestInterception(true);
  page.on('request', r => /^(data:|blob:|about:)/.test(r.url()) ? r.continue() : r.abort());
  await page.setContent(`<!doctype html><meta charset="utf-8">
    <style>html{color-scheme:only light}body{margin:0;background:#f8fafc}
    .mxgraph{width:1800px;height:1400px;overflow:visible}</style>
    <div class="mxgraph"></div>`);
  await page.evaluate(({ xml, pageIndex }) => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('invalid mxfile');
    const pages = [...doc.documentElement.children].filter(el => el.localName === 'diagram');
    const sel = pages[pageIndex];
    if (!sel) throw new Error('page missing');
    for (const d of pages) if (d !== sel) d.remove();
    document.querySelector('.mxgraph').setAttribute('data-mxgraph', JSON.stringify({
      xml: new XMLSerializer().serializeToString(doc.documentElement),
      nav:false, toolbar:'', resize:false, lightbox:false, edit:false }));
  }, { xml, pageIndex: Number(values['page-index']) });
  await page.addScriptTag({ path: path.resolve(values.viewer) });
  await page.waitForSelector('.mxgraph svg', { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready.then(()=>undefined));
  await new Promise(r => setTimeout(r, 800));

  // 直接用画布范围导出，不做内容裁切：内容 bbox 在 draw.io 中存在离屏干扰，
  // 而页面范围由 mxGraphModel 的 pageWidth/pageHeight 显式给出，稳定可控。
  const canvas = await page.evaluate(() => {
    const mx = document.querySelector('.mxgraph');
    const svg = mx.querySelector('svg');
    const r = svg.getBoundingClientRect();
    return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
  });
  const W = canvas.w, H = canvas.h;
  const { markup } = await page.evaluate(({ W, H }) => {
    const svg = document.querySelector('.mxgraph svg');
    const copy = svg.cloneNode(true);
    copy.setAttribute('width', String(W));
    copy.setAttribute('height', String(H));
    if (!copy.getAttribute('viewBox')) {
      copy.setAttribute('viewBox', `0 0 ${W} ${H}`);
    }
    copy.removeAttribute('style');
    return { markup: new XMLSerializer().serializeToString(copy) };
  }, { W, H });

  const shot = await browser.newPage();
  await shot.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
  await shot.setContent(`<!doctype html><meta charset="utf-8"><style>
    html{color-scheme:only light}body{margin:0;background:#f8fafc}
    svg{display:block}</style>${markup}`);
  await shot.evaluate(() => document.fonts.ready.then(()=>undefined));
  const png = await shot.screenshot({ type:'png', clip:{x:0,y:0,width:W,height:H}, captureBeyondViewport:true });
  await fs.writeFile(output, png, { flag: values.overwrite ? 'w' : 'wx' });
  console.log(`${output} (${W*2} x ${H*2})`);
} finally { await browser.close(); }
