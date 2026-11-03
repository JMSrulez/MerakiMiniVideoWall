import { createHash, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import express from 'express'
import type { ErrorRequestHandler } from 'express'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import type { Config } from './config.js'
import { HttpError, Services } from './services.js'

function equal(first: string, second: string): boolean {
  return timingSafeEqual(createHash('sha256').update(first).digest(), createHash('sha256').update(second).digest())
}

export function createApp(config: Config, services = new Services(config)) {
  const app = express()
  app.disable('x-powered-by')
  app.use(helmet({
    contentSecurityPolicy: config.production ? { directives: {
      'default-src': ["'self'"], 'script-src': ["'self'"], 'style-src': ["'self'"],
      'connect-src': ["'self'"], 'img-src': ["'self'", 'data:'],
      'media-src': ["'self'", 'blob:', ...(config.demo ? ['https://interactive-examples.mdn.mozilla.net'] : [])],
      'upgrade-insecure-requests': null,
    } } : false,
    strictTransportSecurity: false,
    crossOriginEmbedderPolicy: false,
  }))
  app.get('/healthz', (_request, response) => { response.json({ status: 'ok' }) })
  const loginLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false })
  app.use((request, response, next) => {
    const header = request.headers.authorization || ''
    const decoded = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString() : ''
    const separator = decoded.indexOf(':')
    const validUser = equal(decoded.slice(0, separator), config.username)
    const validPassword = equal(decoded.slice(separator + 1), config.password)
    if (separator < 0 || !validUser || !validPassword) {
      loginLimit(request, response, () => {
        response.setHeader('WWW-Authenticate', 'Basic realm="Meraki Video Wall", charset="UTF-8"')
        response.status(401).json({ error: 'Authentification requise.' })
      })
      return
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-videowall-request'] !== '1') {
      response.status(403).json({ error: 'Requete non autorisee.' })
      return
    }
    response.setHeader('Cache-Control', 'no-store')
    next()
  })
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }))
  app.get('/api/cameras', async (_request, response) => { response.json(await services.inventory()) })
  app.post('/api/cameras/refresh', async (_request, response) => { response.json(await services.inventory(true)) })
  app.post('/api/cameras/:serial/stream', async (request, response) => { response.json(await services.stream(String(request.params.serial))) })
  app.use('/media', express.text({ type: ['application/sdp', 'application/trickle-ice-sdpfrag'], limit: '64kb' }))
  app.all(/^\/media\/(cam-[a-f0-9]{24})\/whep(?:\/([a-f0-9-]{36}))?$/, async (request, response) => {
    const name = request.params[0]
    const session = request.params[1]
    if (!services.allowedPaths.has(name)) throw new HttpError(404, 'Flux inconnu.')
    if ((!session && request.method !== 'POST') || (session && !['DELETE', 'PATCH'].includes(request.method))) {
      throw new HttpError(405, 'Methode non autorisee.')
    }
    const headers = new Headers()
    for (const header of ['content-type', 'if-match']) {
      const value = request.get(header)
      if (value) headers.set(header, value)
    }
    const upstreamPath = `/${name}/whep${session ? `/${session}` : ''}`
    const upstream = await services.request(`${config.mediaWebrtc}${upstreamPath}`, {
      method: request.method, headers,
      body: ['POST', 'PATCH'].includes(request.method) ? String(request.body || '') : undefined,
      signal: AbortSignal.timeout(25_000),
    })
    if (!upstream.ok) {
      await upstream.body?.cancel()
      throw new HttpError(502, 'Lecture video impossible. Verifier RTSP, codec et acces reseau aux cameras.')
    }
    const location = upstream.headers.get('location')
    if (location) {
      const url = new URL(location, `${config.mediaWebrtc}${upstreamPath}`)
      if (!url.pathname.startsWith(`/${name}/whep/`)) throw new HttpError(502, 'Session video invalide.')
      response.setHeader('Location', `/media${url.pathname}`)
    }
    for (const header of ['content-type', 'etag', 'accept-patch']) {
      const value = upstream.headers.get(header)
      if (value) response.setHeader(header, value)
    }
    response.status(upstream.status).send(await upstream.text())
  })
  app.use(['/api', '/media'], (_request, response) => { response.status(404).json({ error: 'Ressource introuvable.' }) })
  app.use(express.static(path.resolve('dist')))
  app.get('/', (_request, response) => { response.sendFile(path.resolve('dist/index.html')) })
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof HttpError) response.status(error.status).json({ error: error.message })
    else {
      console.error('Echec de requete:', error instanceof Error ? error.name : 'UnknownError')
      response.status(502).json({ error: 'Service indisponible. Verifier la configuration et la connectivite du serveur.' })
    }
  }
  app.use(errorHandler)
  return app
}