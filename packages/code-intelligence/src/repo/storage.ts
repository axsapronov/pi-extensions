import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveXdgDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XDG_DATA_HOME?.trim()
  return configured ? configured : join(homedir(), '.local', 'share')
}

export function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim() || env.PI_AGENT_DIR?.trim()
  if (configured) {
    if (configured === '~') return homedir()
    if (configured.startsWith('~/')) return join(homedir(), configured.slice(2))
    return configured
  }
  return join(homedir(), '.pi', 'agent')
}

export function resolveGlobalCodeIntelligenceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolvePiAgentDir(env), 'code-intelligence.json')
}

export function resolveCodeIntelligenceDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveXdgDataHome(env), 'pi-code-intelligence')
}

export function resolveRepoStorageDir(repoKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveCodeIntelligenceDataDir(env), 'repos', repoKey)
}

export function resolveModelCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveCodeIntelligenceDataDir(env), 'models')
}
