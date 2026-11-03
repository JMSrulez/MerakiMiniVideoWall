import 'dotenv/config'
import { createApp } from './app.js'
import { readConfig } from './config.js'

try {
  const config = readConfig(process.env)
  const server = createApp(config).listen(config.port, '0.0.0.0', () => {
    console.log(`Meraki Video Wall : port ${config.port} (${config.demo ? 'demonstration' : 'Meraki'})`)
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(1), 10_000).unref()
    })
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Configuration invalide.')
  process.exit(1)
}