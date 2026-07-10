// One JSON fetch helper for the whole UI: parses {error} (our endpoints) and
// {message} (framework defaults) into a thrown Error the caller can render.
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	if (!res.ok) {
		let message = `Request failed (${res.status})`;
		try {
			const body = await res.json();
			if (body?.error) message = String(body.error);
			else if (body?.message) message = String(body.message);
		} catch {}
		throw new Error(message);
	}
	return await res.json() as T;
}
