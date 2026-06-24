import { openCodeIntelligenceDb, closeCodeIntelligenceDb } from '../db/connection.ts'
import { updateEmbeddingStatus } from '../db/repositories/embeddingStatusRepo.ts'
import type { CodeIntelligenceConfig } from '../config.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'
import { runFullRepoIndex, runIncrementalIndex } from './indexScheduler.ts'
import { embedMissingChunksForRepo, resolveEmbeddingCacheDir } from '../embeddings/embeddingIndexer.ts'
import { refreshSimilarRelationshipsForRepo } from './similarRelationships.ts'
import { createEmbeddingService } from '../embeddings/createEmbeddingService.ts'
import type { EmbeddingService } from '../embeddings/EmbeddingService.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'

type WorkerPayload = {
  storageDir: string
  identity: RepoIdentity
  config: CodeIntelligenceConfig
  job:
    | { kind: 'fullRepoIndex'; reason: string }
    | { kind: 'changedFilesIndex'; paths: string[]; reason: string }
    | { kind: 'deletedFileCleanup'; paths: string[]; reason: string }
    | { kind: 'embeddingBackfill'; reason: string }
}

type WorkerResult =
  | {
      ok: true
      kind: WorkerPayload['job']['kind']
      result: unknown
      backfilledEmbeddings: number
      similarRelationships: number
      degraded?: boolean
      warning?: string
    }
  | {
      ok: false
      error: string
    }

const logger = {
  debug(message: string, details?: unknown) { writeLog('debug', message, details) },
  info(message: string, details?: unknown) { writeLog('info', message, details) },
  warn(message: string, details?: unknown) { writeLog('warn', message, details) },
  error(message: string, details?: unknown) { writeLog('error', message, details) },
} as CodeIntelligenceLogger

const parentMonitor = startParentMonitor(parseParentPid())

function syncEmbeddingStatus(db: Awaited<ReturnType<typeof openCodeIntelligenceDb>>, service: EmbeddingService): void {
  updateEmbeddingStatus(db, {
    provider: service.provider,
    status: service.status,
    activeModel: service.modelId,
    activeDimensions: service.dimensions,
    activeDevice: service.activeDevice,
    downloadStatus: service.downloadStatus,
    downloadFile: service.downloadFile,
    downloadLoadedBytes: service.downloadLoadedBytes,
    downloadTotalBytes: service.downloadTotalBytes,
    downloadProgress: service.downloadProgress,
    cacheDir: resolveEmbeddingCacheDir(service),
    lastError: service.lastError,
  })
}

async function main(): Promise<void> {
  const raw = process.env.PI_CODE_INTELLIGENCE_WORKER_PAYLOAD
  if (!raw) throw new Error('Missing PI_CODE_INTELLIGENCE_WORKER_PAYLOAD')
  const payload = JSON.parse(raw) as WorkerPayload
  let db: Awaited<ReturnType<typeof openCodeIntelligenceDb>> | undefined
  try {
    db = await openCodeIntelligenceDb(payload.storageDir)
  } catch (error) {
    const message = (error as Error).message
    if (isSqliteNativeBindingError(message)) {
      const warning = `SQLite native binding is unavailable (${message}). Indexing is skipped for this session.`
      writeLog('warn', warning, { storageDir: payload.storageDir, job: payload.job.kind })
      const result: WorkerResult = {
        ok: true,
        kind: payload.job.kind,
        result: payload.job.kind === 'fullRepoIndex' ? emptyFullResult() : emptyIncrementalResult(),
        backfilledEmbeddings: 0,
        similarRelationships: 0,
        degraded: true,
        warning,
      }
      process.stdout.write(`${JSON.stringify(result)}\n`)
      return
    }
    throw error
  }
  try {
    const embeddingService = createEmbeddingService(payload.config, logger, (service) => {
      syncEmbeddingStatus(db, service)
    })
    const common = { identity: payload.identity, db, config: payload.config, logger, embeddingService }
    const result = payload.job.kind === 'fullRepoIndex'
      ? await runFullRepoIndex(common, payload.job.reason)
      : payload.job.kind === 'embeddingBackfill'
        ? emptyIncrementalResult()
        : await runIncrementalIndex(common, {
            changedPaths: payload.job.kind === 'changedFilesIndex' ? payload.job.paths : [],
            deletedPaths: payload.job.kind === 'deletedFileCleanup' ? payload.job.paths : [],
            reason: payload.job.reason,
          })
    const backfilledEmbeddings = await embedMissingChunksForRepo(
      db,
      embeddingService,
      payload.identity.repoKey,
      payload.config.embedding,
      1000
    )
    result.embeddingsIndexed += backfilledEmbeddings
    const similarRelationships = backfilledEmbeddings > 0 ? refreshSimilarRelationshipsForRepo(db, payload.identity.repoKey) : 0
    const workerResult: WorkerResult = { ok: true, kind: payload.job.kind, result, backfilledEmbeddings, similarRelationships }
    process.stdout.write(`${JSON.stringify(workerResult)}\n`)
  } finally {
    parentMonitor?.stop()
    closeCodeIntelligenceDb(db)
  }
}

function emptyFullResult() {
  const now = new Date().toISOString()
  return {
    scanned: 0,
    insertedOrChanged: 0,
    skippedUnchanged: 0,
    deleted: 0,
    generated: 0,
    chunksIndexed: 0,
    embeddingsIndexed: 0,
    summary: {
      scanned: 0,
      ignoredByDefault: 0,
      ignoredByPatterns: 0,
      ignoredByGenerated: 0,
      ignoredBySize: 0,
      ignoredByBinary: 0,
      ignoredByDirectory: 0,
      ignoredByNodeModules: 0,
      ignoredByDistArtifacts: 0,
      ignoredByPathSegment: 0,
      excludedByAllowlist: 0,
      excludedByDenylist: 0,
      unsupportedLanguage: 0,
    },
    startedAt: now,
    completedAt: now,
  }
}

function emptyIncrementalResult() {
  const now = new Date().toISOString()
  return {
    changedFiles: 0,
    deletedFiles: 0,
    skippedUnchanged: 0,
    skippedIgnored: 0,
    chunksIndexed: 0,
    embeddingsIndexed: 0,
    startedAt: now,
    completedAt: now,
  }
}

function isSqliteNativeBindingError(message: string): boolean {
  const normalized = String(message ?? '')
  return normalized.includes('Could not locate the bindings file') ||
    normalized.includes('better_sqlite3.node') ||
    normalized.includes('better-sqlite3')
}

function writeLog(level: string, message: string, details?: unknown): void {
  if (process.env.PI_CODE_INTELLIGENCE_LOG_LEVEL === 'debug') {
    process.stderr.write(`[pi-code-intelligence:index-worker] ${level} ${message}${details ? ` ${JSON.stringify(details)}` : ''}\n`)
  }
}

function parseParentPid(): number | undefined {
  const arg = process.argv.find((item) => item.startsWith('--parent-pid='))
  const raw = arg?.slice('--parent-pid='.length) ?? process.env.PI_CODE_INTELLIGENCE_PARENT_PID
  if (!raw) return undefined
  const pid = Number.parseInt(raw, 10)
  return Number.isFinite(pid) ? pid : undefined
}

function startParentMonitor(parentPid: number | undefined): { stop(): void } | undefined {
  if (!parentPid) return undefined
  const timer = setInterval(() => {
    if (isProcessAlive(parentPid)) return
    writeLog('warn', 'parent process exited; stopping orphaned worker', { parentPid })
    process.exit(0)
  }, 1000)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: (error as Error).message })}\n`)
  process.exit(1)
})
