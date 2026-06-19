import type { CodeIntelligenceConfig } from '../config.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'
import type { EmbeddingService } from './EmbeddingService.ts'
import { DisabledEmbeddingService } from './disabledEmbeddingService.ts'
import { OpenAICompatibleEmbeddingService } from './openaiCompatibleEmbeddingService.ts'
import { TransformersEmbeddingService } from './transformersEmbeddingService.ts'

export function createEmbeddingService(
  config: CodeIntelligenceConfig,
  logger: CodeIntelligenceLogger,
  onStatusChange?: (service: EmbeddingService) => void
): EmbeddingService {
  const provider = config.embedding.provider

  if (provider === 'disabled') {
    return new DisabledEmbeddingService()
  }

  if (provider === 'openai-compatible') {
    if (!config.embedding.baseUrl) {
      logger.warn('embedding provider is openai-compatible but baseUrl is missing; falling back to local')
      return new TransformersEmbeddingService(config, logger, onStatusChange)
    }
    if (!config.embedding.model) {
      logger.warn('embedding provider is openai-compatible but model is missing; falling back to local')
      return new TransformersEmbeddingService(config, logger, onStatusChange)
    }
    return new OpenAICompatibleEmbeddingService({
      type: 'openai-compatible',
      baseUrl: config.embedding.baseUrl,
      apiKey: config.embedding.apiKey,
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
      batchSize: config.embedding.batchSize,
      timeoutMs: config.embedding.timeoutMs,
      maxRetries: config.embedding.maxRetries,
    })
  }

  // Default: local (transformers)
  return new TransformersEmbeddingService(config, logger, onStatusChange)
}
