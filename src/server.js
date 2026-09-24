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
    const countries = url.searchParams.getAll('country');
    const formats = url.searchParams.getAll('format');
    if (countries.length !== 1 || formats.length > 1 || keys.length !== countries.length + formats.length) {
      res.writeHead(400).end('Provide one country and at most one format parameter\n');
      return;
    }
    const format = formats[0] ?? 'text';
    if (format !== 'text' && format !== 'json') {
      res.writeHead(400).end('format must be text or json\n');
      return;
    }
    if (format === 'json') res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const result = await generateRecord(countries[0], { format });
      res.end(`${format === 'json' ? JSON.stringify(result) : result}\n`);
    } catch (error) {
      const message = format === 'json' ? JSON.stringify({ error: error.message }) : error.message;
      res.writeHead(error instanceof InputError ? 400 : 502).end(`${message}\n`);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createCountryProfileServer().listen(port, '127.0.0.1', () => console.error(`Listening on http://127.0.0.1:${port}/generate?country=US`));
}
