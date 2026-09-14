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

  /*
   * Next's development indicator defaults to `bottom-left`, which is exactly where this application's
   * sidebar ends — it sat on top of the last navigation entry and read as part of the product. It is a
   * development-only badge and cannot be switched off in Next 16, only moved, so it is moved to the
   * corner nothing occupies. Absent from a production build either way.
   */
  devIndicators: { position: 'bottom-right' },

  /* The API's own errors are the contract; Next must not rewrite or swallow them. */
  poweredByHeader: false,
};

export default nextConfig;
