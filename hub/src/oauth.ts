/** OAuth 2.0 (PKCE) の小道具。Web Crypto だけで済ませる */
function base64url(bytes: ArrayBuffer | Uint8Array): string {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = '';
	for (const b of u8) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
	const u8 = new Uint8Array(bytes);
	crypto.getRandomValues(u8);
	return base64url(u8);
}

export async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return base64url(digest);
}

export function basicAuth(id: string, secret: string): string {
	return 'Basic ' + btoa(`${id}:${secret}`);
}
