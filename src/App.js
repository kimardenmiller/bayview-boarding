import React, { useState, useEffect } from 'react';
import { WAIVER_SECTIONS } from './waiver';
import { supabase } from './supabase';
import { SETTINGS } from './settings';
import heroDog from './img/hero-dog.jpg';
import './App.css';

// Fallback defaults, used until the `settings` Edge Function's response
// loads (App's useEffect below) and as calcCost's own parameter defaults
// for direct/pure-function callers (e.g. existing tests). The live,
// admin-configurable values come from Supabase - see the settings table
// migration and supabase/functions/settings/index.ts.
const DEFAULT_RATE = SETTINGS.DEFAULT_DAY_RATE;
const DEFAULT_MULTI_DOG_DISCOUNT = SETTINGS.MULTI_DOG_DISCOUNT;
const DEFAULT_HOLIDAY_UPCHARGE = SETTINGS.HOLIDAY_UPCHARGE;
// The editable vet clinic list, without the structural placeholder/"Other"
// entries the app always adds itself (see vetDropdownOptions).
const DEFAULT_VETS = SETTINGS.SAN_RAFAEL_VETS.slice(1, -1);

function vetDropdownOptions(vets) {
  return ['Select a Vet', ...vets, 'Other — see notes'];
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

// Adds thousands separators without otherwise changing the number's
// existing textual form - "199.50" stays "199.50", a bare 1420 becomes
// "1,420", "1199.50" becomes "1,199.50". Deliberately string-based
// (rather than always normalizing to 2 decimals) so it stays a drop-in
// wrapper around each call site's own already-correct formatting instead
// of also changing how many decimal places show up there.
function formatMoney(amount) {
  if (amount === null || amount === undefined || amount === '') return amount;
  const str = String(amount);
  const n = Number(str);
  if (Number.isNaN(n)) return amount;
  const [whole, decimal] = str.split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimal !== undefined ? `${withCommas}.${decimal}` : withCommas;
}

// NOT `new Date().toISOString().slice(0,10)` - toISOString() is always
// UTC. In the evening Pacific time (after ~5pm PDT / 4pm PST), UTC has
// already rolled to tomorrow, so that would compute "today" as tomorrow -
// making the actual local today (and the date-picker's min) reject a
// check-in of today, and make an already-chosen near date look like it's
// "in the past" when you go back to edit it. Use local calendar fields
// instead (see isoFromLocalDate).
function todayISO() {
  return isoFromLocalDate(new Date());
}

function calcAge(dob) {
  if (!dob) return '';
  const today = new Date();
  const birth = new Date(dob);
  const years = today.getFullYear() - birth.getFullYear();
  const months = today.getMonth() - birth.getMonth();
  const totalMonths = years * 12 + months;
  if (totalMonths < 12) return `${totalMonths} month${totalMonths !== 1 ? 's' : ''}`;
  const y = Math.floor(totalMonths / 12);
  const m = totalMonths % 12;
  return m > 0 ? `${y} yr ${m} mo` : `${y} year${y !== 1 ? 's' : ''}`;
}

function isoFromLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// nth weekday of a given month (weekday: 0=Sun..6=Sat, n: 1st/2nd/3rd/4th...)
function nthWeekdayOfMonth(year, month, weekday, n) {
  const d = new Date(year, month, 1);
  let count = 0;
  while (true) {
    if (d.getDay() === weekday) {
      count++;
      if (count === n) return new Date(d);
    }
    d.setDate(d.getDate() + 1);
  }
}

function lastWeekdayOfMonth(year, month, weekday) {
  const d = new Date(year, month + 1, 0); // last day of month
  while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
  return d;
}

// Computes every holiday-upcharge date window for a given year, as
// [startISO, endISO] pairs (inclusive). Algorithmic (not hardcoded dates)
// so it doesn't need yearly maintenance. See FIXES.txt item 7 for the list.
function getHolidayWindows(year) {
  const windows = [];
  const single = (date) => windows.push([isoFromLocalDate(date), isoFromLocalDate(date)]);

  single(new Date(year, 0, 1));                       // New Year's Day
  single(nthWeekdayOfMonth(year, 0, 1, 3));            // MLK Day - 3rd Monday of January

  // Presidents' Day / Ski Week - the week containing the 3rd Monday of
  // February, plus the Sat-Sun weekends immediately surrounding it.
  const presidentsDay = nthWeekdayOfMonth(year, 1, 1, 3);
  windows.push([
    isoFromLocalDate(addDays(presidentsDay, -2)), // Saturday before
    isoFromLocalDate(addDays(presidentsDay, 6)),  // Sunday after
  ]);

  single(lastWeekdayOfMonth(year, 4, 1));              // Memorial Day - last Monday of May
  single(new Date(year, 6, 4));                        // July 4th
  single(nthWeekdayOfMonth(year, 8, 1, 1));            // Labor Day - 1st Monday of September

  const thanksgiving = nthWeekdayOfMonth(year, 10, 4, 4); // 4th Thursday of November
  windows.push([isoFromLocalDate(thanksgiving), isoFromLocalDate(addDays(thanksgiving, 1))]); // + day after

  single(new Date(year, 11, 25));                      // Christmas
  single(new Date(year, 11, 31));                      // New Year's Eve

  return windows;
}

// Whether a given calendar night (YYYY-MM-DD) falls inside a holiday window.
function isHolidayNight(dateISO) {
  const year = Number(dateISO.slice(0, 4));
  return getHolidayWindows(year).some(([start, end]) => dateISO >= start && dateISO <= end);
}

// numberOfDogs: additional dogs beyond the first are each charged at
// (1 - multiDogDiscount) of that night's per-dog rate, uncapped. Holiday
// nights (see getHolidayWindows) upcharge the base rate by
// holidayUpcharge before the multi-dog discount is applied, so the
// discount always tracks the actual (possibly holiday) nightly rate.
// Both are admin-configurable (see the settings table) - the parameter
// defaults here are only a fallback for direct/pure-function callers.
function calcCost(
  checkIn, checkOut, dropTime, pickupTime, rate, numberOfDogs = 1,
  multiDogDiscount = DEFAULT_MULTI_DOG_DISCOUNT, holidayUpcharge = DEFAULT_HOLIDAY_UPCHARGE
) {
  if (!checkIn || !checkOut || !dropTime || !pickupTime) return null;
  const drop = new Date(`${checkIn}T${dropTime}`);
  const pickup = new Date(`${checkOut}T${pickupTime}`);
  const hours = (pickup - drop) / 3600000;
  if (hours <= 0) return null;
  const days = Math.max(1, Math.ceil(hours / 24));
  const dogs = Math.max(1, Number(numberOfDogs) || 1);
  const perNightDogMultiplier = 1 + (dogs - 1) * (1 - multiDogDiscount);

  const [y, m, d] = checkIn.split('-').map(Number);
  let total = 0;
  for (let i = 0; i < days; i++) {
    const nightISO = isoFromLocalDate(new Date(y, m - 1, d + i));
    const nightlyRate = isHolidayNight(nightISO) ? rate * (1 + holidayUpcharge) : rate;
    total += nightlyRate * perNightDogMultiplier;
  }
  return total.toFixed(2);
}

// Named exports alongside the default App export, purely so pure helper
// functions can be unit-tested directly instead of only through full
// multi-step form flows. No behavior change.
export { formatDate, calcAge, calcCost, isHolidayNight, getHolidayWindows, todayISO, formatMoney, vetDropdownOptions };

function Header({ onTitleClick }) {
  return (
    <header className="header">
      <div className="header-inner">
        <button className="wordmark wordmark--link" onClick={onTitleClick}>Bayview Boarding</button>
        <div className="header-sub">San Rafael, California</div>
      </div>
    </header>
  );
}

// Step count is dynamic: Owner + one page per dog + Dates + Agreement +
// Sign, so the labels/total must be computed from numberOfDogs rather
// than hardcoded.
function Progress({ step, numberOfDogs }) {
  const labels = [
    'Your Info',
    ...Array.from({ length: numberOfDogs }, (_, i) => `Dog ${i + 1}`),
    'Stay Dates', 'Agreement', 'Sign',
  ];
  const total = labels.length;
  return (
    <div className="progress-wrap">
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${(step / (total - 1)) * 100}%` }} />
      </div>
      <div className="progress-label">{labels[step]} — Step {step + 1} of {total}</div>
    </div>
  );
}

function Field({ label, error, children, hint }) {
  return (
    <div className={`field${error ? ' field--error' : ''}`}>
      <label className="field-label">{label}</label>
      {hint && <div className="field-hint">{hint}</div>}
      {children}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}

function emptyDog() {
  return {
    name: '', breed: '', dob: '', spayNeuter: '',
    aggressionHistory: '', aggressionDetail: '',
    healthConcerns: '', healthDetail: '',
  };
}

// Owner info, the vet, and "Number of Dogs" are all asked once per
// booking here (Sept 14 scope decision, moved off the dog page Sept 15)
// - a returning-client lookup on this page autofills all of it, plus
// every known dog's own profile, growing the dog-page count to match.
function StepOwner({ data, onChange, onNext, vetOptions, multiDogDiscount }) {
  const [errors, setErrors] = useState({});
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState(false);
  // The "Number of Dogs" input's own displayed text, decoupled from
  // data.dogs.length - see setDogCount below for why.
  const [dogCountText, setDogCountText] = useState(String(data.dogs.length));

  // Resync the field when the dog count changes for a reason other than
  // typing here - e.g. a returning-client lookup growing the array to
  // match known dogs.
  useEffect(() => {
    setDogCountText(String(data.dogs.length));
  }, [data.dogs.length]);

  async function lookupPhone() {
    if (!data.ownerPhone.trim()) return;
    setLooking(true);
    const { data: result } = await supabase.functions.invoke('lookup-client', {
      body: { phone: data.ownerPhone.trim() },
    });
    if (result?.found) {
      const r = result.client;
      onChange('ownerName', r.owner_name || '');
      onChange('ownerEmail', r.owner_email || '');
      if (r.vet_name) onChange('vetName', r.vet_name);
      if (r.dogs && r.dogs.length > 0) {
        // Grow the dog-page count to match every known dog, not just slot
        // 0 - a returning owner with 2 dogs on file should see both
        // prefilled without having to know to bump "Number of Dogs" first.
        const base = data.dogs.slice(0, Math.max(data.dogs.length, r.dogs.length));
        while (base.length < r.dogs.length) base.push(emptyDog());
        onChange('dogs', base.map((dog, i) => {
          const rd = r.dogs[i];
          if (!rd) return dog;
          return {
            ...dog,
            name: rd.dog_name || dog.name,
            breed: rd.dog_breed || dog.breed,
            dob: rd.dog_dob || dog.dob,
            spayNeuter: rd.spay_neuter || dog.spayNeuter,
          };
        }));
      }
      setFound(true);
    } else {
      setFound(false);
    }
    setLooking(false);
  }

  // The input's value used to be bound directly to data.dogs.length,
  // clamped to a minimum of 1 on every keystroke. That was the bug:
  // backspacing "1" to clear the field before typing "2" produced ""
  // -> NaN -> clamped right back to 1, so the field's displayed value
  // never actually changed and "2" could never land. Now the field keeps
  // its own text (dogCountText) while focused - it can go genuinely
  // blank, or hold "0" - and only resizes data.dogs on a valid parse.
  // "Number of Dogs" defaults to 0; Continue itself enforces > 0 (see
  // validate below) rather than the input refusing to go there.
  function handleDogCountChange(e) {
    const raw = e.target.value;
    setDogCountText(raw);
    if (raw === '') return; // let them clear it freely, no snap-back
    const n = parseInt(raw, 10);
    if (Number.isNaN(n) || n < 0) return;
    const next = data.dogs.slice(0, n);
    while (next.length < n) next.push(emptyDog());
    onChange('dogs', next);
  }

  // If they leave the field blank (or otherwise invalid) and click/tab
  // away, snap the displayed text back to the actual committed count
  // instead of leaving it looking blank while dogs.length disagrees.
  function handleDogCountBlur() {
    const n = parseInt(dogCountText, 10);
    if (Number.isNaN(n) || n < 0) setDogCountText(String(data.dogs.length));
  }

  // Pure - no state writes - so it can also drive the Continue button's
  // disabled state on every render, not just report errors after a click.
  function getErrors() {
    const e = {};
    if (!data.ownerPhone.trim()) e.ownerPhone = 'Required';
    if (!data.ownerName.trim()) e.ownerName = 'Required';
    if (!data.ownerEmail.trim()) e.ownerEmail = 'Required';
    if (!data.vetName || data.vetName === 'Select a Vet') e.vetName = 'Required';
    if (data.dogs.length === 0) e.dogCount = 'Must be at least 1';
    return e;
  }

  function validate() {
    const e = getErrors();
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const canContinue = Object.keys(getErrors()).length === 0;

  return (
    <div className="step">
      <h2 className="step-title">Owner Information</h2>
      <p className="step-intro">
        First time boarding with us? Just fill out every field below and on
        each dog's page that follows — we ask everything up front so nothing's
        missing when you drop off.
      </p>
      <Field label="Phone Number" hint="Returning client? Enter your number and click Look up to auto-fill." error={errors.ownerPhone}>
        <div className="email-row">
          <input value={data.ownerPhone} onChange={e => onChange('ownerPhone', e.target.value)} placeholder="(415) 555-0100" type="tel" />
          <button className="btn-secondary" onClick={lookupPhone} style={{ whiteSpace: 'nowrap', padding: '10px 14px' }}>
            {looking ? '...' : 'Look up'}
          </button>
        </div>
        {found && <div style={{ fontSize: '0.78rem', color: '#7D9B76', marginTop: 4 }}>✓ Info found — please review below</div>}
      </Field>
      <Field label="Your Full Name" error={errors.ownerName}>
        <input value={data.ownerName} onChange={e => onChange('ownerName', e.target.value)} placeholder="Jane Smith" />
      </Field>
      <Field label="Email Address" error={errors.ownerEmail}>
        <input value={data.ownerEmail} onChange={e => onChange('ownerEmail', e.target.value)} placeholder="jane@email.com" type="email" />
      </Field>
      <Field label="Veterinarian" error={errors.vetName}>
        <select value={data.vetName} onChange={e => onChange('vetName', e.target.value)}>
          {vetOptions.map((v, i) => <option key={i} value={v}>{v}</option>)}
        </select>
      </Field>
      <Field label="Number of Dogs" error={errors.dogCount}>
        <input
          type="number"
          min="0"
          step="1"
          value={dogCountText}
          onChange={handleDogCountChange}
          onBlur={handleDogCountBlur}
        />
        {data.dogs.length > 1 && (
          <div style={{ fontSize: '0.78rem', color: '#7D9B76', marginTop: 4 }}>
            {multiDogDiscount * 100}% off each additional dog's nightly rate.
          </div>
        )}
      </Field>
      <div className="step-actions">
        <button className="btn-primary" onClick={() => validate() && onNext()} disabled={!canContinue}>Continue</button>
      </div>
    </div>
  );
}

// One page per dog, titled "Dog 1", "Dog 2", etc. - `index` picks which
// entry of data.dogs this page edits. Vet and dog count live on the
// owner page now (see StepOwner); only per-dog fields live here.
function StepDogPage({ data, onChange, index, onNext, onBack }) {
  const [errors, setErrors] = useState({});
  const dog = data.dogs[index];
  const age = calcAge(dog.dob);

  function updateDog(field, value) {
    onChange('dogs', data.dogs.map((d, i) => i === index ? { ...d, [field]: value } : d));
  }

  function getErrors() {
    const e = {};
    if (!dog.name.trim()) e.name = 'Required';
    if (!dog.breed.trim()) e.breed = 'Required';
    if (!dog.dob) e.dob = 'Required';
    if (!dog.spayNeuter) e.spayNeuter = 'Required';
    if (!dog.aggressionHistory) e.aggressionHistory = 'Please select an answer';
    if (!dog.healthConcerns) e.healthConcerns = 'Please select an answer';
    return e;
  }

  function validate() {
    const e = getErrors();
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const canContinue = Object.keys(getErrors()).length === 0;

  return (
    <div className="step">
      <h2 className="step-title">Dog {index + 1}</h2>
      <Field label="Dog's Name" error={errors.name}>
        <input value={dog.name} onChange={e => updateDog('name', e.target.value)} placeholder="Buddy" />
      </Field>
      <Field label="Breed" error={errors.breed}>
        <input value={dog.breed} onChange={e => updateDog('breed', e.target.value)} placeholder="Golden Retriever" />
      </Field>
      <Field label="Date of Birth" error={errors.dob}>
        <input type="date" value={dog.dob} max={todayISO()} onChange={e => updateDog('dob', e.target.value)} />
        {age && <div style={{ fontSize: '0.78rem', color: '#7D9B76', marginTop: 4 }}>Age: {age}</div>}
      </Field>
      <Field label="Spayed / Neutered?" error={errors.spayNeuter}>
        <select value={dog.spayNeuter} onChange={e => updateDog('spayNeuter', e.target.value)}>
          <option value="">Select one</option>
          <option value="yes">Yes</option>
          <option value="no">No (over 1 year)</option>
          <option value="under1">Not yet (under 1 year)</option>
        </select>
      </Field>
      <Field label="Any aggression history toward people or dogs?" error={errors.aggressionHistory}>
        <select value={dog.aggressionHistory} onChange={e => updateDog('aggressionHistory', e.target.value)}>
          <option value="">Select one</option>
          <option value="no">No</option>
          <option value="yes">Yes — I'll describe below</option>
        </select>
      </Field>
      {dog.aggressionHistory === 'yes' && (
        <Field label="Please describe">
          <textarea value={dog.aggressionDetail} onChange={e => updateDog('aggressionDetail', e.target.value)} rows={3} placeholder="Describe any known triggers or incidents" />
        </Field>
      )}
      <Field label="Any health conditions or heat sensitivity?" error={errors.healthConcerns}>
        <select value={dog.healthConcerns} onChange={e => updateDog('healthConcerns', e.target.value)}>
          <option value="">Select one</option>
          <option value="no">No</option>
          <option value="yes">Yes — I'll describe below</option>
        </select>
      </Field>
      {dog.healthConcerns === 'yes' && (
        <Field label="Please describe">
          <textarea value={dog.healthDetail} onChange={e => updateDog('healthDetail', e.target.value)} rows={3} placeholder="Describe any conditions, limitations, or sensitivities" />
        </Field>
      )}
      <div className="step-actions">
        <button className="btn-secondary" onClick={onBack}>Back</button>
        <button className="btn-primary" onClick={() => validate() && onNext()} disabled={!canContinue}>Continue</button>
      </div>
    </div>
  );
}

function StepDates({ data, onChange, onNext, onBack, rate, multiDogDiscount, holidayUpcharge }) {
  const [errors, setErrors] = useState({});

  function getErrors() {
    const e = {};
    if (!data.checkIn) e.checkIn = 'Required';
    if (!data.checkOut) e.checkOut = 'Required';
    if (!data.dropTime) e.dropTime = 'Required';
    if (!data.pickupTime) e.pickupTime = 'Required';
    // The date input's min attribute is only a UI hint - a real check is
    // needed here too (e.g. a stale page left open overnight, or a value
    // set some other way than the picker).
    if (data.checkIn && data.checkIn < todayISO()) e.checkIn = 'Check-in cannot be in the past';
    if (data.checkIn && data.checkOut && data.checkOut < data.checkIn) e.checkOut = 'Check-out must be after check-in';
    // A same-day stay has drop-off and pick-up on the same calendar date,
    // so pick-up must actually be later in the day - a multi-day stay has
    // no such constraint (an evening drop-off and a morning pick-up two
    // days later is completely normal).
    if (data.checkIn && data.checkOut && data.checkIn === data.checkOut &&
        data.dropTime && data.pickupTime && data.pickupTime <= data.dropTime) {
      e.pickupTime = 'Pick-up must be after drop-off for a same-day stay';
    }
    return e;
  }

  function validate() {
    const e = getErrors();
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // Continue is greyed out only while a field is genuinely empty - a
  // filled-in but semantically invalid date (past check-in, check-out
  // before check-in) stays clickable, so the specific error message from
  // getErrors() above can actually be seen instead of leaving an
  // unexplained grey button once every field has *something* in it.
  const isComplete = !!(data.checkIn && data.checkOut && data.dropTime && data.pickupTime);

  const cost = calcCost(data.checkIn, data.checkOut, data.dropTime, data.pickupTime, rate, data.dogs.length, multiDogDiscount, holidayUpcharge);

  return (
    <div className="step">
      <h2 className="step-title">Stay Dates</h2>
      <div className="field-row">
        <Field label="Check-in Date" error={errors.checkIn}>
          <input type="date" value={data.checkIn} min={todayISO()} onChange={e => onChange('checkIn', e.target.value)} />
        </Field>
        <Field label="Check-out Date" error={errors.checkOut}>
          <input type="date" value={data.checkOut} min={data.checkIn || todayISO()} onChange={e => onChange('checkOut', e.target.value)} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Drop-off Time" error={errors.dropTime}>
          <input type="time" value={data.dropTime} onChange={e => onChange('dropTime', e.target.value)} />
        </Field>
        <Field label="Pick-up Time" error={errors.pickupTime}>
          <input type="time" value={data.pickupTime} onChange={e => onChange('pickupTime', e.target.value)} />
        </Field>
      </div>
      {cost && (
        <div className="cost-estimate">
          <span>Estimated cost</span>
          <strong>${formatMoney(cost)}</strong>
          <div className="cost-note">
            Based on ${formatMoney(rate)}/day · 24-hour minimum · +{holidayUpcharge * 100}% on holidays
            {data.dogs.length > 1 && ` · ${multiDogDiscount * 100}% off each additional dog`}
            {' '}· Final invoice at pickup
          </div>
        </div>
      )}
      <Field label="Notes (medications, feeding schedule, special instructions)">
        <textarea value={data.notes} onChange={e => onChange('notes', e.target.value)} rows={4} placeholder="Any instructions we should know for this stay..." />
      </Field>
      <div className="step-actions">
        <button className="btn-secondary" onClick={onBack}>Back</button>
        <button className="btn-primary" onClick={() => validate() && onNext()} disabled={!isComplete}>Continue</button>
      </div>
    </div>
  );
}

function StepWaiver({ onNext, onBack }) {
  return (
    <div className="step">
      <h2 className="step-title">Boarding Agreement</h2>
      <p className="waiver-intro">Please read each section carefully before signing.</p>
      <div className="waiver-scroll">
        {WAIVER_SECTIONS.map((s, i) => (
          <div key={i} className="waiver-section">
            <div className="waiver-section-title">{s.title}</div>
            <p>{s.body}</p>
          </div>
        ))}
      </div>
      <div className="step-actions">
        <button className="btn-secondary" onClick={onBack}>Back</button>
        <button className="btn-primary" onClick={onNext}>I Have Read the Agreement</button>
      </div>
    </div>
  );
}

function StepSign({ data, onChange, onSubmit, onBack, ownerName, submitting }) {
  const [errors, setErrors] = useState({});
  function getErrors() {
    const e = {};
    if (!data.agreed) e.agreed = 'You must check this box to proceed';
    if (!data.signature.trim()) e.signature = 'Please type your full legal name';
    else if (data.signature.trim().toLowerCase() !== ownerName.trim().toLowerCase()) {
      e.signature = 'Signature must match the name you entered on step 1';
    }
    return e;
  }
  function validate() {
    const e = getErrors();
    setErrors(e);
    return Object.keys(e).length === 0;
  }
  // Greyed out only while genuinely incomplete (box unchecked, signature
  // blank) - a filled-in but mismatched signature stays clickable so the
  // "must match" message can actually be seen.
  const isComplete = data.agreed && !!data.signature.trim();
  return (
    <div className="step">
      <h2 className="step-title">Sign & Submit</h2>
      <div className="sign-confirm">
        <label className="checkbox-label">
          <input type="checkbox" checked={data.agreed} onChange={e => onChange('agreed', e.target.checked)} />
          <span>I have read the Bayview Boarding agreement in full and agree to its terms on behalf of myself and my dog.</span>
        </label>
        {errors.agreed && <div className="field-error">{errors.agreed}</div>}
      </div>
      <Field label="Electronic Signature — type your full legal name exactly as entered on step 1" error={errors.signature}>
        <input value={data.signature} onChange={e => onChange('signature', e.target.value)} placeholder={ownerName || 'Your full legal name'} className="signature-input" />
      </Field>
      <p className="esign-note">
        Typing your name above constitutes your electronic signature and is legally binding under the federal E-SIGN Act and California's Uniform Electronic Transactions Act (UETA).
      </p>
      <div className="step-actions">
        <button className="btn-secondary" onClick={onBack}>Back</button>
        <button className="btn-primary" onClick={() => validate() && onSubmit()} disabled={submitting || !isComplete}>
          {submitting ? 'Saving...' : 'Submit Agreement'}
        </button>
      </div>
    </div>
  );
}

function Confirmation({ stay, onNewBooking }) {
  return (
    <div className="step confirmation">
      <div className="confirm-icon">✓</div>
      <h2>You're all set, {stay.owner_name?.split(' ')[0]}!</h2>
      <p>We've received your signed agreement for <strong>{stay.dog_name}</strong>.</p>
      <div className="confirm-blocks">
        <div className="confirm-block">
          <div className="confirm-block-label">Drop-off</div>
          <div className="confirm-block-date">{formatDate(stay.check_in)}</div>
          <div className="confirm-block-time">{stay.drop_time?.slice(0,5)}</div>
        </div>
        <div className="confirm-arrow">→</div>
        <div className="confirm-block">
          <div className="confirm-block-label">Pick-up</div>
          <div className="confirm-block-date">{formatDate(stay.check_out)}</div>
          <div className="confirm-block-time">{stay.pickup_time?.slice(0,5)}</div>
        </div>
      </div>
      {stay.estimated_cost && (
        <div className="cost-estimate">
          <span>Estimated cost</span>
          <strong>${formatMoney(stay.estimated_cost)}</strong>
          <div className="cost-note">Final invoice at pickup</div>
        </div>
      )}
      <p className="confirm-sub">We'll be in touch if we have any questions. See you soon!</p>
      <button className="btn-secondary" onClick={onNewBooking}>Book Another Stay</button>
    </div>
  );
}

function AdminView({
  onClose, rate, setRate, multiDogDiscount, setMultiDogDiscount,
  holidayUpcharge, setHolidayUpcharge, vets, setVets,
}) {
  const [pw, setPw] = useState('');
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState('');
  const [dogs, setDogs] = useState([]);
  const [totalStays, setTotalStays] = useState(0);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editRate, setEditRate] = useState(rate);
  const [editMultiDogDiscount, setEditMultiDogDiscount] = useState(String(multiDogDiscount * 100));
  const [editHolidayUpcharge, setEditHolidayUpcharge] = useState(String(holidayUpcharge * 100));
  const [editVets, setEditVets] = useState(vets);
  const [newVetText, setNewVetText] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  // Billing SMS is admin-triggered (not auto-sent at pickup time) - the
  // estimated cost can be wrong by pickup (early/late pickup, extra
  // services), so an admin reviews/adjusts the actual final amount before
  // it goes out, rather than the system silently texting a guess. Keyed
  // by stay id since a dog can have several stays, each independently
  // billable.
  const [billingDrafts, setBillingDrafts] = useState({});
  const [billingStatus, setBillingStatus] = useState({});

  function billingDraftFor(s) {
    if (s.id in billingDrafts) return billingDrafts[s.id];
    return s.estimated_cost != null ? String(s.estimated_cost) : '';
  }

  async function sendBillingText(s) {
    const finalCost = Number(billingDraftFor(s));
    if (!finalCost || finalCost <= 0) {
      setBillingStatus(prev => ({ ...prev, [s.id]: 'Enter a valid amount first' }));
      return;
    }
    setBillingStatus(prev => ({ ...prev, [s.id]: 'sending' }));
    const { data, error: fnError } = await supabase.functions.invoke('send-confirmation', {
      body: {
        type: 'billing',
        owner_name: selected.owner?.name,
        owner_phone: selected.owner?.phone,
        // Named for the dog currently being viewed - a stay covering
        // several dogs still only names this one in the text, a known
        // scope trade-off rather than reworking admin-data to surface
        // every dog on a shared stay.
        dog_name: selected.name,
        final_cost: finalCost,
      },
    });
    if (fnError || data?.error) {
      setBillingStatus(prev => ({ ...prev, [s.id]: 'Failed to send. Please try again.' }));
      return;
    }
    setBillingStatus(prev => ({ ...prev, [s.id]: 'sent' }));
  }

  async function login() {
    setError('');
    setLoading(true);
    const { data: result, error: fnError } = await supabase.functions.invoke('admin-data', {
      body: { password: pw },
    });
    setLoading(false);
    if (fnError || !result?.dogs) {
      setError('Incorrect password');
      return;
    }
    setAuthed(true);
    setDogs(result.dogs);
    setTotalStays(result.totalStays || 0);
    // editRate/editMultiDogDiscount/editHolidayUpcharge/editVets were
    // seeded from these same-named props back when this component first
    // mounted - but App's own settings fetch (a separate network call)
    // may not have resolved yet at that point, so those props could still
    // have been the hardcoded fallback defaults, not the real saved
    // values. Re-sync now, right as the settings UI actually becomes
    // visible, rather than on every prop change (which would risk
    // clobbering an admin's in-progress, unsaved edits).
    setEditRate(rate);
    setEditMultiDogDiscount(String(multiDogDiscount * 100));
    setEditHolidayUpcharge(String(holidayUpcharge * 100));
    setEditVets(vets);
  }

  // Shared save path for every settings field below - persists to
  // Supabase (see supabase/functions/settings/index.ts) and syncs the
  // whole app's live state so the change takes effect immediately,
  // rather than only on next reload.
  async function saveSettings(updates) {
    setSettingsError('');
    setSavingSettings(true);
    const { data, error: fnError } = await supabase.functions.invoke('settings', {
      body: { password: pw, updates },
    });
    setSavingSettings(false);
    if (fnError || !data || data.error) {
      setSettingsError(data?.error || 'Failed to save. Please try again.');
      return false;
    }
    setRate(data.dayRate);
    setMultiDogDiscount(data.multiDogDiscount);
    setHolidayUpcharge(data.holidayUpcharge);
    setVets(data.vets);
    setEditRate(data.dayRate);
    setEditMultiDogDiscount(String(data.multiDogDiscount * 100));
    setEditHolidayUpcharge(String(data.holidayUpcharge * 100));
    setEditVets(data.vets);
    return true;
  }

  function addVet() {
    const name = newVetText.trim();
    if (!name) return;
    setEditVets(v => [...v, name]);
    setNewVetText('');
  }

  function removeVet(index) {
    setEditVets(v => v.filter((_, i) => i !== index));
  }

  if (!authed) {
    return (
      <div className="admin-overlay">
        <div className="admin-login">
          <h2>Admin Access</h2>
          <input type="password" placeholder="Password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && login()} />
          {error && <div className="field-error">{error}</div>}
          <div className="step-actions">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={login}>Sign In</button>
          </div>
        </div>
      </div>
    );
  }

  const filtered = dogs.filter(d =>
    d.name?.toLowerCase().includes(search.toLowerCase()) ||
    d.owner?.name?.toLowerCase().includes(search.toLowerCase())
  );

  if (selected) {
    // selected.stays is each stay's frozen per-booking snapshot (what was
    // declared/signed at the time), already sorted newest-first by
    // admin-data - deliberately distinct from selected.* below, which is
    // the dog's always-current profile.
    return (
      <div className="admin-overlay">
        <div className="admin-panel">
          <div className="admin-header">
            <button className="back-btn" onClick={() => setSelected(null)}>← All Dogs</button>
            <button className="close-btn" onClick={onClose}>✕</button>
          </div>
          <h2>{selected.name}</h2>
          <p className="admin-owner">
            {selected.owner?.name}
            {selected.breed && ` · ${selected.breed}`}
            {selected.dob && ` · ${calcAge(selected.dob)} old`}
          </p>
          <div className="stay-history">
            {selected.stays.map((s, i) => (
              <div key={i} className="stay-card">
                <div className="stay-dates">
                  <span>{formatDate(s.check_in)} {s.drop_time?.slice(0,5)}</span>
                  <span className="stay-arrow">→</span>
                  <span>{formatDate(s.check_out)} {s.pickup_time?.slice(0,5)}</span>
                </div>
                {s.estimated_cost && <div className="stay-cost">Est. ${formatMoney(s.estimated_cost)}</div>}
                {s.number_of_dogs > 1 && <div className="stay-meta">{s.number_of_dogs} dogs</div>}
                <div className="stay-meta">Signed {formatDate(s.submitted_at?.slice(0,10))} · {selected.owner?.email} · {selected.owner?.phone}</div>
                {s.dob && <div className="stay-meta">DOB: {formatDate(s.dob)} · Age at stay: {calcAge(s.dob)}</div>}
                {s.notes && <div className="stay-notes">"{s.notes}"</div>}
                {s.aggression_history === 'yes' && <div className="stay-flag">⚠ Aggression noted: {s.aggression_detail}</div>}
                {s.health_concerns === 'yes' && <div className="stay-flag">⚕ Health note: {s.health_detail}</div>}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <span style={{ fontSize: '0.85rem' }}>$</span>
                  <input
                    type="number"
                    value={billingDraftFor(s)}
                    onChange={e => setBillingDrafts(prev => ({ ...prev, [s.id]: e.target.value }))}
                    style={{ width: 80, padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.85rem' }}
                  />
                  <button
                    className="btn-secondary"
                    style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                    disabled={billingStatus[s.id] === 'sending'}
                    onClick={() => sendBillingText(s)}
                  >
                    {billingStatus[s.id] === 'sending' ? 'Sending...' : 'Send Billing Text'}
                  </button>
                  {billingStatus[s.id] === 'sent' && <span style={{ color: '#7D9B76', fontSize: '0.78rem' }}>✓ Sent</span>}
                  {billingStatus[s.id] && billingStatus[s.id] !== 'sending' && billingStatus[s.id] !== 'sent' && (
                    <span className="field-error" style={{ fontSize: '0.78rem' }}>{billingStatus[s.id]}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-overlay">
      <div className="admin-panel">
        <div className="admin-header">
          <h2>Bayview Boarding — Admin</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="rate-setting">
          <label className="field-label">Day Rate (per 24 hours)</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span>$</span>
            <input type="number" value={editRate} onChange={e => setEditRate(e.target.value)} style={{ width: 80, padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.95rem' }} />
            <button className="btn-primary" style={{ padding: '6px 14px' }} disabled={savingSettings} onClick={() => saveSettings({ dayRate: Number(editRate) })}>Save</button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#6B7A8A', marginTop: 4 }}>24-hour minimum · Current rate: ${formatMoney(rate)}/day</div>
        </div>

        <div className="rate-setting">
          <label className="field-label">2nd+ Dog Discount</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="number" value={editMultiDogDiscount} onChange={e => setEditMultiDogDiscount(e.target.value)} style={{ width: 80, padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.95rem' }} />
            <span>%</span>
            <button className="btn-primary" style={{ padding: '6px 14px' }} disabled={savingSettings} onClick={() => saveSettings({ multiDogDiscount: Number(editMultiDogDiscount) / 100 })}>Save</button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#6B7A8A', marginTop: 4 }}>Off each additional dog's nightly rate · Current: {multiDogDiscount * 100}%</div>
        </div>

        <div className="rate-setting">
          <label className="field-label">Holiday Upcharge</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="number" value={editHolidayUpcharge} onChange={e => setEditHolidayUpcharge(e.target.value)} style={{ width: 80, padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.95rem' }} />
            <span>%</span>
            <button className="btn-primary" style={{ padding: '6px 14px' }} disabled={savingSettings} onClick={() => saveSettings({ holidayUpcharge: Number(editHolidayUpcharge) / 100 })}>Save</button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#6B7A8A', marginTop: 4 }}>On holiday nights (New Year's, MLK, Ski Week, etc.) · Current: {holidayUpcharge * 100}%</div>
        </div>

        <div className="rate-setting">
          <label className="field-label">Vet Clinics (booking form dropdown)</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {editVets.map((v, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.85rem' }}>
                <span style={{ flex: 1 }}>{v}</span>
                <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: '0.78rem' }} onClick={() => removeVet(i)}>Remove</button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              placeholder="Clinic Name — (415) 555-0100"
              value={newVetText}
              onChange={e => setNewVetText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addVet()}
              style={{ flex: 1, padding: '6px 10px', border: '1.5px solid #D5D9DE', borderRadius: 6, fontSize: '0.9rem' }}
            />
            <button className="btn-secondary" style={{ padding: '6px 14px' }} onClick={addVet}>Add</button>
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="btn-primary" style={{ padding: '6px 14px' }} disabled={savingSettings} onClick={() => saveSettings({ vets: editVets })}>Save Vet List</button>
          </div>
        </div>
        {settingsError && <div className="field-error" style={{ marginBottom: 12 }}>{settingsError}</div>}

        <input className="search-input" placeholder="Search by dog or owner name..." value={search} onChange={e => setSearch(e.target.value)} />
        <div className="admin-count">{loading ? 'Loading...' : `${totalStays} signed agreement${totalStays !== 1 ? 's' : ''} on file`}</div>
        {filtered.length === 0 && !loading && <p className="empty">No records found.</p>}
        <div className="dog-list">
          {filtered.map((d, i) => (
            <div key={i} className="dog-row" onClick={() => setSelected(d)}>
              <div className="dog-row-left">
                <div className="dog-row-name">{d.name}</div>
                <div className="dog-row-owner">{d.owner?.name}</div>
              </div>
              <div className="dog-row-right">
                <span className="stay-count">{d.stays.length} stay{d.stays.length !== 1 ? 's' : ''}</span>
                <span className="chevron">›</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Landing({ onStart, onLearnMore }) {
  return (
    <div className="landing">
      <img className="landing-img" src={heroDog} alt="A happy dog boarding with Bayview Boarding on a Marin hillside trail" />
      <div className="landing-overlay">
        <div className="landing-top">
          <h1 className="landing-title landing-title--link" onClick={onLearnMore}>Bayview Boarding</h1>
        </div>
        <div className="landing-bottom">
          <button className="landing-cta" onClick={onStart}>Book My Stay</button>
          <button className="landing-learn-more" onClick={onLearnMore}>New? Learn more →</button>
        </div>
      </div>
    </div>
  );
}

// Every 5-star review from the Rover profile's 18 reviews, newest first -
// the one 4-star review (Megan S., Aug 23 2023, a mixed "somewhat awkward
// introductions" note) is deliberately left out since it isn't glowing.
const ABOUT_REVIEWS = [
  { author: 'Aiste B.', date: 'Jun 15, 2026', quote: "Kim and Estee were amazing! They took care of our boy Lincoln like he was their own and gave him all the love, patience and off leash time. We're very lucky to have found them and will definitely work with them again!" },
  { author: 'Sue E.', date: 'Apr 30, 2026', quote: 'Great. Very flexible host easy to work with. Dog centric.' },
  { author: 'Caitlin C.', date: 'Apr 06, 2026', quote: 'We are very particular with who we leave our dog with since he needs lots of exercise and attention to be his best self. Kim and Estee took great care of him - from long hikes from the house to playing with other dogs in their beautiful backyard, he got plenty of exercise. They have a great setup for hosting dogs and were very communicative - sending pictures during his stay and taking time before hand to learn his routines and preferences. We were very happy to find a wonderful place for Moxie to get such great care when we are away - thank you!' },
  { author: 'Jordan & Kyle R.', date: 'Mar 14, 2026', quote: 'Took great care of our pup. Very communicative. Sent photos regularly. Would definitely have our pup board with Kim again. Thanks!' },
  { author: 'Andi H.', date: 'Oct 24, 2025', quote: 'My dog wagged her tail from beginning to end. She loved going on off leash hikes in the trails right outside their door. Very friendly "dog people", just my kind of people.' },
  { author: 'Ellie L.', date: 'Aug 15, 2025', quote: "Pemmy had the most fantastic time, and I was always at ease that she was being treated well. I feel okay about traveling now because I know she'll be cared for." },
  { author: 'Christian M.', date: 'Apr 18, 2025', quote: "Can't recommend enough. Home was a dream for our Goldie." },
  { author: 'Todd S.', date: 'Jan 08, 2025', quote: "We couldn't be happier with the care Kim provided for our dog, Boots! From the very start, during the initial meet and greet, we knew Boots was in excellent hands. Kim's calm and friendly demeanor immediately put us at ease, and Boots took to him right away. Throughout Boots' stay, Kim kept us updated with regular messages and adorable photos, which really helped us feel connected while we were away. Our travel plans unexpectedly changed, and Kim was incredibly accommodating, extending Boots' stay without hesitation. We wholeheartedly recommend Kim to anyone looking for a trustworthy, attentive, and compassionate dog sitter." },
  { author: 'John K.', date: 'Dec 02, 2024', quote: 'Kim provided excellent care of our dog Jasper. We recommend him highly for your pets care and will not hesitate to use him ourselves when the need arises.' },
  { author: 'Kristine Q.', date: 'Dec 05, 2023', quote: "Kim was an amazing Rover! He was very kind and communicative and clearly just has a deep love of all dogs. We really appreciated him taking great care of our pup (who isn't always the easiest dog to manage) and being so great throughout!" },
  { author: 'Steve C.', date: 'Nov 27, 2023', quote: 'Great experience having Kim and Estee care for our dog this past week. Great care and our dog Tyson was happy playing with other well behaved dogs. Will be book again, no question.' },
  { author: 'Avi D.', date: 'Nov 27, 2023', quote: 'Kim and Estee were great. Our Daisy seemed happy and well cared for and it sounded like she got lots of exercise doing long hikes during her stay. Very grateful to have found this option for when we travel. Will definitely book again.' },
  { author: 'Jennifer G.', date: 'Oct 09, 2023', quote: 'Our dog had an immediate connection with them and seemed happy and at ease when we picked her up from her short stay. Communication was easy. We will definitely book another stay.' },
  { author: 'Stephen D.', date: 'Sep 29, 2023', quote: 'Our pup had a great time with Kim and his wife! They went for a few local hikes and hung out by the pool. Communication was super easy. Happy to have Kim watch our pup again anytime.' },
  { author: 'Peter S.', date: 'Aug 17, 2023', quote: 'Kim was great with our Buddy. We had another sitter fall through about a week before our trip and found Kim just in the nick of time. Kim and Estee were warm and welcoming to us and to Buddy. Throughout the stay Kim was communicative and shared photos of their hiking adventures. We will definitely be booking with Kim again!' },
  { author: 'Megan O.', date: 'Nov 29, 2022', quote: 'Kim was wonderful. They have a very comfortable and welcoming home. He sent several pictures with my puppy, so that I could be updated on his well-being. Overall; I would highly recommend Kim!' },
  { author: 'Rennie G.', date: 'Nov 18, 2022', quote: "We are very happy with Kim's care of Dusty for this one night stay. Kim was very attentive and kept us informed. We are comfortable leaving Dusty in Kim's care and will be boarding Dusty for longer stays with Kim in the near future." },
];

// Photos supplied directly (public/img/about/) - filenames were numbered by
// Kim to set the display order; served from the public folder (not
// imported/bundled) since there are several of them and some are sizeable.
const ABOUT_PHOTOS = [
  { src: `${process.env.PUBLIC_URL}/img/about/1-choco.jpeg`, alt: 'Choco' },
  { src: `${process.env.PUBLIC_URL}/img/about/2-milo.jpeg`, alt: 'Milo' },
  { src: `${process.env.PUBLIC_URL}/img/about/3-china-camp-shoreline-trail.jpg`, alt: 'China Camp shoreline trail' },
  { src: `${process.env.PUBLIC_URL}/img/about/4-bayview-dog-room.jpg`, alt: 'The dog room at Bayview' },
  { src: `${process.env.PUBLIC_URL}/img/about/5-bayview-acre.jpg`, alt: 'The acre at Bayview' },
  { src: `${process.env.PUBLIC_URL}/img/about/6-china-camp-bay-line.jpg`, alt: 'China Camp, along the bay' },
];

// "Learn more about us" (content adapted from the Bayview Boarding Rover
// profile) - a real, underlined link on the landing page itself (not the
// decorative title text, which has no link affordance and nobody would
// think to tap) so first-time visitors can see who they're trusting with
// their dog BEFORE they commit to starting the booking flow, rather than
// after.
function AboutUs({ onBack, onStart }) {
  return (
    <div className="about">
      <div className="about-hero">
        <img className="about-hero-img" src={heroDog} alt="A dog on a hike with Bayview Boarding" />
        <button className="about-back" onClick={onBack}>← Back</button>
      </div>
      <div className="about-content">
        <h1 className="about-title about-title--center">Dog Paradise Above Loch Lomond</h1>
        <p>
          We specialize in providing a consistent family experience for your
          dog to come back to time and again. Our home sits on the China Camp
          State Park trailhead, a favorite location for dogs to take every
          kind of walk from short walks to vigorous hikes all the way up to
          the top.
        </p>
        <p>
          Being retired, we look after dogs for the love of dogs and nothing
          more. We do best with well-trained dogs who thrive on long,
          off-leash hikes. Generally we like to build long-term relationships
          where we can get to know your lovely family member and be the
          country home your pup comes back to again and again.
        </p>

        <div className="about-gallery">
          {ABOUT_PHOTOS.map((p, i) => (
            <img key={i} className="about-gallery-img" src={p.src} alt={p.alt} loading="lazy" />
          ))}
        </div>

        <h2 className="about-subhead">Where your pet will stay</h2>
        <ul className="about-facts">
          <li>Lives in a house</li>
          <li>Has a fenced yard</li>
          <li>Non-smoking household</li>
          <li>Has no pets</li>
          <li>No children present</li>
          <li>Dogs not allowed on bed</li>
          <li>Dogs not allowed on furniture</li>
          <li>Potty breaks every 0-2 hours</li>
        </ul>

        <h3 className="about-subhead about-subhead--minor">Safety, trust &amp; environment</h3>
        <p>
          Our mid-century modern home is perched over the Bay and has a
          special dog room that is also our office - so we are with your dog
          the whole time. The dog room has access to the outdoors if your dog is
          smaller and can be kept in with fencing, or closed off for larger
          dogs if necessary.
        </p>

        <h2 className="about-subhead">A typical day</h2>
        <p>
          We will go on frequent walks, including more vigorous walks if
          appropriate, in the adjacent 1,500-acre China Camp State Park that
          is steps from our home.
        </p>

        <h2 className="about-subhead">Location</h2>
        <p>
          We're in the Loch Lomond neighborhood of San Rafael, right at the
          China Camp State Park trailhead - map below shows the general area,
          not our exact address; we'll share that once your stay is booked.
        </p>
        <div className="about-map">
          <iframe
            title="Approximate location - Loch Lomond, San Rafael, CA"
            src="https://maps.google.com/maps?q=Loch+Lomond,+San+Rafael,+CA&z=13&output=embed"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        </div>

        <h2 className="about-subhead">Schedule</h2>
        <p>
          We are home throughout the week, early risers, and readily
          available to care for your dog with walks, play time, and fetch.
        </p>

        <div className="about-rating">
          ★★★★★ <strong>5.0</strong> ·{' '}
          <a
            className="link-blue"
            href="https://www.rover.com/members/kim-m-dog-paradise-above-loch-lomond/#:~:text=be%20cared%20for.-,View,-all"
            target="_blank"
            rel="noopener noreferrer"
          >
            21 ratings on Rover
          </a>
        </div>
        <div className="about-reviews">
          {ABOUT_REVIEWS.map((r, i) => (
            <div className="about-review" key={i}>
              <p className="about-review-quote">"{r.quote}"</p>
              <p className="about-review-author">— {r.author} · {r.date}</p>
            </div>
          ))}
        </div>

        <button className="landing-cta" onClick={onStart}>Book My Stay</button>
      </div>
    </div>
  );
}

// Hamburger nav - one instance, rendered by App itself on every screen
// (landing, about, contact, and the booking flow), rather than duplicated
// per page. Fixed-position, dark translucent pill (same treatment as
// AboutUs's "← Back" button) so it reads over both the hero photo and
// plain white pages without needing per-page theming.
// Admin is back in this menu (Sept 2026), a deliberate reversal of the
// earlier "no visible Admin entry point" decision (v1.5.13) per explicit
// request - it's still fully password-gated server-side (see AdminView),
// so this trades obscurity for convenience, not security.
function NavMenu({ onAbout, onContact, onBookStay, onAdmin }) {
  const [open, setOpen] = useState(false);

  function go(handler) {
    setOpen(false);
    handler();
  }

  return (
    <div className="nav-menu">
      <button
        className="nav-menu-toggle"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        {open ? '✕' : '☰'}
      </button>
      {open && (
        <>
          <div className="nav-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="nav-menu-panel">
            <button className="nav-menu-item" onClick={() => go(onAbout)}>About Us</button>
            <button className="nav-menu-item" onClick={() => go(onContact)}>Contact Us</button>
            <button className="nav-menu-item" onClick={() => go(onBookStay)}>Book a Stay</button>
            <button className="nav-menu-item" onClick={() => go(onAdmin)}>Admin</button>
          </div>
        </>
      )}
    </div>
  );
}

// Public contact form - relayed via SMS to Kim & Estee by the send-contact
// Edge Function (reuses the KIM_PHONE/ESTEE_PHONE secrets already set up
// for receive-sms, rather than standing up a separate email service).
function ContactUs({ onBack }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', message: '' });
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error

  function update(key, val) { setForm(f => ({ ...f, [key]: val })); }

  // Pure - no state writes - so it can drive the Send button's disabled
  // state on every render (see the established getErrors/validate split
  // used throughout the booking flow).
  function getErrors() {
    const e = {};
    if (!form.name.trim()) e.name = 'Required';
    if (!form.message.trim()) e.message = 'Required';
    if (!form.email.trim() && !form.phone.trim()) e.contact = 'Enter an email or phone number';
    return e;
  }

  const canSend = Object.keys(getErrors()).length === 0;

  async function handleSend() {
    const e = getErrors();
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setStatus('sending');
    const { data, error } = await supabase.functions.invoke('send-contact', { body: form });
    if (error || data?.error) {
      setStatus('error');
      return;
    }
    setStatus('sent');
  }

  if (status === 'sent') {
    return (
      <div className="about">
        <div className="about-content">
          <button className="back-btn" onClick={onBack}>← Back</button>
          <h1 className="about-title about-title--center" style={{ marginTop: 20 }}>Message sent!</h1>
          <p style={{ textAlign: 'center' }}>Thanks, {form.name.split(' ')[0]} — we'll get back to you soon.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="about">
      <div className="about-content">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <h1 className="about-title about-title--center" style={{ marginTop: 20 }}>Contact Us</h1>
        <p>
          Questions about a stay, availability, or anything else - send us a
          message and we'll get back to you.
        </p>
        <Field label="Your Name" error={errors.name}>
          <input value={form.name} onChange={e => update('name', e.target.value)} placeholder="Jane Smith" />
        </Field>
        <Field label="Email" error={errors.contact}>
          <input value={form.email} onChange={e => update('email', e.target.value)} placeholder="jane@email.com" type="email" />
        </Field>
        <Field label="Phone (optional if email given)">
          <input value={form.phone} onChange={e => update('phone', e.target.value)} placeholder="(415) 555-0100" type="tel" />
        </Field>
        <Field label="Message" error={errors.message}>
          <textarea value={form.message} onChange={e => update('message', e.target.value)} placeholder="How can we help?" rows={5} />
        </Field>
        {status === 'error' && (
          <div className="field-error" style={{ marginBottom: 12 }}>
            Something went wrong sending your message. Please try again, or text us directly.
          </div>
        )}
        <button className="landing-cta" style={{ width: '100%', boxShadow: 'none' }} disabled={!canSend || status === 'sending'} onClick={handleSend}>
          {status === 'sending' ? 'Sending...' : 'Send Message'}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [showLanding, setShowLanding] = useState(true);
  const [showAbout, setShowAbout] = useState(false);
  const [showContact, setShowContact] = useState(false);
  const [step, setStep] = useState(0);
  // Admin has no visible entry point in the UI anymore - reached only via a
  // bookmarked URL (?admin), e.g. https://.../bayview-boarding/?admin
  const [showAdmin, setShowAdmin] = useState(() => new URLSearchParams(window.location.search).has('admin'));
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [currentStay, setCurrentStay] = useState(null);
  const [rate, setRate] = useState(DEFAULT_RATE);
  const [multiDogDiscount, setMultiDogDiscount] = useState(DEFAULT_MULTI_DOG_DISCOUNT);
  const [holidayUpcharge, setHolidayUpcharge] = useState(DEFAULT_HOLIDAY_UPCHARGE);
  const [vets, setVets] = useState(DEFAULT_VETS);

  // Admin-configurable settings (day rate, multi-dog discount, holiday
  // upcharge, vet list) are persisted in Supabase now, not hardcoded -
  // every visitor needs the current values to see correct pricing and
  // the current vet list, so this is a public, unauthenticated read (see
  // supabase/functions/settings/index.ts), not gated behind admin login.
  // The hook-declared defaults above are just what's shown until this
  // resolves.
  useEffect(() => {
    supabase.functions.invoke('settings', { body: {} }).then(({ data, error }) => {
      if (error || !data || data.error) return; // keep the defaults
      if (typeof data.dayRate === 'number') setRate(data.dayRate);
      if (typeof data.multiDogDiscount === 'number') setMultiDogDiscount(data.multiDogDiscount);
      if (typeof data.holidayUpcharge === 'number') setHolidayUpcharge(data.holidayUpcharge);
      if (Array.isArray(data.vets)) setVets(data.vets);
    }).catch(() => {}); // network hiccup - keep the defaults, don't crash the page
  }, []);

  function emptyForm() {
    return {
      ownerName: '', ownerPhone: '', ownerEmail: '',
      vetName: 'Select a Vet',
      dogs: [emptyDog()], // "Number of Dogs" defaults to 1, but is still freely editable (see setDogCountText)
      checkIn: '', checkOut: '', dropTime: '', pickupTime: '', notes: '',
      agreed: false, signature: '',
    };
  }

  const [form, setForm] = useState(emptyForm);

  function update(key, val) { setForm(f => ({ ...f, [key]: val })); }

  async function handleSubmit() {
    setSubmitting(true);
    const cost = calcCost(form.checkIn, form.checkOut, form.dropTime, form.pickupTime, rate, form.dogs.length, multiDogDiscount, holidayUpcharge);
    const payload = {
      owner: {
        name: form.ownerName,
        phone: form.ownerPhone,
        email: form.ownerEmail.toLowerCase(),
        vetName: form.vetName,
      },
      dogs: form.dogs.map(d => ({
        name: d.name,
        breed: d.breed,
        dob: d.dob || null,
        spayNeuter: d.spayNeuter,
        aggressionHistory: d.aggressionHistory,
        aggressionDetail: d.aggressionDetail,
        healthConcerns: d.healthConcerns,
        healthDetail: d.healthDetail,
      })),
      checkIn: form.checkIn,
      checkOut: form.checkOut,
      dropTime: form.dropTime || null,
      pickupTime: form.pickupTime || null,
      notes: form.notes,
      estimatedCost: cost ? parseFloat(cost) : null,
      signature: form.signature,
      clientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    const { data: result, error } = await supabase.functions.invoke('submit-booking', { body: payload });
    setSubmitting(false);
    if (!error && result?.stay) {
      const stay = result.stay;
      const confirmation = {
        owner_name: stay.owner_name,
        dog_name: stay.dog_names.join(' & '),
        check_in: stay.check_in,
        check_out: stay.check_out,
        drop_time: stay.drop_time,
        pickup_time: stay.pickup_time,
        estimated_cost: stay.estimated_cost,
      };
      setCurrentStay(confirmation);
      setSubmitted(true);
      // Send confirmation text
      try {
        await supabase.functions.invoke('send-confirmation', {
          body: {
            owner_name: confirmation.owner_name,
            owner_phone: form.ownerPhone,
            dog_name: confirmation.dog_name,
            check_in: confirmation.check_in,
            check_out: confirmation.check_out,
            drop_time: confirmation.drop_time,
            pickup_time: confirmation.pickup_time,
            estimated_cost: confirmation.estimated_cost,
          }
        });
      } catch (textErr) {
        console.error('Text send failed:', textErr);
      }
    } else {
      alert('There was an error saving. Please try again.');
    }
  }

  function reset() {
    setForm(emptyForm());
    setStep(0); setSubmitted(false); setCurrentStay(null);
  }

  const adminProps = {
    onClose: () => setShowAdmin(false),
    rate, setRate,
    multiDogDiscount, setMultiDogDiscount,
    holidayUpcharge, setHolidayUpcharge,
    vets, setVets,
  };

  // Mutually-exclusive top-level views. Each nav function clears the
  // others explicitly rather than relying on ordering, so there's no way
  // to land on two views at once regardless of which one was previously
  // showing.
  function goToLanding() { setShowLanding(true); setShowAbout(false); setShowContact(false); }
  function goToAbout() { setShowAbout(true); setShowLanding(false); setShowContact(false); }
  function goToContact() { setShowContact(true); setShowLanding(false); setShowAbout(false); }
  function goToBooking() { setShowLanding(false); setShowAbout(false); setShowContact(false); }

  const navMenu = (
    <NavMenu onAbout={goToAbout} onContact={goToContact} onBookStay={goToBooking} onAdmin={() => setShowAdmin(true)} />
  );

  let pageContent;
  if (showAbout) {
    pageContent = <AboutUs onBack={goToLanding} onStart={goToBooking} />;
  } else if (showContact) {
    pageContent = <ContactUs onBack={goToLanding} />;
  } else if (showLanding) {
    pageContent = <Landing onStart={goToBooking} onLearnMore={goToAbout} />;
  } else {
    pageContent = (
      <>
        <Header onTitleClick={goToAbout} />
        <main className="main">
          {!submitted ? (
            <>
              <Progress step={step} numberOfDogs={form.dogs.length} />
              {step === 0 && (
                <StepOwner
                  data={form}
                  onChange={update}
                  onNext={() => setStep(1)}
                  vetOptions={vetDropdownOptions(vets)}
                  multiDogDiscount={multiDogDiscount}
                />
              )}
              {step >= 1 && step <= form.dogs.length && (
                <StepDogPage
                  data={form}
                  onChange={update}
                  index={step - 1}
                  onNext={() => setStep(step + 1)}
                  onBack={() => setStep(step - 1)}
                />
              )}
              {step === form.dogs.length + 1 && (
                <StepDates
                  data={form}
                  onChange={update}
                  onNext={() => setStep(step + 1)}
                  onBack={() => setStep(step - 1)}
                  rate={rate}
                  multiDogDiscount={multiDogDiscount}
                  holidayUpcharge={holidayUpcharge}
                />
              )}
              {step === form.dogs.length + 2 && <StepWaiver onNext={() => setStep(step + 1)} onBack={() => setStep(step - 1)} />}
              {step === form.dogs.length + 3 && <StepSign data={form} onChange={update} onSubmit={handleSubmit} onBack={() => setStep(step - 1)} ownerName={form.ownerName} submitting={submitting} />}
            </>
          ) : (
            <Confirmation stay={currentStay} onNewBooking={reset} />
          )}
        </main>
      </>
    );
  }

  return (
    <div className="app">
      {pageContent}
      {navMenu}
      {showAdmin && <AdminView {...adminProps} />}
    </div>
  );
}
