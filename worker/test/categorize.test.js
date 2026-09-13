import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, CATEGORIES } from '../src/categorize.js';

const cases = [
  ['PS5 Slim Disc Edition', 'electronics'],
  ['Sonos Connect:Amp', 'electronics'],
  ['Samsung 65 inch TV', 'electronics'],
  ['Brown leather sectional couch', 'furniture'],
  ['Herman Miller Aeron chair', 'furniture'],
  ['Whirlpool washer and dryer set', 'appliances'],
  ['DeWalt 20V MAX cordless drill DCD777 kit', 'tools'],
  ['Trek mountain bike 29er', 'outdoor'],
  ['Set of 4 tires 225/65R17', 'auto'],
  ['Yamaha acoustic guitar with case', 'music'],
  ['Nike Air Max size 11', 'apparel'],
  ['LEGO Millennium Falcon set', 'toys'],
  ['Area rug 8x10 wool', 'home'],
];

test('categorises real listing titles', () => {
  for (const [title, expected] of cases) {
    assert.equal(categorize(title).category, expected, `"${title}"`);
  }
});

test('unrecognisable titles land in other rather than guessing', () => {
  assert.equal(categorize('Free pile of cables').category, 'other');
  assert.equal(categorize('').category, 'other');
});

test('a category supplied by the source wins over inference', () => {
  const c = categorize('Brown leather sectional couch', '', 'electronics');
  assert.equal(c.category, 'electronics');
  assert.equal(c.method, 'source');
});

test('an invalid source category falls back to inference', () => {
  const c = categorize('Brown leather sectional couch', '', 'not-a-category');
  assert.equal(c.category, 'furniture');
  assert.equal(c.method, 'keyword');
});

test('an explicit noun outranks a brand pointing elsewhere', () => {
  // Yamaha makes both receivers and guitars; the noun decides.
  assert.equal(categorize('Yamaha acoustic guitar').category, 'music');
  assert.equal(categorize('Bosch dishwasher').category, 'appliances');
});

test('multi-word terms outweigh a single generic word', () => {
  assert.equal(categorize('mechanical keyboard, barely used').category, 'electronics');
  assert.equal(categorize('piano keyboard 88 weighted keys').category, 'music');
});

test('every returned category is in the published list', () => {
  for (const [title] of cases) {
    assert.ok(CATEGORIES.includes(categorize(title).category));
  }
});
