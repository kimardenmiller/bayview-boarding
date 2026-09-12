import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App, { formatDate, calcAge, calcCost } from './App';
import { supabase } from './supabase';

jest.mock('./supabase');

// CRA's Jest config sets resetMocks: true, which wipes mock implementations
// (not just call history) before every test — so defaults are re-applied
// here each time rather than once at module scope.
beforeEach(() => {
  supabase.from.mockReturnValue({ insert: jest.fn().mockResolvedValue({ error: null }) });
  supabase.functions.invoke.mockResolvedValue({ data: { found: false }, error: null });
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function isoMonthsAgo(months, day = 15) {
  const d = new Date();
  d.setDate(day); // dodge month-length edge cases (e.g. Jan 31 - 1 month)
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

async function fillStep1(phone = '4155550100', name = 'Kim Miller', email = 'kim@test.com') {
  render(<App />);
  await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), phone);
  await userEvent.type(screen.getByPlaceholderText('Jane Smith'), name);
  await userEvent.type(screen.getByPlaceholderText('jane@email.com'), email);
  fireEvent.click(screen.getByText('Continue'));
  await screen.findByText('About Your Dog');
}

async function fillStep2() {
  await userEvent.type(screen.getByPlaceholderText('Buddy'), 'Rex');
  await userEvent.type(screen.getByPlaceholderText('Golden Retriever'), 'Labrador');
  const dobInput = document.querySelector('input[type="date"]');
  fireEvent.change(dobInput, { target: { value: '2020-01-01' } });
  fireEvent.change(screen.getByDisplayValue('Select a veterinarian'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });
  const selects = document.querySelectorAll('select');
  fireEvent.change(selects[1], { target: { value: 'yes' } }); // spayNeuter
  fireEvent.change(selects[2], { target: { value: 'no' } });  // aggression
  fireEvent.change(selects[3], { target: { value: 'no' } });  // health
  fireEvent.click(screen.getByText('Continue'));
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

const SAMPLE_STAYS = [
  {
    dog_name: 'Bud', owner_name: 'Kim', owner_email: 'kim@test.com', owner_phone: '6505551111',
    check_in: '2026-09-01', check_out: '2026-09-03', drop_time: '09:00:00', pickup_time: '17:00:00',
    estimated_cost: 210, submitted_at: '2026-08-30T10:00:00Z', dog_dob: '2020-01-01',
    notes: 'Loves belly rubs', aggression_history: 'no', aggression_detail: '',
    health_concerns: 'no', health_detail: '',
  },
  {
    dog_name: 'Choco', owner_name: 'Estee', owner_email: 'estee@test.com', owner_phone: '6505552222',
    check_in: '2026-09-05', check_out: '2026-09-06', drop_time: '10:00:00', pickup_time: '12:00:00',
    estimated_cost: null, submitted_at: '2026-08-31T10:00:00Z', dog_dob: null,
    notes: '', aggression_history: 'yes', aggression_detail: 'Barks at mail carrier',
    health_concerns: 'yes', health_detail: 'Mild hip dysplasia',
  },
  {
    dog_name: 'Bud', owner_name: 'Kim', owner_email: 'kim@test.com', owner_phone: '6505551111',
    check_in: '2026-06-01', check_out: '2026-06-02', drop_time: '09:00:00', pickup_time: '17:00:00',
    estimated_cost: 105, submitted_at: '2026-05-30T10:00:00Z', dog_dob: null,
    notes: '', aggression_history: 'no', aggression_detail: '',
    health_concerns: 'no', health_detail: '',
  },
];

async function loginAsAdmin(stays = SAMPLE_STAYS) {
  supabase.functions.invoke.mockResolvedValueOnce({ data: { stays }, error: null });
  render(<App />);
  fireEvent.click(screen.getByText('Admin'));
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

describe('calcCost', () => {
  test('returns null when any required field is missing', () => {
    expect(calcCost('', '2026-01-02', '09:00', '09:00', 100)).toBeNull();
    expect(calcCost('2026-01-01', '', '09:00', '09:00', 100)).toBeNull();
    expect(calcCost('2026-01-01', '2026-01-02', '', '09:00', 100)).toBeNull();
    expect(calcCost('2026-01-01', '2026-01-02', '09:00', '', 100)).toBeNull();
  });

  test('returns null when pickup is before drop-off', () => {
    expect(calcCost('2026-01-05', '2026-01-01', '09:00', '09:00', 100)).toBeNull();
  });

  test('charges a 1-day minimum for a short same-day stay', () => {
    expect(calcCost('2026-01-01', '2026-01-01', '09:00', '15:00', 100)).toBe('100.00');
  });

  test('rounds up partial days', () => {
    expect(calcCost('2026-01-01', '2026-01-02', '09:00', '10:00', 100)).toBe('200.00'); // 25 hrs -> 2 days
  });
});

// ── Step 1: Owner Info ──────────────────────────────────────────────────────
describe('Step 1 — Owner Info', () => {
  test('shows required errors when submitting empty form', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findAllByText('Required')).toHaveLength(3);
  });

  test('advances to step 2 when all required fields filled', async () => {
    await fillStep1();
    expect(screen.getByText('About Your Dog')).toBeInTheDocument();
  });

  test('looks up a returning client by phone and autofills name/email', async () => {
    supabase.functions.invoke.mockResolvedValueOnce({
      data: { found: true, client: { owner_name: 'Found Person', owner_email: 'found@test.com' } },
      error: null,
    });
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    fireEvent.click(screen.getByText('Look up'));
    expect(await screen.findByText(/Info found/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Jane Smith')).toHaveValue('Found Person');
    expect(screen.getByPlaceholderText('jane@email.com')).toHaveValue('found@test.com');
    expect(supabase.functions.invoke).toHaveBeenCalledWith('lookup-client', { body: { phone: '4155550100' } });
  });

  test('does not autofill or show the banner when phone is not found', async () => {
    render(<App />); // default mock: { found: false }
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155559999');
    fireEvent.click(screen.getByText('Look up'));
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalled());
    expect(screen.queryByText(/Info found/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Jane Smith')).toHaveValue('');
  });

  test('look up does nothing when phone field is empty', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Look up'));
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  test('handles an entirely empty lookup record without crashing', async () => {
    // real records can have gaps (e.g. an older submission missing every
    // field) - the `field || ''` fallbacks exist for exactly this case, so
    // controlled inputs never receive null/undefined
    supabase.functions.invoke.mockResolvedValueOnce({ data: { found: true, client: {} }, error: null });
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    fireEvent.click(screen.getByText('Look up'));
    await screen.findByText(/Info found/);
    expect(screen.getByPlaceholderText('Jane Smith')).toHaveValue('');
    expect(screen.getByPlaceholderText('jane@email.com')).toHaveValue('');
  });
});

// ── Step 2: Dog Info ────────────────────────────────────────────────────────
describe('Step 2 — Dog Info', () => {
  test('shows required errors when submitting empty dog form', async () => {
    await fillStep1();
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findAllByText('Required')).toHaveLength(5);
  });

  test('calculates age from DOB', async () => {
    await fillStep1();
    const dobInput = document.querySelector('input[type="date"]');
    fireEvent.change(dobInput, { target: { value: isoMonthsAgo(36) } });
    expect(await screen.findByText('Age: 3 years')).toBeInTheDocument();
  });

  test('autofills dog info on mount when the phone matches a returning client', async () => {
    supabase.functions.invoke.mockResolvedValueOnce({
      data: {
        found: true,
        client: {
          dog_name: 'Rex', dog_breed: 'Labrador', dog_dob: '2020-01-01',
          vet_name: 'Marin Pet Hospital — (415) 479-8387', spay_neuter: 'yes',
        },
      },
      error: null,
    });
    await fillStep1();
    expect(await screen.findByPlaceholderText('Buddy')).toHaveValue('Rex');
    expect(screen.getByPlaceholderText('Golden Retriever')).toHaveValue('Labrador');
    expect(screen.getByDisplayValue('Marin Pet Hospital — (415) 479-8387')).toBeInTheDocument();
  });

  test('handles an entirely empty returning-dog record without crashing', async () => {
    supabase.functions.invoke.mockResolvedValueOnce({ data: { found: true, client: {} }, error: null });
    await fillStep1();
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalled()); // let the on-mount lookup actually resolve
    expect(screen.getByPlaceholderText('Buddy')).toHaveValue('');
    expect(screen.getByPlaceholderText('Golden Retriever')).toHaveValue('');
    expect(screen.getByDisplayValue('Select a veterinarian')).toBeInTheDocument();
  });

  test('reveals the aggression detail field when "Yes" is selected, and accepts text', async () => {
    await fillStep1();
    const selects = document.querySelectorAll('select');
    fireEvent.change(selects[2], { target: { value: 'yes' } }); // aggression
    const detail = await screen.findByPlaceholderText(/known triggers/);
    await userEvent.type(detail, 'Growls at squirrels');
    expect(detail).toHaveValue('Growls at squirrels');
  });

  test('reveals the health detail field when "Yes" is selected, and accepts text', async () => {
    await fillStep1();
    const selects = document.querySelectorAll('select');
    fireEvent.change(selects[3], { target: { value: 'yes' } }); // health
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
});

// ── Step 3: Stay Dates ───────────────────────────────────────────────────────
describe('Step 3 — Stay Dates', () => {
  test('shows required errors when submitting empty dates form', async () => {
    await fillStep1();
    await fillStep2();
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findAllByText('Required')).toHaveLength(4);
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

  test('accepts free-text notes', async () => {
    await fillStep1();
    await fillStep2();
    const notes = screen.getByPlaceholderText(/Any instructions/);
    await userEvent.type(notes, 'Please give 1 cup of food twice a day.');
    expect(notes).toHaveValue('Please give 1 cup of food twice a day.');
  });

  test('Back returns to Step 2', async () => {
    await fillStep1();
    await fillStep2();
    fireEvent.click(screen.getByText('Back'));
    expect(await screen.findByText('About Your Dog')).toBeInTheDocument();
  });
});

// ── Step 5: Signature & Submission ──────────────────────────────────────────
describe('Step 5 — Signature', () => {
  test('requires checkbox before submitting', async () => {
    await fillThrough();
    fireEvent.click(screen.getByText('Submit Agreement'));
    expect(await screen.findByText(/must check this box/i)).toBeInTheDocument();
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

    // regression check for the v1.5.1 bug: submission must not depend on
    // reading the inserted row back (insert().select() breaks under RLS
    // that only grants anon INSERT, not SELECT)
    expect(supabase.from).toHaveBeenCalledWith('stays');
    const insertMock = supabase.from.mock.results[0].value.insert;
    expect(insertMock).toHaveBeenCalled();
    expect(supabase.functions.invoke).toHaveBeenCalledWith('send-confirmation', expect.any(Object));
  });

  test('shows an alert and stays on the form when saving fails', async () => {
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    supabase.from.mockReturnValueOnce({ insert: jest.fn().mockResolvedValue({ error: { message: 'db down' } }) });

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

    await fillThrough(); // StepDog's on-mount lookup consumes the default mock here
    // only *now* does the queued rejection apply to the next invoke() call,
    // which will be the send-confirmation call inside handleSubmit
    supabase.functions.invoke.mockRejectedValueOnce(new Error('twilio down'));
    fireEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByPlaceholderText('Kim Miller'), 'Kim Miller');
    fireEvent.click(screen.getByText('Submit Agreement'));

    expect(await screen.findByText(/You're all set/)).toBeInTheDocument();
    await waitFor(() => expect(consoleSpy).toHaveBeenCalledWith('Text send failed:', expect.any(Error)));

    consoleSpy.mockRestore();
  });
});

// ── Admin: login ─────────────────────────────────────────────────────────────
describe('Admin login', () => {
  test('rejects wrong password', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Admin'));
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
    await loginAsAdmin([SAMPLE_STAYS[0]]);
    expect(screen.getByText('1 signed agreement on file')).toBeInTheDocument();
  });

  test('shows an empty state when there are no records', async () => {
    await loginAsAdmin([]);
    expect(screen.getByText('No records found.')).toBeInTheDocument();
  });

  test('cancel button on the login screen closes the admin overlay', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Admin'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Admin Access')).not.toBeInTheDocument();
  });

  test('pressing Enter in the password field submits it', async () => {
    supabase.functions.invoke.mockResolvedValueOnce({ data: { stays: SAMPLE_STAYS }, error: null });
    render(<App />);
    fireEvent.click(screen.getByText('Admin'));
    await userEvent.type(screen.getByPlaceholderText('Password'), 'correct-password{Enter}');
    expect(await screen.findByText('Bayview Boarding — Admin')).toBeInTheDocument();
  });
});

// ── Admin: logged in ─────────────────────────────────────────────────────────
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
    expect(screen.getByText('Kim')).toBeInTheDocument();
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
    const rateInput = document.querySelector('input[type="number"]');
    fireEvent.change(rateInput, { target: { value: '150' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText(/Current rate: \$150\/day/)).toBeInTheDocument();
  });
});
