/* `npm run serve` — the app on http://127.0.0.1:8099 for hand-testing.
 * A service worker needs https or localhost, which 127.0.0.1 counts as. */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startServer } from './serve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8099;
const { url } = await startServer(root, port);
console.log('PLANK//MATRIX → ' + url + '  (ctrl-c to stop)');
