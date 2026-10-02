import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, extname, sep } from 'node:path'
import worker from '../.local-build/worker.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const publicDir = resolve(root, 'frontend/dist')
const db = new DatabaseSync(resolve(root, 'cloudflare/generated/local.sqlite'), { readOnly: true })
const DB = { prepare(sql) { return { bind(...values) { return { async all() { return { results: db.prepare(sql).all(...values) } } } } } } }
const port = Number(process.env.PORT || 8765)
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.csv': 'text/csv; charset=utf-8' }
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1:' + port)
    if (url.pathname.startsWith('/api/')) {
      let size = 0; const chunks = []
      for await (const chunk of req) { size += chunk.length; if (size > 8192) { res.writeHead(413); res.end('Request too large'); return }; chunks.push(chunk) }
      const request = new Request(url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) })
      const response = await worker.fetch(request, { DB, ALLOWED_ORIGINS: 'http://127.0.0.1:' + port + ',http://localhost:' + port })
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const path = resolve(publicDir, relative)
    if (!path.startsWith(publicDir + sep)) { res.writeHead(403); res.end(); return }
    const file = await readFile(path)
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : file)
  } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end('Local request failed'); console.error(error.message) }
})
server.listen(port, '127.0.0.1', () => console.log('RLTTTSK local: http://127.0.0.1:' + port))
process.on('SIGINT', () => server.close(() => { db.close(); process.exit(0) }))

