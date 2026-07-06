import type { CodeIntelligenceRuntime } from '../lifecycle/activate.ts'
import { renderStatusCard } from '@catdaemon/pi-sidebar'

type Component = {
  render(width: number): string[]
  invalidate(): void
}

type ProgressTheme = {
  fg?: (color: string, text: string) => string
  bold?: (text: string) => string
}

import { getEmbeddingStats } from '../db/repositories/embeddingsRepo.ts'
import { getEmbeddingStatus } from '../db/repositories/embeddingStatusRepo.ts'
import { getIndexingState } from '../db/repositories/indexingStateRepo.ts'
import type { EmbeddingProviderKind, EmbeddingService } from '../embeddings/EmbeddingService.ts'

export class CodeIntelligenceProgressWidget implements Component {
  private cachedWidth?: number
  private cachedLines?: string[]

  constructor(
    private readonly getRuntime: () => CodeIntelligenceRuntime | undefined,
    private readonly getTheme?: () => ProgressTheme | undefined,
    private readonly onLayout?: (layout: { visible: boolean; height: number }) => void
  ) {}

  render(width: number): string[] {
    const runtime = this.getRuntime()
    if (!runtime) {
      this.onLayout?.({ visible: false, height: 0 })
      this.cachedWidth = undefined
      this.cachedLines = undefined
      return []
    }

    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines

    const indexStatus = runtime.indexScheduler.getStatus()
    const embeddingService = runtime.services.get<EmbeddingService>('embeddingService')
    const storedEmbeddingStatus = getEmbeddingStatus(runtime.db)
    const embeddingStatus = storedEmbeddingStatus?.status ?? embeddingService?.status ?? 'not_started'
    const embeddingStats = getEmbeddingStats(runtime.db, runtime.identity.repoKey)
    const indexingState = getIndexingState(runtime.db)
    const degraded = Boolean(indexStatus.degradedWarning)
    const workerActive = Boolean(indexStatus.workerPid) && !indexStatus.workerProgressStale
    const busy = !degraded && isCodeIntelligenceBusy({
      indexRunning: indexStatus.running,
      queuedJobs: indexStatus.queuedJobs,
      workerActive,
      embeddingStatus,
      missingEmbeddings: embeddingStats.missingEmbeddings,
    })
    if (!busy) {
      this.onLayout?.({ visible: false, height: 0 })
      this.cachedWidth = undefined
      this.cachedLines = undefined
      return []
    }

    const theme = this.getTheme?.()
    const worker = workerActive ? `worker ${indexStatus.workerPid}` : indexStatus.queuedJobs > 0 ? 'queued' : 'pending'
    const action = indexStatus.queuedJobs > 0 && !indexStatus.running && !workerActive ? 'Queued' : 'Indexing'
    const pct = embeddingStats.totalEmbeddableChunks > 0
      ? `${Math.round((embeddingStats.embeddedChunks / embeddingStats.totalEmbeddableChunks) * 100)}%`
      : '0%'
    const bodyLines = [
      ` → ${action} • ${worker}`,
      ` ○ Phase ${indexingState?.progress_phase ?? 'pending'}${indexingState?.progress_current_path ? ` • ${indexingState.progress_current_path}` : ''}`,
    ]
    if (isFileWorkVisible(indexStatus.currentJobKind, indexStatus.running, indexStatus.queuedJobs, workerActive)) {
      bodyLines.push(` ○ ${formatFileProgress(
        indexStatus.currentJobKind,
        indexingState?.progress_phase,
        indexingState?.progress_files_scanned ?? indexStatus.stats.activeFiles ?? 0,
        indexStatus.stats.totalFiles
      )}`)
    }
    if (isEmbeddingWorkVisible(embeddingStatus, embeddingStats.missingEmbeddings)) {
      const throughput = formatEmbeddingThroughputLine(storedEmbeddingStatus?.embedding_rate_per_second, storedEmbeddingStatus?.embedding_eta_seconds)
      bodyLines.push(` ○ Embeddings ${embeddingStats.embeddedChunks}/${embeddingStats.totalEmbeddableChunks} (${pct})`)
      if (throughput) bodyLines.push(` ○ ${throughput}`)
    }
    const downloadLine = formatEmbeddingDownloadLine({
      status: storedEmbeddingStatus?.download_status ?? embeddingService?.downloadStatus,
      file: storedEmbeddingStatus?.download_file ?? embeddingService?.downloadFile,
      loadedBytes: storedEmbeddingStatus?.download_loaded_bytes ?? embeddingService?.downloadLoadedBytes,
      totalBytes: storedEmbeddingStatus?.download_total_bytes ?? embeddingService?.downloadTotalBytes,
      progress: storedEmbeddingStatus?.download_progress ?? embeddingService?.downloadProgress,
    })
    if (downloadLine) bodyLines.push(` ○ ${downloadLine}`)
    const workerActiveForBackend = workerActive
    const backendLine = formatEmbeddingBackendLine({
      kind: resolveWidgetBackendKind(workerActiveForBackend, storedEmbeddingStatus?.provider, embeddingService?.kind, runtime.config.embedding.provider),
      storedProvider: storedEmbeddingStatus?.provider,
      activeDevice: storedEmbeddingStatus?.active_device ?? embeddingService?.activeDevice,
      configuredDevice: runtime.config.embedding.provider === 'local' ? runtime.config.embedding.device : undefined,
      modelId: workerActiveForBackend
        ? storedEmbeddingStatus?.active_model ?? embeddingService?.modelId
        : embeddingService?.modelId ?? storedEmbeddingStatus?.active_model,
    })
    if (backendLine) bodyLines.push(` ○ ${backendLine}`)
    const statusLine = formatEmbeddingStatusLine(embeddingStatus, embeddingStats.missingEmbeddings)
    if (statusLine) bodyLines.push(` ○ ${statusLine}`)

    const lines = renderStatusCard(
      {
        fg: (color: string, text: string) => style(theme, color, text),
        bold: (text: string) => theme?.bold?.(text) ?? text,
      },
      'Code Intelligence',
      bodyLines,
      width
    )
    this.onLayout?.({ visible: true, height: lines.length })
    this.cachedLines = lines
    this.cachedWidth = width
    return lines
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }
}

