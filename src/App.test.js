import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App, { formatDate, calcAge, calcCost, isHolidayNight, getHolidayWindows, todayISO, formatMoney } from './App';
import { supabase } from './supabase';

jest.mock('./supabase');

// The booking flow now calls three different Edge Functions through the
// same supabase.functions.invoke() - lookup-client (StepOwner's manual
// button + StepDog's on-mount check), submit-booking (final submit), and
// send-confirmation (the SMS after a successful submit) - so the mock
// dispatches by function name rather than relying on call order, which
// would break the moment more than one function is in play in a test.
// `overrides` replaces the default for just the named function(s); pass
// a fake implementation matching supabase-js's (fnName, opts) => Promise
// shape.
const DEFAULT_STAY = {
  id: 'stay-1', check_in: '2026-10-01', check_out: '2026-10-05',
  drop_time: '09:00:00', pickup_time: '09:00:00', estimated_cost: 420,
  submitted_at: '2026-09-13T10:00:00Z',
  owner_name: 'Kim Miller', owner_phone: '4155550100', dog_names: ['Rex'],
};

const DEFAULT_SETTINGS = {
  dayRate: 105, multiDogDiscount: 0.10, holidayUpcharge: 0.30,
  vets: ['Marin Pet Hospital — (415) 479-8387'],
  packingList: ['Food', 'Leash & doggy bags'],
  smsConfirmation: 'Hi {firstName}! confirmed.',
  smsReminder: 'Hi {firstName}! reminder, bring {packingList}.',
  smsBilling: 'Hi {firstName}! total ${finalCost}.',
};

function mockInvokeDefaults(overrides = {}) {
  // A fresh mutable copy each call, so a Save in the admin settings UI
  // (which sends {password, updates}) behaves like the real Edge
  // Function - merging and echoing back the new values - rather than
  // always returning the same fixed defaults regardless of what was sent.
  const currentSettings = { ...DEFAULT_SETTINGS };
  let currentFeedback = [];
  supabase.functions.invoke.mockImplementation((fn, opts) => {
    if (overrides[fn]) return overrides[fn](opts);
    if (fn === 'lookup-client') return Promise.resolve({ data: { found: false }, error: null });
    if (fn === 'submit-booking') return Promise.resolve({ data: { stay: DEFAULT_STAY }, error: null });
    if (fn === 'send-confirmation') return Promise.resolve({ data: {}, error: null });
    if (fn === 'admin-data') return Promise.resolve({ data: null, error: { message: 'not mocked in this test' } });
    if (fn === 'send-contact') return Promise.resolve({ data: { success: true }, error: null });
    // Mimics the real feedback function: no password -> public submit
    // (appends to an in-memory list); password + id -> update that
    // submission's status; password alone -> list everything + open count.
    if (fn === 'feedback') {
      const { password, id, status, message, category, name, contact } = opts?.body || {};
      if (!password) {
        if (!message?.trim()) return Promise.resolve({ data: null, error: { message: 'Message is required' } });
        currentFeedback = [
          { id: `fb-${currentFeedback.length + 1}`, status: 'open', created_at: '2026-09-16T12:00:00Z', category: category || 'idea', name: name || null, contact: contact || null, message },
          ...currentFeedback,
        ];
        return Promise.resolve({ data: { success: true }, error: null });
      }
      if (id) {
        currentFeedback = currentFeedback.map(f => (f.id === id ? { ...f, status } : f));
        return Promise.resolve({ data: { feedback: currentFeedback.find(f => f.id === id) }, error: null });
      }
      return Promise.resolve({
        data: { feedback: currentFeedback, openCount: currentFeedback.filter(f => f.status === 'open').length },
        error: null,
      });
    }
    // App fetches this once on mount (public read, no password) to load
    // live pricing/vet-list settings - every test needs a sane default
    // here or that automatic call interferes with tests written around
    // a single expected invoke() call (e.g. mockResolvedValueOnce).
    if (fn === 'settings') {
      const updates = opts?.body?.updates;
      if (updates) Object.assign(currentSettings, updates);
      return Promise.resolve({ data: { ...currentSettings }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

// CRA's Jest config sets resetMocks: true, which wipes mock implementations
// (not just call history) before every test — so defaults are re-applied
// here each time rather than once at module scope.
beforeEach(() => {
  mockInvokeDefaults();
  // Reset the URL before every test - admin tests opt in via goToAdminUrl(),
  // everything else should start from a plain, non-admin URL.
  window.history.pushState({}, '', '/');
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function isoMonthsAgo(months, day = 15) {
  const d = new Date();
  d.setDate(day); // dodge month-length edge cases (e.g. Jan 31 - 1 month)
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function daysFromToday(offset) {
  // NOT `.toISOString().slice(0,10)` - toISOString() is always UTC, and
  // this helper hit exactly the bug todayISO() (src/App.js) was fixed
  // for earlier: in the evening Pacific time, UTC has already rolled to
  // tomorrow, silently shifting every date this returns by a day and
  // breaking date-sensitive tests specifically when run in the evening.
  // Local calendar fields instead, same fix as todayISO().
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Renders and advances only to the Owner Information page - for tests
// that check that page's own fields (vet, Number of Dogs) directly,
// without also filling and leaving it.
async function goToOwnerStep() {
  render(<App />);
  fireEvent.click(screen.getByText('Book My Stay'));
  await screen.findByText('Owner Information');
}

// Fills Owner Information (name/phone/email/vet/Number of Dogs) and
// advances to Dog 1. Vet and dog count live here now, not on the dog
// pages. "Number of Dogs" defaults to 0, so this always sets it to 1
// unless a test explicitly wants otherwise.
async function fillStep1(phone = '4155550100', name = 'Kim Miller', email = 'kim@test.com', numberOfDogs = 1) {
  render(<App />);
  fireEvent.click(screen.getByText('Book My Stay'));
  await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), phone);
  await userEvent.type(screen.getByPlaceholderText('Jane Smith'), name);
  await userEvent.type(screen.getByPlaceholderText('jane@email.com'), email);
  fireEvent.change(screen.getByDisplayValue('Select a Vet'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: String(numberOfDogs) } });
  fireEvent.click(screen.getByText('Continue'));
  await screen.findByText('Dog 1');
}

// Fills whichever dog page is currently showing and clicks Continue.
// Does not assert where it lands - the caller checks ("Dog 2" for an
// earlier dog, "Stay Dates" for the last one).
async function fillDogPage({ name = 'Rex', breed = 'Labrador', dob = '2020-01-01' } = {}) {
  await userEvent.type(screen.getByPlaceholderText('Buddy'), name);
  await userEvent.type(screen.getByPlaceholderText('Golden Retriever'), breed);
  fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: dob } });
  const selects = document.querySelectorAll('select');
  fireEvent.change(selects[0], { target: { value: 'yes' } }); // spayNeuter
  fireEvent.change(selects[1], { target: { value: 'no' } });  // aggression
  fireEvent.change(selects[2], { target: { value: 'no' } });  // health
  fireEvent.click(screen.getByText('Continue'));
}

// Single-dog case (the default form state) - fills Dog 1 and lands on
// Stay Dates. Multi-dog flows call fillDogPage() directly per dog.
async function fillStep2() {
  await fillDogPage();
  await screen.findByText('Stay Dates');
}

async function fillStep3() {
  const dateInputs = document.querySelectorAll('input[type="date"]');
  fireEvent.change(dateInputs[0], { target: { value: '2026-10-01' } });
  fireEvent.change(dateInputs[1], { target: { value: '2026-10-05' } });
  const timeInputs = document.querySelectorAll('input[type="time"]');
  fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
  fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
  fireEvent.click(screen.getByText('Continue'));
  await screen.findByText('Boarding Agreement');
}

async function fillStep4() {
  fireEvent.click(screen.getByText('I Have Read the Agreement'));
  await screen.findByText('Sign & Submit');
}

async function fillThrough(phone, name, email) {
  await fillStep1(phone, name, email);
  await fillStep2();
  await fillStep3();
  await fillStep4();
}

// Shaped like admin-data's actual response: dogs (each with a current
// profile, owner, and a `stays` array already sorted newest-first, where
// each stay entry carries its own frozen snapshot of name/breed/dob/
// aggression/health as declared for THAT stay - see admin-data/index.ts).
// Bud's two stays deliberately have different dob/aggression snapshots
// to exercise that distinction.
const SAMPLE_DOGS = [
  {
    id: 'dog-bud', name: 'Bud', breed: 'Labrador', dob: '2020-01-01',
    spay_neuter: 'yes', aggression_history: 'no', aggression_detail: '',
    health_concerns: 'no', health_detail: '',
    owner: { name: 'Kim', phone: '6505551111', email: 'kim@test.com' },
    stays: [
      {
        id: 'stay-1', check_in: '2026-09-01', check_out: '2026-09-03', drop_time: '09:00:00', pickup_time: '17:00:00',
        estimated_cost: 210, submitted_at: '2026-08-30T10:00:00Z', notes: 'Loves belly rubs', number_of_dogs: 1,
        dob: '2020-01-01', aggression_history: 'no', aggression_detail: '', health_concerns: 'no', health_detail: '',
        waiver_snapshot: [{ title: 'Risks & Releases', body: 'Test waiver body text.' }],
      },
      {
        id: 'stay-3', check_in: '2026-06-01', check_out: '2026-06-02', drop_time: '09:00:00', pickup_time: '17:00:00',
        estimated_cost: 105, submitted_at: '2026-05-30T10:00:00Z', notes: '', number_of_dogs: 1,
        dob: null, aggression_history: 'no', aggression_detail: '', health_concerns: 'no', health_detail: '',
      },
    ],
  },
  {
    id: 'dog-choco', name: 'Choco', breed: 'Poodle', dob: null,
    spay_neuter: 'no', aggression_history: 'yes', aggression_detail: 'Barks at mail carrier',
    health_concerns: 'yes', health_detail: 'Mild hip dysplasia',
    owner: { name: 'Estee', phone: '6505552222', email: 'estee@test.com' },
    stays: [
      {
        id: 'stay-2', check_in: '2026-09-05', check_out: '2026-09-06', drop_time: '10:00:00', pickup_time: '12:00:00',
        estimated_cost: null, submitted_at: '2026-08-31T10:00:00Z', notes: '', number_of_dogs: 1,
        dob: null, aggression_history: 'yes', aggression_detail: 'Barks at mail carrier',
        health_concerns: 'yes', health_detail: 'Mild hip dysplasia',
      },
    ],
  },
];
const SAMPLE_TOTAL_STAYS = 3; // 2 (Bud) + 1 (Choco), independent of dog count

// Admin has no visible button in the UI - reached only via a bookmarked
// ?admin URL. Tests navigate there the same way a real bookmark would.
function goToAdminUrl() {
  window.history.pushState({}, '', '/?admin');
}

async function loginAsAdmin(dogs = SAMPLE_DOGS, totalStays = SAMPLE_TOTAL_STAYS) {
  mockInvokeDefaults({ 'admin-data': async () => ({ data: { dogs, totalStays }, error: null }) });
  goToAdminUrl();
  render(<App />);
  await userEvent.type(screen.getByPlaceholderText('Password'), 'correct-password');
  fireEvent.click(screen.getByText('Sign In'));
  await screen.findByText('Bayview Boarding — Admin');
}

const SAMPLE_FEEDBACK = [
  { id: 'fb-1', category: 'bug', message: 'Map pin looks off on Safari', name: 'Jane Tester', contact: 'jane@test.com', status: 'open', created_at: '2026-09-16T12:00:00Z' },
  { id: 'fb-2', category: 'idea', message: 'Add a dark mode', name: null, contact: null, status: 'open', created_at: '2026-09-15T12:00:00Z' },
  { id: 'fb-3', category: 'other', message: 'Already fixed, thanks', name: null, contact: null, status: 'done', created_at: '2026-09-14T12:00:00Z' },
];

async function loginAsAdminWithFeedback(feedback = SAMPLE_FEEDBACK) {
  let current = feedback.map(f => ({ ...f }));
  mockInvokeDefaults({
    'admin-data': async () => ({ data: { dogs: SAMPLE_DOGS, totalStays: SAMPLE_TOTAL_STAYS }, error: null }),
    'feedback': async (opts) => {
      const { id, status } = opts?.body || {};
      if (id) {
        current = current.map(f => (f.id === id ? { ...f, status } : f));
        return { data: { feedback: current.find(f => f.id === id) }, error: null };
      }
      return { data: { feedback: current, openCount: current.filter(f => f.status === 'open').length }, error: null };
    },
  });
  goToAdminUrl();
  render(<App />);
  await userEvent.type(screen.getByPlaceholderText('Password'), 'correct-password');
  fireEvent.click(screen.getByText('Sign In'));
  await screen.findByText('Bayview Boarding — Admin');
}

// ── Pure helpers ─────────────────────────────────────────────────────────────
describe('formatDate', () => {
  test('returns empty string for falsy input', () => {
    expect(formatDate('')).toBe('');
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
  });

  test('formats an ISO date as M/D/YYYY', () => {
    expect(formatDate('2026-03-05')).toBe('03/05/2026');
  });
});

describe('calcAge', () => {
  test('returns empty string for falsy dob', () => {
    expect(calcAge('')).toBe('');
    expect(calcAge(null)).toBe('');
  });

  test('shows months for dogs under a year, pluralized', () => {
    expect(calcAge(isoMonthsAgo(6))).toBe('6 months');
    expect(calcAge(isoMonthsAgo(1))).toBe('1 month');
  });

  test('shows singular "year" for an exactly-1-year-old dog', () => {
    expect(calcAge(isoMonthsAgo(12))).toBe('1 year');
  });

  test('shows plural "years" for whole-year ages over 1', () => {
    expect(calcAge(isoMonthsAgo(36))).toBe('3 years');
  });

  test('shows "yr mo" format when there is a remainder', () => {
    expect(calcAge(isoMonthsAgo(27))).toBe('2 yr 3 mo');
  });
});

// 2026-03-10/11 are plain weekdays with no holiday window nearby - used
// throughout as neutral dates so these base-case tests aren't coupled to
// the holiday-upcharge logic covered separately below.
describe('calcCost', () => {
  test('returns null when any required field is missing', () => {
    expect(calcCost('', '2026-03-11', '09:00', '09:00', 100)).toBeNull();
    expect(calcCost('2026-03-10', '', '09:00', '09:00', 100)).toBeNull();
    expect(calcCost('2026-03-10', '2026-03-11', '', '09:00', 100)).toBeNull();
    expect(calcCost('2026-03-10', '2026-03-11', '09:00', '', 100)).toBeNull();
  });

  test('returns null when pickup is before drop-off', () => {
    expect(calcCost('2026-03-11', '2026-03-10', '09:00', '09:00', 100)).toBeNull();
  });

  test('charges a 1-day minimum for a short same-day stay', () => {
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100)).toBe('100.00');
  });

  test('rounds up partial days', () => {
    expect(calcCost('2026-03-10', '2026-03-11', '09:00', '10:00', 100)).toBe('200.00'); // 25 hrs -> 2 days
  });

  test('defaults to 1 dog when numberOfDogs is omitted', () => {
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100)).toBe('100.00');
  });
});

