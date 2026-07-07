import { relative } from 'node:path'
import { normalizeRelativePath } from './glob.ts'

export function pathToRepoRelative(repoRoot: string, path: string): string | undefined {
  const rel = normalizeRelativePath(relative(repoRoot, path))
  if (!rel || rel.startsWith('..')) return undefined
  return rel
}

export function isPathInsideRepo(repoRoot: string, absolutePath: string): boolean {
  return pathToRepoRelative(repoRoot, absolutePath) !== undefined
}

/** @deprecated Use pathToRepoRelative — kept for existing imports/tests */
export const watchPathToRelative = pathToRepoRelative
