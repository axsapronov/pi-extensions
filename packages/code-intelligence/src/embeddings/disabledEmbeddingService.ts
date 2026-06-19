import type {
	EmbeddingService,
	EmbeddingStatusValue,
} from "./EmbeddingService.ts";

export class DisabledEmbeddingService implements EmbeddingService {
	readonly kind = "disabled" as const;
	readonly provider = "disabled" as const;
	readonly modelId = "disabled";
	readonly dimensions = 0;
	status: EmbeddingStatusValue = "fts_only";

	async ensureReady(): Promise<void> {}

	async embedTexts(_texts: string[]): Promise<number[][]> {
		return [];
	}
}
