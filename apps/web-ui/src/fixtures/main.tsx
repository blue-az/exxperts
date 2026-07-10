import React from "react";
import { createRoot } from "react-dom/client";
import { FixtureGallery } from "./FixtureGallery";

createRoot(document.getElementById("fixture-root")!).render(
	<React.StrictMode>
		<FixtureGallery />
	</React.StrictMode>,
);