export function isActiveEmbeddingStatus(embeddingStatus: string): boolean {
  return !['ready', 'fts_only', 'failed', 'not_started'].includes(embeddingStatus)
}

export function isCodeIntelligenceBusy(input: {
  indexRunning: boolean
  queuedJobs: number
  workerActive: boolean
  embeddingStatus: string
  missingEmbeddings: number
}): boolean {
  const indexingActive = input.indexRunning || input.queuedJobs > 0 || input.workerActive
  const embeddingActive = input.missingEmbeddings > 0 || isActiveEmbeddingStatus(input.embeddingStatus)
  return indexingActive || embeddingActive
}

export function formatFileProgress(
  jobKind: string | undefined,
  progressPhase: string | null | undefined,
  processedFiles: number,
  totalFiles: number | undefined
): string {
  if (progressPhase === 'scanning' && (totalFiles ?? 0) === 0) {
    return processedFiles > 0 ? `Scanning • ${processedFiles} files found` : 'Scanning repository...'
  }
  if (jobKind === 'fullRepoIndex') return `Files ${processedFiles}/${totalFiles ?? '?'}`
  if (jobKind === 'changedFilesIndex') return `Changed files ${processedFiles}`
  if (jobKind === 'deletedFileCleanup') return `Deleted files ${processedFiles}`
  if (jobKind === 'embeddingBackfill') return `Files ${totalFiles ?? processedFiles}`
  return `Files ${processedFiles}`
}

export function isFileWorkVisible(jobKind: string | undefined, running: boolean, queuedJobs: number, workerActive = running || queuedJobs > 0): boolean {
  return jobKind !== 'embeddingBackfill' && (running || queuedJobs > 0 || workerActive)
}

export function isEmbeddingWorkVisible(embeddingStatus: string, missingEmbeddings: number): boolean {
  return missingEmbeddings > 0 || !['ready', 'fts_only', 'failed', 'not_started'].includes(embeddingStatus)
}

export function formatEmbeddingStatusLine(embeddingStatus: string, missingEmbeddings: number): string | undefined {
  if (embeddingStatus === 'ready' && missingEmbeddings > 0) return undefined
  if (embeddingStatus === 'ready') return undefined
  return `Status ${embeddingStatus}`
}

