import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "@/app";

declare global {
	interface Window {
		__SSR__?: { url: string };
	}
}

const elem = document.getElementById("root") as HTMLElement;
const url = window.__SSR__?.url ?? window.location.pathname;

const app = (
	<StrictMode>
		<App url={url} />
	</StrictMode>
);

if (import.meta.hot) {
	// biome-ignore lint/suspicious/noAssignInExpressions: needed pattern for hmr
	const root = (import.meta.hot.data.root ??= elem.innerHTML.trim()
		? hydrateRoot(elem, app)
		: createRoot(elem));
	root.render(app);
} else if (elem.innerHTML.trim()) {
	hydrateRoot(elem, app);
} else {
	createRoot(elem).render(app);
}
