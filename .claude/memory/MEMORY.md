# Project: bun-test-react-ssr

## Stack
- Elysia v1.x (HTTP framework wrapping Bun.serve())
- React 19 SSR via renderToString
- Bun native HMR via HTML imports
- Tailwind + shadcn/ui components
- TypeScript, tsconfig path alias `@/` → `./src/`

## Key Files
- `src/index.ts` — Elysia server, SSR injection, getTemplate() self-fetch
- `src/server.tsx` — renderToString(<App url={...} />)
- `src/app.tsx` — shared React component (server + client)
- `src/pages/index.html` — static HTML entry; script src: `./frontend.tsx`
- `src/pages/frontend.tsx` — client entry: hydrateRoot / createRoot / HMR
- `src/pages/index.css` — styles
- `src/public/` — static assets (logo.svg, react.svg)

## The Single-Port SSR + HMR Trick
Elysia skips wildcard routes (charCode 42 = `*`) when building Bun's native
`routes` object, keeping them as the `fetch` fallback. `app.config.serve?.routes`
IS merged into Bun.serve(). So:

```ts
new Elysia({
  serve: {
    routes: { "/_bun_entry": indexHtml },  // triggers Bun bundling + HMR
  },
})
```

Bun registers JS chunk routes and HMR WebSocket. These take priority over
Elysia's `GET("*")` fallback. No second process, no proxy, one port (3000).

## Template Self-Fetch
On first HTML request, lazy-fetch `/_bun_entry` from localhost (Bun's own
route). Cache the response. Use it as SSR template (has correct hashed chunk
paths + HMR client already injected). Works because Bun updates modules
in-place during HMR — chunk paths don't change.

## Hydration Pattern (frontend.tsx)
- `window.__SSR__?.url` provides the URL from SSR payload
- `hydrateRoot` when server markup exists; `createRoot` as CSR fallback
- HMR: root stored in `import.meta.hot.data.root` to survive re-evaluation

## Dev Command
```sh
bun --hot src/index.ts
```
