import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import type { Camera, CameraInventory, StreamDescription } from '../src/types.js'
import type { Config } from './config.js'

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

type Device = { serial: string; name?: string; model: string; networkId?: string; tags?: string[] }
type Network = { id: string; name: string }
type DeviceStatus = { serial: string; status: string }
type VideoSettings = { externalRtspEnabled?: boolean; rtspUrl?: string }
export type Fetcher = typeof fetch

const merakiBase = 'https://api.meraki.com/api/v1'
export const demoVideo = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'

export function validateRtspUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new HttpError(502, 'URL RTSP Meraki invalide.') }
  const octets = url.hostname.split('.').map(Number)
  const privateAddress = isIP(url.hostname) === 4 && (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  )
  if (!privateAddress || url.protocol !== 'rtsp:' || url.port !== '9000' ||
      url.pathname !== '/live' || url.username || url.password || url.search || url.hash) {
    throw new HttpError(502, 'Le flux doit utiliser une IP privee IPv4, RTSP TCP 9000 et /live.')
  }
  return url.toString()
}

export class Services {
  private cached?: CameraInventory
  private loading?: Promise<CameraInventory>
  private pendingStreams = new Map<string, Promise<StreamDescription>>()
  readonly allowedPaths = new Set<string>()

  constructor(readonly config: Config, readonly request: Fetcher = fetch) {}

