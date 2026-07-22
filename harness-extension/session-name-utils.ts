const MAX_SESSION_NAME_LENGTH = 64;

export function isSubagentSessionFile(sessionFile: string | undefined): boolean {
	if (!sessionFile) return false;
	return /[/\\]sessions[/\\]subagents[/\\]/.test(sessionFile);
}

export function normalizeGeneratedSessionName(raw: string): string {
	let title = raw
		.replace(/<think>[\s\S]*?<\/think>/gi, " ")
		.replace(/^\s*(?:title|session(?:\s+name)?|название(?:\s+сессии)?)\s*:\s*/i, "")
		.split(/\r?\n/, 1)[0]
		.replace(/^[\s`*_#"'«»]+|[\s`*_#"'«»]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!title) return "";
	if (title.length > MAX_SESSION_NAME_LENGTH) {
		const clipped = title.slice(0, MAX_SESSION_NAME_LENGTH + 1);
		const boundary = clipped.lastIndexOf(" ");
		title = clipped.slice(0, boundary >= 24 ? boundary : MAX_SESSION_NAME_LENGTH).trim();
	}
	return title.replace(/[.!?,;:]+$/g, "").trim();
}
