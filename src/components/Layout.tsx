import { type ReactNode, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../lib/useAuth";

export default function Layout({ children }: { children: ReactNode }) {
	const location = useLocation();
	const isMeeting = location.pathname.startsWith("/meeting/");
	const { user, loading, signOut } = useAuth();
	const [menuOpen, setMenuOpen] = useState(false);

	if (isMeeting) {
		return <>{children}</>;
	}

	return (
		<div className="page-wrapper">
			<nav className="navbar">
				<Link to="/" className="navbar-brand" onClick={() => setMenuOpen(false)}>
					<img src="/favicon.svg" alt="VE Rooom" className="navbar-logo" />
					<span className="navbar-brand-text">VE Rooom</span>
				</Link>

				<div className="navbar-links">
					<Link to="/" className={`navbar-link ${location.pathname === "/" ? "active" : ""}`}>
						Home
					</Link>
					<Link to="/dashboard" className={`navbar-link ${location.pathname === "/dashboard" ? "active" : ""}`}>
						Dashboard
					</Link>
					{loading ? (
						<div className="navbar-avatar-placeholder" />
					) : user ? (
						<div className="navbar-user">
							{user.avatarURL ? (
								<img src={user.avatarURL} alt={user.name} className="navbar-avatar" referrerPolicy="no-referrer" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
							) : (
								<div className="navbar-avatar-placeholder" />
							)}
							<span className="navbar-user-name">{user.name}</span>
							<button className="btn-sign-out" onClick={signOut} title="Reset local identity">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
									<polyline points="16 17 21 12 16 7"/>
									<line x1="21" y1="12" x2="9" y2="12"/>
								</svg>
							</button>
						</div>
					) : null}
				</div>

				<button
					className={`navbar-menu-toggle ${menuOpen ? "open" : ""}`}
					onClick={() => setMenuOpen(!menuOpen)}
					aria-label="Toggle menu"
				>
					<span></span>
					<span></span>
					<span></span>
				</button>
			</nav>

			{menuOpen && (
				<>
					<div className="navbar-mobile-overlay" onClick={() => setMenuOpen(false)} />
					<div className="navbar-mobile-menu" onClick={() => setMenuOpen(false)}>
						<Link to="/" className={`navbar-mobile-link ${location.pathname === "/" ? "active" : ""}`}>Home</Link>
						<Link to="/dashboard" className={`navbar-mobile-link ${location.pathname === "/dashboard" ? "active" : ""}`}>Dashboard</Link>
						{user && <button className="navbar-mobile-link" onClick={() => { signOut(); setMenuOpen(false); }}>Reset local identity</button>}
					</div>
				</>
			)}

			<div className="page-content">{children}</div>
		</div>
	);
}