  private async meraki<T>(path: string): Promise<T> {
    const url = new URL(path.startsWith('https:') ? path : `${merakiBase}${path}`)
    if (url.origin !== 'https://api.meraki.com' || !url.pathname.startsWith('/api/v1/')) {
      throw new HttpError(502, 'Pagination Meraki invalide.')
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.request(url, {
        headers: { 'X-Cisco-Meraki-API-Key': this.config.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (response.status === 429 && attempt < 2) {
        const seconds = Number(response.headers.get('retry-after') || 1)
        await response.body?.cancel()
        await delay(Math.min(Math.max(Number.isFinite(seconds) ? seconds : 1, 1), 5) * 1000)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new HttpError(502, `Meraki retourne ${response.status}. Verifier la cle et les droits sur l'organisation.`)
      }
      return await response.json() as T
    }
    throw new HttpError(503, 'Limite API Meraki atteinte.')
  }

  private async pages<T>(path: string): Promise<T[]> {
    const result: T[] = []
    let next = `${merakiBase}${path}`
    const visited = new Set<string>()
    while (next) {
      if (visited.has(next) || visited.size >= 100) throw new HttpError(502, 'Pagination Meraki invalide.')
      visited.add(next)
      const url = new URL(next)
      if (url.origin !== 'https://api.meraki.com' || !url.pathname.startsWith('/api/v1/')) {
        throw new HttpError(502, 'Pagination Meraki invalide.')
      }
      let response: Response | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        response = await this.request(url, {
          headers: { 'X-Cisco-Meraki-API-Key': this.config.apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        })
        if (response.status !== 429 || attempt === 2) break
        const seconds = Number(response.headers.get('retry-after') || 1)
        await response.body?.cancel()
        await delay(Math.min(Math.max(Number.isFinite(seconds) ? seconds : 1, 1), 5) * 1000)
      }
      if (!response?.ok) {
        await response?.body?.cancel()
        throw new HttpError(502, `Meraki retourne ${response?.status}. Verifier la cle et les droits sur l'organisation.`)
      }
      const body: unknown = await response.json()
      if (!Array.isArray(body)) throw new HttpError(502, 'Inventaire Meraki invalide.')
      result.push(...body as T[])
      const link = response.headers.get('link') || ''
      next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] || ''
    }
    return result
  }

  async inventory(refresh = false): Promise<CameraInventory> {
    if (!refresh && this.cached && Date.now() - Date.parse(this.cached.updatedAt) < 60_000) return this.cached
    if (this.loading) return this.loading
    this.loading = this.loadInventory()
    try {
      this.cached = await this.loading
      return this.cached
    } finally { this.loading = undefined }
  }

  private async loadInventory(): Promise<CameraInventory> {
    if (this.config.demo) {
      const names = ['Accueil', 'Entree principale', 'Couloir nord', 'Parking visiteurs', 'Quai de livraison', 'Cour interieure']
      return {
        demo: true, updatedAt: new Date().toISOString(),
        cameras: names.map((name, index) => ({
          serial: `DEMO-${index + 1}`, name, model: index % 2 ? 'MV13' : 'MV12',
          network: index < 3 ? 'Batiment principal' : 'Exterieurs',
          tags: [], status: index === 5 ? 'offline' : 'online',
        })),
      }
    }
    const org = encodeURIComponent(this.config.organizationId)
    const query = '?productTypes[]=camera&perPage=1000'
    const [devices, networks, statuses] = await Promise.all([
      this.pages<Device>(`/organizations/${org}/devices${query}`),
      this.pages<Network>(`/organizations/${org}/networks${query}`),
      this.pages<DeviceStatus>(`/organizations/${org}/devices/statuses${query}`).catch(() => []),
    ])
    const networkNames = new Map(networks.map(network => [network.id, network.name]))
    const states = new Map(statuses.map(device => [device.serial, device.status]))
    return {
      demo: false, updatedAt: new Date().toISOString(),
      cameras: devices.filter(device => device.model.startsWith('MV')).map<Camera>(device => ({
        serial: device.serial, name: device.name || device.serial, model: device.model,
        network: networkNames.get(device.networkId || '') || 'Reseau inconnu', tags: device.tags || [],
        status: states.get(device.serial) === 'online' ? 'online' :
          states.get(device.serial) === 'offline' ? 'offline' : 'unknown',
      })).sort((first, second) => first.name.localeCompare(second.name, 'fr')),
    }
  }

  async stream(serial: string): Promise<StreamDescription> {
    const existing = this.pendingStreams.get(serial)
    if (existing) return existing
    const pending = this.prepareStream(serial)
    this.pendingStreams.set(serial, pending)
    try { return await pending } finally { this.pendingStreams.delete(serial) }
  }

  private async prepareStream(serial: string): Promise<StreamDescription> {
    const { cameras } = await this.inventory()
    const camera = cameras.find(item => item.serial === serial)
    if (!camera) throw new HttpError(404, 'Camera introuvable dans cette organisation.')
    if (this.config.demo) {
      if (camera.status === 'offline') throw new HttpError(503, 'Camera de demonstration hors ligne.')
      return { demo: true, url: demoVideo }
    }
    const settings = await this.meraki<VideoSettings>(`/devices/${encodeURIComponent(serial)}/camera/video/settings`)
    if (!settings.externalRtspEnabled || !settings.rtspUrl) {
      throw new HttpError(409, 'RTSP desactive. Activer External RTSP dans les parametres video du Dashboard Meraki.')
    }
    const source = validateRtspUrl(settings.rtspUrl)
    const name = `cam-${createHash('sha256').update(serial).digest('hex').slice(0, 24)}`
    const target = `${this.config.mediaApi}/v3/config/paths`
    const current = await this.request(`${target}/get/${name}`, { signal: AbortSignal.timeout(5000) })
    if (current.status === 404) {
      await current.body?.cancel()
      const added = await this.request(`${target}/add/${name}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, sourceOnDemand: true, sourceOnDemandCloseAfter: '10s', rtspTransport: 'tcp' }),
        signal: AbortSignal.timeout(5000),
      })
      await added.body?.cancel()
      if (!added.ok) throw new HttpError(502, 'Impossible de configurer la passerelle video.')
    } else if (current.ok) {
      const body = await current.json() as { source: string }
      if (body.source !== source) {
        const patched = await this.request(`${target}/patch/${name}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, sourceOnDemand: true, rtspTransport: 'tcp' }),
          signal: AbortSignal.timeout(5000),
        })
        await patched.body?.cancel()
        if (!patched.ok) throw new HttpError(502, 'Impossible de mettre a jour la passerelle video.')
      }
    } else {
      await current.body?.cancel()
      throw new HttpError(502, 'Passerelle video indisponible.')
    }
    this.allowedPaths.add(name)
    return { demo: false, url: `/media/${name}/whep` }
  }
}