export interface Config {
  port: number
  username: string
  password: string
  apiKey: string
  organizationId: string
  mediaApi: string
  mediaWebrtc: string
  demo: boolean
  production: boolean
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  if (!env.APP_PASSWORD || env.APP_PASSWORD.length < 12) {
    throw new Error('APP_PASSWORD doit contenir au moins 12 caracteres.')
  }
  const demo = env.DEMO_MODE === 'true'
  if (!demo && (!env.MERAKI_API_KEY || !env.MERAKI_ORGANIZATION_ID)) {
    throw new Error('Configurer MERAKI_API_KEY et MERAKI_ORGANIZATION_ID, ou DEMO_MODE=true.')
  }
  return {
    port: Number(env.PORT || 3000),
    username: env.APP_USERNAME || 'admin',
    password: env.APP_PASSWORD,
    apiKey: env.MERAKI_API_KEY || '',
    organizationId: env.MERAKI_ORGANIZATION_ID || '',
    mediaApi: env.MEDIAMTX_API_URL || 'http://127.0.0.1:9997',
    mediaWebrtc: env.MEDIAMTX_WEBRTC_URL || 'http://127.0.0.1:8889',
    demo,
    production: env.NODE_ENV === 'production',
  }
}