export function formatEmbeddingBackendLine(input: {
  kind?: EmbeddingProviderKind
  storedProvider?: string
  activeDevice?: string | null
  configuredDevice?: string
  modelId?: string | null
}): string | undefined {
  const kind = input.kind ?? mapStoredEmbeddingProvider(input.storedProvider)
  if (kind === 'disabled') return 'Provider disabled (FTS only)'
  if (kind === 'openai-compatible') {
    const model = formatRemoteModelName(input.modelId)
    return model ? `Provider remote • ${model}` : 'Provider remote'
  }
  return formatEmbeddingDeviceLine(
    input.activeDevice ?? undefined,
    input.configuredDevice,
    input.modelId
  )
}

export function formatEmbeddingDeviceLine(activeDevice: string | undefined, configuredDevice: string | undefined, modelId?: string | null): string | undefined {
  const device = activeDevice || configuredDevice
  if (!device) return undefined
  const model = modelId ? ` • ${shortModelName(modelId)}` : ''
  return activeDevice ? `Device ${activeDevice}${model}` : `Device ${device} requested${model}`
}

export function formatEmbeddingProviderLabel(
  kind?: EmbeddingProviderKind,
  storedProvider?: string
): string {
  const resolved = kind ?? mapStoredEmbeddingProvider(storedProvider)
  if (resolved === 'openai-compatible') return 'remote (openai-compatible)'
  if (resolved === 'disabled') return 'disabled (FTS only)'
  return 'local (transformers)'
}

function resolveWidgetBackendKind(
  workerActive: boolean,
  storedProvider: string | undefined,
  serviceKind: EmbeddingProviderKind | undefined,
  configuredKind: EmbeddingProviderKind
): EmbeddingProviderKind {
  if (workerActive && storedProvider) {
    return mapStoredEmbeddingProvider(storedProvider) ?? configuredKind
  }
  return serviceKind ?? configuredKind
}

function mapStoredEmbeddingProvider(provider?: string): EmbeddingProviderKind | undefined {
  if (provider === 'openai-compatible') return 'openai-compatible'
  if (provider === 'disabled') return 'disabled'
  if (provider === 'transformers') return 'local'
  return undefined
}

function formatRemoteModelName(modelId?: string | null): string | undefined {
  if (!modelId) return undefined
  const separator = modelId.indexOf('::')
  if (separator >= 0) return modelId.slice(separator + 2) || undefined
  return shortModelName(modelId)
}

export function formatEmbeddingThroughputLine(rate?: number | null, etaSeconds?: number | null): string | undefined {
  if (!rate || rate <= 0) return undefined
  const eta = etaSeconds && etaSeconds > 0 ? ` • ETA ${formatDuration(etaSeconds)}` : ''
  return `Rate ${formatRate(rate)}/s${eta}`
}

export function formatEmbeddingDownloadLine(input: {
  status?: string
  file?: string
  loadedBytes?: number | null
  totalBytes?: number | null
  progress?: number | null
}): string | undefined {
  if (!input.status && !input.file && input.progress == null) return undefined
  const status = input.status ? humanizeDownloadStatus(input.status) : 'Preparing model'
  const file = input.file ? ` ${shortFileName(input.file)}` : ''
  const pct = input.progress == null ? '' : ` ${Math.round(input.progress)}%`
  const size = formatDownloadSize(input.loadedBytes ?? undefined, input.totalBytes ?? undefined)
  return `${status}${file}${pct}${size ? ` • ${size}` : ''}`
}

function humanizeDownloadStatus(status: string): string {
  if (status === 'download' || status === 'progress') return 'Downloading'
  if (status === 'ready') return 'Downloaded'
  if (status === 'initiate') return 'Starting download'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function formatDownloadSize(loaded: number | undefined, total: number | undefined): string | undefined {
  if (loaded != null && total != null) return `${formatBytes(loaded)}/${formatBytes(total)}`
  if (total != null) return formatBytes(total)
  if (loaded != null) return formatBytes(loaded)
  return undefined
}

function formatRate(rate: number): string {
  return rate >= 10 ? rate.toFixed(0) : rate.toFixed(1)
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds))
  if (rounded < 60) return `${rounded}s`
  const minutes = Math.floor(rounded / 60)
  const remainingSeconds = rounded % 60
  if (minutes < 60) return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function shortFileName(file: string): string {
  return file.split('/').pop() || file
}

function shortModelName(modelId: string): string {
  return modelId.split('/').at(-1) || modelId
}

function style(theme: ProgressTheme | undefined, color: string, text: string): string {
  return theme?.fg?.(color, text) ?? text
}
