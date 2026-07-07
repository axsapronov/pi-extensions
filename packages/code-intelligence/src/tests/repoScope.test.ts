import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { isPathInsideRepo, pathToRepoRelative } from '../indexing/repoScope.ts'

const posixRepoRoot = '/repo/project'
const windowsRepoRoot = 'C:/Users/A.Volkov/Projects/my-app'

describe('repoScope', () => {
  describe('pathToRepoRelative', () => {
    it('keeps in-repo paths on posix', () => {
      assert.equal(pathToRepoRelative(posixRepoRoot, join(posixRepoRoot, 'src/app.ts')), 'src/app.ts')
      assert.equal(pathToRepoRelative(posixRepoRoot, join(posixRepoRoot, 'README.md')), 'README.md')
    })

    it('keeps in-repo paths on Windows-style repo root', () => {
      assert.equal(
        pathToRepoRelative(windowsRepoRoot, 'C:/Users/A.Volkov/Projects/my-app/src/app.ts'),
        'src/app.ts'
      )
    })

    it('drops sibling and parent paths outside repo', () => {
      assert.equal(pathToRepoRelative(posixRepoRoot, '/repo/other-project/file.ts'), undefined)
      assert.equal(
        pathToRepoRelative(posixRepoRoot, join(posixRepoRoot, '..', 'AppData', 'Local', 'ElevatedDiagnostics')),
        undefined
      )
      assert.equal(
        pathToRepoRelative(windowsRepoRoot, 'C:/Users/A.Volkov/AppData/Local/ElevatedDiagnostics'),
        undefined
      )
    })

    it('drops traversal segments that escape repo even when prefixed with in-repo path', () => {
      assert.equal(
        pathToRepoRelative(posixRepoRoot, join(posixRepoRoot, 'src', '..', '..', 'outside.ts')),
        undefined
      )
    })
  })

  describe('isPathInsideRepo', () => {
    it('returns true for paths inside repo', () => {
      assert.equal(isPathInsideRepo(posixRepoRoot, join(posixRepoRoot, 'src/app.ts')), true)
    })

    it('returns false for paths outside repo', () => {
      assert.equal(
        isPathInsideRepo(posixRepoRoot, 'C:/Users/A.Volkov/AppData/Local/ElevatedDiagnostics'),
        false
      )
    })
  })
})
