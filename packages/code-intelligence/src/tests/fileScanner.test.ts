import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_CONFIG } from '../config.ts'
import { scanRepoFiles, scanSingleFile } from '../indexing/fileScanner.ts'

function testConfig() {
  return {
    ...DEFAULT_CONFIG,
    include: ['**/*'] as string[],
    exclude: [...DEFAULT_CONFIG.exclude],
  }
}

async function createSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'EPERM' || code === 'EACCES') return false
    throw error
  }
}

describe('fileScanner repo scope', () => {
  it('scans regular in-repo files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-ci-scan-inrepo-'))
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'app.ts'), 'export const app = 1\n')

      const result = await scanRepoFiles(root, testConfig())
      assert.deepEqual(
        result.files.map((file) => file.relativePath).sort(),
        ['src/app.ts']
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips symlink to a file outside the repo', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'pi-ci-scan-out-file-'))
    const root = await mkdtemp(join(tmpdir(), 'pi-ci-scan-symlink-file-'))
    try {
      await writeFile(join(outsideRoot, 'secret.ts'), 'export const secret = 1\n')
      const linkPath = join(root, 'escape.ts')
      const linked = await createSymlink(join(outsideRoot, 'secret.ts'), linkPath)
      if (!linked) {
        console.log('skip: symlink file test requires permission to create symlinks')
        return
      }
      await writeFile(join(root, 'local.ts'), 'export const local = 1\n')

      const result = await scanRepoFiles(root, testConfig())
      const paths = result.files.map((file) => file.relativePath).sort()

      assert.equal(paths.includes('escape.ts'), false)
      assert.deepEqual(paths, ['local.ts'])
      assert.equal(await scanSingleFile(root, 'escape.ts', testConfig()), undefined)
      assert(result.summary.skippedIgnored >= 1)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('skips symlink to a directory outside the repo', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'pi-ci-scan-out-dir-'))
    const root = await mkdtemp(join(tmpdir(), 'pi-ci-scan-symlink-dir-'))
    try {
      await mkdir(join(outsideRoot, 'nested'), { recursive: true })
      await writeFile(join(outsideRoot, 'nested', 'outside.ts'), 'export const outside = 1\n')
      const linkPath = join(root, 'external')
      const linked = await createSymlink(outsideRoot, linkPath)
      if (!linked) {
        console.log('skip: symlink directory test requires permission to create symlinks')
        return
      }
      await writeFile(join(root, 'local.ts'), 'export const local = 1\n')

      const result = await scanRepoFiles(root, testConfig())
      const paths = result.files.map((file) => file.relativePath).sort()

      assert.equal(paths.some((path) => path.startsWith('external/')), false)
      assert.deepEqual(paths, ['local.ts'])
      assert(result.summary.skippedIgnored >= 1)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })
})