describe('calcCost — multi-dog discount', () => {
  test('charges the 2nd dog at 90% of the nightly rate (10% discount)', () => {
    // 1 night @ $100: dog 1 = $100, dog 2 = $100 * 0.9 = $90 -> $190
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100, 2)).toBe('190.00');
  });

  test('discount is uncapped - applies to every additional dog', () => {
    // dog 1 = $100, dogs 2 & 3 = $90 each -> $280
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100, 3)).toBe('280.00');
  });

  test('treats 0 or invalid dog counts as 1 dog', () => {
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100, 0)).toBe('100.00');
    expect(calcCost('2026-03-10', '2026-03-10', '09:00', '15:00', 100, null)).toBe('100.00');
  });

  test('applies across multiple nights', () => {
    // 2 nights, 2 dogs @ $100/night -> ($100 + $90) * 2 = $380
    expect(calcCost('2026-03-10', '2026-03-11', '09:00', '10:00', 100, 2)).toBe('380.00');
  });
});

describe('calcCost — holiday upcharge', () => {
  test('adds 30% on New Year\'s Day', () => {
    expect(calcCost('2026-01-01', '2026-01-01', '09:00', '15:00', 100)).toBe('130.00');
  });

  test('does not upcharge the day right after a holiday', () => {
    expect(calcCost('2026-01-02', '2026-01-02', '09:00', '15:00', 100)).toBe('100.00');
  });

  test('combines the holiday upcharge with the multi-dog discount', () => {
    // nightly rate = $100 * 1.3 = $130; dog 2 = $130 * 0.9 = $117 -> $247
    expect(calcCost('2026-01-01', '2026-01-01', '09:00', '15:00', 100, 2)).toBe('247.00');
  });

  test('only upcharges the holiday night within a multi-night stay', () => {
    // check-in Jan 1 (holiday, $130) -> check-out Jan 2 (ordinary night, $100)
    // = 2 nights total, only the first is upcharged -> $230
    expect(calcCost('2026-01-01', '2026-01-02', '09:00', '10:00', 100)).toBe('230.00');
  });
});

describe('isHolidayNight', () => {
  test('New Year\'s Day', () => {
    expect(isHolidayNight('2026-01-01')).toBe(true);
  });

  test('MLK Day (3rd Monday of January)', () => {
    expect(isHolidayNight('2026-01-19')).toBe(true);
    expect(isHolidayNight('2026-01-18')).toBe(false);
    expect(isHolidayNight('2026-01-20')).toBe(false);
  });

  test('Ski Week surrounding Presidents\' Day', () => {
    expect(isHolidayNight('2026-02-16')).toBe(true); // Presidents' Day itself
    expect(isHolidayNight('2026-02-14')).toBe(true); // Saturday before
    expect(isHolidayNight('2026-02-22')).toBe(true); // Sunday after
    expect(isHolidayNight('2026-02-13')).toBe(false);
    expect(isHolidayNight('2026-02-23')).toBe(false);
  });

  test('Memorial Day (last Monday of May)', () => {
    expect(isHolidayNight('2026-05-25')).toBe(true);
    expect(isHolidayNight('2026-05-18')).toBe(false);
  });

  test('July 4th', () => {
    expect(isHolidayNight('2026-07-04')).toBe(true);
    expect(isHolidayNight('2026-07-03')).toBe(false);
  });

  test('Labor Day (1st Monday of September)', () => {
    expect(isHolidayNight('2026-09-07')).toBe(true);
    expect(isHolidayNight('2026-09-14')).toBe(false);
  });

  test('Thanksgiving and the day after', () => {
    expect(isHolidayNight('2026-11-26')).toBe(true);
    expect(isHolidayNight('2026-11-27')).toBe(true);
    expect(isHolidayNight('2026-11-25')).toBe(false);
    expect(isHolidayNight('2026-11-28')).toBe(false);
  });

  test('Christmas and New Year\'s Eve', () => {
    expect(isHolidayNight('2026-12-25')).toBe(true);
    expect(isHolidayNight('2026-12-31')).toBe(true);
    expect(isHolidayNight('2026-12-24')).toBe(false);
  });

  test('an ordinary weekday is not a holiday', () => {
    expect(isHolidayNight('2026-03-10')).toBe(false);
  });

  test('recomputes for a different year rather than using hardcoded dates', () => {
    // MLK Day 2027 is the 3rd Monday of January 2027 (Jan 18), not Jan 19
    expect(isHolidayNight('2027-01-19')).toBe(false);
    expect(isHolidayNight('2027-01-18')).toBe(true);
  });
});

