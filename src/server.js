import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { generateProfileByCountry, InputError } from './generator.js';

export function createCountryProfileServer(generateRecord = generateProfileByCountry) {
  return createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end('Invalid request URL\n');
      return;
    }
    if (url.pathname !== '/generate') {
      res.writeHead(404).end('Use GET /generate?country=US\n');
      return;
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.writeHead(405).end('Method not allowed\n');
      return;
    }
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== 'country') {
      res.writeHead(400).end('Provide exactly one country parameter\n');
      return;
    }
    const input = url.searchParams.get(keys[0]);
    try {
      res.end(`${await generateRecord(input)}\n`);
    } catch (error) {
      res.writeHead(error instanceof InputError ? 400 : 502).end(`${error.message}\n`);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createCountryProfileServer().listen(port, '127.0.0.1', () => console.error(`Listening on http://127.0.0.1:${port}/generate?country=US`));
}
