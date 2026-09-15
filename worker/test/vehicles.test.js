import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vehicleReason } from '../src/vehicles.js';

test('whole vehicles are recognised', () => {
  for (const title of [
    '1972 Chevrolet nova',          // priced at $13 against models before the rule
    '2005 school bus',
    '1972 VW transporter',
    '2023 Vespa Betty',
    'Western golf cart',
    '1992 Dodge Ram 50 · Short Bed', // was matched to beds
    '2019 Honda Grom motorcycle',
    '2008 Honda Civic 120k miles',
    'Seadoos & zieman trailer',
    'Trailer Home',
    'Runs great, clean title, must sell',
    'Trailer home for sale',
    '2021 Tesla Model 3 long range',
  ]) {
    assert.ok(vehicleReason(title), title);
  }
});

test('vehicle parts, fitments and look-alikes are kept', () => {
  for (const title of [
    '2019 Yamaha P-125 digital piano',
    'Honda EU2200i generator 2020',
    'Interstate M-24F Group 24F Car Battery – Infiniti/Nissan/Toyota',
    'Rims for 2015 Honda Civic',
    'Hot Wheels 1969 Chevy Camaro',
    'Yamaha Aventage RX-A2000 7.2 channel receiver',
    'Mini bike engine',
    'Ozark Trail Medium Explorer Gravel Bike',
    '2018 Ford F-150 tonneau cover',
    '48 Volt E-Bike Rack Battery 20Ah',
    'Toyota key fob',
    'Air Jordan 4 retro OG Fire Red 2020 size 10',
    'JL AUDIO W7AE CAR SUBWOOFER',
    'Steel Car Ramps',
  ]) {
    assert.equal(vehicleReason(title), null, title);
  }
});

test('the source naming a vehicle category is enough', () => {
  assert.ok(vehicleReason('Great runner, no issues', 'Vehicles'));
  assert.equal(vehicleReason('Great runner, no issues', 'Electronics'), null);
});