describe('getHolidayWindows', () => {
  test('returns 9 windows per year (one per holiday, Ski Week + Thanksgiving as ranges)', () => {
    expect(getHolidayWindows(2026)).toHaveLength(9);
  });

  test('every window is a valid [start, end] ISO pair with start <= end', () => {
    getHolidayWindows(2026).forEach(([start, end]) => {
      expect(start <= end).toBe(true);
    });
  });
});

describe('formatMoney', () => {
  test('leaves amounts under 1,000 unchanged', () => {
    expect(formatMoney('199.50')).toBe('199.50');
    expect(formatMoney(420)).toBe('420');
  });

  test('adds a thousands comma above 999, preserving the existing decimal form', () => {
    expect(formatMoney('1199.50')).toBe('1,199.50');
    expect(formatMoney(1420)).toBe('1,420');
    expect(formatMoney('999.99')).toBe('999.99'); // right at the boundary, no comma yet
    expect(formatMoney('1000.00')).toBe('1,000.00');
  });

  test('adds multiple commas for larger amounts', () => {
    expect(formatMoney(1234567)).toBe('1,234,567');
  });

  test('passes through null/undefined/empty/non-numeric values unchanged', () => {
    expect(formatMoney(null)).toBeNull();
    expect(formatMoney(undefined)).toBeUndefined();
    expect(formatMoney('')).toBe('');
    expect(formatMoney('not a number')).toBe('not a number');
  });
});

describe('todayISO', () => {
  const realTZ = process.env.TZ;
  afterEach(() => {
    process.env.TZ = realTZ;
    jest.useRealTimers();
  });

  test('uses the local calendar date, not UTC (the evening-Pacific-time bug)', () => {
    // 2026-03-16 06:00 UTC = 2026-03-15 23:00 PDT - a different calendar
    // date in each. A UTC-based implementation would wrongly say "today"
    // is the 16th while it's still the evening of the 15th in Pacific
    // time, causing the Stay Dates page's min/"cannot be in the past"
    // check to reject that same Pacific evening's actual today.
    process.env.TZ = 'America/Los_Angeles';
    jest.useFakeTimers().setSystemTime(new Date('2026-03-16T06:00:00Z'));
    expect(todayISO()).toBe('2026-03-15');
  });

  test('matches the UTC date when local time and UTC agree', () => {
    process.env.TZ = 'America/Los_Angeles';
    jest.useFakeTimers().setSystemTime(new Date('2026-03-16T18:00:00Z')); // 11am PDT
    expect(todayISO()).toBe('2026-03-16');
  });
});

// ── App-level settings (fetched from Supabase, not hardcoded) ───────────────
describe('Live settings (day rate, discount %, holiday %, vet list)', () => {
  test('the vet dropdown reflects the fetched vet list, not the hardcoded fallback', async () => {
    mockInvokeDefaults({
      'settings': async () => ({
        data: { dayRate: 105, multiDogDiscount: 0.10, holidayUpcharge: 0.30, vets: ['Only Custom Vet — (415) 555-0100'] },
        error: null,
      }),
    });
    await goToOwnerStep();
    expect(await screen.findByText('Only Custom Vet — (415) 555-0100')).toBeInTheDocument();
    expect(screen.queryByText('Marin Pet Hospital — (415) 479-8387')).not.toBeInTheDocument();
  });

  test('the cost estimate uses the fetched discount % and holiday %, not the hardcoded defaults', async () => {
    mockInvokeDefaults({
      'settings': async () => ({
        data: { dayRate: 100, multiDogDiscount: 0.20, holidayUpcharge: 0.30, vets: ['Marin Pet Hospital — (415) 479-8387'] },
        error: null,
      }),
    });
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-10-03' } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    // 2 nights @ $100/night, fetched rate - confirms dayRate loaded too
    expect(await screen.findByText('$200.00')).toBeInTheDocument();
  });

  test('keeps the hardcoded defaults if the settings fetch fails, rather than crashing', async () => {
    mockInvokeDefaults({ 'settings': async () => ({ data: null, error: { message: 'network down' } }) });
    await goToOwnerStep();
    expect(screen.getByDisplayValue('Select a Vet')).toBeInTheDocument();
    expect(screen.getByText('Marin Pet Hospital — (415) 479-8387')).toBeInTheDocument();
  });
});

describe('Landing — Learn more about us', () => {
  test('a real link, separate from the title, takes a first-timer to the About page', async () => {
    render(<App />);
    expect(screen.getByText('Bayview Boarding')).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Learn more/));
    expect(await screen.findByText('Dog Paradise Above Loch Lomond')).toBeInTheDocument();
  });

  test('Back from the About page returns to the landing page', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    fireEvent.click(screen.getByText('← Back'));
    expect(await screen.findByText('Book My Stay')).toBeInTheDocument();
    expect(screen.queryByText('Dog Paradise Above Loch Lomond')).not.toBeInTheDocument();
  });

  test('About page shows home characteristics and the typical-day/safety sections', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    expect(screen.getByText('Has a fenced yard')).toBeInTheDocument();
    expect(screen.getByText('Potty breaks every 0-2 hours')).toBeInTheDocument();
    expect(screen.getByText('Safety, trust & environment')).toBeInTheDocument();
    expect(screen.getByText('A typical day')).toBeInTheDocument();
    expect(screen.getByText(/1,500-acre China Camp State Park/)).toBeInTheDocument();
  });

  test('About page shows an approximate-location map, not the exact address', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    expect(screen.getByText(/not our exact address/)).toBeInTheDocument();
    const map = screen.getByTitle(/Approximate location/);
    expect(map.tagName).toBe('IFRAME');
    // a specific point ~300 yards past the actual address, not the address itself
    expect(map.getAttribute('src')).toContain('37.980802,-122.484319');
    // the exact street address must never appear on this public page
    expect(screen.queryByText(/210 Bayview Drive/)).not.toBeInTheDocument();
  });

  test('clicking anywhere on the map opens Google Maps in a new tab, at the pinned spot', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    const overlay = document.querySelector('.about-map-overlay');
    expect(overlay.tagName).toBe('A');
    expect(overlay).toHaveAttribute('target', '_blank');
    expect(overlay).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(overlay.getAttribute('href')).toBe('https://maps.app.goo.gl/xWg4sCFVpevDCKd16');
  });

  test('About page shows a Schedule section, written in "we" not "I"', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    expect(screen.getByText('Schedule')).toBeInTheDocument();
    expect(screen.getByText(/We are home throughout the week, early risers/)).toBeInTheDocument();
    // the old single-host, first-person phrasing should be gone entirely
    expect(screen.queryByText(/\bI am\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/We only take males that have been neutered/)).not.toBeInTheDocument();
  });

  test('the title is centered and a photo gallery renders in numbered order', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    const title = await screen.findByText('Dog Paradise Above Loch Lomond');
    expect(title).toHaveClass('about-title--center');
    const photos = document.querySelectorAll('.about-gallery-img');
    expect(photos.length).toBe(6);
    expect(photos[0].src).toContain('1-choco');
    expect(photos[5].src).toContain('6-china-camp-bay-line');
  });

  test('About page shows the Rover rating as a link to the Rover reviews, with dated review quotes', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    const ratingLink = screen.getByText('21 ratings on Rover');
    expect(ratingLink.tagName).toBe('A');
    expect(ratingLink).toHaveAttribute(
      'href',
      'https://www.rover.com/members/kim-m-dog-paradise-above-loch-lomond/#:~:text=be%20cared%20for.-,View,-all'
    );
    expect(ratingLink).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/Took great care of our pup/)).toBeInTheDocument();
    expect(screen.getByText(/Aiste B\. · Jun 15, 2026/)).toBeInTheDocument();
    // the one 4-star, mixed review should not appear alongside the glowing ones
    expect(screen.queryByText(/somewhat awkward/)).not.toBeInTheDocument();
    // every review card shows its own 5-star row, not just the aggregate rating
    const starRows = document.querySelectorAll('.about-review-stars');
    expect(starRows.length).toBe(17);
    starRows.forEach(row => expect(row.textContent).toBe('★★★★★'));
  });

  test('Book My Stay on the About page starts the booking flow directly', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    fireEvent.click(screen.getAllByText('Book My Stay')[0]);
    expect(await screen.findByText('Owner Information')).toBeInTheDocument();
  });

  test('clicking the "Bayview Boarding" landing title also goes to the About page', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Bayview Boarding'));
    expect(await screen.findByText('Dog Paradise Above Loch Lomond')).toBeInTheDocument();
  });

  test('clicking the "Bayview Boarding" header wordmark mid-booking goes to the About page', async () => {
    await fillStep1();
    fireEvent.click(screen.getByText('Bayview Boarding'));
    expect(await screen.findByText('Dog Paradise Above Loch Lomond')).toBeInTheDocument();
  });
});

