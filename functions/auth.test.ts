import { describe, expect, it, vi } from "vitest";
import { verifyAuthToken } from "./auth";

describe("verifyAuthToken", () => {
	it("accepts a well-formed local identity", async () => {
		const user = await verifyAuthToken("guest:bbbf9d3c-c539-4872-86d9-81ff31ca31fb", {});
		expect(user).toEqual({
			id: "bbbf9d3c-c539-4872-86d9-81ff31ca31fb",
			email: "bbbf9d3c-c539-4872-86d9-81ff31ca31fb@guest.local",
			name: "Guest",
			type: "local",
		});
	});

	it("rejects malformed local identities", async () => {
		expect(await verifyAuthToken("guest:not-a-uuid", {})).toBeNull();
		expect(await verifyAuthToken(undefined, {})).toBeNull();
	});

	it("does not make an external request when no gateway is configured", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		expect(await verifyAuthToken("opaque-token", {})).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
});
