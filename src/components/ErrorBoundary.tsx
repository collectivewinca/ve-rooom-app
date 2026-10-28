import { Component, type ReactNode, type ErrorInfo } from "react";
import { Link } from "react-router-dom";

interface Props {
	children: ReactNode;
}

interface State {
	hasError: boolean;
	error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error): State {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("[ErrorBoundary]", error, info.componentStack);
	}

	render() {
		if (this.state.hasError) {
			return (
				<div className="page-wrapper" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", textAlign: "center", padding: "2rem" }}>
					<div>
						<img src="/favicon.svg" alt="VE Rooom" style={{ width: 64, height: 64, borderRadius: 16, marginBottom: "1.25rem", opacity: 0.5 }} />
						<h1 style={{ fontSize: "1.5rem", fontWeight: 800, marginBottom: "0.5rem", color: "var(--color-text)" }}>Something went wrong</h1>
						<p style={{ color: "var(--color-text-muted)", fontSize: "0.875rem", marginBottom: "1.5rem", maxWidth: 320 }}>
							{this.state.error?.message || "An unexpected error occurred."}
						</p>
						<Link to="/" className="btn-primary" style={{ textDecoration: "none", display: "inline-flex" }}>
							Back to Home
						</Link>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}