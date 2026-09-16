import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../src/config.mjs';

let failed = false;
for (const directory of ['src', 'scripts', 'test']) {
  for (const file of await readdir(path.join(ROOT, directory))) {
    if (!file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(ROOT, directory, file)], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log('所有 JavaScript 模块语法检查通过。');
