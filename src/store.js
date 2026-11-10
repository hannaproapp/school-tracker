import fs from 'fs';
import path from 'path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const file = (name) => path.join(config.dataDir, `${name}.json`);

export function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
  catch { return fallback; }
}

export function save(name, data) {
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(name));
}
