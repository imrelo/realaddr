#!/usr/bin/env node
import { generateProfileByCountry } from './generator.js';

try {
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
    console.log('Usage: realaddr <country>\nSet GOOGLE_API_KEY and optionally GOOGLE_REFERER in the environment.');
  } else {
    if (process.argv.length !== 3) throw new Error('Usage: realaddr <country>');
    console.log(await generateProfileByCountry(process.argv[2]));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