describe('Nav menu (hamburger)', () => {
  function openMenu() {
    fireEvent.click(screen.getByLabelText('Open menu'));
  }

  test('is collapsed until opened, then shows all five destinations', async () => {
    render(<App />);
    expect(screen.queryByText('About Us')).not.toBeInTheDocument();
    openMenu();
    expect(screen.getByText('About Us')).toBeInTheDocument();
    expect(screen.getByText('Contact Us')).toBeInTheDocument();
    expect(screen.getByText('Submit Idea')).toBeInTheDocument();
    expect(screen.getByText('Book a Stay')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  test('"Submit Idea" opens the idea/bug form', async () => {
    render(<App />);
    openMenu();
    fireEvent.click(screen.getByText('Submit Idea'));
    expect(await screen.findByText('Submit Idea', { selector: 'h1' })).toBeInTheDocument();
  });

  test('clicking the backdrop closes the menu without navigating', () => {
    render(<App />);
    openMenu();
    fireEvent.click(document.querySelector('.nav-menu-backdrop'));
    expect(screen.queryByText('About Us')).not.toBeInTheDocument();
    expect(screen.getByText('Bayview Boarding')).toBeInTheDocument();
  });

  test('"About Us" opens the About page', async () => {
    render(<App />);
    openMenu();
    fireEvent.click(screen.getByText('About Us'));
    expect(await screen.findByText('Dog Paradise Above Loch Lomond')).toBeInTheDocument();
  });

  test('"Contact Us" opens the contact form', async () => {
    render(<App />);
    openMenu();
    fireEvent.click(screen.getByText('Contact Us'));
    expect(await screen.findByText('Contact Us', { selector: 'h1' })).toBeInTheDocument();
  });

  test('"Book a Stay" jumps straight into the booking flow', async () => {
    render(<App />);
    openMenu();
    fireEvent.click(screen.getByText('Book a Stay'));
    expect(await screen.findByText('Owner Information')).toBeInTheDocument();
  });

  test('"Admin" opens the same password-gated admin login as the ?admin URL', async () => {
    render(<App />);
    openMenu();
    fireEvent.click(screen.getByText('Admin'));
    expect(await screen.findByText('Admin Access')).toBeInTheDocument();
  });

  test('is available from the About page and the Contact page too, not just the landing page', async () => {
    render(<App />);
    fireEvent.click(screen.getByText(/Learn more/));
    await screen.findByText('Dog Paradise Above Loch Lomond');
    expect(screen.getByLabelText('Open menu')).toBeInTheDocument();
    openMenu();
    fireEvent.click(screen.getByText('Contact Us'));
    await screen.findByText('Contact Us', { selector: 'h1' });
    expect(screen.getByLabelText('Open menu')).toBeInTheDocument();
  });
});

describe('Contact Us', () => {
  function goToContact() {
    render(<App />);
    fireEvent.click(screen.getByLabelText('Open menu'));
    fireEvent.click(screen.getByText('Contact Us'));
  }

  test('Send is disabled until name, message, and an email or phone are filled in', async () => {
    goToContact();
    await screen.findByText('Contact Us', { selector: 'h1' });
    const send = screen.getByText('Send Message');
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Jane Owner');
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('How can we help?'), 'Do you have room in October?');
    expect(send).toBeDisabled(); // still no email or phone
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'jane@test.com');
    expect(send).not.toBeDisabled();
  });

  test('sends the message via send-contact and shows a confirmation', async () => {
    goToContact();
    await screen.findByText('Contact Us', { selector: 'h1' });
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Jane Owner');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'jane@test.com');
    await userEvent.type(screen.getByPlaceholderText('How can we help?'), 'Do you have room in October?');
    fireEvent.click(screen.getByText('Send Message'));

    await waitFor(() => {
      expect(supabase.functions.invoke).toHaveBeenCalledWith('send-contact', {
        body: { name: 'Jane Owner', email: 'jane@test.com', phone: '', message: 'Do you have room in October?' },
      });
    });
    expect(await screen.findByText('Message sent!')).toBeInTheDocument();
    expect(screen.getByText(/Thanks, Jane/)).toBeInTheDocument();
  });

  test('shows an error and does not claim success if the send fails', async () => {
    mockInvokeDefaults({ 'send-contact': async () => ({ data: null, error: { message: 'network down' } }) });
    goToContact();
    await screen.findByText('Contact Us', { selector: 'h1' });
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Jane Owner');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'jane@test.com');
    await userEvent.type(screen.getByPlaceholderText('How can we help?'), 'Hi');
    fireEvent.click(screen.getByText('Send Message'));
    expect(await screen.findByText(/Something went wrong sending your message/)).toBeInTheDocument();
    expect(screen.queryByText('Message sent!')).not.toBeInTheDocument();
  });

  test('Back returns to the landing page', async () => {
    goToContact();
    await screen.findByText('Contact Us', { selector: 'h1' });
    fireEvent.click(screen.getByText('← Back'));
    expect(await screen.findByText('Book My Stay')).toBeInTheDocument();
  });
});

describe('Submit Idea', () => {
  function goToSubmitIdea() {
    render(<App />);
    fireEvent.click(screen.getByLabelText('Open menu'));
    fireEvent.click(screen.getByText('Submit Idea'));
  }

  test('defaults to "Idea / suggestion" and requires only a message', async () => {
    goToSubmitIdea();
    await screen.findByText('Submit Idea', { selector: 'h1' });
    expect(screen.getByDisplayValue('Idea / suggestion')).toBeInTheDocument();
    const submit = screen.getByText('Submit');
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText("What's on your mind?"), 'Add dark mode');
    expect(submit).not.toBeDisabled();
  });

  test('submits with category/name/contact and shows a thank-you', async () => {
    goToSubmitIdea();
    await screen.findByText('Submit Idea', { selector: 'h1' });
    fireEvent.change(screen.getByDisplayValue('Idea / suggestion'), { target: { value: 'bug' } });
    await userEvent.type(screen.getByPlaceholderText("What's on your mind?"), 'The map pin looks wrong on Safari');
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Jane Tester');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'jane@test.com');
    fireEvent.click(screen.getByText('Submit'));

    await waitFor(() => {
      expect(supabase.functions.invoke).toHaveBeenCalledWith('feedback', {
        body: {
          category: 'bug', message: 'The map pin looks wrong on Safari',
          name: 'Jane Tester', contact: 'jane@test.com',
        },
      });
    });
    expect(await screen.findByText('Thanks!')).toBeInTheDocument();
  });

  test('shows an error and does not claim success if the send fails', async () => {
    mockInvokeDefaults({ 'feedback': async () => ({ data: null, error: { message: 'network down' } }) });
    goToSubmitIdea();
    await screen.findByText('Submit Idea', { selector: 'h1' });
    await userEvent.type(screen.getByPlaceholderText("What's on your mind?"), 'Hi');
    fireEvent.click(screen.getByText('Submit'));
    expect(await screen.findByText(/Something went wrong sending this/)).toBeInTheDocument();
    expect(screen.queryByText('Thanks!')).not.toBeInTheDocument();
  });

  test('Back returns to the landing page', async () => {
    goToSubmitIdea();
    await screen.findByText('Submit Idea', { selector: 'h1' });
    fireEvent.click(screen.getByText('← Back'));
    expect(await screen.findByText('Book My Stay')).toBeInTheDocument();
  });
});

