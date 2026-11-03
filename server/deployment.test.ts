import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse } from 'yaml'

test('Docker only publishes HTTPS and ICE, not application or media control APIs', () => {
  const compose = parse(readFileSync('compose.yaml', 'utf8'))
  assert.equal(compose.services.app.environment.NODE_ENV, 'production')
  assert.equal(compose.services.app.ports, undefined)
  assert.deepEqual(compose.services.mediamtx.ports, ['8189:8189/udp', '8189:8189/tcp'])
  assert.deepEqual(compose.services.caddy.ports, ['${HTTPS_PORT:-443}:443'])
  assert.deepEqual(compose.services.mediamtx.networks, ['media'])
  assert.deepEqual(compose.services.caddy.networks, ['web'])
  assert.match(compose.services.app.environment.APP_PASSWORD, /\?/)
  assert.match(compose.services.mediamtx.environment.MTX_WEBRTCADDITIONALHOSTS, /SERVER_LAN_IP/)
})

test('MediaMTX pulls TCP on demand without recording or anonymous publishing', () => {
  const media = parse(readFileSync('deploy/mediamtx.yml', 'utf8'))
  assert.equal(media.pathDefaults.sourceOnDemand, true)
  assert.equal(media.pathDefaults.rtspTransport, 'tcp')
  assert.equal(media.pathDefaults.record, false)
  assert.equal(media.webrtcIPsFromInterfaces, false)
  assert.equal(media.rtsp, false)
  assert.equal(media.hls, false)
  assert.deepEqual(media.paths, {})
  assert.ok(!media.authInternalUsers.flatMap((user: { permissions: { action: string }[] }) => user.permissions).some((permission: { action: string }) => permission.action === 'publish'))
  assert.match(readFileSync('deploy/Caddyfile', 'utf8'), /tls internal/)
})