import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fetchMeetings, joinRoom, type MeetingWithSessions, type MeetingSession } from "../lib/api";
import { useAuth } from "../lib/useAuth";

function formatDate(dateStr?: string): string {
	if (!dateStr) return "—";
	const d = new Date(dateStr);
	if (isNaN(d.getTime())) return dateStr;
	return d.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatDuration(start?: string, end?: string): string {
	if (!start || !end) return "—";
	const ms = new Date(end).getTime() - new Date(start).getTime();
	if (isNaN(ms) || ms < 0) return "—";
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function sessionStatusInfo(status: string): { label: string; cls: string } {
	const s = (status || "").toUpperCase();
	if (s === "LIVE" || s === "ACTIVE") return { label: "Live", cls: "live" };
	if (s === "ENDED") return { label: "Ended", cls: "ended" };
	if (s === "INIT" || s === "NEW") return { label: "Init", cls: "init" };
	return { label: s || "Unknown", cls: "init" };
}

function recordingStatusIcon(status: string): string {
	const s = (status || "").toUpperCase();
	if (s === "UPLOADED") return "✓ Uploaded";
	if (s === "RECORDING") return "● Recording";
	if (s === "INVOKED") return "⟳ Starting";
	if (s === "STOPPED" || s === "STOPPING") return "■ Stopped";
	if (s === "FAILED") return "✕ Failed";
	return s || "—";
}

export default function Dashboard() {
	const [meetings, setMeetings] = useState<MeetingWithSessions[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [searchQuery, setSearchQuery] = useState("");
	const [joiningId, setJoiningId] = useState<string | null>(null);
	const [joinError, setJoinError] = useState<string>("");
	const { user } = useAuth();
	const navigate = useNavigate();

	console.log("[Dashboard] Render — loading:", loading, "meetings:", meetings.length);

	useEffect(() => {
		console.log("[Dashboard] Fetching /api/meetings");
		fetchMeetings()
			.then((data) => {
				setMeetings(data);
				setLoading(false);
			})
			.catch((e) => {
				console.log("[Dashboard] Error:", e);
				setError(e instanceof Error ? e.message : "Failed to load meetings");
				setLoading(false);
			});
	}, []);

	const toggleExpand = (id: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const handleJoinAgain = async (meetingId: string) => {
		if (joiningId) return;
		const name = user?.name || user?.email || "Participant";
		setJoiningId(meetingId);
		setJoinError("");
		try {
			const { authToken } = await joinRoom(meetingId, name);
			sessionStorage.setItem(`rtk_token_${meetingId}`, authToken);
			navigate(`/meeting/${meetingId}`);
		} catch (e) {
			console.log("[Dashboard] joinAgain error:", e);
			setJoinError(e instanceof Error ? e.message : "Failed to join meeting");
		} finally {
			setJoiningId(null);
		}
	};

	const filteredMeetings = searchQuery.trim()
		? meetings.filter((m) => (m.title || "").toLowerCase().includes(searchQuery.toLowerCase()))
		: meetings;

	const activeCount = meetings.filter((m) => m.sessions.some((s) => s.status !== "ENDED")).length;
	const endedCount = meetings.filter((m) => !m.sessions.some((s) => s.status !== "ENDED")).length;
	const totalSessions = meetings.reduce((sum, m) => sum + m.sessions.length, 0);
	const totalRecordings = meetings.reduce(
		(sum, m) => sum + m.sessions.reduce((s, sess) => s + sess.recordings.length, 0),
		0
	);

	return (
		<div className="dashboard-page">
			<div className="dashboard-header">
				<h1>Dashboard</h1>
				<Link to="/" className="btn-primary" style={{ width: "auto", textDecoration: "none" }}>
					+ New Meeting
				</Link>
			</div>

			{!loading && meetings.length > 0 && (
				<div className="dashboard-stats">
					<div className="stat-card">
						<div className="stat-value">{meetings.length}</div>
						<div className="stat-label">Meetings</div>
					</div>
					<div className="stat-card">
						<div className="stat-value">{totalSessions}</div>
						<div className="stat-label">Sessions</div>
					</div>
					<div className="stat-card">
						<div className="stat-value">{totalRecordings}</div>
						<div className="stat-label">Recordings</div>
					</div>
					<div className="stat-card">
						<div className="stat-value">{activeCount}</div>
						<div className="stat-label">Active Now</div>
					</div>
				</div>
			)}

			{!loading && meetings.length > 0 && (
				<div className="dashboard-search">
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search meetings by title..."
					/>
				</div>
			)}

			<h2>{searchQuery.trim() ? `Meetings (${filteredMeetings.length} found)` : "Meetings"}</h2>

			{loading && (
				<>
					<div className="dashboard-stats">
						<div className="stat-card skeleton skeleton-stat" />
						<div className="stat-card skeleton skeleton-stat" />
						<div className="stat-card skeleton skeleton-stat" />
						<div className="stat-card skeleton skeleton-stat" />
					</div>
					<div className="skeleton skeleton-row" />
					<div className="skeleton skeleton-row" />
					<div className="skeleton skeleton-row" />
				</>
			)}

			{error && <div className="error">{error}</div>}

			{joinError && (
				<div className="error join-error-toast">{joinError}</div>
			)}

			{!loading && meetings.length === 0 && !error && (
				<div className="empty-state">
					<img src="/favicon.svg" alt="VE Rooom" className="empty-state-icon" />
					<h3>No meetings yet</h3>
					<p>Create your first meeting to get started with AI-powered transcription and summaries.</p>
					<Link to="/" className="btn-primary" style={{ display: "inline-flex", textDecoration: "none", width: "auto" }}>
						Start Your First Meeting
					</Link>
				</div>
			)}

			{!loading && meetings.length > 0 && filteredMeetings.length === 0 && (
				<div className="empty-state">
					<h3>No meetings match "{searchQuery}"</h3>
					<p>Try a different search term.</p>
				</div>
			)}

			{filteredMeetings.length > 0 && (
				<div className="meeting-list">
					{filteredMeetings.map((m) => {
				const isExpanded = expanded.has(m.id);
					const sessionCount = m.sessions.length;
					const recordingCount = m.sessions.reduce((s, sess) => s + sess.recordings.length, 0);
					const endedSessions = m.sessions.filter((s) => s.status === "ENDED");
					const hasEndedSession = endedSessions.length > 0;
					const isLive = m.sessions.some((s) => s.status !== "ENDED" && s.status !== "INIT");
					// Prefer the latest ended session that has recordings; fall back to latest ended
					const endedWithRecordings = endedSessions.filter((s) => s.recordings.length > 0);
					const summarySession = endedWithRecordings[0] || endedSessions[0];
					const summarySessionId = summarySession?.id;

					return (
						<div key={m.id} className={`meeting-card ${isExpanded ? "expanded" : ""}`}>
							<div className="meeting-card-header" onClick={() => toggleExpand(m.id)}>
								<div className="meeting-card-info">
								<div className="meeting-card-title-row">
									<h3>{m.title || "Untitled Meeting"}</h3>
										<span className={`meeting-status-badge ${isLive ? "active" : "ended"}`}>
											{isLive ? "● Active" : "Ended"}
										</span>
									</div>
									<div className="meeting-card-meta">
										<span className="meta-date">{formatDate(m.created_at)}</span>
										<span className="meta-sep">·</span>
										<span className="meta-id">{m.id.slice(0, 8)}</span>
										{m.createdBy && (
											<>
												<span className="meta-sep">·</span>
												<span className="meta-creator" title={m.createdBy.email}>by {m.createdBy.name}</span>
											</>
										)}
										{sessionCount > 0 && (
											<>
												<span className="meta-sep">·</span>
												<span className="meta-sessions">{sessionCount} session{sessionCount !== 1 ? "s" : ""}</span>
											</>
										)}
										{recordingCount > 0 && (
											<>
												<span className="meta-sep">·</span>
												<span className="meta-recordings">{recordingCount} recording{recordingCount !== 1 ? "s" : ""}</span>
											</>
										)}
										{m.participants && m.participants.length > 0 && (
											<>
												<span className="meta-sep">·</span>
												<span className="meta-participants">{m.participants.length} participant{m.participants.length !== 1 ? "s" : ""}</span>
											</>
										)}
									</div>
								</div>
									<div className="meeting-card-actions">
										{hasEndedSession && summarySessionId && (
											<Link
												to={`/summary/${m.id}?sessionId=${summarySessionId}`}
												className="btn-link"
												onClick={(e) => e.stopPropagation()}
											>
												View Summary
											</Link>
										)}
										<button
											className={`btn-link ${isLive ? "btn-join" : "btn-rejoin"}`}
											onClick={(e) => { e.stopPropagation(); handleJoinAgain(m.id); }}
											disabled={joiningId === m.id}
										>
											{joiningId === m.id ? "Joining…" : isLive ? "Join" : "Join Again"}
										</button>
										<button className="expand-toggle" aria-label={isExpanded ? "Collapse" : "Expand"} onClick={(e) => { e.stopPropagation(); toggleExpand(m.id); }}>
											<svg width="16" height="16" viewBox="0 0 16 16" fill="none"
												style={{ transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
												<path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
											</svg>
										</button>
									</div>
								</div>

							{isExpanded && (
								<div className="meeting-card-body">
									{m.createdBy && (
										<div className="meeting-creator">
											<span className="creator-label">Created by</span>
											<span className="creator-name">{m.createdBy.name}</span>
											<span className="creator-email">{m.createdBy.email}</span>
										</div>
									)}

									{m.participants && m.participants.length > 0 && (
										<div className="meeting-participants">
											<span className="participants-label">Participants</span>
											<div className="participant-chips">
												{m.participants.map((p, i) => (
													<span key={i} className="participant-chip" title={p.email}>
														{p.name}
													</span>
												))}
											</div>
										</div>
									)}

									{m.sessions.length === 0 ? (
											<div className="no-sessions">
												<p>No sessions yet. {isLive ? "Meeting is live — join and talk to create a session." : "Meeting has not been joined yet."}</p>
											</div>
										) : (
											<div className="session-list">
												{m.sessions.map((sess) => (
													<SessionRow key={sess.id} session={sess} meetingId={m.id} />
												))}
											</div>
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

function SessionRow({ session, meetingId }: { session: MeetingSession; meetingId: string }) {
	const statusInfo = sessionStatusInfo(session.status);
	const duration = formatDuration(session.created_at, session.ended_at);
	const compositeRecs = session.recordings.filter((r) => r.type === "composite");
	const hasUploaded = session.recordings.some((r) => r.status === "UPLOADED");

	return (
		<div className={`session-row ${statusInfo.cls}`}>
			<div className="session-row-main">
				<div className="session-row-header">
					<span className={`session-status-badge ${statusInfo.cls}`}>{statusInfo.label}</span>
					<span className="session-id">{session.id.slice(0, 8)}</span>
				</div>
				<div className="session-row-details">
					<span className="session-detail">
						<span className="session-detail-label">Started</span>
						{formatDate(session.created_at)}
					</span>
					{session.ended_at && (
						<span className="session-detail">
							<span className="session-detail-label">Ended</span>
							{formatDate(session.ended_at)}
						</span>
					)}
					<span className="session-detail">
						<span className="session-detail-label">Duration</span>
						{duration}
					</span>
					{session.participant_count != null && session.participant_count > 0 && (
						<span className="session-detail">
							<span className="session-detail-label">Participants</span>
							{session.participant_count}
						</span>
					)}
				</div>
			</div>

			<div className="session-row-recordings">
				{session.recordings.length === 0 ? (
					<span className="no-recordings">No recordings</span>
				) : (
					<div className="recording-group">
						<span className="recording-type">Recording</span>
						{compositeRecs.map((r) => (
							<span key={r.id} className={`recording-badge ${r.status.toLowerCase()}`}>
								{recordingStatusIcon(r.status)}
							</span>
						))}
					</div>
				)}
			</div>

			{session.status === "ENDED" && (
				<div className="session-row-action">
					<Link to={`/summary/${meetingId}?sessionId=${session.id}`} className="btn-link btn-small">
						Summary →
					</Link>
				</div>
			)}
			{session.status !== "ENDED" && hasUploaded && (
				<div className="session-row-action">
					<span className="recording-ready">Recordings ready</span>
				</div>
			)}
		</div>
	);
}