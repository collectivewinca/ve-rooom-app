import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import ErrorBoundary from "./components/ErrorBoundary";
import Home from "./pages/Home";
import Meeting from "./pages/Meeting";
import Summary from "./pages/Summary";
import Dashboard from "./pages/Dashboard";
import NotFound from "./pages/NotFound";

export default function App() {
	return (
		<ErrorBoundary>
			<Layout>
				<Routes>
					<Route path="/" element={<Home />} />
					<Route path="/dashboard" element={<Dashboard />} />
					<Route path="/meeting/:roomId" element={<Meeting />} />
					<Route path="/summary/:roomId" element={<Summary />} />
					<Route path="*" element={<NotFound />} />
				</Routes>
			</Layout>
		</ErrorBoundary>
	);
}