import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

const usage = `Usage: node export-png.mjs INPUT.drawio OUTPUT.png
  --viewer PATH       Local draw.io viewer-static.min.js
  --deps-dir PATH     Directory containing node_modules/puppeteer-core
  --browser PATH      Chrome or Edge executable
  --page-index N      Zero-based page index (default 0)
  --overwrite         Replace an existing PNG`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      viewer: { type: 'string' },
      'deps-dir': { type: 'string' },
      browser: { type: 'string' },
      'page-index': { type: 'string', default: '0' },
      overwrite: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const [input, output] = positionals;
  if (positionals.length !== 2 || !/\.drawio$/i.test(input) || !/\.png$/i.test(output) ||
      !values.viewer || !values['deps-dir'] || !values.browser || !/^\d+$/.test(values['page-index'])) {
    throw new Error(usage);
  }

  const xml = await fs.readFile(input, 'utf8');
  const requireFromDeps = createRequire(path.resolve(values['deps-dir'], 'package.json'));
  const puppeteer = requireFromDeps('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: path.resolve(values.browser),
    headless: true,
    args: ['--disable-background-networking'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (/^(data:|blob:|about:)/.test(request.url())) void request.continue();
      else void request.abort();
    });
    await page.setContent(`<!doctype html><meta charset="utf-8">
      <style>html { color-scheme: only light } body { margin: 0; background: #f8fafc }
      .mxgraph { width: 1600px; height: 1000px; overflow: visible }</style>
      <div class="mxgraph"></div>`);
    await page.evaluate(({ xml, pageIndex }) => {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'mxfile') {
        throw new Error('Expected a valid draw.io mxfile');
      }
      const pages = [...doc.documentElement.children].filter(el => el.localName === 'diagram');
      const selected = pages[pageIndex];
      if (!selected) throw new Error(`Page ${pageIndex} does not exist (${pages.length} pages)`);
      for (const diagram of pages) {
        if (diagram !== selected) diagram.remove();
      }
      const config = {
        xml: new XMLSerializer().serializeToString(doc.documentElement),
        nav: false, toolbar: '', resize: false, lightbox: false, edit: false,
      };
      document.querySelector('.mxgraph').setAttribute('data-mxgraph', JSON.stringify(config));
    }, { xml, pageIndex: Number(values['page-index']) });
    await page.addScriptTag({ path: path.resolve(values.viewer) });
    await page.waitForSelector('.mxgraph svg', { timeout: 15000 });

    const { markup, width, height } = await page.$eval('.mxgraph svg', async svg => {
      await document.fonts.ready;
      const bounds = svg.getBBox();
      if (bounds.width <= 0 || bounds.height <= 0) throw new Error('The page has no rendered content');
      const margin = 12;
      const width = Math.ceil(bounds.width + 2 * margin);
      const height = Math.ceil(bounds.height + 2 * margin);
      const copy = svg.cloneNode(true);
      copy.setAttribute('width', String(width));
      copy.setAttribute('height', String(height));
      copy.setAttribute('viewBox', `${bounds.x - margin} ${bounds.y - margin} ${width} ${height}`);
      copy.removeAttribute('style');
      return { markup: new XMLSerializer().serializeToString(copy), width, height };
    });
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      html { color-scheme: only light } body { margin: 0; background: #f8fafc }
      svg { display: block }</style>${markup}`);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const png = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width, height },
      captureBeyondViewport: true,
    });
    await fs.writeFile(output, png, { flag: values.overwrite ? 'w' : 'wx' });
    console.log(`${output} (${width * 2} × ${height * 2})`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
