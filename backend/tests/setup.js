'use strict';

/**
 * Per-test-file guards. Referenced by `setupFilesAfterEnv` in package.json.
 *
 * Its absence was Known Issue #4: jest resolves `setupFilesAfterEnv` during config normalization and
 * throws a hard ValidationError before it discovers a single test, so `npm test` failed with
 * "Module <rootDir>/tests/setup.js in the setupFilesAfterEnv option was not found" and never ran
 * anything. Merely existing fixes that.
 *
 * ## What must NOT go in here
 *
 * `setupFilesAfterEnv` runs once per test **file**, inside the test environment, with a fresh module
 * registry each time. The two things most commonly put in a file like this would each break this
 * repo, silently and in a way that looks like flake:
 *
 *   - **`jest.useFakeTimers()`** — `scripts/lib/settle.js` polls with a real `setTimeout` against a
 *     `Date.now()` deadline. Under fake timers the clock never advances, so every `settle()` call
 *     runs to its full bound and the suites that use it hang until the 60s test timeout.
 *   - **A global truncate or database reset** — every suite authenticates as the seeded Super Admin.
 *     Wiping between files destroys the login the whole loop depends on.
 *
 * Neither applies to the suites themselves, which run as child processes in globalSetup long before
 * this file is loaded — but both would apply to any test added here later, and the failure would be
 * blamed on the new test rather than on this file. So the guard below is not defensive decoration:
 * it names the mistake at the moment it is made.
 */

beforeAll(() => {
  /*
   * Assert the timers are the real ones. This is the only assertion in this file that can ever fire,
   * and it fires exactly when someone adds `jest.useFakeTimers()` and then wonders why unrelated
   * suites started timing out.
   *
   * Both jest timer implementations are covered, and each check is the mechanism that implementation
   * actually uses rather than a guess:
   *
   *   - **modern** (the default since jest 27) installs `@sinonjs/fake-timers`, whose `hijackMethod`
   *     ends with `target[method].clock = clock` — `fake-timers-src.js:958`. So a faked `setTimeout`
   *     carries a `clock` property and a real one does not.
   *   - **legacy** builds its replacements through `this._moduleMocker.fn(...)`
   *     (`legacyFakeTimers.js:404`), i.e. they are jest mock functions, which carry
   *     `_isMockFunction === true`.
   */
  const isMocked = setTimeout._isMockFunction === true || Boolean(setTimeout.clock);

  if (isMocked) {
    throw new Error(
      'Fake timers are installed. scripts/lib/settle.js polls with a real setTimeout against a ' +
        'Date.now() deadline and will hang. Remove jest.useFakeTimers() from the global setup.'
    );
  }
});
