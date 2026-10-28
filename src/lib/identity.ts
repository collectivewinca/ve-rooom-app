export interface LocalIdentity {
	id: string;
	token: string;
	name: string;
	createdAt: string;
}

const STORAGE_KEY = "ve_rooom_identity";
const CHANGE_EVENT = "ve-rooom-identity-change";

function isUuid(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function getIdentity(): LocalIdentity | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const value = JSON.parse(raw) as Partial<LocalIdentity>;
		if (!isUuid(value.id)) return null;
		return {
			id: value.id,
			token: `guest:${value.id}`,
			name: typeof value.name === "string" ? value.name : "",
			createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
		};
	} catch {
		return null;
	}
}

export function ensureIdentity(name = ""): LocalIdentity {
	const existing = getIdentity();
	if (existing) return name.trim() ? updateIdentityName(name) : existing;

	const id = crypto.randomUUID();
	const identity: LocalIdentity = { id, token: `guest:${id}`, name: name.trim(), createdAt: new Date().toISOString() };
	localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
	window.dispatchEvent(new Event(CHANGE_EVENT));
	return identity;
}

export function updateIdentityName(name: string): LocalIdentity {
	const existing = getIdentity() || ensureIdentity();
	const updated = { ...existing, name: name.trim() };
	localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
	window.dispatchEvent(new Event(CHANGE_EVENT));
	return updated;
}

export function resetIdentity(): LocalIdentity {
	localStorage.removeItem(STORAGE_KEY);
	const identity = ensureIdentity();
	window.dispatchEvent(new Event(CHANGE_EVENT));
	return identity;
}

export const identityChangeEvent = CHANGE_EVENT;
