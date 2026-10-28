import { Link } from "react-router-dom";

export default function NotFound() {
	return (
		<div className="page-wrapper" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", textAlign: "center", padding: "2rem" }}>
			<div>
				<img src="/favicon.svg" alt="VE Rooom" style={{ width: 64, height: 64, borderRadius: 16, marginBottom: "1.25rem", opacity: 0.5 }} />
				<h1 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: "0.5rem", color: "var(--color-text)" }}>Page not found</h1>
				<p style={{ color: "var(--color-text-muted)", fontSize: "0.875rem", marginBottom: "1.5rem", maxWidth: 320, margin: "0 auto 1.5rem" }}>
					The page you're looking for doesn't exist.
				</p>
				<Link to="/" className="btn-primary" style={{ textDecoration: "none", display: "inline-flex" }}>
					Back to Home
				</Link>
			</div>
		</div>
	);
}