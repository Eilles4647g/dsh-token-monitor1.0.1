import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(resolve(root, 'src/client/index.cjs'), 'utf8')
const artifact = `window.__ModuleLoader__.load({
  id: 'dsh-token-monitor',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
${source}
    return module.exports;
  }
});
`
const output = resolve(root, 'lib/client.js')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, artifact, 'utf8')
console.log(`Built ${output}`)
