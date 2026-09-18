/*
 * Applies the stored colour theme before the first paint.
 *
 * A static file loaded by a render-blocking <script src> rather than an inline
 * `dangerouslySetInnerHTML`, because `verify-security.js` asserts that nothing in `frontend/src`
 * calls that API — React escapes every interpolated value by construction and that assertion is what
 * keeps the claim true. The string here is a compile-time constant with no interpolation, so an
 * inline version would have been safe in fact; narrowing a cross-site-scripting rule to admit one's
 * own code is a bad habit even when the code is fine, and the cost of not doing it is one tiny
 * cacheable request.
 *
 * Why it has to run here at all: reading the preference in an effect means the first paint happens in
 * the wrong theme and then snaps. That flash is the thing every themed interface is judged on, and
 * only a synchronous read before paint prevents it.
 *
 * Kept in step with `src/components/theme.tsx` by hand — both sides are three lines, and shipping a
 * module to the document head to share them would cost more than it saves.
 */
(function () {
  try {
    var choice = localStorage.getItem('msms-theme');
    if (choice === 'dark' || choice === 'light') {
      document.documentElement.setAttribute('data-theme', choice);
    }
  } catch (e) {
    /* Storage throws outright in some privacy modes. Following the system is a fine answer. */
  }
})();
