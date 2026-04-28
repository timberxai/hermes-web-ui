import { resolve, join } from 'path'
import { homedir } from 'os'
import { readFileSync, existsSync } from 'fs'

// hermes agent honors $HERMES_HOME as the data directory (fall back to
// ~/.hermes). web-ui must use the same resolution or it reads a stale /
// empty tree — manifested as "Feishu config empty" in the UI and 500s on
// /api/hermes/sessions because state.db / .env live under $HERMES_HOME,
// not ~/.hermes. The single-container closeclaw deployment sets
// HERMES_HOME=/opt/data, so this alignment is required.
// Exported so other modules (model-context, gateway-manager) use the same
// base instead of re-deriving from homedir() and silently diverging.
export const HERMES_BASE = process.env.HERMES_HOME?.trim()
  || resolve(homedir(), '.hermes')

/**
 * Get the active profile's home directory.
 * default → $HERMES_HOME (or ~/.hermes)
 * other   → $HERMES_HOME/profiles/{name}/
 */
export function getActiveProfileDir(): string {
  const activeFile = join(HERMES_BASE, 'active_profile')
  try {
    const name = readFileSync(activeFile, 'utf-8').trim()
    if (name && name !== 'default') {
      const dir = join(HERMES_BASE, 'profiles', name)
      if (existsSync(dir)) return dir
    }
  } catch { }
  return HERMES_BASE
}

/**
 * Get the active profile's config.yaml path.
 */
export function getActiveConfigPath(): string {
  return join(getActiveProfileDir(), 'config.yaml')
}

/**
 * Get the active profile's auth.json path.
 */
export function getActiveAuthPath(): string {
  return join(getActiveProfileDir(), 'auth.json')
}

/**
 * Get the active profile's .env path.
 */
export function getActiveEnvPath(): string {
  return join(getActiveProfileDir(), '.env')
}

/**
 * Get the active profile name.
 */
export function getActiveProfileName(): string {
  const activeFile = join(HERMES_BASE, 'active_profile')
  try {
    const name = readFileSync(activeFile, 'utf-8').trim()
    return name || 'default'
  } catch {
    return 'default'
  }
}

/**
 * Get profile directory by name.
 * default → ~/.hermes/
 * other   → ~/.hermes/profiles/{name}/
 */
export function getProfileDir(name: string): string {
  if (!name || name === 'default') return HERMES_BASE
  const dir = join(HERMES_BASE, 'profiles', name)
  return existsSync(dir) ? dir : HERMES_BASE
}
