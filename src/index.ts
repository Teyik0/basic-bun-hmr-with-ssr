import { staticPlugin } from "@elysiajs/static";
import { Elysia } from "elysia";
import { render } from "./server";

const PORT = 3000;

// Lazily fetch and cache the Bun-processed HTML template.
// Bun rewrites script paths to bundled chunks and injects the HMR client,
// so we use this response as our SSR base instead of the raw HTML file.
let bundleTemplatePromise: Promise<string> | null = null;

function getTemplate(url: URL): Promise<string> {
	if (!bundleTemplatePromise) {
		bundleTemplatePromise = fetch(`${url}/_bun_hmr_entry`)
			.then((r) => r.text())
			.catch((err) => {
				bundleTemplatePromise = null;
				throw err;
			});
	}
	return bundleTemplatePromise;
}

const app = new Elysia()
	.use(
		await staticPlugin({
			assets: `${import.meta.dir}/public`,
			prefix: "/public",
		}),
	)
	.use(
		await staticPlugin({
			assets: `${import.meta.dir}/pages`,
			prefix: "/_bun_hmr_entry",
		}),
	)
	.get("*", async ({ request, set, server }) => {
		const url = new URL(request.url);

		// Get the Bun-processed HTML: correct bundle paths + HMR client injected.
		const template = await getTemplate(server?.url as URL);
		const [before, after] = template.split("<!--ssr-outlet-->");

		const payload = JSON.stringify({ url: url.pathname }).replace(
			/</g,
			"\\u003c",
		);

		const reactStream = await render(url.pathname);
		const encoder = new TextEncoder();

		const stream = new ReadableStream({
			async start(controller) {
				controller.enqueue(encoder.encode(before));

				await reactStream.pipeTo(
					new WritableStream({
						write(chunk) {
							controller.enqueue(chunk);
						},
					}),
				);

				controller.enqueue(
					encoder.encode(`<script>window.__SSR__=${payload}</script>${after}`),
				);

				controller.close();
			},
		});

		set.headers["content-type"] = "text/html; charset=utf-8";
		return new Response(stream);
	})
	.listen(PORT);

console.log(`🚀 Server running at ${app.server?.url}`);