// ── Step 1: Owner Info (now also vet + Number of Dogs) ──────────────────────
describe('Step 1 — Owner Info', () => {
  test('Continue is disabled (greyed out) on an empty form, and does nothing if clicked anyway', async () => {
    await goToOwnerStep();
    const button = screen.getByText('Continue');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    // a disabled button never fires its click handler - no error text,
    // no navigation to Dog 1
    expect(screen.queryByText('Required')).not.toBeInTheDocument();
    expect(screen.queryByText('Dog 1')).not.toBeInTheDocument();
  });

  test('Continue enables once every required field (name/phone/email/vet) is filled - dog count already defaults to 1', async () => {
    await goToOwnerStep();
    const button = screen.getByText('Continue');
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');
    expect(button).toBeDisabled(); // vet still unset
    fireEvent.change(screen.getByDisplayValue('Select a Vet'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });
    expect(button).not.toBeDisabled();
  });

  test('advances to Dog 1 when all required fields filled', async () => {
    await fillStep1();
    expect(screen.getByText('Dog 1')).toBeInTheDocument();
  });

  test('shows a first-timer note explaining to fill out every field', async () => {
    await goToOwnerStep();
    expect(screen.getByText(/First time boarding with us/)).toBeInTheDocument();
  });

  test('vet defaults to the "Select a Vet" placeholder', async () => {
    await goToOwnerStep();
    expect(screen.getByDisplayValue('Select a Vet')).toBeInTheDocument();
  });

  test('Number of Dogs defaults to 1 (editable) and does not show a discount note', async () => {
    await goToOwnerStep();
    expect(screen.getByRole('spinbutton')).toHaveValue(1);
    expect(screen.queryByText(/off each additional dog/)).not.toBeInTheDocument();
  });

  test('Continue stays disabled if Number of Dogs is cleared down to 0, everything else filled', async () => {
    await goToOwnerStep();
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');
    fireEvent.change(screen.getByDisplayValue('Select a Vet'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });
    expect(screen.getByText('Continue')).toBeDisabled();
    expect(screen.queryByText('Dog 1')).not.toBeInTheDocument();
  });

  test('shows the multi-dog discount note once more than 1 dog is entered', async () => {
    await goToOwnerStep();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
    expect(await screen.findByText(/10% off each additional dog/)).toBeInTheDocument();
  });

  test('lets the field go blank while editing, instead of snapping back on every keystroke', async () => {
    // Regression test for the actual reported bug: clearing "1" before
    // typing "2" used to clamp straight back to 1 on the empty
    // intermediate state, so the field could never actually change.
    await goToOwnerStep();
    const spinbutton = screen.getByRole('spinbutton');
    fireEvent.change(spinbutton, { target: { value: '1' } });
    expect(spinbutton).toHaveValue(1);
    fireEvent.change(spinbutton, { target: { value: '' } }); // simulates backspacing to clear
    expect(spinbutton).toHaveValue(null); // genuinely blank, not reverted to 1
    fireEvent.change(spinbutton, { target: { value: '2' } });
    expect(spinbutton).toHaveValue(2);
  });

  test('blank Number of Dogs reverts to the last committed count on blur', async () => {
    await goToOwnerStep();
    const spinbutton = screen.getByRole('spinbutton');
    fireEvent.change(spinbutton, { target: { value: '3' } });
    fireEvent.change(spinbutton, { target: { value: '' } });
    fireEvent.blur(spinbutton);
    expect(spinbutton).toHaveValue(3);
  });

  test('looks up a returning client by phone and autofills name/email', async () => {
    mockInvokeDefaults({
      'lookup-client': async () => ({
        data: { found: true, client: { owner_name: 'Found Person', owner_email: 'found@test.com' } },
        error: null,
      }),
    });
    await goToOwnerStep();
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    fireEvent.click(screen.getByText('Look up'));
    expect(await screen.findByText(/Info found/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Jane Smith')).toHaveValue('Found Person');
    expect(screen.getByPlaceholderText('jane@email.com')).toHaveValue('found@test.com');
    expect(supabase.functions.invoke).toHaveBeenCalledWith('lookup-client', { body: { phone: '4155550100' } });
  });

  test('the same lookup also autofills the vet and dog profile, visible once advanced to Dog 1', async () => {
    mockInvokeDefaults({
      'lookup-client': async () => ({
        data: {
          found: true,
          client: {
            owner_name: 'Kim Miller', owner_email: 'kim@test.com',
            vet_name: 'Marin Pet Hospital — (415) 479-8387',
            dogs: [{ dog_name: 'Rex', dog_breed: 'Labrador', dog_dob: '2020-01-01', spay_neuter: 'yes' }],
          },
        },
        error: null,
      }),
    });
    await goToOwnerStep();
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    fireEvent.click(screen.getByText('Look up'));
    await screen.findByText(/Info found/);
    expect(screen.getByDisplayValue('Marin Pet Hospital — (415) 479-8387')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Continue'));
    await screen.findByText('Dog 1');
    expect(screen.getByPlaceholderText('Buddy')).toHaveValue('Rex');
    expect(screen.getByPlaceholderText('Golden Retriever')).toHaveValue('Labrador');
  });

  test('autofills every dog for a returning owner with multiple dogs, growing the count', async () => {
    mockInvokeDefaults({
      'lookup-client': async () => ({
        data: {
          found: true,
          client: {
            vet_name: 'Marin Pet Hospital — (415) 479-8387',
            dogs: [
              { dog_name: 'Rex', dog_breed: 'Labrador', dog_dob: '2020-01-01', spay_neuter: 'yes' },
              { dog_name: 'Fido', dog_breed: 'Poodle', dog_dob: '2021-06-01', spay_neuter: 'no' },
            ],
          },
        },
        error: null,
      }),
    });
    await goToOwnerStep();
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    fireEvent.click(screen.getByText('Look up'));
    await screen.findByText(/Info found/);
    expect(screen.getByRole('spinbutton')).toHaveValue(2); // count grew to match, not left at 1
    // this mock's client has no owner_name/owner_email - fill those
    // manually so Continue's own validation isn't what's under test here
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');

    fireEvent.click(screen.getByText('Continue'));
    await screen.findByText('Dog 1');
    expect(screen.getByPlaceholderText('Buddy')).toHaveValue('Rex');
    // lookup-client never returns aggression/health (re-confirmed fresh
    // each stay, not carried forward) - still required to advance
    let selects = document.querySelectorAll('select');
    fireEvent.change(selects[1], { target: { value: 'no' } });
    fireEvent.change(selects[2], { target: { value: 'no' } });
    fireEvent.click(screen.getByText('Continue'));
    await screen.findByText('Dog 2');
    expect(screen.getByPlaceholderText('Buddy')).toHaveValue('Fido');
  });

  test('does not autofill or show the banner when phone is not found', async () => {
    await goToOwnerStep(); // default mock: { found: false }
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155559999');
    fireEvent.click(screen.getByText('Look up'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalled());
    expect(screen.queryByText(/Info found/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Jane Smith')).toHaveValue('');
  });

  test('look up does nothing when phone field is empty', async () => {
    await goToOwnerStep();
    fireEvent.click(screen.getByText('Look up'));
    // App's own settings fetch on mount already called invoke() once -
    // the assertion is that Look up specifically never called lookup-client
    expect(supabase.functions.invoke).not.toHaveBeenCalledWith('lookup-client', expect.any(Object));
  });

  test('handles an entirely empty lookup record without crashing', async () => {
    // real records can have gaps (e.g. an older submission missing every
    // field) - the `field || ''` fallbacks exist for exactly this case, so
    // controlled inputs never receive null/undefined
    mockInvokeDefaults({ 'lookup-client': async () => ({ data: { found: true, client: {} }, error: null }) });
    await goToOwnerStep();
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    fireEvent.click(screen.getByText('Look up'));
    await screen.findByText(/Info found/);
    expect(screen.getByPlaceholderText('Jane Smith')).toHaveValue('');
    expect(screen.getByPlaceholderText('jane@email.com')).toHaveValue('');
    expect(screen.getByDisplayValue('Select a Vet')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton')).toHaveValue(1); // unaffected - an empty lookup doesn't touch the count
  });
});

// ── Dog pages ────────────────────────────────────────────────────────────────
describe('Dog pages', () => {
  test('Continue is disabled on an empty dog page, and does nothing if clicked anyway', async () => {
    await fillStep1();
    const button = screen.getByText('Continue');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByText('Stay Dates')).not.toBeInTheDocument();
  });

  test('Continue only enables once every field - including aggression and health - is answered', async () => {
    await fillStep1();
    const button = screen.getByText('Continue');
    await userEvent.type(screen.getByPlaceholderText('Buddy'), 'Rex');
    await userEvent.type(screen.getByPlaceholderText('Golden Retriever'), 'Labrador');
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: '2020-01-01' } });
    const selects = document.querySelectorAll('select');
    fireEvent.change(selects[0], { target: { value: 'yes' } }); // spayNeuter
    expect(button).toBeDisabled();
    fireEvent.change(selects[1], { target: { value: 'no' } }); // aggression
    expect(button).toBeDisabled(); // health still unanswered
    fireEvent.change(selects[2], { target: { value: 'no' } }); // health
    expect(button).not.toBeDisabled();
  });

  test('calculates age from DOB', async () => {
    await fillStep1();
    const dobInput = document.querySelector('input[type="date"]');
    fireEvent.change(dobInput, { target: { value: isoMonthsAgo(36) } });
    expect(await screen.findByText('Age: 3 years')).toBeInTheDocument();
  });

  test('reveals the aggression detail field when "Yes" is selected, and accepts text', async () => {
    await fillStep1();
    const selects = document.querySelectorAll('select');
    fireEvent.change(selects[1], { target: { value: 'yes' } }); // aggression
    const detail = await screen.findByPlaceholderText(/known triggers/);
    await userEvent.type(detail, 'Growls at squirrels');
    expect(detail).toHaveValue('Growls at squirrels');
  });

  test('reveals the health detail field when "Yes" is selected, and accepts text', async () => {
    await fillStep1();
    const selects = document.querySelectorAll('select');
    fireEvent.change(selects[2], { target: { value: 'yes' } }); // health
    const detail = await screen.findByPlaceholderText(/conditions, limitations/);
    await userEvent.type(detail, 'Mild arthritis');
    expect(detail).toHaveValue('Mild arthritis');
  });

  test('Back returns to Step 1 with owner info preserved', async () => {
    await fillStep1('4155550100', 'Kim Miller', 'kim@test.com');
    fireEvent.click(screen.getByText('Back'));
    expect(await screen.findByText('Owner Information')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Jane Smith')).toHaveValue('Kim Miller');
  });

  test('a 2nd dog gets its own page, titled "Dog 2"', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Book My Stay'));
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');
    fireEvent.change(screen.getByDisplayValue('Select a Vet'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Continue'));

    await screen.findByText('Dog 1');
    await fillDogPage({ name: 'Rex', breed: 'Labrador' });
    expect(await screen.findByText('Dog 2')).toBeInTheDocument();
    expect(screen.queryByText('Dog 1')).not.toBeInTheDocument();
    // dog 1's data isn't lost - just off-screen, verified via a later test
    // that submits a 2-dog booking and checks both dogs made it to the
    // payload (see Step 5 - Signature)
  });

  test('Back from Dog 2 returns to Dog 1 with its data preserved', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Book My Stay'));
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');
    fireEvent.change(screen.getByDisplayValue('Select a Vet'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Continue'));

    await screen.findByText('Dog 1');
    await fillDogPage({ name: 'Rex', breed: 'Labrador' });
    await screen.findByText('Dog 2');
    fireEvent.click(screen.getByText('Back'));
    expect(await screen.findByText('Dog 1')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Buddy')).toHaveValue('Rex');
  });
});

// ── Step 3: Stay Dates ───────────────────────────────────────────────────────
describe('Step 3 — Stay Dates', () => {
  test('Continue is disabled on an empty dates form, and does nothing if clicked anyway', async () => {
    await fillStep1();
    await fillStep2();
    const button = screen.getByText('Continue');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByText('Boarding Agreement')).not.toBeInTheDocument();
  });

  test('Continue enables once dates/times are filled, even before they\'re checked for validity', async () => {
    // Deliberately an invalid combination (check-out before check-in) -
    // Continue should still be clickable so the specific error message
    // can be seen, rather than an unexplained grey button.
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-05' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-10-01' } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    expect(screen.getByText('Continue')).not.toBeDisabled();
  });

  test('shows an error when check-out is before check-in', async () => {
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-05' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-10-01' } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText(/must be after check-in/)).toBeInTheDocument();
  });

  test('rejects a check-in date in the past, even though the date input\'s min is only a UI hint', async () => {
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: daysFromToday(-1) } });
    fireEvent.change(dateInputs[1], { target: { value: daysFromToday(1) } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText('Check-in cannot be in the past')).toBeInTheDocument();
  });

  test('accepts today as check-in even in the evening, Pacific time (regression for the UTC "today" bug)', async () => {
    // Fill the form first, under real timers - userEvent's internal
    // scheduling doesn't play well with fake timers. Only the moment of
    // picking the date and clicking Continue needs the clock frozen.
    await fillStep1();
    await fillStep2();

    const realTZ = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    // 06:00 UTC = 11pm PDT the previous evening - a UTC-based "today"
    // would be one calendar day ahead of Pacific's actual today, making
    // that real today (and any check-in date near it) look "in the
    // past" and impossible to (re-)select - this is what broke it.
    jest.useFakeTimers().setSystemTime(new Date('2026-03-16T06:00:00Z'));
    try {
      const dateInputs = document.querySelectorAll('input[type="date"]');
      fireEvent.change(dateInputs[0], { target: { value: '2026-03-15' } }); // Pacific's actual "today"
      fireEvent.change(dateInputs[1], { target: { value: '2026-03-16' } });
      const timeInputs = document.querySelectorAll('input[type="time"]');
      fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
      fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
      fireEvent.click(screen.getByText('Continue'));
      expect(screen.getByText('Boarding Agreement')).toBeInTheDocument();
      expect(screen.queryByText('Check-in cannot be in the past')).not.toBeInTheDocument();
    } finally {
      process.env.TZ = realTZ;
      jest.useRealTimers();
    }
  });

  test('accepts a check-in of today', async () => {
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: daysFromToday(0) } });
    fireEvent.change(dateInputs[1], { target: { value: daysFromToday(1) } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText('Boarding Agreement')).toBeInTheDocument();
  });

  test('rejects a same-day pick-up at or before drop-off', async () => {
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    const today = daysFromToday(1);
    fireEvent.change(dateInputs[0], { target: { value: today } });
    fireEvent.change(dateInputs[1], { target: { value: today } }); // same day
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '17:00' } }); // drop-off
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } }); // "pick-up" earlier in the day
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText('Pick-up must be after drop-off for a same-day stay')).toBeInTheDocument();
  });

  test('allows an evening drop-off and a next-morning pick-up across two different days', async () => {
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: daysFromToday(1) } });
    fireEvent.change(dateInputs[1], { target: { value: daysFromToday(2) } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '17:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } }); // earlier clock time, but a later day - fine
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText('Boarding Agreement')).toBeInTheDocument();
  });

  test('shows an estimated cost once valid dates/times are entered', async () => {
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-10-03' } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    expect(await screen.findByText('$210.00')).toBeInTheDocument();
  });

  test('formats the estimate with a thousands comma once it crosses $999', async () => {
    await fillStep1();
    await fillStep2();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    // 10 nights @ $105/night = $1,050.00
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-10-11' } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    expect(await screen.findByText('$1,050.00')).toBeInTheDocument();
  });

  test('accepts free-text notes', async () => {
    await fillStep1();
    await fillStep2();
    const notes = screen.getByPlaceholderText(/Any instructions/);
    await userEvent.type(notes, 'Please give 1 cup of food twice a day.');
    expect(notes).toHaveValue('Please give 1 cup of food twice a day.');
  });

  test('estimated cost factors in the multi-dog discount set on the owner page', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Book My Stay'));
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');
    fireEvent.change(screen.getByDisplayValue('Select a Vet'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Continue'));

    await screen.findByText('Dog 1');
    await fillDogPage({ name: 'Rex', breed: 'Labrador', dob: '2020-01-01' });
    await screen.findByText('Dog 2');
    await fillDogPage({ name: 'Fido', breed: 'Poodle', dob: '2021-06-01' });
    await screen.findByText('Stay Dates');

    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-10-02' } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    // 1 night @ $105: dog 1 = $105, dog 2 = $105 * 0.9 = $94.50 -> $199.50
    expect(await screen.findByText('$199.50')).toBeInTheDocument();
    expect(screen.getByText(/10% off each additional dog/)).toBeInTheDocument();
  });

  test('Back returns to Dog 1', async () => {
    await fillStep1();
    await fillStep2();
    fireEvent.click(screen.getByText('Back'));
    expect(await screen.findByText('Dog 1')).toBeInTheDocument();
  });
});

