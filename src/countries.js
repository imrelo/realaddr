// English names and ISO codes from i18n-iso-countries 7.14.0.
// Attribution and MIT license: ../licenses/i18n-iso-countries.txt.
import rows from './countries.json' with { type: 'json' };

const codes = new Map();
const names = new Map();
for (const [alpha2, alpha3, officialName, ...aliases] of rows) {
  names.set(alpha2, officialName);
  codes.set(alpha2.toLowerCase(), alpha2);
  codes.set(alpha3.toLowerCase(), alpha2);
  for (const name of [officialName, ...aliases]) {
    const key = name.toLowerCase();
    if (!codes.has(key)) codes.set(key, alpha2);
  }
}
codes.set('uk', 'GB');
codes.set('vietnam', 'VN');

export function countryCode(input) {
  return typeof input === 'string' ? codes.get(input.trim().toLowerCase()) : undefined;
}

export function countryName(code) {
  return names.get(code);
}
