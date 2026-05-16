import { NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const DEPLOY_COMMAND = `
cd /meteoracle && \
git pull && \
npm install && \
npm run build && \
pm2 stop all && \
pm2 delete all && \
pm2 flush && \
pm2 start ecosystem.config.cjs --update-env && \
pm2 save
`.trim()

export async function POST() {
  try {
    // Run the deploy command in background so the response can return immediately
    execAsync(DEPLOY_COMMAND, { shell: '/bin/bash' })
      .then(() => console.log('[config] Deployment command completed'))
      .catch((err) => console.error('[config] Deployment command failed:', err))

    return NextResponse.json({
      success: true,
      message: 'Configuration saved. Bot is restarting (this may take 1-2 minutes). Please refresh the page shortly.',
    })
  } catch (error) {
    console.error('Apply config error:', error)
    return NextResponse.json({ error: 'Failed to trigger restart' }, { status: 500 })
  }
}
