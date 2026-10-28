import { useEffect, useState, useCallback } from "react";
import { ensureIdentity, getIdentity, identityChangeEvent, resetIdentity, updateIdentityName } from "./identity";

export interface AuthUser {
	token: string;
	email: string;
	name: string;
	avatarURL: string;
	id: string;
}

function toAuthUser(): AuthUser {
	const identity = getIdentity() || ensureIdentity();
	return { token: identity.token, email: "", name: identity.name, avatarURL: "", id: identity.id };
}

export function useAuth() {
	const [user, setUser] = useState<AuthUser | null>(() => toAuthUser());
	const [loading] = useState(false);

	useEffect(() => {
		const refresh = () => setUser(toAuthUser());
		window.addEventListener(identityChangeEvent, refresh);
		window.addEventListener("storage", refresh);
		return () => {
			window.removeEventListener(identityChangeEvent, refresh);
			window.removeEventListener("storage", refresh);
		};
	}, []);

	const setName = useCallback((name: string) => {
		updateIdentityName(name);
	}, []);

	const signOut = useCallback(() => {
		resetIdentity();
	}, []);

	return { user, loading, setName, signOut };
}
