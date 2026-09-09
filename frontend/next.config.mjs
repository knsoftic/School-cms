/**
 * Next.js configuration.
 *
 * SRS §3 requires backend and frontend to "remain clearly separated during development", and §4/§30
 * make the backend a REST API this application talks to over HTTP like any other client. So there is
 * no rewrite proxying `/api` into Express: the API's origin is configuration
 * (`NEXT_PUBLIC_API_URL`), the browser calls it directly, and CORS on the backend is what permits it
 * — `config.app.corsOrigins` already carries this origin.
 *
 * Proxying would hide exactly the thing that must keep working in production: a cross-origin request
 * carrying a bearer token and an httpOnly refresh cookie.
 */
const nextConfig = {
  reactStrictMode: true,

  /* The API's own errors are the contract; Next must not rewrite or swallow them. */
  poweredByHeader: false,
};

export default nextConfig;