// ── Step 5: Signature & Submission ──────────────────────────────────────────
describe('Step 5 — Signature', () => {
  test('Submit Agreement is disabled until the checkbox is checked and a signature is typed', async () => {
    await fillThrough();
    const button = screen.getByText('Submit Agreement');
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(button).toBeDisabled(); // signature still blank
    await userEvent.type(screen.getByPlaceholderText('Kim Miller'), 'Wrong Name');
    expect(button).not.toBeDisabled(); // filled in, even though it won't match on click
  });

  test('Submit Agreement uses the same styling as every other Continue button, not a separate muted color', async () => {
    // Regression guard: it used to carry its own "btn-submit" class with a
    // muted sage green that read as grey/disabled-looking even when the
    // button was fully enabled - now it's just btn-primary like everywhere
    // else in the flow.
    await fillThrough();
    const button = screen.getByText('Submit Agreement');
    expect(button.className).toBe('btn-primary');
  });

  test('signature must match name from step 1', async () => {
    await fillThrough();
    fireEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByPlaceholderText('Kim Miller'), 'Wrong Name');
    fireEvent.click(screen.getByText('Submit Agreement'));
    expect(await screen.findByText(/must match/i)).toBeInTheDocument();
  });

  test('submits successfully and shows the confirmation screen with correct details', async () => {
    await fillThrough();
    fireEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByPlaceholderText('Kim Miller'), 'Kim Miller');
    fireEvent.click(screen.getByText('Submit Agreement'));

    expect(await screen.findByText("You're all set, Kim!")).toBeInTheDocument();
    expect(screen.getByText(/Rex/)).toBeInTheDocument();
    expect(screen.getByText('10/01/2026')).toBeInTheDocument();
    expect(screen.getByText('10/05/2026')).toBeInTheDocument();
    expect(screen.getByText('$420')).toBeInTheDocument(); // 4 nights (Oct 1-5) @ $105/day, Confirmation shows the raw number

    // Regression guard: submission goes through the submit-booking Edge
    // Function (server-side find-or-create under the service role key),
    // never a direct client insert - the owners/dogs/stays tables grant
    // anon nothing at all (see the Sept 14 dog-profiles reorg).
    expect(supabase.functions.invoke).toHaveBeenCalledWith('submit-booking', {
      body: expect.objectContaining({
        owner: expect.objectContaining({ name: 'Kim Miller', phone: '4155550100', email: 'kim@test.com' }),
        dogs: [expect.objectContaining({ name: 'Rex', breed: 'Labrador' })],
        checkIn: '2026-10-01',
        checkOut: '2026-10-05',
        // captured verbatim at submission (Sept 16, 2026) so a later edit
        // to waiver.js can never retroactively change what this client is
        // on record as having signed
        waiverSnapshot: expect.arrayContaining([expect.objectContaining({ title: expect.any(String), body: expect.any(String) })]),
      }),
    });
    expect(supabase.functions.invoke).toHaveBeenCalledWith('send-confirmation', expect.any(Object));
  });

  test('shows an alert and stays on the form when saving fails', async () => {
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    mockInvokeDefaults({ 'submit-booking': async () => ({ data: null, error: { message: 'db down' } }) });

    await fillThrough();
    fireEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByPlaceholderText('Kim Miller'), 'Kim Miller');
    fireEvent.click(screen.getByText('Submit Agreement'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy).toHaveBeenCalledWith('There was an error saving. Please try again.');
    expect(screen.queryByText(/You're all set/)).not.toBeInTheDocument();
    expect(screen.getByText('Sign & Submit')).toBeInTheDocument();

    alertSpy.mockRestore();
  });

  test('"Book Another Stay" resets the form back to step 1', async () => {
    await fillThrough();
    fireEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByPlaceholderText('Kim Miller'), 'Kim Miller');
    fireEvent.click(screen.getByText('Submit Agreement'));
    await screen.findByText(/You're all set/);

    fireEvent.click(screen.getByText('Book Another Stay'));
    expect(await screen.findByText('Owner Information')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('(415) 555-0100')).toHaveValue('');
  });

  test('Back returns to the waiver step', async () => {
    await fillThrough();
    fireEvent.click(screen.getByText('Back'));
    expect(await screen.findByText('Boarding Agreement')).toBeInTheDocument();
  });

  test('still shows the confirmation screen even if the confirmation text fails to send', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockInvokeDefaults({ 'send-confirmation': async () => { throw new Error('twilio down'); } });

    await fillThrough();
    fireEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByPlaceholderText('Kim Miller'), 'Kim Miller');
    fireEvent.click(screen.getByText('Submit Agreement'));

    expect(await screen.findByText(/You're all set/)).toBeInTheDocument();
    await waitFor(() => expect(consoleSpy).toHaveBeenCalledWith('Text send failed:', expect.any(Error)));

    consoleSpy.mockRestore();
  });

  test('a 2-dog booking submits both dogs\' data, each from its own page', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Book My Stay'));
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');
    fireEvent.change(screen.getByDisplayValue('Select a Vet'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Continue'));

    await screen.findByText('Dog 1');
    await fillDogPage({ name: 'Rex', breed: 'Labrador', dob: '2020-01-01' });
    await screen.findByText('Dog 2');
    await fillDogPage({ name: 'Fido', breed: 'Poodle', dob: '2021-06-01' });
    await fillStep3();
    await fillStep4();

    fireEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByPlaceholderText('Kim Miller'), 'Kim Miller');
    fireEvent.click(screen.getByText('Submit Agreement'));

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('submit-booking', expect.any(Object)));
    const call = supabase.functions.invoke.mock.calls.find(c => c[0] === 'submit-booking');
    expect(call[1].body.dogs).toEqual([
      expect.objectContaining({ name: 'Rex', breed: 'Labrador', dob: '2020-01-01' }),
      expect.objectContaining({ name: 'Fido', breed: 'Poodle', dob: '2021-06-01' }),
    ]);
    expect(call[1].body.owner).toEqual(expect.objectContaining({ vetName: 'Marin Pet Hospital — (415) 479-8387' }));
  });
});

