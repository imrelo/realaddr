#!/usr/bin/env node
import { generateProfileByCountry } from './generator.js';

try {
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
    console.log('Usage: realaddr <country> [--json]\nSet GOOGLE_API_KEY and optionally GOOGLE_REFERER in the environment.');
  } else {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const countries = args.filter(arg => arg !== '--json');
    if (countries.length !== 1 || args.length !== countries.length + Number(json)) throw new Error('Usage: realaddr <country> [--json]');
    const result = await generateProfileByCountry(countries[0], { format: json ? 'json' : 'text' });
    console.log(json ? JSON.stringify(result) : result);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
