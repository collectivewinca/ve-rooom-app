import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { createRoom, joinRoom } from "../lib/api";
import { useAuth } from "../lib/useAuth";

export default function Home() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const { user, setName: setIdentityName } = useAuth();
	const [name, setName] = useState("");
	const [roomTitle, setRoomTitle] = useState("");
	const [joinRoomId, setJoinRoomId] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [mode, setMode] = useState<"create" | "join">("create");

	useEffect(() => {
		const roomFromUrl = searchParams.get("room");
		if (roomFromUrl) {
			console.log("[Home] Auto-filled room ID from URL:", roomFromUrl);
			setJoinRoomId(roomFromUrl);
			setMode("join");
		}
	}, [searchParams]);

	useEffect(() => {
		if (user?.name && !name) {
			console.log("[Home] Pre-filled name from auth:", user.name);
			setName(user.name);
		}
	}, [user, name]);

	async function handleCreate() {
		console.log("[Home] handleCreate — name:", name, "roomTitle:", roomTitle);
		if (!name.trim()) {
			setError("Please enter your name");
			return;
		}
		setLoading(true);
		setError("");
		setIdentityName(name);
		try {
			const { roomId, authToken } = await createRoom(name.trim(), roomTitle.trim() || undefined);
			console.log("[Home] Room created, navigating to meeting:", roomId);
			sessionStorage.setItem(`rtk_token_${roomId}`, authToken);
			navigate(`/meeting/${roomId}`);
		} catch (e) {
			console.log("[Home] createRoom error:", e);
			setError(e instanceof Error ? e.message : "Failed to create room");
		} finally {
			setLoading(false);
		}
	}

	async function handleJoin() {
		console.log("[Home] handleJoin — name:", name, "joinRoomId:", joinRoomId);
		if (!name.trim() || !joinRoomId.trim()) {
			setError("Please enter your name and room ID");
			return;
		}
		setLoading(true);
		setError("");
		setIdentityName(name);
		try {
			const { authToken } = await joinRoom(joinRoomId.trim(), name.trim());
			console.log("[Home] Joined room, navigating to meeting:", joinRoomId.trim());
			sessionStorage.setItem(`rtk_token_${joinRoomId.trim()}`, authToken);
			navigate(`/meeting/${joinRoomId.trim()}`);
		} catch (e) {
			console.log("[Home] joinRoom error:", e);
			setError(e instanceof Error ? e.message : "Failed to join room");
		} finally {
			setLoading(false);
		}
	}

	return (
		<div className="home">
			<div style={{ width: "100%", maxWidth: "440px" }}>
				<div className="home-hero">
					<img src="/favicon.svg" alt="VE Rooom" className="home-hero-icon" />
					<h1>
						<span className="gradient-text">VE Rooom</span>
					</h1>
					<p className="tagline">
						Video conferencing with AI-powered transcription and meeting summaries. Record, transcribe, and get instant recaps.
					</p>
				</div>

				<div className="home-card">
					<>
							<div style={{ display: "flex", gap: "4px", marginBottom: "1.5rem", background: "rgba(15, 12, 8, 0.6)", borderRadius: "var(--radius-md)", padding: "4px" }}>
								<button
									onClick={() => { setMode("create"); setError(""); }}
									style={{
										flex: 1,
										padding: "0.5rem",
										borderRadius: "var(--radius-sm)",
										fontSize: "0.8125rem",
										fontWeight: 700,
										background: mode === "create" ? "var(--gradient-primary)" : "transparent",
										color: mode === "create" ? "#1a1208" : "var(--color-text-muted)",
										transition: "all var(--transition)",
										border: "none",
										cursor: "pointer",
									}}
								>
									New Meeting
								</button>
								<button
									onClick={() => { setMode("join"); setError(""); }}
									style={{
										flex: 1,
										padding: "0.5rem",
										borderRadius: "var(--radius-sm)",
										fontSize: "0.8125rem",
										fontWeight: 700,
										background: mode === "join" ? "var(--gradient-primary)" : "transparent",
										color: mode === "join" ? "#1a1208" : "var(--color-text-muted)",
										transition: "all var(--transition)",
										border: "none",
										cursor: "pointer",
									}}
								>
									Join Meeting
								</button>
							</div>

							<div className="form-group">
								<label htmlFor="name">Your Name</label>
								<input
									id="name"
									type="text"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="Enter your name"
									disabled={loading}
									onKeyDown={(e) => {
										if (e.key === "Enter" && mode === "create") handleCreate();
										if (e.key === "Enter" && mode === "join") handleJoin();
									}}
								/>
							</div>

							{mode === "create" ? (
								<>
									<div className="form-group">
										<label htmlFor="title">Room Title (optional)</label>
										<input
											id="title"
											type="text"
											value={roomTitle}
											onChange={(e) => setRoomTitle(e.target.value)}
											placeholder="e.g. Weekly Standup"
											disabled={loading}
											onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
										/>
									</div>
									<button className="btn-primary btn-full" onClick={handleCreate} disabled={loading}>
										{loading ? "Creating..." : "Start New Meeting"}
									</button>
								</>
							) : (
								<>
									<div className="form-group">
										<label htmlFor="joinId">Room ID</label>
										<input
											id="joinId"
											type="text"
											value={joinRoomId}
											onChange={(e) => setJoinRoomId(e.target.value)}
											placeholder="Paste room ID here"
											disabled={loading}
											onKeyDown={(e) => { if (e.key === "Enter") handleJoin(); }}
										/>
									</div>
									<button className="btn-primary btn-full" onClick={handleJoin} disabled={loading}>
										{loading ? "Joining..." : "Join Meeting"}
									</button>
								</>
							)}

							{error && <p className="error">{error}</p>}
					</>
				</div>

				<div className="feature-badges">
					<div className="feature-badge">
						<div className="feature-badge-icon">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>
							</svg>
						</div>
						<span>Auto-Recording</span>
					</div>
					<div className="feature-badge">
						<div className="feature-badge-icon">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c084fc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
							</svg>
						</div>
						<span>AI Transcription</span>
					</div>
					<div className="feature-badge">
						<div className="feature-badge-icon">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f472b6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
							</svg>
						</div>
						<span>Smart Summary</span>
					</div>
				</div>
			</div>
		</div>
	);
}
