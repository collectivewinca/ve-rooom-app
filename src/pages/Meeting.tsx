import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
	RealtimeKitProvider,
	useRealtimeKitClient,
	useRealtimeKitMeeting,
} from "@cloudflare/realtimekit-react";
import { RtkMeeting } from "@cloudflare/realtimekit-react-ui";
import { stopAllRecordings, getLatestEndedSessionId } from "../lib/api";

export default function Meeting() {
	const { roomId } = useParams<{ roomId: string }>();
	const navigate = useNavigate();
	const [meeting, initMeeting] = useRealtimeKitClient();
	const initialized = useRef(false);
	const [authToken, setAuthToken] = useState<string | null>(null);
	const [connectionError, setConnectionError] = useState("");

	console.log("[Meeting] Render — roomId:", roomId, "meetingReady:", !!meeting);

	useEffect(() => {
		if (!roomId) return;
		const token = sessionStorage.getItem(`rtk_token_${roomId}`);
		if (token) {
			setAuthToken(token);
			sessionStorage.removeItem(`rtk_token_${roomId}`);
		}
	}, [roomId]);

	useEffect(() => {
		console.log("[Meeting] useEffect — authToken:", authToken ? "present" : "missing", "initialized:", initialized.current);
		if (!authToken || initialized.current) return;
		initialized.current = true;
		console.log("[Meeting] Calling initMeeting with authToken (truncated):", authToken.slice(0, 30) + "...");
		initMeeting({ authToken }).then(() => {
			console.log("[Meeting] initMeeting resolved — meeting should be ready");
		}).catch((e) => {
			console.log("[Meeting] initMeeting error:", e);
			setConnectionError(e instanceof Error ? e.message : "Failed to connect to meeting");
		});
	}, [authToken, initMeeting]);

	if (!authToken) {
		return (
			<div className="meeting-error">
				<p>Missing auth token. Please go back and create or join a meeting.</p>
				<button className="btn-secondary" onClick={() => navigate("/")}>
					Back to Home
				</button>
			</div>
		);
	}

	if (connectionError) {
		return (
			<div className="meeting-error">
				<p>Failed to connect: {connectionError}</p>
				<button className="btn-secondary" onClick={() => navigate("/")}>
					Back to Home
				</button>
			</div>
		);
	}

	if (!meeting) {
		return (
			<div className="meeting-loading">
				<div className="spinner" />
				<p>Connecting to meeting...</p>
			</div>
		);
	}

	console.log("[Meeting] Meeting ready — rendering RtkMeeting");

	return (
		<RealtimeKitProvider value={meeting}>
			<MeetingView roomId={roomId!} />
		</RealtimeKitProvider>
	);
}

function MeetingView({ roomId }: { roomId: string }) {
	const { meeting } = useRealtimeKitMeeting();
	const [copied, setCopied] = useState(false);
	const [meetingEnded, setMeetingEnded] = useState(false);
	const [stopping, setStopping] = useState(false);
	const [sessionId, setSessionId] = useState<string | undefined>(undefined);
	const stopRequested = useRef(false);
	const meetingRef = useRef(meeting);
	meetingRef.current = meeting;
	console.log("[MeetingView] Render — meeting present:", !!meeting, "meetingEnded:", meetingEnded, "stopping:", stopping);

	const shareUrl = `${window.location.origin}/?room=${roomId}`;

	useEffect(() => {
		const m = meetingRef.current;
		if (!m) return;

		const stopRecordings = async () => {
			if (stopRequested.current) return;
			stopRequested.current = true;
			setStopping(true);
			console.log("[MeetingView] roomLeft — stopping recordings for meeting:", roomId);
			try {
				const res = await stopAllRecordings(roomId);
				console.log("[MeetingView] Stop result:", res);
			} catch (e) {
				console.log("[MeetingView] Stop recordings failed:", e);
			}
			// Wait a moment for RTK to mark the session as ENDED, then resolve its ID
			setTimeout(async () => {
				const sid = await getLatestEndedSessionId(roomId);
				if (sid) {
					console.log("[MeetingView] Resolved session ID:", sid);
					setSessionId(sid);
				}
			}, 3000);
			setStopping(false);
			setMeetingEnded(true);
		};

		const self = m.self as unknown as {
			on(event: "roomJoined", handler: (payload: { reconnected: boolean }) => void): void;
			on(event: "roomLeft", handler: (payload: { state: string }) => void): void;
			off(event: "roomJoined", handler: (payload: { reconnected: boolean }) => void): void;
			off(event: "roomLeft", handler: (payload: { state: string }) => void): void;
		};

		console.log("[MeetingView] Attaching roomLeft listener");
		self.on("roomLeft", stopRecordings);

		return () => {
			console.log("[MeetingView] Cleaning up roomLeft listener");
			self.off("roomLeft", stopRecordings);
		};
	}, [roomId]);

	function handleCopyLink() {
		console.log("[MeetingView] Copying share link:", shareUrl);
		navigator.clipboard.writeText(shareUrl).then(() => {
			setCopied(true);
			console.log("[MeetingView] Link copied to clipboard");
			setTimeout(() => setCopied(false), 3000);
		}).catch((e) => {
			console.log("[MeetingView] Clipboard error:", e);
		});
	}

	return (
		<div className="meeting-container">
			<RtkMeeting
				mode="fill"
				meeting={meeting}
				showSetupScreen={true}
			/>
			<div className="meeting-overlay-controls">
				<button className="btn-share" onClick={handleCopyLink}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
						<polyline points="16 6 12 2 8 6"/>
						<line x1="12" y1="2" x2="12" y2="15"/>
					</svg>
					{copied ? "Copied!" : "Copy Join Link"}
				</button>
				{stopping && (
					<span className="summary-link summary-link-loading">
						<span className="spinner" style={{ width: 14, height: 14 }} />
						Stopping…
					</span>
				)}
				{meetingEnded && (
					<a href={`/summary/${roomId}${sessionId ? `?sessionId=${sessionId}` : ""}`} className="summary-link">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}>
							<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
							<polyline points="14 2 14 8 20 8"/>
							<line x1="16" y1="13" x2="8" y2="13"/>
							<line x1="16" y1="17" x2="8" y2="17"/>
						</svg>
						Summary
					</a>
				)}
			</div>
		</div>
	);
}