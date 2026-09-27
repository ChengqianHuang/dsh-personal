/**
 * Prefixed random id minting for personal rows. Ids stay readable in direct
 * SQLite reads (`movie_...`, `task_...`) while remaining collision-safe.
 * @module @deepseek-ai/dsh-personal/store/ids
 */

/**
 * Mint one `<prefix>_<24 hex>` id.
 * @param prefix - short lowercase type prefix, e.g. `movie`.
 * @returns the minted id.
 */
export function mintId(prefix: string): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const body = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${prefix}_${body}`
}
