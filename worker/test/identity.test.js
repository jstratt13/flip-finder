import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identity, judgeResult } from '../src/identity.js';

// Cases from the Sept 2026 eBay samples (research/ebay-sample-*). The judge was
// measured there: 97% accurate on held-out results for titles with a model code
// or generation, 68% for brand-only titles (research/03-holdout-score.mjs).

test('queries keep identity and drop sale and condition chatter', () => {
  assert.equal(identity('Monster vintage Onkyo TX-SV515Pro 80W Receiver').query, 'onkyo tx-sv515pro receiver');
  assert.equal(identity('Apple iPhone 13 - 128GB - Midnight').query, 'apple iphone 13 128gb');
  assert.equal(identity('2 Sony PMW-EX1R XDCAM HD Camcorders + Batteries, Chargers & Adapters').query, 'sony pmw-ex1r');
  assert.equal(identity('Brand NEW Fire TV Box').query.startsWith('fire tv'), true);
});

test('counts and sizes are not generations', () => {
  assert.deepEqual(identity('ACE 8 Outlet Surge Suppressor Strip').generations, []);
  assert.deepEqual(identity('Lenovo - IdeaPad Slim 3 Chromebook - 14" FHD').generations, ['slim 3']);
  assert.deepEqual(identity('Litter Robot 3').generations, ['robot 3']);
});

test('sibling models are not the product', () => {
  const id = identity('Polk Audio R10 - Bookshelf Speaker');
  assert.equal(judgeResult('Polk Audio R10 Bookshelf Speakers Pair Black', id).relevant, true);
  assert.equal(judgeResult('Polk Audio R15 Bookshelf Speaker Pair', id).relevant, false);
  assert.equal(judgeResult('Polk Audio Reserve R100 Small Bookshelf Speaker', id).relevant, false);
});

test('other generations and variants are not the product', () => {
  const id = identity('Apple iPhone 13 - 128GB - Midnight');
  assert.equal(judgeResult('Apple iPhone 13 A2482 128GB Midnight Black', id).relevant, true);
  assert.equal(judgeResult('Apple iPhone 14 128 GB Midnight', id).relevant, false);
  assert.equal(judgeResult('Apple iPhone 13 Pro 128GB', id).relevant, false);
});

test('accessories are not the product, however they are written', () => {
  assert.equal(judgeResult('Kastar Replacement Battery for Sony BP-U60 Sony PMW-EX1R', identity('Sony PMW-EX1R XDCAM Camcorder')).relevant, false);
  assert.equal(judgeResult('GameStop PS5 Slim Travel Case Value Pack', identity('Ps5 slim bundle')).relevant, false);
  assert.equal(judgeResult('Bambu Lab P2S/P1S/P1P/A1/X1C 3D Printer Flexible Build Plate', identity('Bambu Lab P1P 3D Printer')).relevant, false);
});

test('extras listed after the product do not make it an accessory', () => {
  const urc = identity('URC MX880 Remote Control');
  assert.equal(judgeResult('URC MX-880 Universal Remote,Charging Cord Tested, Works', urc).relevant, true);
  assert.equal(judgeResult('URC MX-880 Universal Programmable Remote Control No Charger', urc).relevant, true);
  assert.equal(judgeResult('Bose Wave Radio CD Player AWRCC1 • Refurbished • Remote & Power Cord Included', identity('Bose Wave Radio/CD Player')).relevant, true);
});

test('long part numbers match inside cross-reference lists', () => {
  const id = identity('LG 6870EC 9081C-2');
  assert.equal(judgeResult('LG 6871EC1121A 6871EC1121D 6870EC9081C Dryer Control Board', id).relevant, true);
});

test('titles with nothing checkable judge nothing', () => {
  assert.equal(judgeResult('Wooden Foosball Table', identity('Airfryer')).relevant, null);
});
