// Manual mock for src/supabase.js, used automatically whenever a test file
// calls `jest.mock('./supabase')`. Keeps tests fast, deterministic, and off
// production Supabase entirely.
//
// CRA's default Jest config sets `resetMocks: true`, which wipes mock
// *implementations* (not just call history) before every single test — so
// default behavior can't live here at module scope, it has to be
// re-established in a `beforeEach` in the test file itself. See App.test.js.

export const supabase = {
  from: jest.fn(),
  functions: { invoke: jest.fn() },
  // Used by aboutPhotoSrc (App.js) to resolve a live (Storage-backed)
  // about-page photo's public URL - default implementation re-established
  // in App.test.js's mockInvokeDefaults (see that file for why it can't
  // live here at module scope).
  storage: { from: jest.fn() },
};
