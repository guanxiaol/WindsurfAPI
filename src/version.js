import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export const VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '1.0.0';
  }
})();

export const BRAND = 'WindsurfPoolAPI';
