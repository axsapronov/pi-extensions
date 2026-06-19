import type {
	EmbeddingService,
	EmbeddingStatusValue,
} from "./EmbeddingService.ts";

export type OpenAICompatibleEmbeddingConfig = {
	type: "openai-compatible";
	baseUrl: string;
	apiKey?: string;
	model: string;
	dimensions?: number;
	batchSize?: number;
	timeoutMs?: number;
	maxRetries?: number;
};

type EmbeddingResponse = {
	data: Array<{ index: number; embedding: number[] }>;
	model?: string;
};

export class OpenAICompatibleEmbeddingService implements EmbeddingService {
	readonly kind = "openai-compatible" as const;
	readonly provider = "openai-compatible" as const;
	readonly modelId: string;
	dimensions: number;
	status: EmbeddingStatusValue = "not_started";
	lastError: string | undefined;

	// Download progress fields (not used for remote, kept for interface compatibility)
	readonly activeDevice: string | undefined = undefined;
	readonly downloadStatus: string | undefined = undefined;
	readonly downloadFile: string | undefined = undefined;
	readonly downloadLoadedBytes: number | undefined = undefined;
	readonly downloadTotalBytes: number | undefined = undefined;
	readonly downloadProgress: number | undefined = undefined;

	private dim?: number;
	private readyPromise: Promise<void> | undefined;

	constructor(private readonly cfg: OpenAICompatibleEmbeddingConfig) {
		this.modelId = `${this.cfg.baseUrl.replace(/\/+$/, "")}::${this.cfg.model}`;
		this.dimensions = cfg.dimensions ?? 0;
		this.dim = cfg.dimensions;
	}

	async ensureReady(): Promise<void> {
		if (this.status === "ready") return;
		if (this.readyPromise) return this.readyPromise;

		this.status = "warming";
		this.readyPromise = this.probeDimensions().catch((error) => {
			this.readyPromise = undefined;
			this.status = "failed";
			this.lastError = error instanceof Error ? error.message : String(error);
			throw error;
		});
		return this.readyPromise;
	}

	async embedTexts(texts: string[]): Promise<number[][]> {
		await this.ensureReady();
		if (this.status === "fts_only" || this.status === "failed") return [];
		if (texts.length === 0) return [];

		const batchSize = this.cfg.batchSize ?? 64;
		const result: number[][] = [];

		for (let i = 0; i < texts.length; i += batchSize) {
			const batch = texts.slice(i, i + batchSize);
			const vectors = await this.requestBatch(batch);
			result.push(...vectors);
		}

		return result;
	}

	private async probeDimensions(): Promise<void> {
		if (this.dim) {
			this.status = "ready";
			return;
		}
		const vectors = await this.requestBatch(["dimension probe"]);
		const detectedDim = vectors[0]?.length;
		if (!detectedDim)
			throw new Error("Empty embedding vector returned from remote provider");
		this.dim = detectedDim;
		this.dimensions = detectedDim;
		this.status = "ready";
	}

	private async requestBatch(
		input: string[],
		attempt = 0,
	): Promise<number[][]> {
		const maxRetries = this.cfg.maxRetries ?? 3;
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			this.cfg.timeoutMs ?? 30_000,
		);

		try {
			const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/embeddings`;
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(this.cfg.apiKey
						? { authorization: `Bearer ${this.cfg.apiKey}` }
						: {}),
				},
				body: JSON.stringify({
					model: this.cfg.model,
					input,
					...(this.cfg.dimensions ? { dimensions: this.cfg.dimensions } : {}),
				}),
				signal: controller.signal,
			});

			if (!res.ok) {
				const body = await res.text().catch(() => "");
				const statusText = res.statusText || "error";
				// Retry on 5xx and network errors only
				if ((res.status >= 500 || res.status === 429) && attempt < maxRetries) {
					const backoff = Math.min(1000 * 2 ** attempt, 5000);
					await new Promise((resolve) => setTimeout(resolve, backoff));
					return this.requestBatch(input, attempt + 1);
				}
				throw new Error(`HTTP ${res.status} ${statusText}: ${body}`);
			}

			const json = (await res.json()) as EmbeddingResponse;
			const ordered = [...json.data]
				.sort((a, b) => a.index - b.index)
				.map((x) => x.embedding);

			if (ordered.length !== input.length) {
				throw new Error(
					`Embedding count mismatch: got=${ordered.length}, expected=${input.length}`,
				);
			}

			const dim = ordered[0]?.length;
			if (!dim) throw new Error("No embedding vectors returned");

			for (const vec of ordered) {
				if (vec.length !== dim) {
					throw new Error(
						`Inconsistent embedding dimensions: expected=${dim}, got=${vec.length}`,
					);
				}
			}

			this.dim ??= dim;
			if (this.status === "warming") this.status = "ready";
			return ordered;
		} finally {
			clearTimeout(timeout);
		}
	}
}
