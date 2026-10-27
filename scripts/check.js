'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
let count = 0;
function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) check(filename);
    else if (entry.name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
      count++;
    }
  }
}
for (const directory of ['src', 'scripts', 'test']) if (fs.existsSync(directory)) check(directory);
console.log(`${count} archivos JavaScript verificados`);
