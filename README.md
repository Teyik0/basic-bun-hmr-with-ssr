# Bun SSR + HMR with Elysia — Single Port, No Proxy

## Goals

- SSR with React (`renderToString`)
- Bun's native HMR (hot module replacement) preserved
- No extra fetch round-trip for initial data
- No second process, no reverse proxy, single port
- One server: Elysia

---

## The Core Problem

Bun's HTML bundler rewrites `<script type="module" src="./frontend.tsx">` to a
hashed bundle path (e.g. `/_bun/chunk-abc123.js`) and injects the HMR client
script. If you serve your own HTML from the raw file on disk, the browser
requests `./frontend.tsx` — a `.tsx` file — as a JS module. Elysia's wildcard
route catches that request and returns HTML, which gives:

```
Failed to load module script: Expected a JavaScript-or-Wasm module script
but the server responded with a MIME type of "text/html".
```

The fix is to never serve the raw `index.html` to users. Always serve the
Bun-processed version, which has the correct bundle paths already rewritten.

---

## The Trick — Elysia + `serve.routes`

Elysia wraps `Bun.serve()` internally. Its source skips wildcard routes when
building `Bun.serve()`'s native `routes` object (charCode 42 = `*`), keeping
them as the `fetch` fallback instead. And it merges `app.config.serve?.routes`
directly into `Bun.serve()`:

```ts
// elysia/dist/adapter/bun/index.js (simplified)
Bun.serve({
  routes: mergeRoutes(
    elysiaStaticRoutes,
    elysiaFetchHandlerRoutes,
    app.config.serve?.routes,   // ← our HTML bundle goes here
  ),
  fetch: app.fetch,             // ← Elysia's wildcard lives here
});
```

**Bun routes always take priority over `fetch`.** So anything Bun registers
(JS bundles, HMR WebSocket) is never seen by Elysia's wildcard handler.

```ts
const app = new Elysia({
  serve: {
    routes: {
      "/_bun_entry": indexHtml,  // ← import indexHtml from "./pages/index.html"
    },
  },
})
```

This one line tells Bun to:
1. Bundle `frontend.tsx` and all its dependencies
2. Serve the resulting JS chunks at their registered paths
3. Set up the HMR WebSocket
4. Handle all of the above before Elysia's `fetch` handler ever runs

---

## The Template Self-Fetch

The Bun-processed HTML at `/_bun_entry` has the correct hashed script path and
the injected HMR bootstrap. We fetch it once (lazily on the first request) and
cache it as the SSR template:

```ts
let bundleTemplatePromise: Promise<string> | null = null;

function getTemplate(): Promise<string> {
  if (!bundleTemplatePromise) {
    bundleTemplatePromise = fetch(`http://localhost:${PORT}/_bun_entry`)
      .then((r) => r.text())
      .catch((err) => { bundleTemplatePromise = null; throw err; });
  }
  return bundleTemplatePromise;
}
```

`/_bun_entry` is a Bun route — it never hits Elysia's wildcard. The self-fetch
is a normal concurrent async request; there is no deadlock.

In HMR mode Bun updates modules in-place without changing chunk paths, so the
cached template stays valid across hot reloads.

---

## Request Routing Table

| Request | Who handles it | Result |
|---|---|---|
| `GET /_bun_entry` | Bun route | Raw bundled HTML (used as template) |
| `GET /_bun/chunk-*.js` | Bun (auto-registered) | Bundled JS |
| `WS /_bun/hmr` | Bun (auto-registered) | HMR WebSocket |
| `GET /public/*` | Elysia static plugin | Static assets |
| `GET /`, `/about`, … | Elysia `GET("*")` fallback | SSR-injected HTML |

---

## SSR Payload — No Extra Fetch

State is serialized directly into the HTML response:

```html
<div id="root"><!-- server-rendered markup --></div>
<script>window.__SSR__ = { url: "/about" };</script>
```

The client reads it immediately on load — no extra network request, no
waterfall, no flash of unstyled content.

---

## Hydration (`frontend.tsx`)

```tsx
const url = window.__SSR__?.url ?? window.location.pathname;
const app = <StrictMode><App url={url} /></StrictMode>;

if (import.meta.hot) {
  // HMR: reuse the existing root across hot reloads
  const root = (import.meta.hot.data.root ??= elem.innerHTML.trim()
    ? hydrateRoot(elem, app)
    : createRoot(elem));
  root.render(app);
} else if (elem.innerHTML.trim()) {
  hydrateRoot(elem, app);   // SSR: attach to existing DOM
} else {
  createRoot(elem).render(app);  // CSR fallback
}
```

- **SSR path**: `hydrateRoot` attaches React to the server-rendered DOM without
  re-rendering. React warnings fire if the server and client render diverge.
- **HMR path**: the root is stored in `import.meta.hot.data` so it survives
  module re-evaluation. React Fast Refresh updates components in place.
- **CSR fallback**: if there is no server markup, `createRoot` renders normally.

---

## Dev Flow

```
bun --hot src/index.ts
        │
        ├─ Elysia starts on port 3000
        │
        └─ Bun.serve() receives routes: { "/_bun_entry": indexHtml }
                │
                ├─ Bun bundles frontend.tsx → registers chunk routes
                ├─ Bun sets up HMR WebSocket
                │
Browser → GET /
                │
                └─ Elysia GET("*") (fetch fallback)
                        │
                        ├─ getTemplate() → self-fetch GET /_bun_entry (Bun route)
                        │       └─ returns HTML with correct chunk paths + HMR client
                        │
                        ├─ renderToString(<App url="/" />)  ← SSR
                        │
                        ├─ replace <!--ssr-outlet--> with SSR markup + __SSR__ script
                        │
                        └─ return modified HTML

Browser loads /_bun/chunk-*.js  → Bun serves it
Browser connects WS /_bun/hmr   → Bun handles HMR

You edit app.tsx → Bun pushes HMR update → React Fast Refresh → no page reload
```

---

## File Structure

```
src/
  index.ts          ← Elysia server + getTemplate() + SSR injection
  server.tsx        ← renderToString(<App url={...} />)
  app.tsx           ← shared React component (server + client)
  pages/
    index.html      ← static entry; Bun uses this to discover frontend.tsx
    frontend.tsx    ← client entry: hydrateRoot / createRoot
    index.css       ← styles
  public/
    logo.svg
    react.svg
```

---

## Why Wildcards Don't Intercept Bundle Requests

Elysia's `listen()` internally calls `Bun.serve()`. When building the native
`routes` object it skips any route whose path ends with `*` (ASCII 42):

```js
// elysia/dist/adapter/bun/index.js ~line 50
if (route.path.charCodeAt(route.path.length - 1) === 42) continue;
```

Wildcard routes become part of the `fetch` handler (the fallback), not native
Bun routes. Native Bun routes win over `fetch`. So JS chunks and the HMR
WebSocket — registered by Bun when it processes the HTML import — are served
by Bun and never reach Elysia's `GET("*")`.

---

## What Breaks HMR

- Removing `"/_bun_entry": indexHtml` from `serve.routes` — Bun stops
  bundling, no HMR WebSocket is set up
- Intercepting `/_bun/*` paths in Elysia routes — Bun's bundle responses get
  overridden
- Serving JS/TSX files yourself with the wrong MIME type — browsers reject them
  as module scripts

---

## Summary

> Register the HTML import as a hidden Bun route (`/_bun_entry`). Bun owns all
> JS, chunks, and the HMR WebSocket. On the first request, self-fetch that route
> to get the Bun-processed HTML (correct paths, HMR client injected), cache it,
> and use it as the SSR template. Elysia's wildcard only ever serves that
> modified HTML. One port. One process. No separate dev server. No proxy.
