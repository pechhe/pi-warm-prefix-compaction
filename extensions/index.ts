import { randomUUID } from "node:crypto";
import { contentText } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REQUEST_PROJECTION_EVENT = "pi-warm-prefix-compaction:request-projection";

const COMPACTION_INSTRUCTION = `Create a dense continuation summary for this exact conversation state.

This is a compaction request, not a new user task. Do not call tools and do not continue the task. Return only the summary text.

Preserve:
- the user's objective and current intent
- important constraints and preferences
- completed work and verified evidence
- current in-progress work and blockers
- exact file paths, symbol names, commands, identifiers, and error messages that matter
- decisions already made and their rationale
- the smallest concrete next steps

Prefer factual compression over prose. Do not invent facts. The recent retained tail remains available separately, so redundancy is acceptable only when it protects critical continuity.`;

function instruction(customInstructions: string | undefined): string {
	const custom = customInstructions?.trim();
	return custom
		? `${COMPACTION_INSTRUCTION}\n\nAdditional compaction focus:\n${custom}`
		: COMPACTION_INSTRUCTION;
}

export default function warmPrefixCompaction(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event, ctx) => {
		try {
			const projectionToken = randomUUID();
			pi.events.emit(REQUEST_PROJECTION_EVENT, {
				action: "authorize",
				token: projectionToken,
			});
			const response = await (async () => {
				try {
					return await ctx.completeFromLatestSettledRequest(instruction(event.customInstructions), {
						signal: event.signal,
					});
				} finally {
					pi.events.emit(REQUEST_PROJECTION_EVENT, {
						action: "release",
						token: projectionToken,
					});
				}
			})();
			const summary = contentText(response.content).trim();
			if (!summary) throw new Error("The continuation returned no summary text");

			const modifiedFiles = new Set([
				...event.preparation.fileOps.written,
				...event.preparation.fileOps.edited,
			]);
			return {
				compaction: {
					summary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: response.usage,
					details: {
						model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
						readFiles: [...event.preparation.fileOps.read]
							.filter((path) => !modifiedFiles.has(path))
							.sort(),
						modifiedFiles: [...modifiedFiles].sort(),
						warmPrefix: true,
					},
				},
			};
		} catch (error) {
			console.warn(`[warm-prefix-compaction] failed: ${String(error)}`);
			throw error;
		}
	});
}
