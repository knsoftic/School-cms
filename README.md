# hostinger-frontend — generated, do not edit

This branch is the web app, already built, as Hostinger runs it. It is rewritten by
`.github/workflows/hostinger-frontend.yml` on every push to `main` that touches `frontend/`.
Change the source on `main`; anything committed here is replaced by the next build.

Hostinger: deploy this branch with Node.js 24, no build step, and entry file `server.js`.
Why the build does not happen on Hostinger: `deploy/hostinger/bundle-frontend.js` on `main`.
