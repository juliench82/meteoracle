import axios from 'axios'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function redactSecrets(text: string): string {
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'botredacted')
    .replace(/([?&]api-key=)[^&\s"']+/gi, '$1redacted')
    .replace(/([?&]apikey=)[^&\s"']+/gi, '$1redacted')
    .replace(/(https:\/\/[^/\s"']+\.quiknode\.pro\/)[^\s"']+/gi, '$1redacted')
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, '$1redacted')
    .replace(/(authorization:\s*Bearer\s+)[^\s"']+/gi, '$1redacted')
}

export function summarizeError(error: unknown, maxLength = 300): string {
  let raw = ''

  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? error.status
    const parts = [
      status ? `status=${status}` : null,
      error.code ? `code=${error.code}` : null,
    ]

    const data = error.response?.data
    if (isRecord(data)) {
      const detail = data.description ?? data.error ?? data.message
      if (detail != null) parts.push(String(detail))
    } else if (typeof data === 'string' && data.trim()) {
      parts.push(data)
    }

    if (parts.length <= 2 && error.message) parts.push(error.message)
    raw = parts.filter(Boolean).join(' ')
  } else if (error instanceof Error) {
    raw = error.message
  } else if (typeof error === 'string') {
    raw = error
  } else {
    try {
      raw = JSON.stringify(error)
    } catch {
      raw = String(error)
    }
  }

  const compact = redactSecrets(raw).replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact
}

export function isAuthError(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? error.status
    if (status === 401 || status === 403) return true
  }

  const summary = summarizeError(error).toLowerCase()
  return summary.includes('401') ||
    summary.includes('403') ||
    summary.includes('unauthorized') ||
    summary.includes('forbidden') ||
    summary.includes('invalid api key')
}