// ── Admin: login ─────────────────────────────────────────────────────────────
describe('Admin login', () => {
  test('rejects wrong password', async () => {
    goToAdminUrl();
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText('Password'), 'wrongpassword');
    fireEvent.click(screen.getByText('Sign In'));
    expect(await screen.findByText('Incorrect password')).toBeInTheDocument();
    expect(supabase.functions.invoke).toHaveBeenCalledWith('admin-data', { body: { password: 'wrongpassword' } });
  });

  test('accepts the correct password and shows the stay list', async () => {
    await loginAsAdmin();
    expect(screen.getByText('3 signed agreements on file')).toBeInTheDocument();
    expect(screen.getByText('Bud')).toBeInTheDocument();
    expect(screen.getByText('Choco')).toBeInTheDocument();
  });

  test('shows the singular label for exactly one record', async () => {
    await loginAsAdmin([{ ...SAMPLE_DOGS[0], stays: [SAMPLE_DOGS[0].stays[0]] }], 1);
    expect(screen.getByText('1 signed agreement on file')).toBeInTheDocument();
  });

  test('shows an empty state when there are no records', async () => {
    await loginAsAdmin([], 0);
    expect(screen.getByText('No records found.')).toBeInTheDocument();
  });

  test('cancel button on the login screen closes the admin overlay', async () => {
    goToAdminUrl();
    render(<App />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Admin Access')).not.toBeInTheDocument();
  });

  test('pressing Enter in the password field submits it', async () => {
    mockInvokeDefaults({ 'admin-data': async () => ({ data: { dogs: SAMPLE_DOGS, totalStays: SAMPLE_TOTAL_STAYS }, error: null }) });
    goToAdminUrl();
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText('Password'), 'correct-password{Enter}');
    expect(await screen.findByText('Bayview Boarding — Admin')).toBeInTheDocument();
  });

  test('Admin is not shown directly - only inside the collapsed nav menu (or the ?admin URL)', async () => {
    render(<App />);
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Book My Stay'));
    expect(await screen.findByText('Owner Information')).toBeInTheDocument();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });
});

