import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
const root = fileURLToPath(new URL('../', import.meta.url))
const frontendRequire = createRequire(resolve(root, 'frontend/package.json'))
const viteRequire = createRequire(frontendRequire.resolve('vite'))
const { build } = await import(pathToFileURL(viteRequire.resolve('rolldown')).href)
await mkdir(resolve(root, '.local-build'), { recursive: true })
for (const [input, output] of [['cloudflare/src/index.ts', 'worker.mjs'], ['tests/core.test.ts', 'core.test.mjs']]) {
  await build({ input: resolve(root, input), platform: 'node', external: [/^node:/],
    output: { file: resolve(root, '.local-build', output), format: 'esm' } })
}
console.log('Local Worker and tests compiled.')

