/** 合言葉の照合。長さが違ってもすぐには返さず、時間で当てられないようにする */
export function tokenMatches(
	given: string | null | undefined,
	expected: string | undefined
): boolean {
	if (!given || !expected) return false;
	const a = new TextEncoder().encode(given);
	const b = new TextEncoder().encode(expected);
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}

export function bearerToken(req: Request): string | null {
	const h = req.headers.get('authorization') ?? '';
	const m = /^Bearer\s+(.+)$/i.exec(h);
	return m ? m[1].trim() : null;
}

export function cookieValue(req: Request, name: string): string | null {
	const raw = req.headers.get('cookie') ?? '';
	for (const part of raw.split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k === name) return decodeURIComponent(v.join('='));
	}
	return null;
}