// ── Admin: logged in ─────────────────────────────────────────────────────────
describe('Admin — logged in — Ideas & Bugs', () => {
  test('the entry button shows the open count as a badge', async () => {
    await loginAsAdminWithFeedback();
    const entry = screen.getByText('💡 Ideas & Bugs').closest('button');
    expect(within(entry).getByText('2')).toBeInTheDocument(); // 2 of the 3 fixtures are open
  });

  test('no badge when there are no open submissions', async () => {
    await loginAsAdminWithFeedback([{ id: 'fb-1', category: 'idea', message: 'x', status: 'done', created_at: '2026-09-16T12:00:00Z' }]);
    const entry = screen.getByText('💡 Ideas & Bugs').closest('button');
    expect(within(entry).queryByText('1')).not.toBeInTheDocument();
  });

  test('opens the list showing every submission with its category, message, and submitter', async () => {
    await loginAsAdminWithFeedback();
    fireEvent.click(screen.getByText('💡 Ideas & Bugs'));
    expect(await screen.findByText('Ideas & Bugs', { selector: 'h2' })).toBeInTheDocument();
    expect(screen.getByText('3 submissions · 2 open')).toBeInTheDocument();
    expect(screen.getByText('Map pin looks off on Safari')).toBeInTheDocument();
    expect(screen.getByText('Jane Tester · jane@test.com')).toBeInTheDocument();
    expect(screen.getByText('Add a dark mode')).toBeInTheDocument();
  });

  test('moves a submission to a new status', async () => {
    await loginAsAdminWithFeedback();
    fireEvent.click(screen.getByText('💡 Ideas & Bugs'));
    await screen.findByText('Map pin looks off on Safari');
    const card = screen.getByText('Map pin looks off on Safari').closest('.stay-card');

    fireEvent.click(within(card).getByText('Considered'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('feedback', {
      body: { password: 'correct-password', id: 'fb-1', status: 'considered' },
    }));
  });

  test('← All Dogs returns to the dog list', async () => {
    await loginAsAdminWithFeedback();
    fireEvent.click(screen.getByText('💡 Ideas & Bugs'));
    await screen.findByText('Ideas & Bugs', { selector: 'h2' });
    fireEvent.click(screen.getByText('← All Dogs'));
    expect(await screen.findByText('Bayview Boarding — Admin')).toBeInTheDocument();
  });
});

describe('Admin — logged in', () => {
  test('filters the dog list by search term', async () => {
    await loginAsAdmin();
    await userEvent.type(screen.getByPlaceholderText('Search by dog or owner name...'), 'Bud');
    expect(screen.getByText('Bud')).toBeInTheDocument();
    expect(screen.queryByText('Choco')).not.toBeInTheDocument();
  });

  test('close button closes the admin overlay', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('✕'));
    expect(screen.queryByText('Bayview Boarding — Admin')).not.toBeInTheDocument();
  });

  test('selecting a dog shows its full stay history, including flags and notes', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Bud'));
    expect(await screen.findByRole('heading', { name: 'Bud' })).toBeInTheDocument();
    // owner name shares a line with the dog's current breed/age, so this
    // is a partial match rather than the line's full text
    expect(screen.getByText(/Kim/)).toBeInTheDocument();
    expect(screen.getByText('Est. $210')).toBeInTheDocument();
    expect(screen.getByText(/Loves belly rubs/)).toBeInTheDocument();
    expect(screen.getByText(/DOB:/)).toBeInTheDocument();

    // Bud has 2 stays (Sept + June) — most recent check-in sorts first
    const budCards = document.querySelectorAll('.stay-card');
    expect(budCards).toHaveLength(2);
    expect(budCards[0].textContent).toContain('09/01/2026');
    expect(budCards[1].textContent).toContain('06/01/2026');

    fireEvent.click(screen.getByText(/All Dogs/));
    fireEvent.click(screen.getByText('Choco'));
    expect(await screen.findByRole('heading', { name: 'Choco' })).toBeInTheDocument();
    expect(screen.getByText(/Aggression noted: Barks at mail carrier/)).toBeInTheDocument();
    expect(screen.getByText(/Health note: Mild hip dysplasia/)).toBeInTheDocument();
  });

  test('a stay with a waiver snapshot offers to show it, collapsed by default; one without shows no such control', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Bud'));
    await screen.findByRole('heading', { name: 'Bud' });
    const budCards = document.querySelectorAll('.stay-card');

    // stay-1 (Sept) has a waiver_snapshot in the fixture; stay-3 (June) does not
    expect(within(budCards[0]).getByText('View waiver as signed')).toBeInTheDocument();
    expect(within(budCards[1]).queryByText('View waiver as signed')).not.toBeInTheDocument();
    expect(within(budCards[0]).queryByText('Test waiver body text.')).not.toBeInTheDocument();

    fireEvent.click(within(budCards[0]).getByText('View waiver as signed'));
    expect(within(budCards[0]).getByText('Risks & Releases')).toBeInTheDocument();
    expect(within(budCards[0]).getByText('Test waiver body text.')).toBeInTheDocument();

    fireEvent.click(within(budCards[0]).getByText('Hide waiver as signed'));
    expect(within(budCards[0]).queryByText('Test waiver body text.')).not.toBeInTheDocument();
  });

  test('Billing SMS: final cost defaults to the estimate, and Send calls send-confirmation with type billing', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Bud'));
    await screen.findByRole('heading', { name: 'Bud' });

    const budCards = document.querySelectorAll('.stay-card');
    const costInput = budCards[0].querySelector('input[type="number"]');
    expect(costInput).toHaveValue(210); // defaults to that stay's estimate

    fireEvent.click(within(budCards[0]).getByText('Send Billing Text'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('send-confirmation', {
      body: {
        type: 'billing',
        owner_name: 'Kim',
        owner_phone: '6505551111',
        dog_name: 'Bud',
        final_cost: 210,
        message_template: expect.any(String), // the admin-editable billing template (settings.sms_billing)
      },
    }));
    expect(await within(budCards[0]).findByText('✓ Sent')).toBeInTheDocument();
  });

  test('Billing SMS: admin can adjust the final cost before sending', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Bud'));
    await screen.findByRole('heading', { name: 'Bud' });

    const budCards = document.querySelectorAll('.stay-card');
    const costInput = budCards[0].querySelector('input[type="number"]');
    fireEvent.change(costInput, { target: { value: '250' } });
    fireEvent.click(within(budCards[0]).getByText('Send Billing Text'));

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('send-confirmation', {
      body: expect.objectContaining({ final_cost: 250 }),
    }));
  });

  test('Billing SMS: refuses to send with no amount entered', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Choco')); // Choco's stay has a null estimate
    await screen.findByRole('heading', { name: 'Choco' });

    const chocoCard = document.querySelector('.stay-card');
    fireEvent.click(within(chocoCard).getByText('Send Billing Text'));
    expect(await within(chocoCard).findByText('Enter a valid amount first')).toBeInTheDocument();
    expect(supabase.functions.invoke).not.toHaveBeenCalledWith('send-confirmation', expect.any(Object));
  });

  test('Billing SMS: shows an error and does not claim success if the send fails', async () => {
    mockInvokeDefaults({
      'admin-data': async () => ({ data: { dogs: SAMPLE_DOGS, totalStays: SAMPLE_TOTAL_STAYS }, error: null }),
      'send-confirmation': async () => ({ data: null, error: { message: 'Twilio down' } }),
    });
    goToAdminUrl();
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText('Password'), 'correct-password');
    fireEvent.click(screen.getByText('Sign In'));
    await screen.findByText('Bayview Boarding — Admin');
    fireEvent.click(screen.getByText('Bud'));
    await screen.findByRole('heading', { name: 'Bud' });

    const budCard = document.querySelectorAll('.stay-card')[0];
    fireEvent.click(within(budCard).getByText('Send Billing Text'));
    expect(await within(budCard).findByText('Failed to send. Please try again.')).toBeInTheDocument();
    expect(within(budCard).queryByText('✓ Sent')).not.toBeInTheDocument();
  });

  test('back button returns from the detail view to the dog list', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Bud'));
    await screen.findByRole('heading', { name: 'Bud' });
    fireEvent.click(screen.getByText(/All Dogs/));
    expect(await screen.findByText('Bayview Boarding — Admin')).toBeInTheDocument();
  });

  test('close button in the detail view closes the admin overlay', async () => {
    await loginAsAdmin();
    fireEvent.click(screen.getByText('Bud'));
    await screen.findByRole('heading', { name: 'Bud' });
    fireEvent.click(screen.getByText('✕'));
    expect(screen.queryByRole('heading', { name: 'Bud' })).not.toBeInTheDocument();
  });

  test('updates and displays the day rate after Save', async () => {
    await loginAsAdmin();
    // Day Rate is the first of several settings sections, each with its
    // own "Save" button (rate, discount %, holiday %) - scope to the first.
    const rateInput = document.querySelectorAll('input[type="number"]')[0];
    fireEvent.change(rateInput, { target: { value: '150' } });
    fireEvent.click(screen.getAllByText('Save')[0]);
    expect(await screen.findByText(/Current rate: \$150\/day/)).toBeInTheDocument();
  });

  test('updates the 2nd+ dog discount %', async () => {
    await loginAsAdmin();
    const discountInput = document.querySelectorAll('input[type="number"]')[1];
    fireEvent.change(discountInput, { target: { value: '15' } });
    fireEvent.click(screen.getAllByText('Save')[1]);
    expect(await screen.findByText(/Current: 15%/)).toBeInTheDocument();
  });

  test('updates the holiday upcharge %', async () => {
    await loginAsAdmin();
    const holidayInput = document.querySelectorAll('input[type="number"]')[2];
    fireEvent.change(holidayInput, { target: { value: '25' } });
    fireEvent.click(screen.getAllByText('Save')[2]);
    expect(await screen.findByText(/Current: 25%/)).toBeInTheDocument();
  });

  test('shows a validation error from the server without crashing, and does not update the displayed rate', async () => {
    mockInvokeDefaults({
      'admin-data': async () => ({ data: { dogs: [], totalStays: 0 }, error: null }),
      'settings': async (opts) => {
        if (opts?.body?.updates) return { data: { error: 'Invalid settings: dayRate must be a positive number' }, error: null };
        return { data: { dayRate: 105, multiDogDiscount: 0.10, holidayUpcharge: 0.30, vets: ['Marin Pet Hospital — (415) 479-8387'] }, error: null };
      },
    });
    goToAdminUrl();
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText('Password'), 'correct-password');
    fireEvent.click(screen.getByText('Sign In'));
    await screen.findByText('Bayview Boarding — Admin');

    const rateInput = document.querySelectorAll('input[type="number"]')[0];
    fireEvent.change(rateInput, { target: { value: '-5' } });
    fireEvent.click(screen.getAllByText('Save')[0]);
    expect(await screen.findByText(/Invalid settings: dayRate must be a positive number/)).toBeInTheDocument();
    expect(screen.getByText(/Current rate: \$105\/day/)).toBeInTheDocument(); // unchanged
  });

  test('shows the vet list actually fetched from settings, not the hardcoded fallback', async () => {
    // Regression test: the admin panel's vet-list editor used to seed
    // itself from the vets *prop* at the moment AdminView first mounted -
    // but App's settings fetch (a separate, async network call) hadn't
    // necessarily resolved by then, so it could show the hardcoded
    // fallback list (8 entries, defined in src/settings.js) instead of
    // what was actually saved. DEFAULT_SETTINGS here deliberately has
    // only 1 entry, distinct from that fallback, so this only passes if
    // the real fetched value is what's shown.
    await loginAsAdmin();
    const vetEditor = within(document.querySelector('.vet-editor'));
    expect(vetEditor.getByText('Marin Pet Hospital — (415) 479-8387')).toBeInTheDocument();
    expect(vetEditor.queryByText('VCA Marin Animal Hospital — (415) 454-5225')).not.toBeInTheDocument();
    expect(vetEditor.getAllByText('Remove')).toHaveLength(1);
  });

  test('adds a vet clinic to the list, then removes it, before saving', async () => {
    await loginAsAdmin();
    const vetEditor = within(document.querySelector('.vet-editor'));
    expect(vetEditor.getByText('Marin Pet Hospital — (415) 479-8387')).toBeInTheDocument();

    await userEvent.type(vetEditor.getByPlaceholderText(/Clinic Name/), 'New Clinic — (415) 555-0100');
    fireEvent.click(vetEditor.getByText('Add'));
    expect(vetEditor.getByText('New Clinic — (415) 555-0100')).toBeInTheDocument();

    fireEvent.click(vetEditor.getByText('Save Vet List'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('settings', {
      body: { password: 'correct-password', updates: { vets: ['Marin Pet Hospital — (415) 479-8387', 'New Clinic — (415) 555-0100'] } },
    }));
  });

  test('removes a vet clinic from the list before saving', async () => {
    await loginAsAdmin();
    const vetEditor = within(document.querySelector('.vet-editor'));
    fireEvent.click(vetEditor.getAllByText('Remove')[0]);
    expect(vetEditor.queryByText('Marin Pet Hospital — (415) 479-8387')).not.toBeInTheDocument();
  });

  test('shows the packing list actually fetched from settings, not the hardcoded fallback', async () => {
    await loginAsAdmin();
    const packingEditor = within(document.querySelector('.packing-editor'));
    expect(packingEditor.getByText('Food')).toBeInTheDocument();
    expect(packingEditor.getByText('Leash & doggy bags')).toBeInTheDocument();
    expect(packingEditor.queryByText('Bed & favorite blanket')).not.toBeInTheDocument();
  });

  test('adds a packing-list item, then saves it', async () => {
    await loginAsAdmin();
    const packingEditor = within(document.querySelector('.packing-editor'));
    await userEvent.type(packingEditor.getByPlaceholderText('Item to bring'), 'Medication');
    fireEvent.click(packingEditor.getByText('Add'));
    expect(packingEditor.getByText('Medication')).toBeInTheDocument();

    fireEvent.click(packingEditor.getByText('Save Packing List'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('settings', {
      body: { password: 'correct-password', updates: { packingList: ['Food', 'Leash & doggy bags', 'Medication'] } },
    }));
  });

  test('removes a packing-list item before saving', async () => {
    await loginAsAdmin();
    const packingEditor = within(document.querySelector('.packing-editor'));
    fireEvent.click(packingEditor.getAllByText('Remove')[0]);
    expect(packingEditor.queryByText('Food')).not.toBeInTheDocument();
  });

  test('shows the SMS templates actually fetched from settings, editable and independently saveable', async () => {
    await loginAsAdmin();
    const smsEditor = within(document.querySelector('.sms-editor'));
    expect(smsEditor.getByDisplayValue('Hi {firstName}! confirmed.')).toBeInTheDocument();
    expect(smsEditor.getByDisplayValue('Hi {firstName}! reminder, bring {packingList}.')).toBeInTheDocument();
    expect(smsEditor.getByDisplayValue('Hi {firstName}! total ${finalCost}.')).toBeInTheDocument();

    const reminderBox = smsEditor.getByDisplayValue('Hi {firstName}! reminder, bring {packingList}.');
    fireEvent.change(reminderBox, { target: { value: 'New reminder wording {firstName}' } });
    fireEvent.click(smsEditor.getByText('Save Stay Reminder Text'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('settings', {
      body: { password: 'correct-password', updates: { smsReminder: 'New reminder wording {firstName}' } },
    }));
    // saving the reminder template shouldn't touch the other two
    expect(supabase.functions.invoke).not.toHaveBeenCalledWith('settings', {
      body: expect.objectContaining({ updates: expect.objectContaining({ smsConfirmation: expect.anything() }) }),
    });
  });
});
