import assert from 'node:assert/strict'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_CONFIG } from '../config.ts'
import {
  createFileWatcherOptions,
  shouldIgnoreWatchPath,
  watchPathToRelative,
} from '../indexing/fileWatcher.ts'

const posixRepoRoot = '/repo/project'
const windowsRepoRoot = 'C:/Users/A.Volkov/Projects/my-app'

function testConfig(overrides: { include?: string[]; exclude?: string[] } = {}) {
  return {
    include: overrides.include ?? (['**/*'] as string[]),
    exclude: overrides.exclude ?? [...DEFAULT_CONFIG.exclude],
  }
}

function dirStats(): Stats {
  return { isDirectory: () => true, isFile: () => false } as Stats
}

function fileStats(): Stats {
  return { isDirectory: () => false, isFile: () => true } as Stats
}

describe('fileWatcher', () => {
  describe('watchPathToRelative', () => {
    it('keeps in-repo paths on posix', () => {
      assert.equal(watchPathToRelative(posixRepoRoot, join(posixRepoRoot, 'src/app.ts')), 'src/app.ts')
      assert.equal(watchPathToRelative(posixRepoRoot, join(posixRepoRoot, 'README.md')), 'README.md')
    })

    it('keeps in-repo paths on Windows-style repo root', () => {
      assert.equal(
        watchPathToRelative(windowsRepoRoot, 'C:/Users/A.Volkov/Projects/my-app/src/app.ts'),
        'src/app.ts'
      )
    })

    it('drops sibling and parent paths outside repo', () => {
      assert.equal(watchPathToRelative(posixRepoRoot, '/repo/other-project/file.ts'), undefined)
      assert.equal(
        watchPathToRelative(posixRepoRoot, join(posixRepoRoot, '..', 'AppData', 'Local', 'ElevatedDiagnostics')),
        undefined
      )
      assert.equal(
        watchPathToRelative(windowsRepoRoot, 'C:/Users/A.Volkov/AppData/Local/ElevatedDiagnostics'),
        undefined
      )
    })

    it('drops traversal segments that escape repo even when prefixed with in-repo path', () => {
      assert.equal(
        watchPathToRelative(posixRepoRoot, join(posixRepoRoot, 'src', '..', '..', 'outside.ts')),
        undefined
      )
    })
  })

  describe('shouldIgnoreWatchPath', () => {
    it('ignores excluded directories inside repo', () => {
      const config = testConfig()
      assert.equal(
        shouldIgnoreWatchPath(join(posixRepoRoot, 'node_modules'), dirStats(), posixRepoRoot, config),
        true
      )
      assert.equal(
        shouldIgnoreWatchPath(join(posixRepoRoot, 'node_modules', 'pkg', 'index.js'), fileStats(), posixRepoRoot, config),
        true
      )
      assert.equal(shouldIgnoreWatchPath(join(posixRepoRoot, '.git'), dirStats(), posixRepoRoot, config), true)
      assert.equal(shouldIgnoreWatchPath(join(posixRepoRoot, 'dist'), dirStats(), posixRepoRoot, config), true)
    })

    it('watches included source files inside repo', () => {
      const config = testConfig()
      assert.equal(
        shouldIgnoreWatchPath(join(posixRepoRoot, 'src/app.ts'), fileStats(), posixRepoRoot, config),
        false
      )
    })

    it('ignores paths outside repo regardless of stats (Windows EPERM regression)', () => {
      const config = testConfig()
      const elevatedDiagnostics = 'C:/Users/A.Volkov/AppData/Local/ElevatedDiagnostics'

      assert.equal(shouldIgnoreWatchPath(elevatedDiagnostics, dirStats(), posixRepoRoot, config), true)
      assert.equal(shouldIgnoreWatchPath(elevatedDiagnostics, fileStats(), posixRepoRoot, config), true)
      assert.equal(shouldIgnoreWatchPath(elevatedDiagnostics, undefined, posixRepoRoot, config), true)
      assert.equal(
        shouldIgnoreWatchPath(elevatedDiagnostics, undefined, windowsRepoRoot, config),
        true
      )
    })

    it('ignores outside paths even when include is narrowed to src/**', () => {
      const config = testConfig({ include: ['src/**'] })
      const outside = 'C:/Users/A.Volkov/AppData/Local/ElevatedDiagnostics'
      assert.equal(shouldIgnoreWatchPath(outside, fileStats(), windowsRepoRoot, config), true)
    })

    it('respects custom exclude patterns for in-repo paths', () => {
      const config = testConfig({ exclude: [...DEFAULT_CONFIG.exclude, 'legacy/**'] })
      assert.equal(
        shouldIgnoreWatchPath(join(posixRepoRoot, 'legacy/old.ts'), fileStats(), posixRepoRoot, config),
        true
      )
      assert.equal(
        shouldIgnoreWatchPath(join(posixRepoRoot, 'src/new.ts'), fileStats(), posixRepoRoot, config),
        false
      )
    })

    it('treats excluded directory entries as ignored before include rules run', () => {
      const config = testConfig({ include: ['**/*'] })
      assert.equal(
        shouldIgnoreWatchPath(join(posixRepoRoot, 'coverage'), dirStats(), posixRepoRoot, config),
        true
      )
    })

    it('does not watch files excluded by pattern even when stats are missing', () => {
      const config = testConfig()
      assert.equal(
        shouldIgnoreWatchPath(join(posixRepoRoot, 'dist/bundle.js'), undefined, posixRepoRoot, config),
        true
      )
    })
  })

  describe('createFileWatcherOptions', () => {
    it('enables Windows-safe chokidar flags from the EPERM fix', () => {
      const options = createFileWatcherOptions(posixRepoRoot, testConfig())
      assert.equal(options.followSymlinks, false)
      assert.equal(options.ignorePermissionErrors, true)
      assert.equal(options.ignoreInitial, true)
      assert.equal(options.persistent, true)
    })

    it('routes ignored paths through shouldIgnoreWatchPath', () => {
      const options = createFileWatcherOptions(windowsRepoRoot, testConfig())
      const outside = 'C:/Users/A.Volkov/AppData/Local/ElevatedDiagnostics'

      assert.equal(options.ignored(outside, dirStats()), true)
      assert.equal(
        options.ignored('C:/Users/A.Volkov/Projects/my-app/src/app.ts', fileStats()),
        false
      )
      assert.equal(
        options.ignored('C:/Users/A.Volkov/Projects/my-app/node_modules/pkg/index.js', fileStats()),
        true
      )
    })

    if (process.platform === 'win32') {
      it('resolves native Windows backslash paths from the EPERM report', () => {
        const repoRoot = 'C:\\Users\\A.Volkov\\Projects\\my-app'
        const config = testConfig()
        const elevatedDiagnostics = 'C:\\Users\\A.Volkov\\AppData\\Local\\ElevatedDiagnostics'

        assert.equal(watchPathToRelative(repoRoot, `${repoRoot}\\src\\app.ts`), 'src/app.ts')
        assert.equal(shouldIgnoreWatchPath(elevatedDiagnostics, dirStats(), repoRoot, config), true)
        assert.equal(createFileWatcherOptions(repoRoot, config).ignored(elevatedDiagnostics, dirStats()), true)
      })
    }
  })
})
