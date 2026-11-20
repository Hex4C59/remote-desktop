// 在审查父进程中逐行读取 JSONL，并保留有限的诊断输出。
// Thread: review parent event loop.

const TAIL_BYTES = 64 * 1024;
const RECORD_BYTES = 2 * 1024 * 1024;

type AssistantMessage = {
	role?: unknown;
	provider?: unknown;
	model?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
	content?: Array<{ type?: unknown; text?: unknown }>;
};

export type AssistantSummary = { text: string; model?: string; stopReason?: string; errorMessage?: string };

function readAssistantLine(line: string, summary: AssistantSummary): void {
	if (!line.trim()) return;
	let event: { type?: unknown; message?: AssistantMessage } | null;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (event?.type !== "message_end" || event.message?.role !== "assistant") return;
	const { content, provider, model, stopReason, errorMessage } = event.message;
	if (Array.isArray(content)) {
		for (const part of content) {
			if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) summary.text = part.text;
		}
	}
	if (typeof model === "string" && model.trim()) {
		summary.model = typeof provider === "string" && provider.trim() ? `${provider}/${model}` : model;
	}
	if (typeof stopReason === "string") summary.stopReason = stopReason;
	if (typeof errorMessage === "string" && errorMessage.trim()) summary.errorMessage = errorMessage;
}

export function summarizeAssistant(jsonl: string): AssistantSummary {
	const summary: AssistantSummary = { text: "" };
	for (const line of jsonl.split("\n")) readAssistantLine(line, summary);
	return summary;
}

export class OutputTail {
	private readonly bytes = Buffer.alloc(TAIL_BYTES);
	private length = 0;

	write(chunk: Buffer): void {
		const incoming = Math.min(chunk.length, this.bytes.length);
		const kept = Math.min(this.length, this.bytes.length - incoming);
		this.bytes.copyWithin(0, this.length - kept, this.length);
		chunk.copy(this.bytes, kept, chunk.length - incoming);
		this.length = kept + incoming;
	}

	text(): string {
		let start = 0;
		while (start < this.length && (this.bytes[start] & 0xc0) === 0x80) start++;
		const text = this.bytes.toString("utf8", start, this.length);
		if (Buffer.byteLength(text) <= TAIL_BYTES) return text;
		// Replacing invalid UTF-8 can expand the decoded tail.
		const encoded = Buffer.from(text);
		start = encoded.length - TAIL_BYTES;
		while ((encoded[start] & 0xc0) === 0x80) start++;
		return encoded.toString("utf8", start);
	}
}

export class ChildOutput {
	readonly summary: AssistantSummary = { text: "" };
	private record?: Buffer;
	private pending = 0;
	error?: string;

	write(chunk: Buffer): void {
		if (this.error) return;
		for (let start = 0; start < chunk.length;) {
			const newline = chunk.indexOf(0x0a, start);
			const end = newline === -1 ? chunk.length : newline;
			const length = end - start;
			if (this.pending + length > RECORD_BYTES) {
				this.error = `Review child JSONL record exceeded ${RECORD_BYTES} bytes.`;
				this.record = undefined;
				this.pending = 0;
				return;
			}
			const part = chunk.subarray(start, end);
			if (this.pending === 0 && newline !== -1) {
				readAssistantLine(part.toString("utf8"), this.summary);
			} else {
				if (length) {
					this.record ??= Buffer.allocUnsafe(RECORD_BYTES);
					part.copy(this.record, this.pending);
				}
				this.pending += length;
				if (newline !== -1) this.finish();
			}
			start = end + 1;
		}
	}

	finish(): void {
		if (!this.record || this.pending === 0) return;
		readAssistantLine(this.record.toString("utf8", 0, this.pending), this.summary);
		this.pending = 0;
	}
}
