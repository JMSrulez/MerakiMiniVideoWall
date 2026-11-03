import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createApp } from './app.js'
import { readConfig } from './config.js'
import type { Config } from './config.js'
import { Services, validateRtspUrl } from './services.js'

const config: Config = {
  port: 0, username: 'admin', password: 'test-password-1234', apiKey: 'secret-meraki-key',
  organizationId: '123', mediaApi: 'http://media:9997', mediaWebrtc: 'http://media:8889',
  demo: false, production: false,
}
const auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`

async function withApp(services: Services, run: (base: string) => Promise<void>) {
  const server = createApp(services.config, services).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`) }
  finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

function fakeMeraki(url: string): Response {
  if (url.includes('/devices/statuses')) return Response.json([{ serial: 'Q123-ABCD-1234', status: 'online' }])
  if (url.includes('/networks')) return Response.json([{ id: 'N1', name: 'Bureau' }])
  if (url.includes('/camera/video/settings')) return Response.json({ externalRtspEnabled: true, rtspUrl: 'rtsp://192.168.1.50:9000/live' })
  if (url.includes('/organizations/123/devices')) return Response.json([{ serial: 'Q123-ABCD-1234', name: 'Accueil', model: 'MV12', networkId: 'N1' }])
  return new Response(null, { status: 404 })
}

test('configuration requires a strong password and explicit Meraki configuration', () => {
  assert.throws(() => readConfig({ APP_PASSWORD: 'short' }))
  assert.throws(() => readConfig({ APP_PASSWORD: config.password }))
  assert.equal(readConfig({ APP_PASSWORD: config.password, DEMO_MODE: 'true' }).demo, true)
})

test('RTSP validation accepts private camera addresses only', () => {
  assert.equal(validateRtspUrl('rtsp://10.0.0.5:9000/live'), 'rtsp://10.0.0.5:9000/live')
  for (const url of ['http://192.168.1.5:9000/live', 'rtsp://127.0.0.1:9000/live', 'rtsp://8.8.8.8:9000/live', 'rtsp://169.254.169.254:9000/live', 'rtsp://192.168.1.5:9997/live', 'rtsp://192.168.1.5:9000/live?x=1']) {
    assert.throws(() => validateRtspUrl(url))
  }
})

test('API and video signaling require authentication; mutations require anti-CSRF header', async () => {
  const services = new Services({ ...config, demo: true })
  await withApp(services, async base => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200)
    assert.equal((await fetch(`${base}/api/cameras`)).status, 401)
    assert.equal((await fetch(`${base}/media/cam-${'a'.repeat(24)}/whep`, { method: 'POST' })).status, 401)
    assert.equal((await fetch(`${base}/api/cameras/DEMO-1/stream`, { method: 'POST', headers: { Authorization: auth } })).status, 403)
    const response = await fetch(`${base}/api/cameras`, { headers: { Authorization: auth } })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).cameras.length, 6)
  })
})

test('inventory is cached and never exposes the API key or camera IP', async () => {
  let calls = 0
  const services = new Services(config, async input => { calls++; return fakeMeraki(String(input)) })
  const inventory = await services.inventory()
  await services.inventory()
  assert.equal(calls, 3)
  assert.equal(inventory.cameras[0].network, 'Bureau')
  assert.equal(inventory.cameras[0].status, 'online')
  assert.ok(!JSON.stringify(inventory).includes(config.apiKey))
  assert.ok(!JSON.stringify(inventory).includes('192.168'))
})

test('authenticated video errors do not consume the failed-login budget', async () => {
  const services = new Services({ ...config, demo: true })
  await withApp(services, async base => {
    for (let attempt = 0; attempt < 25; attempt++) {
      const response = await fetch(`${base}/api/cameras/unknown/stream`, {
        method: 'POST', headers: { Authorization: auth, 'X-Videowall-Request': '1' },
      })
      assert.equal(response.status, 404)
    }
    assert.equal((await fetch(`${base}/api/cameras`, { headers: { Authorization: auth } })).status, 200)
  })
})

test('unknown cameras cannot create a stream', async () => {
  const services = new Services(config, async input => fakeMeraki(String(input)))
  await assert.rejects(services.stream('unknown'), /introuvable/)
})

test('RTSP disabled is reported without mutating Meraki', async () => {
  const services = new Services(config, async (input, init) => {
    assert.ok(!init?.method || init.method === 'GET')
    if (String(input).includes('/camera/video/settings')) return Response.json({ externalRtspEnabled: false })
    return fakeMeraki(String(input))
  })
  await assert.rejects(services.stream('Q123-ABCD-1234'), /RTSP desactive/)
})

test('selected camera creates a shared on-demand TCP path and proxies WHEP session cleanup', async () => {
  let additions = 0
  let streamPath = ''
  let deleted = false
  const services = new Services(config, async (input, init) => {
    const url = String(input)
    if (url.includes('/v3/config/paths/get/')) return new Response(null, { status: 404 })
    if (url.includes('/v3/config/paths/add/')) {
      additions++
      const body = JSON.parse(String(init?.body))
      assert.equal(body.sourceOnDemand, true)
      assert.equal(body.rtspTransport, 'tcp')
      streamPath = url.split('/').at(-1) || ''
      return new Response(null, { status: 200 })
    }
    if (url.includes('/whep')) {
      assert.ok(!new Headers(init?.headers).has('authorization'))
      if (init?.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }) }
      return new Response('v=0\r\n', { status: 201, headers: {
        'Content-Type': 'application/sdp', Location: `/${streamPath}/whep/12345678-1234-1234-1234-123456789abc`,
      } })
    }
    return fakeMeraki(url)
  })
  const [first, second] = await Promise.all([services.stream('Q123-ABCD-1234'), services.stream('Q123-ABCD-1234')])
  assert.equal(first.url, second.url)
  assert.equal(additions, 1)
  await withApp(services, async base => {
    const headers = { Authorization: auth, 'X-Videowall-Request': '1', 'Content-Type': 'application/sdp' }
    const response = await fetch(`${base}${first.url}`, { method: 'POST', headers, body: 'v=0\r\n' })
    assert.equal(response.status, 201)
    const location = response.headers.get('location')!
    assert.ok(location.startsWith(`/media/${streamPath}/whep/`))
    assert.equal((await fetch(`${base}${location}`, { method: 'DELETE', headers })).status, 204)
    assert.equal(deleted, true)
  })
})

test('pagination does not send the Meraki key to an external host', async () => {
  const services = new Services(config, async input => {
    assert.equal(new URL(String(input)).hostname, 'api.meraki.com')
    if (String(input).includes('/devices?')) return Response.json([], { headers: { Link: '<https://evil.example/steal>; rel="next"' } })
    return fakeMeraki(String(input))
  })
  await assert.rejects(services.inventory(), /Pagination Meraki invalide/)
})