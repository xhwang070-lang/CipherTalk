import { dbAdapter } from '../dbAdapter'

/** 微信「折叠的聊天」聚合入口 */
export const FOLD_GROUP_USERNAME = '@placeholder_foldgroup'
const COLLAPSED_FLAG = 0x10000000

export function isFoldGroupUsername(username: string): boolean {
  return String(username || '').trim().toLowerCase() === FOLD_GROUP_USERNAME
}

export async function loadCollapsedUsernames(): Promise<Set<string>> {
  const out = new Set<string>([FOLD_GROUP_USERNAME])
  try {
    const cols = await dbAdapter.all<{ name: string }>('contact', '', 'PRAGMA table_info(contact)')
    if (!cols.some((col) => col.name === 'flag') || !cols.some((col) => col.name === 'username')) {
      return out
    }
    const rows = await dbAdapter.all<{ username: string }>(
      'contact',
      '',
      `SELECT username FROM contact WHERE username IS NOT NULL AND (flag & ${COLLAPSED_FLAG}) != 0`,
    )
    for (const row of rows) {
      const username = String(row.username || '').trim()
      if (username) out.add(username)
    }
  } catch {
    /* contact.flag 不可用时至少排除聚合入口 */
  }
  return out
}

export function shouldSkipFoldedChat(username: string, collapsed: Set<string>, opts?: { allowNamed?: boolean }): boolean {
  const value = String(username || '').trim()
  if (!value) return true
  if (isFoldGroupUsername(value)) return true
  if (opts?.allowNamed) return false
  return collapsed.has(value)
}
