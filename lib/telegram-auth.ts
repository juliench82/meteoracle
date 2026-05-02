type TelegramAuthEnv = {
  TELEGRAM_ALLOWED_USERS?: string
  TELEGRAM_CHAT_ID?: string
}

export function parseTelegramAllowedUsers(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(/[,\s]+/)
      .map(id => id.trim())
      .filter(Boolean),
  )
}

export function getTelegramAllowedUsers(env?: TelegramAuthEnv): Set<string> {
  const source = env ?? {
    TELEGRAM_ALLOWED_USERS: process.env.TELEGRAM_ALLOWED_USERS,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  }
  const explicitAllowList = source.TELEGRAM_ALLOWED_USERS?.trim()
  return parseTelegramAllowedUsers(explicitAllowList || source.TELEGRAM_CHAT_ID)
}

export function isTelegramUserAllowed(
  userId: number | string | null | undefined,
  allowedUsers: Set<string> = getTelegramAllowedUsers(),
): boolean {
  if (userId === null || userId === undefined) return false
  return allowedUsers.has(String(userId))
}

export function isTelegramCommandAllowed(
  senderUserId: number | string | null | undefined,
  chatId: number | string | null | undefined,
  allowedUsers: Set<string> = getTelegramAllowedUsers(),
): boolean {
  return (
    isTelegramUserAllowed(senderUserId, allowedUsers) ||
    isTelegramUserAllowed(chatId, allowedUsers)
  )
}
