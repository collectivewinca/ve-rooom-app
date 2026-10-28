import { describe, expect, it } from "vitest";
import { isAllowedMediaUrl, isValidUuid } from "./url-guard";

describe("isAllowedMediaUrl", () => {
	it("accepts HTTPS RealtimeKit/R2 media URLs", () => {
		expect(isAllowedMediaUrl("https://bucket.account.r2.cloudflarestorage.com/file.mp3")).toBe(true);
	});

	it("rejects cleartext external URLs", () => {
		expect(isAllowedMediaUrl("http://bucket.account.r2.cloudflarestorage.com/file.mp3")).toBe(false);
	});

	it("allows the exact application host for local proxying", () => {
		expect(isAllowedMediaUrl("http://127.0.0.1:8788/api/recording/key", { allowHosts: ["127.0.0.1"] })).toBe(true);
	});

	it("does not allow lookalike suffixes", () => {
		expect(isAllowedMediaUrl("https://evilmedia.example.com/file", { extraAllowedHosts: "media.example.com" })).toBe(false);
		expect(isAllowedMediaUrl("https://cdn.media.example.com/file", { extraAllowedHosts: "media.example.com" })).toBe(true);
	});

	it("rejects malformed and non-HTTP URLs", () => {
		expect(isAllowedMediaUrl("not-a-url")).toBe(false);
		expect(isAllowedMediaUrl("file:///etc/passwd")).toBe(false);
	});
});

describe("isValidUuid", () => {
	it("accepts a UUID", () => {
		expect(isValidUuid("bbbf9d3c-c539-4872-86d9-81ff31ca31fb")).toBe(true);
	});

	it("rejects key injection and missing values", () => {
		expect(isValidUuid("../../other-key")).toBe(false);
		expect(isValidUuid(undefined)).toBe(false);
	});
});
