import { useEffect, useRef, useState } from 'react'
import { Camera as CameraIcon, Maximize, Minimize, RefreshCw, Scan, X, WifiOff } from 'lucide-react'
import { api } from './api'
import type { Camera, StreamDescription } from './types'

type PlaybackState = 'empty' | 'connecting' | 'live' | 'demo' | 'error'

async function gatherIce(peer: RTCPeerConnection, signal: AbortSignal) {
  if (peer.iceGatheringState === 'complete') return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); peer.removeEventListener('icegatheringstatechange', changed); signal.removeEventListener('abort', aborted) }
    const changed = () => { if (peer.iceGatheringState === 'complete') { cleanup(); resolve() } }
    const aborted = () => { cleanup(); reject(new Error('Lecture annulee.')) }
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Negociation WebRTC trop longue.')) }, 8000)
    peer.addEventListener('icegatheringstatechange', changed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

export function VideoTile({ camera, index, selected, onSelect, onRemove }: {
  camera?: Camera; index: number; selected: boolean; onSelect: () => void; onRemove: () => void
}) {
  const tile = useRef<HTMLElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<PlaybackState>('empty')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [cover, setCover] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const serial = camera?.serial

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === tile.current)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])

  useEffect(() => {
    const element = video.current
    if (!serial || !element) { setState('empty'); return }
    let disposed = false
    let peer: RTCPeerConnection | undefined
    let controller = new AbortController()
    let sessionUrl: string | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined

    const release = () => {
      clearTimeout(handshakeTimer)
      controller.abort()
      if (peer) { peer.onconnectionstatechange = null; peer.close(); peer = undefined }
      if (sessionUrl) {
        void fetch(sessionUrl, { method: 'DELETE', headers: { 'X-Videowall-Request': '1' }, keepalive: true }).catch(() => {})
        sessionUrl = undefined
      }
      element.pause(); element.srcObject = null; element.removeAttribute('src'); element.load()
    }
    const failed = (message: string) => {
      if (disposed || retryTimer) return
      release(); setError(message); setState('error')
      retryTimer = setTimeout(() => { retryTimer = undefined; void connect() }, 5000)
    }
    const connect = async () => {
      if (disposed) return
      controller = new AbortController(); setState('connecting'); setError('')
      try {
        const stream = await api<StreamDescription>(`/api/cameras/${encodeURIComponent(serial)}/stream`, {
          method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
        })
        if (disposed || controller.signal.aborted) return
        if (stream.demo) { element.src = stream.url; setState('demo'); await element.play(); return }
        if (!window.RTCPeerConnection) throw new Error('WebRTC indisponible dans ce navigateur.')
        const connection = new RTCPeerConnection({ iceServers: [] })
        peer = connection
        connection.addTransceiver('video', { direction: 'recvonly' })
        connection.ontrack = event => { element.srcObject = new MediaStream([event.track]) }
        connection.onconnectionstatechange = () => {
          if (disposed) return
          if (connection.connectionState === 'connected') {
            clearTimeout(handshakeTimer); setState('live')
            void element.play().catch(() => failed('Lecture bloquee par le navigateur.'))
          } else if (['failed', 'disconnected'].includes(connection.connectionState)) failed('Connexion interrompue. Nouvelle tentative dans 5 secondes.')
        }
        await connection.setLocalDescription(await connection.createOffer())
        await gatherIce(connection, controller.signal)
        if (disposed || controller.signal.aborted) return
        const response = await fetch(stream.url, {
          method: 'POST', headers: { 'Content-Type': 'application/sdp', 'X-Videowall-Request': '1' }, body: connection.localDescription?.sdp,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        })
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string }
          throw new Error(body.error || 'Le flux WebRTC est indisponible.')
        }
        sessionUrl = response.headers.get('location') || undefined
        if (disposed) { release(); return }
        if (!sessionUrl || !sessionUrl.startsWith('/media/')) throw new Error('Session WebRTC invalide.')
        await connection.setRemoteDescription({ type: 'answer', sdp: await response.text() })
        if (connection.connectionState !== 'connected') handshakeTimer = setTimeout(() => failed('Connexion video impossible. Verifier le port 8189 et l IP annoncee.'), 20_000)
      } catch (cause) { if (!disposed) failed(cause instanceof Error ? cause.message : 'Lecture impossible.') }
    }
    void connect()
    return () => { disposed = true; clearTimeout(retryTimer); release() }
  }, [serial, retry])

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await tile.current?.requestFullscreen()
    } catch { setError('Plein ecran indisponible sur ce navigateur.') }
  }
  const labels: Record<PlaybackState, string> = { empty: 'Libre', connecting: 'Connexion', live: 'Live', demo: 'Demo', error: 'Indisponible' }

  return <section ref={tile} className={`video-tile ${selected ? 'selected' : ''}`} aria-label={`Emplacement ${index + 1}`}>
    <header className="tile-header">
      <button className="tile-select" onClick={onSelect} aria-pressed={selected} title={`Selectionner l emplacement ${index + 1}`}><span className="tile-number">0{index + 1}</span><span className="tile-name">{camera?.name || 'Emplacement libre'}</span></button>
      <span className={`stream-state state-${state}`}><i />{labels[state]}</span>
      <button className="icon-button" onClick={() => void toggleFullscreen()} title={fullscreen ? 'Quitter le plein ecran' : 'Plein ecran'} aria-label={fullscreen ? 'Quitter le plein ecran' : 'Plein ecran'}>{fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}</button>
    </header>
    <div className={`video-surface ${cover ? 'cover' : ''}`} onClick={onSelect}>
      <video ref={video} autoPlay muted playsInline loop aria-label={camera ? `Video ${camera.name}` : 'Emplacement video libre'} onError={() => { if (state === 'demo') { setState('error'); setError('Clip de demonstration indisponible.') } }} />
      {(!camera || state === 'connecting' || state === 'error') && <div className="video-placeholder">
        {state === 'connecting' ? <RefreshCw className="spin" size={28} /> : state === 'error' ? <WifiOff size={30} /> : <CameraIcon size={32} strokeWidth={1.2} />}
        <strong>{!camera ? `Emplacement 0${index + 1}` : state === 'connecting' ? 'Connexion au flux' : 'Flux indisponible'}</strong>
        {state === 'error' && <p role="status">{error}</p>}
      </div>}
      {state === 'demo' && <span className="demo-watermark">DEMONSTRATION</span>}
    </div>
    <footer className="tile-footer"><span>{camera ? `${camera.model} / ${camera.network}` : 'Aucune camera'}</span><div className="tile-actions">
      <button className="icon-button" onClick={() => setCover(!cover)} disabled={!camera} aria-pressed={cover} title={cover ? 'Afficher l image entiere' : 'Remplir le cadre'} aria-label={cover ? 'Afficher l image entiere' : 'Remplir le cadre'}><Scan size={15} /></button>
      <button className="icon-button" onClick={() => setRetry(retry + 1)} disabled={!camera} title="Reconnecter" aria-label="Reconnecter"><RefreshCw size={15} /></button>
      <button className="icon-button" onClick={onRemove} disabled={!camera} title="Retirer la camera" aria-label="Retirer la camera"><X size={16} /></button>
    </div></footer>
  </section>
}