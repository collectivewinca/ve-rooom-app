import type { AppEnv } from "./lib/env";

export interface AppIdentity {
	id: string;
	email: string;
	name: string;
	type: "local" | "external";
}

const LOCAL_TOKEN = /^guest:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/**
 * Validate an application identity.
 *
 * Fresh open-source deployments work without an external identity provider:
 * the browser creates a random UUID and sends `guest:<uuid>`. This is a
 * persistent pseudonymous identity, not strong authentication. It is suitable
 * for meeting ownership, per-user preferences, and the initial free tier.
 *
 * Existing installations can retain their PocketBase gateway by setting
 * FORMSDB_URL. Non-local tokens are then validated with PocketBase. A future
 * OAuth provider can be added behind this same function without changing API
 * handlers.
 */
export async function verifyAuthToken(
	authToken: string | undefined,
	env: Pick<AppEnv, "FORMSDB_URL">
): Promise<AppIdentity | null> {
	if (!authToken) return null;

	const local = LOCAL_TOKEN.exec(authToken.trim());
	if (local) {
		const id = local[1].toLowerCase();
		return { id, email: `${id}@guest.local`, name: "Guest", type: "local" };
	}

	const pbUrl = env.FORMSDB_URL?.replace(/\/+$/, "");
	if (!pbUrl) return null;

	try {
		const res = await fetch(`${pbUrl}/api/collections/users/auth-refresh`, {
			method: "POST",
			headers: { Authorization: authToken },
		});
		if (!res.ok) return null;

		const data = await res.json() as {
			record?: { id?: string; email?: string; name?: string };
		};
		if (!data.record) return null;

		const email = data.record.email || "";
		return {
			id: data.record.id || email,
			email,
			name: data.record.name || email,
			type: "external",
		};
	} catch {
		return null;
	}
}
