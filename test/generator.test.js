import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { addressFrom, generateProfileByCountry, password, phoneFor, resolveCountry, findAddress } from '../src/generator.js';
import { createCountryProfileServer } from '../src/server.js';
import usAreaCodes from '../src/us-area-codes.json' with { type: 'json' };
import { countryName } from '../src/countries.js';

const component = (type, longText, shortText = longText) => ({ types: [type], longText, shortText });
function place(country = 'US', state = 'CA') {
  return { addressComponents: [component('country', country), component('administrative_area_level_1', state === 'CA' ? 'California' : state, state), component('locality', 'Sample City'), component('route', 'Main Street'), component('street_number', '123'), component('postal_code', '90210')] };
}
const fakeFetch = async () => ({ ok: true, json: async () => ({ places: [place('US', 'HI'), place('US', 'PR'), place('CA'), place()] }) });
const firstNames = new Set(readFileSync(new URL('../src/firstname.txt', import.meta.url), 'utf8').split(/\r\n|\n|\r/).map(name => name.trim()).filter(Boolean));
const lastNames = new Set(readFileSync(new URL('../src/lastname.txt', import.meta.url), 'utf8').split(/\r\n|\n|\r/).map(name => name.trim()).filter(Boolean));

test('country accepts codes and English names, rejects Vietnamese and invalid input', () => {
  for (const input of ['US', 'usa', 'United States']) assert.equal(resolveCountry(input), 'US');
  for (const input of ['VN', 'Vietnam']) assert.equal(resolveCountry(input), 'VN');
  for (const input of ['UK', 'gbr', ' United Kingdom ']) assert.equal(resolveCountry(input), 'GB');
  for (const input of ['DE', 'deu', 'gErMaNy']) assert.equal(resolveCountry(input), 'DE');
  assert.equal(countryName(resolveCountry('deu')), 'Germany');
  for (const input of ['', null, 'XX', 'not a country', 'Mỹ', 'Việt Nam', 'Nhật Bản', 'constructor', '__proto__', 'toString', '840', 840]) assert.throws(() => resolveCountry(input));
});
test('password always meets length and all four character classes', () => {
  for (let i = 0; i < 200; i++) {
    const value = password();
    assert.match(value, /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[!@#$%^&*_+=?\-])[\S]{8,12}$/);
    assert.ok(!value.includes('|'));
  }
});
test('phone is valid and belongs to requested numbering country', () => {
  for (const country of ['US', 'VN', 'GB', 'CA', 'AU', 'DE', 'FR', 'JP', 'IN', 'BR']) {
    for (let i = 0; i < 20; i++) {
      const value = phoneFor(country, country === 'US' ? 'CA' : undefined);
      const number = parsePhoneNumberFromString(value, country);
      assert.match(value, /^\d+$/);
      assert.equal(value, number.nationalNumber);
      assert.equal(number.country, country);
      assert.ok(number.isValid());
    }
  }
});
test('US records use the Google state to select a geographic area code for all 48 states', async () => {
  const states = 'AL AZ AR CA CO CT DE FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
  assert.deepEqual(Object.keys(usAreaCodes.states), states);
  assert.ok(usAreaCodes.states.CA.includes('415'));
  assert.ok(usAreaCodes.states.NY.includes('212'));
  assert.ok(!usAreaCodes.states.CA.includes('212'));
  for (const state of states) {
    for (let i = 0; i < 10; i++) {
      const record = await generateProfileByCountry('US', { apiKey: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ places: [place('US', state)] }) }) });
      const fields = record.split('|');
      assert.ok(firstNames.has(fields[0]));
      assert.ok(lastNames.has(fields[1]));
      const phone = parsePhoneNumberFromString(fields[7], 'US');
      assert.match(fields[7], /^\d{10}$/);
      assert.equal(fields[4], state);
      assert.equal(phone.country, 'US');
      assert.ok(phone.isValid());
      assert.ok(usAreaCodes.states[state].includes(phone.nationalNumber.slice(0, 3)), `${state}: ${phone.number}`);
      assert.notEqual(phone.nationalNumber.slice(4, 6), '11');
    }
  }
  for (const state of [undefined, '', 'HI', 'PR', 'AK', 'DC', 'XX', 'toString']) assert.throws(() => phoneFor('US', state), /Unsupported US state/);
});
test('address filtering rejects foreign countries and every non-mainland US state', () => {
  for (const state of ['HI', 'PR', 'AK', 'GU', 'VI', 'AS', 'MP', 'DC', '']) assert.equal(addressFrom(place('US', state), 'US'), null);
  assert.equal(addressFrom(place('CA'), 'US'), null);
  assert.equal(addressFrom(place(), 'US').state, 'CA');
  assert.equal(addressFrom({}, 'US'), null);
});
test('output is one line with ten fields in the agreed order', async () => {
  const result = await generateProfileByCountry('US', { apiKey: 'test-key', fetchImpl: fakeFetch });
  const fields = result.split('|');
  assert.equal(fields.length, 10);
  assert.ok(!/[\r\n]/.test(result));
  assert.deepEqual(fields.slice(2, 7), ['123 Main Street', 'Sample City', 'CA', 'California', '90210']);
  assert.match(fields[8], /^[a-z0-9]+\.[a-z0-9]+\.[a-z0-9]{6}@(gmail\.com|yahoo\.com|outlook\.com|hotmail\.com|icloud\.com|aol\.com|live\.com|msn\.com|proton\.me|mail\.com)$/);
  const [first, last, suffix] = fields[8].split('@')[0].split('.');
  const normalize = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/g, 'd').replace(/[^a-z0-9]/g, '').slice(0, 27);
  assert.equal(first, normalize(fields[0]) || 'user');
  assert.equal(last, normalize(fields[1]) || 'mail');
  assert.match(suffix, /[a-z]/);
  assert.match(suffix, /[0-9]/);
});
test('Google request uses key header; errors and empty results do not fabricate addresses', async () => {
  await findAddress('US', { apiKey: 'test-key', referer: 'https://example.com/', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://places.googleapis.com/v1/places:searchText');
    assert.equal(init.headers['X-Goog-Api-Key'], 'test-key');
    assert.equal(init.headers.Referer, 'https://example.com/');
    return fakeFetch();
  } });
  await findAddress('US', { apiKey: 'test-key', referer: '', fetchImpl: async (_url, init) => {
    assert.equal(Object.hasOwn(init.headers, 'Referer'), false);
    return fakeFetch();
  } });
  await assert.rejects(findAddress('US', { apiKey: '' }), /GOOGLE_API_KEY/);
  await assert.rejects(findAddress('US', { apiKey: 'test-key', fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
  let calls = 0;
  await assert.rejects(findAddress('US', { apiKey: 'test-key', fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ places: [place('US', 'HI')] }) }; } }), /No usable/);
  assert.equal(calls, 3);
});
test('HTTP endpoint accepts only one country, returns plain text with no cache', async t => {
  const server = createCountryProfileServer(input => generateProfileByCountry(input, { apiKey: 'test-key', fetchImpl: fakeFetch }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const good = await fetch(`${url}/generate?country=US`);
  assert.equal(good.status, 200);
  assert.match(good.headers.get('content-type'), /text\/plain/);
  assert.equal(good.headers.get('cache-control'), 'no-store');
  assert.equal((await good.text()).trim().split('|').length, 10);
  for (const query of ['', '?country=XX', '?country=US&count=2', '?country=US&country=VN']) assert.equal((await fetch(`${url}/generate${query}`)).status, 400);
  assert.equal((await fetch(`${url}/generate?country=US`, { method: 'POST' })).status, 405);
});

test('incomplete records retry at most three times and can succeed on the last retry', async () => {
  for (const successAt of [1, 2, 4]) {
    let calls = 0;
    const record = await generateProfileByCountry('US', { apiKey: 'test-key', fetchImpl: async () => {
      calls++;
      const result = place();
      if (calls < successAt) result.addressComponents.find(c => c.types.includes('administrative_area_level_1')).longText = '  ';
      return { ok: true, json: async () => ({ places: [result] }) };
    } });
    assert.equal(calls, successAt);
    assert.equal(record.split('|').length, 10);
    assert.ok(record.split('|').every(value => value.trim()));
  }
});

test('missing address fields and empty search results return null after four total attempts', async () => {
  for (const missing of ['route', 'locality', 'administrative_area_level_1', 'postal_code', 'all']) {
    let calls = 0;
    const record = await generateProfileByCountry('VN', { apiKey: 'test-key', fetchImpl: async () => {
      calls++;
      const result = place('VN');
      result.addressComponents = result.addressComponents.filter(c => !c.types.includes(missing));
      return { ok: true, json: async () => ({ places: missing === 'all' ? [] : [result] }) };
    } });
    assert.equal(record, null, missing);
    assert.equal(calls, 4, missing);
  }
});

test('Google permission failures are not treated as missing fields', async () => {
  let calls = 0;
  await assert.rejects(generateProfileByCountry('US', { apiKey: 'test-key', fetchImpl: async () => {
    calls++;
    return { ok: false, status: 403 };
  } }), /HTTP 403/);
  assert.equal(calls, 1);
});

test('HTTP endpoint returns literal null after incomplete results exhaust retries', async t => {
  let calls = 0;
  const server = createCountryProfileServer(input => generateProfileByCountry(input, { apiKey: 'test-key', fetchImpl: async () => {
    calls++;
    return { ok: true, json: async () => ({ places: [] }) };
  } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/generate?country=US`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'null\n');
  assert.equal(calls, 4);
});
