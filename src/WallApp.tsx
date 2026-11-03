import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { Camera as CameraIcon, ChevronDown, Grid2X2, Menu, Monitor, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { api } from './api'
import type { CameraInventory } from './types'
import { VideoTile } from './VideoTile'

const storageKey = 'meraki-videowall-layout-v1'
function savedSlots(): (string | null)[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) || 'null')
    if (Array.isArray(parsed) && parsed.length === 4 && parsed.every(item => item === null || typeof item === 'string')) return parsed
  } catch {}
  return [null, null, null, null]
}

export default function App() {
  const [inventory, setInventory] = useState<CameraInventory>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [network, setNetwork] = useState('')
  const [slots, setSlots] = useState(savedSlots)
  const [selected, setSelected] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const wall = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)

  async function load(refresh = false) {
    if (loadingRef.current) return
    loadingRef.current = true; setLoading(true); setError('')
    try {
      const data = await api<CameraInventory>(refresh ? '/api/cameras/refresh' : '/api/cameras', { method: refresh ? 'POST' : 'GET' })
      setInventory(data)
      setSlots(previous => previous.map(serial => data.cameras.some(camera => camera.serial === serial) ? serial : null))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Inventaire indisponible.') }
    finally { loadingRef.current = false; setLoading(false) }
  }
  useEffect(() => {
    const controller = new AbortController()
    loadingRef.current = true
    void api<CameraInventory>('/api/cameras', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]) })
      .then(data => {
        if (controller.signal.aborted) return
        setInventory(data)
        setSlots(previous => previous.map(serial => data.cameras.some(camera => camera.serial === serial) ? serial : null))
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Inventaire indisponible.')
      })
      .finally(() => {
        if (!controller.signal.aborted) { loadingRef.current = false; setLoading(false) }
      })
    return () => controller.abort()
  }, [])
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(slots)) } catch {} }, [slots])
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer) }, [])

  const cameras = inventory?.cameras || []
  const networks = [...new Set(cameras.map(camera => camera.network))].sort()
  const filtered = cameras.filter(camera => (!network || camera.network === network) && `${camera.name} ${camera.model} ${camera.serial} ${camera.tags.join(' ')}`.toLocaleLowerCase('fr').includes(deferredQuery.toLocaleLowerCase('fr')))
  const online = cameras.filter(camera => camera.status === 'online').length
  const assigned = slots.filter(Boolean).length

  function assign(serial: string) {
    setSlots(previous => previous.map((value, index) => index === selected ? serial : value === serial ? null : value))
    const nextEmpty = slots.findIndex((value, index) => index !== selected && !value)
    if (nextEmpty !== -1) setSelected(nextEmpty)
    setSidebarOpen(false)
  }
  async function toggleWallFullscreen() {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await wall.current?.requestFullscreen() }
    catch { setError('Plein ecran indisponible sur ce navigateur.') }
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-icon"><Grid2X2 size={22} /></span><span>meraki<span className="brand-divider">/</span><strong>Video Wall</strong></span></div>
      <div className="topbar-right">{inventory?.demo && <span className="demo-label">Demonstration</span>}<span className="system-label"><i className={error ? 'dot warning' : 'dot'} />{loading ? 'Synchronisation' : error ? 'Attention' : 'Connecte'}</span><time dateTime={now.toISOString()}>{now.toLocaleTimeString('fr-FR')}</time></div>
    </header>
    <div className="workspace">
      {sidebarOpen && <button className="sidebar-backdrop" aria-label="Fermer la liste des cameras" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="Liste des cameras">
        <div className="sidebar-title"><h2>Cameras <span>{cameras.length}</span></h2><button className="icon-button" onClick={() => void load(true)} disabled={loading} title="Actualiser les cameras" aria-label="Actualiser les cameras"><RefreshCw className={loading ? 'spin' : ''} size={17} /></button><button className="icon-button mobile-close" onClick={() => setSidebarOpen(false)} title="Fermer" aria-label="Fermer"><X size={18} /></button></div>
        <label className="search-field"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Rechercher une camera" aria-label="Rechercher une camera" />{query && <button className="icon-button" onClick={() => setQuery('')} title="Effacer la recherche" aria-label="Effacer la recherche"><X size={14} /></button>}</label>
        <div className="network-field"><select value={network} onChange={event => setNetwork(event.target.value)} aria-label="Filtrer par reseau"><option value="">Tous les reseaux</option>{networks.map(name => <option key={name}>{name}</option>)}</select><ChevronDown size={15} /></div>
        <div className="list-meta"><span>{filtered.length} cameras</span><span><i className="dot" />{online} en ligne</span></div>
        <div className="camera-list">
          {loading && !inventory && <div className="list-empty"><RefreshCw size={22} className="spin" /><span>Chargement</span></div>}
          {!loading && filtered.length === 0 && <div className="list-empty"><CameraIcon size={28} /><span>{error ? 'Liste indisponible' : 'Aucune camera'}</span></div>}
          {filtered.map(camera => {
            const slot = slots.indexOf(camera.serial)
            return <button key={camera.serial} className={`camera-row ${slot >= 0 ? 'assigned' : ''}`} onClick={() => assign(camera.serial)} title={`${camera.name} - ${camera.serial}`}>
              <span className="camera-row-icon"><CameraIcon size={19} /><i className={`camera-status ${camera.status}`} /></span>
              <span className="camera-row-info"><strong>{camera.name}</strong><span>{camera.model}<span className="meta-separator">/</span>{camera.network}</span></span>
              {slot >= 0 && <span className="assignment">0{slot + 1}</span>}
            </button>
          })}
        </div>
        <div className="sidebar-bottom"><span><i className="dot" />{inventory?.demo ? 'Inventaire de demonstration' : 'Cisco Meraki Dashboard'}</span><span>{inventory ? `Mis a jour a ${new Date(inventory.updatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : 'En attente de synchronisation'}</span></div>
      </aside>
      <main className="main-content">
        <div className="wall-toolbar"><div className="wall-heading"><button className="icon-button sidebar-toggle" onClick={() => setSidebarOpen(true)} title="Cameras" aria-label="Ouvrir la liste des cameras"><Menu size={22} /></button><div><h1>Vue en direct</h1><span>{assigned} / 4 emplacements attribues</span></div></div>
          <div className="wall-actions"><span className="layout-indicator"><Grid2X2 size={16} />2 x 2</span><button className="icon-button" onClick={() => { if (window.confirm('Retirer les quatre cameras du mur ?')) setSlots([null, null, null, null]) }} disabled={!assigned} title="Vider le mur" aria-label="Vider le mur"><Trash2 size={18} /></button><button className="fullscreen-button" onClick={() => void toggleWallFullscreen()} title="Plein ecran du mur"><Monitor size={17} /><span>Plein ecran</span></button></div>
        </div>
        {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => void load(true)} disabled={loading}>Reessayer</button></div>}
        <div ref={wall} className="video-wall">{slots.map((serial, index) => <VideoTile key={index} camera={cameras.find(camera => camera.serial === serial)} index={index} selected={selected === index} onSelect={() => setSelected(index)} onRemove={() => setSlots(previous => previous.map((value, slot) => slot === index ? null : value))} />)}</div>
        <footer className="wall-bottom"><span><i className="selection-dot" />Emplacement selectionne : 0{selected + 1}</span><span>{inventory?.demo ? 'Mode demonstration / clip public' : 'RTSP / WebRTC'}<span className="meta-separator">/</span>Video uniquement</span></footer>
      </main>
    </div>
  </div>
}