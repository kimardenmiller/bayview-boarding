import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

// ── Step 1: Owner Info ──────────────────────────────────────────────────────
describe('Step 1 — Owner Info', () => {
  test('shows required errors when submitting empty form', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findAllByText('Required')).toHaveLength(3);
  });

  test('advances to step 2 when all required fields filled', async () => {
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText('About Your Dog')).toBeInTheDocument();
  });
});

// ── Step 2: Dog Info ────────────────────────────────────────────────────────
describe('Step 2 — Dog Info', () => {
  async function fillStep1() {
    render(<App />);
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');
    fireEvent.click(screen.getByText('Continue'));
    await screen.findByText('About Your Dog');
  }

  test('shows required errors when submitting empty dog form', async () => {
    await fillStep1();
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findAllByText('Required')).toHaveLength(5);
  });

  test('calculates age from DOB', async () => {
    await fillStep1();
    const dobInput = document.querySelector('input[type="date"]');
    fireEvent.change(dobInput, { target: { value: '2020-01-01' } });
    expect(await screen.findByText(/yr/)).toBeInTheDocument();
  });
});

// ── Step 5: Signature ───────────────────────────────────────────────────────
describe('Step 5 — Signature', () => {
  async function fillThrough() {
    render(<App />);
    // Step 1
    await userEvent.type(screen.getByPlaceholderText('(415) 555-0100'), '4155550100');
    await userEvent.type(screen.getByPlaceholderText('Jane Smith'), 'Kim Miller');
    await userEvent.type(screen.getByPlaceholderText('jane@email.com'), 'kim@test.com');
    fireEvent.click(screen.getByText('Continue'));
    // Step 2
    await screen.findByText('About Your Dog');
    await userEvent.type(screen.getByPlaceholderText('Buddy'), 'Rex');
    await userEvent.type(screen.getByPlaceholderText('Golden Retriever'), 'Labrador');
    const dobInput = document.querySelector('input[type="date"]');
    fireEvent.change(dobInput, { target: { value: '2020-01-01' } });
    fireEvent.change(screen.getByDisplayValue('Select a veterinarian'), { target: { value: 'Marin Pet Hospital — (415) 479-8387' } });
    const selects = document.querySelectorAll('select');
    fireEvent.change(selects[1], { target: { value: 'yes' } });   // spayNeuter
    fireEvent.change(selects[2], { target: { value: 'no' } });    // aggression
    fireEvent.change(selects[3], { target: { value: 'no' } });    // health
    fireEvent.click(screen.getByText('Continue'));
    // Step 3
    await screen.findByText('Stay Dates');
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: '2026-10-01' } });
    fireEvent.change(dateInputs[1], { target: { value: '2026-10-05' } });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[0], { target: { value: '09:00' } });
    fireEvent.change(timeInputs[1], { target: { value: '09:00' } });
    fireEvent.click(screen.getByText('Continue'));
    // Step 4
    await screen.findByText('Boarding Agreement');
    fireEvent.click(screen.getByText('I Have Read the Agreement'));
    await screen.findByText('Sign & Submit');
  }

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
});

// ── Admin ───────────────────────────────────────────────────────────────────
describe('Admin login', () => {
  test('rejects wrong password', async () => {
    render(<App />);
    fireEvent.click(screen.getByText('Admin'));
    await userEvent.type(screen.getByPlaceholderText('Password'), 'wrongpassword');
    fireEvent.click(screen.getByText('Sign In'));
    expect(await screen.findByText('Incorrect password')).toBeInTheDocument();
  });
});
