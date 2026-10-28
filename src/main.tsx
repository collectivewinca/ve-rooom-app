import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";
import "./styles/variables.css";
import "./styles/shared.css";
import "./styles/navbar.css";
import "./styles/home.css";
import "./styles/meeting.css";
import "./styles/summary.css";
import "./styles/dashboard.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</React.StrictMode>
);