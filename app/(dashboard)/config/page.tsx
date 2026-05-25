'use client'

import { useState, useEffect } from 'react'

interface ConfigGroups {
  [key: string]: Record<string, string>
}

const GROUP_LABELS: Record<string, string> = {
  global: 'Global Risk & Position Sizing',
  evilPanda: 'Evil Panda Strategy',
  scalpSpike: 'Scalp Spike Strategy',
  scanner: 'Scanner Tuning',
}

export default function ConfigPage() {
  const [groups, setGroups] = useState<ConfigGroups>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  // Load current config
  useEffect(() => {
    async function loadConfig() {
      try {
        const res = await fetch('/api/config')
        const data = await res.json()
        setGroups(data.groups || {})
      } catch (err) {
        console.error(err)
        setMessage('Failed to load configuration')
      } finally {
        setLoading(false)
      }
    }
    loadConfig()
  }, [])

  const handleChange = (group: string, key: string, value: string) => {
    setGroups((prev) => ({
      ...prev,
      [group]: {
        ...prev[group],
        [key]: value,
      },
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    setMessage('')

    try {
      // Flatten all values
      const flatConfig: Record<string, string> = {}
      Object.values(groups).forEach((groupValues) => {
        Object.assign(flatConfig, groupValues)
      })

      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(flatConfig),
      })

      const result = await res.json()

      if (result.success) {
        setMessage('Configuration saved successfully. Applying changes...')
        // Trigger the full restart
        await fetch('/api/config/apply', { method: 'POST' })
        setMessage('Restart command sent! The bot will restart shortly. Please refresh the page in 1-2 minutes.')
      } else {
        setMessage('Failed to save configuration')
      }
    } catch (err) {
      console.error(err)
      setMessage('Error saving configuration')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="p-8">Loading configuration...</div>
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-2">Bot Configuration</h1>
      <p className="text-zinc-400 mb-8">
        Edit strategy and risk parameters. Changes will trigger a full bot restart.
      </p>

      <div className="space-y-10">
        {Object.entries(groups).map(([groupKey, values]) => (
          <div key={groupKey} className="border border-zinc-700 rounded-xl p-6 bg-zinc-900">
            <h2 className="text-xl font-semibold mb-4 text-white">
              {GROUP_LABELS[groupKey] || groupKey}
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {Object.entries(values).map(([key, value]) => (
                <div key={key}>
                  <label className="block text-sm font-medium text-zinc-300 mb-1">
                    {key.replace(/_/g, ' ')}
                  </label>
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => handleChange(groupKey, key, e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-pink-500"
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-10 flex flex-col items-start gap-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-3 bg-pink-600 hover:bg-pink-700 disabled:opacity-50 rounded-lg font-semibold text-lg transition"
        >
          {saving ? 'Saving & Restarting...' : 'Save & Restart Bot'}
        </button>

        {message && (
          <div className="text-sm text-emerald-400 bg-emerald-950 border border-emerald-800 px-4 py-2 rounded">
            {message}
          </div>
        )}

        <p className="text-xs text-zinc-500 max-w-lg">
          Clicking the button will save your changes and run a full deployment + PM2 restart on the server.
          The dashboard will temporarily go down during the restart.
        </p>
      </div>
    </div>
  )
}
