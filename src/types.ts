export interface Camera {
  serial: string
  name: string
  model: string
  network: string
  tags: string[]
  status: 'online' | 'offline' | 'unknown'
}

export interface CameraInventory {
  cameras: Camera[]
  demo: boolean
  updatedAt: string
}

export interface StreamDescription {
  url: string
  demo: boolean
}