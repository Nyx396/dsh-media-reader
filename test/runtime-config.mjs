import fs from 'node:fs';
import path from 'node:path';
export function runtimeFile(relative) {
  const root = process.env.DSH_TEST_RUNTIME;
  if (!root || !path.isAbsolute(root)) throw new Error('Set DSH_TEST_RUNTIME to an absolute DSH 0.2.1-rc.2 runtime directory containing node_modules. See README.md.');
  const filename = path.join(root, 'node_modules', relative);
  if (!fs.existsSync(filename)) throw new Error('Missing DSH runtime fixture: '+relative);
  return filename;
}
