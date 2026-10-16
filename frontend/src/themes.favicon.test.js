import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import process from 'node:process';

function fixture() {
  const images = [], blobs = new Map(), links = [];
  let accent = '#d79921', nextUrl = 0;
  const badgeInSvg = svg => svg.match(/<text\b[^>]*>([^<]*)<\/text>/)?.[1] || '';
  class Canvas {
    badge = '';
    getContext() { return { drawImage: image => { this.badge = image instanceof Canvas ? image.badge : badgeInSvg(image.svg); },
      beginPath() {}, arc() {}, fill() {}, fillText: text => { this.badge = text; } }; }
    toDataURL() { return `data:image/png;synthetic,${this.badge}`; }
  }
  const document = { documentElement: {},
    createElement: tag => tag === 'canvas' ? new Canvas() : { rel: '', href: '', type: '', isConnected: false, remove() { this.isConnected = false; } },
    querySelector: () => links.find(l => l.isConnected) || null,
    querySelectorAll: () => links.filter(l => l.isConnected),
    head: { appendChild(link) { link.isConnected = true; links.push(link); } } };
  const context = vm.createContext({ document, encodeURIComponent,
    getComputedStyle: () => ({ getPropertyValue: () => accent }),
    Blob: class { constructor(parts) { this.svg = parts.join(''); } },
    URL: { createObjectURL(blob) { const url = `blob:synthetic-${++nextUrl}`; blobs.set(url, blob); return url; }, revokeObjectURL(url) { blobs.delete(url); } },
    Image: class { constructor() { images.push(this); } set src(url) { this.svg = blobs.get(url).svg; } },
  });
  const source = readFileSync(process.env.MAILFLOW_FAVICON_BASELINE || new URL('./themes.js', import.meta.url), 'utf8').replace(/^export /gm, '');
  vm.runInContext(source + '\nglobalThis.api = { updateFaviconBadge };', context);
  const badge = () => {
    const href = links.find(l => l.isConnected)?.href || '';
    return href.startsWith('data:image/svg+xml') ? badgeInSvg(decodeURIComponent(href.slice(href.indexOf(',') + 1))) : href.split(',')[1] || '';
  };
  return { images, badge, update: context.api.updateFaviconBadge, links, accent: value => { accent = value; } };
}

test('a requested zero immediately clears the badge even if PNG decoding fails', () => {
  const f = fixture();
  f.update(1); f.images[0].onload(); assert.equal(f.badge(), '1');
  f.update(0);
  assert.equal(f.badge(), '', 'clearing does not wait for Image.onload');
  f.images[2].onerror();
  assert.equal(f.badge(), '');
});
test('a delayed old positive render cannot repaint after zero is requested', () => {
  const f = fixture();
  f.update(1); f.update(0);
  f.images[0].onload();
  assert.equal(f.badge(), '', 'latest requested count wins before its rasterization completes');
  f.images[2].onerror();
  assert.equal(f.badge(), '', 'a failed zero PNG cannot leave the old badge behind');
});
test('positive renders also follow request order rather than completion order', () => {
  const f = fixture(); f.update(1); f.update(2);
  f.images[0].onload(); assert.notEqual(f.badge(), '1');
  f.images[2].onload(); assert.equal(f.badge(), '2');
  f.images[0].onload(); assert.equal(f.badge(), '2');
});
test('the warm-base fast path still composites and clears synchronously on one link', () => {
  const f = fixture(); f.update(0);
  f.images[0].onload(); assert.equal(f.links[0].type, 'image/png');
  const count = f.images.length, link = f.links[0];
  f.update(1); assert.equal(f.badge(), '1'); f.update(0); assert.equal(f.badge(), '');
  assert.equal(f.images.length, count); assert.equal(f.links.filter(l => l.isConnected).length, 1); assert.equal(f.links[0], link);
});

test('a late base warmer from an older accent cannot poison the current synchronous cache', () => {
  const f = fixture(); f.update(1);
  f.accent('#336699'); f.update(2);
  f.images[3].onload(); // current accent's unbadged base
  f.images[1].onload(); // older accent finishes afterwards
  const requests = f.images.length;
  f.update(3);
  assert.equal(f.images.length, requests, 'current accent base remains usable synchronously');
  assert.equal(f.badge(), '3');
  f.images[2].onload(); assert.equal(f.badge(), '3');
});
