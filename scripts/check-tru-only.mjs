import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright')
const root = fileURLToPath(new URL('../', import.meta.url))
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage(), errors = []
page.on('pageerror', error => errors.push(error.message))
await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
await page.goto('http://127.0.0.1:8765')
await page.getByRole('button', { name: 'Список закупок CSV', exact: true }).click()
await page.getByLabel('Загрузить CSV').setInputFiles(resolve(root, 'input_samples/test/purchases_2.csv'))
await page.getByRole('button', { name: 'Открыть лот 5968880', exact: true }).waitFor()
assert.equal(await page.locator('.lot-select').count(), 38)
assert.equal(await page.locator('.provisional-note').count(), 1)
await page.getByRole('button', { name: 'Подобрать для этого лота', exact: true }).click()
await page.getByRole('button', { name: 'Обновить подбор', exact: true }).waitFor()
assert.equal(await page.locator('.lot-dot.error').count(), 0)
const provisionalStatus = await page.locator('.lot-select.selected .lot-select-bottom').innerText()
await page.getByLabel('Загрузить CSV').setInputFiles(resolve(root, 'input_samples/test/purchases_1.csv'))
await page.waitForFunction(() => !document.querySelector('.provisional-note') && document.querySelector('.lot-meta')?.textContent?.includes('7808046224'))
assert.equal(await page.locator('.lot-select').count(), 38)
assert.ok((await page.locator('.bulk-stats').innerText()).includes('670'))
assert.equal(await page.locator('.lot-dot.error').count(), 0)
assert.ok((await page.locator('.lot-select.selected .lot-select-bottom').innerText()).includes('Не обработано'))
assert.deepEqual(errors, [])
await writeFile(resolve(root, 'qa/tru-only-report.json'), JSON.stringify({ provisionalLots: 38, itemRows: 670, initialRecommendationStatus: provisionalStatus,
  noticeMerged: true, changedRecommendationReset: true, pageErrors: errors }, null, 2))
await browser.close()
console.log('TRU-only lots and recommendations verified; later notice merges and resets the changed lot.')
