export interface AppEnv {
	CF_ACCOUNT_ID: string;
	CF_API_TOKEN: string;
	RTK_APP_ID: string;
	OPENROUTER_API_KEY: string;
	OPENROUTER_MODEL?: string;
	OPENROUTER_FREE_MODEL?: string;
	OLLAMA_API_KEY: string;
	OLLAMA_BASE_URL: string;
	OLLAMA_MODEL?: string;
	GEMINI_API_KEY?: string;
	FORMSDB_URL?: string;
	/** Optional comma-separated emails that may view every meeting. */
	ADMIN_EMAILS?: string;
	SMTP_API_URL?: string;
	ALWAYS_EMAIL?: string;
	/** Fallback email provider — used when the central SMTP relay is unreachable. */
	RESEND_API_KEY?: string;
	/** From address for the fallback provider. */
	EMAIL_FROM?: string;
	/** Optional shared secret for /api/webhook. When set, the request must carry it. */
	WEBHOOK_SECRET?: string;
	/** Extra comma-separated media host suffixes allowed by the URL guard. */
	MEDIA_ALLOWED_HOSTS?: string;
	/**
	 * Optional R2 S3 credentials for RealtimeKit's *native* external-bucket
	 * transfer (the `storage_config` block on POST /recordings).
	 *
	 * Never hardcode these: they are account credentials and they belong in
	 * Worker secrets / .dev.vars. When they are absent the recording
	 * is started without `storage_config`, RTK keeps its own copy (which the
	 * webhook then copies into our bucket), and no failing transfer is
	 * attempted.
	 */
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
	/** Bucket that receives RTK's native transfer. Defaults to the project bucket. */
	R2_BUCKET_NAME?: string;
	/** Cloudflare account that owns the bucket. Defaults to CF_ACCOUNT_ID. */
	R2_ACCOUNT_ID?: string;
	MEETING_CACHE: KVNamespace;
	RECORDINGS_BUCKET: R2Bucket;
}
