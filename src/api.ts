export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options,
    headers: { 'X-Videowall-Request': '1', ...options.headers },
    signal: options.signal || AbortSignal.timeout(45_000),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || `Erreur ${response.status}`)
  }
  return await response.json() as T
}