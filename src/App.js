import React, { useState } from 'react';
import { WAIVER_SECTIONS } from './waiver';
import { supabase } from './supabase';
import { SETTINGS } from './settings';
import './App.css';

const DEFAULT_RATE = SETTINGS.DEFAULT_DAY_RATE;

const SAN_RAFAEL_VETS = SETTINGS.SAN_RAFAEL_VETS;

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
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

function calcCost(checkIn, checkOut, dropTime, pickupTime, rate) {
  if (!checkIn || !checkOut || !dropTime || !pickupTime) return null;
  const drop = new Date(`${checkIn}T${dropTime}`);
  const pickup = new Date(`${checkOut}T${pickupTime}`);
  const hours = (pickup - drop) / 3600000;
  if (hours <= 0) return null;
  const days = Math.max(1, Math.ceil(hours / 24));
  return (days * rate).toFixed(2);
}

function Header({ onAdmin }) {
  return (
    <header className="header">
      <div className="header-inner">
        <div className="wordmark">Bayview Boarding</div>
        <div className="header-sub">San Rafael, California</div>
      </div>
      <button className="admin-link" onClick={onAdmin}>Admin</button>
    </header>
  );
}

function Progress({ step, total }) {
  const labels = ['Your Info', 'Your Dog', 'Stay Dates', 'Agreement', 'Sign'];
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

function StepOwner({ data, onChange, onNext }) {
  const [errors, setErrors] = useState({});
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState(false);

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
      setFound(true);
    } else {
      setFound(false);
    }
    setLooking(false);
  }

  function validate() {
    const e = {};
    if (!data.ownerPhone.trim()) e.ownerPhone = 'Required';
    if (!data.ownerName.trim()) e.ownerName = 'Required';
    if (!data.ownerEmail.trim()) e.ownerEmail = 'Required';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  return (
    <div className="step">
      <h2 className="step-title">Owner Information</h2>
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
      <div className="step-actions">
        <button className="btn-primary" onClick={() => validate() && onNext()}>Continue</button>
      </div>
    </div>
  );
}

function StepDog({ data, onChange, onNext, onBack }) {
  const [errors, setErrors] = useState({});

  async function lookupDog(phone) {
    if (!phone) return;
    const { data: result } = await supabase.functions.invoke('lookup-client', {
      body: { phone: data.ownerPhone.trim() },
    });
    if (result?.found) {
      const r = result.client;
      onChange('dogName', r.dog_name || '');
      onChange('dogBreed', r.dog_breed || '');
      onChange('dogDob', r.dog_dob || '');
      onChange('vetName', r.vet_name || '');
      onChange('spayNeuter', r.spay_neuter || '');
    }
  }

  useState(() => { lookupDog(data.ownerPhone); }, []);

  function validate() {
    const e = {};
    if (!data.dogName.trim()) e.dogName = 'Required';
    if (!data.dogBreed.trim()) e.dogBreed = 'Required';
    if (!data.dogDob) e.dogDob = 'Required';
    if (!data.vetName || data.vetName === 'Select a veterinarian') e.vetName = 'Required';
    if (!data.spayNeuter) e.spayNeuter = 'Required';
    if (!data.aggressionHistory) e.aggressionHistory = 'Required';
    if (!data.healthConcerns) e.healthConcerns = 'Required';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const age = calcAge(data.dogDob);

  return (
    <div className="step">
      <h2 className="step-title">About Your Dog</h2>
      <Field label="Dog's Name" error={errors.dogName}>
        <input value={data.dogName} onChange={e => onChange('dogName', e.target.value)} placeholder="Buddy" />
      </Field>
      <Field label="Breed" error={errors.dogBreed}>
        <input value={data.dogBreed} onChange={e => onChange('dogBreed', e.target.value)} placeholder="Golden Retriever" />
      </Field>
      <Field label="Date of Birth" error={errors.dogDob}>
        <input type="date" value={data.dogDob} max={todayISO()} onChange={e => onChange('dogDob', e.target.value)} />
        {age && <div style={{ fontSize: '0.78rem', color: '#7D9B76', marginTop: 4 }}>Age: {age}</div>}
      </Field>
      <Field label="Veterinarian" error={errors.vetName}>
        <select value={data.vetName} onChange={e => onChange('vetName', e.target.value)}>
          {SAN_RAFAEL_VETS.map((v, i) => <option key={i} value={v}>{v}</option>)}
        </select>
      </Field>
      <Field label="Spayed / Neutered?" error={errors.spayNeuter}>
        <select value={data.spayNeuter} onChange={e => onChange('spayNeuter', e.target.value)}>
          <option value="">Select one</option>
          <option value="yes">Yes</option>
          <option value="no">No (over 1 year)</option>
          <option value="under1">Not yet (under 1 year)</option>
        </select>
      </Field>
      <Field label="Any aggression history toward people or dogs?">
        <select value={data.aggressionHistory} onChange={e => onChange('aggressionHistory', e.target.value)}>
          <option value="">Select one</option>
          <option value="no">No</option>
          <option value="yes">Yes — I'll describe below</option>
        </select>
      </Field>
      {data.aggressionHistory === 'yes' && (
        <Field label="Please describe">
          <textarea value={data.aggressionDetail} onChange={e => onChange('aggressionDetail', e.target.value)} rows={3} placeholder="Describe any known triggers or incidents" />
        </Field>
      )}
      <Field label="Any health conditions or heat sensitivity?">
        <select value={data.healthConcerns} onChange={e => onChange('healthConcerns', e.target.value)}>
          <option value="">Select one</option>
          <option value="no">No</option>
          <option value="yes">Yes — I'll describe below</option>
        </select>
      </Field>
      {data.healthConcerns === 'yes' && (
        <Field label="Please describe">
          <textarea value={data.healthDetail} onChange={e => onChange('healthDetail', e.target.value)} rows={3} placeholder="Describe any conditions, limitations, or sensitivities" />
        </Field>
      )}
      <div className="step-actions">
        <button className="btn-secondary" onClick={onBack}>Back</button>
        <button className="btn-primary" onClick={() => validate() && onNext()}>Continue</button>
      </div>
    </div>
  );
}

function StepDates({ data, onChange, onNext, onBack, rate }) {
  const [errors, setErrors] = useState({});

  function validate() {
    const e = {};
    if (!data.checkIn) e.checkIn = 'Required';
    if (!data.checkOut) e.checkOut = 'Required';
    if (!data.dropTime) e.dropTime = 'Required';
    if (!data.pickupTime) e.pickupTime = 'Required';
    if (data.checkIn && data.checkOut && data.checkOut < data.checkIn) e.checkOut = 'Check-out must be after check-in';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const cost = calcCost(data.checkIn, data.checkOut, data.dropTime, data.pickupTime, rate);

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
          <strong>${cost}</strong>
          <div className="cost-note">Based on ${rate}/day · 24-hour minimum · Final invoice at pickup</div>
        </div>
      )}
      <Field label="Notes (medications, feeding schedule, special instructions)">
        <textarea value={data.notes} onChange={e => onChange('notes', e.target.value)} rows={4} placeholder="Any instructions we should know for this stay..." />
      </Field>
      <div className="step-actions">
        <button className="btn-secondary" onClick={onBack}>Back</button>
        <button className="btn-primary" onClick={() => validate() && onNext()}>Continue</button>
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
  function validate() {
    const e = {};
    if (!data.agreed) e.agreed = 'You must check this box to proceed';
    if (!data.signature.trim()) e.signature = 'Please type your full legal name';
    if (data.signature.trim().toLowerCase() !== ownerName.trim().toLowerCase()) {
      e.signature = 'Signature must match the name you entered on step 1';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }
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
        <button className="btn-primary btn-submit" onClick={() => validate() && onSubmit()} disabled={submitting}>
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
          <strong>${stay.estimated_cost}</strong>
          <div className="cost-note">Final invoice at pickup</div>
        </div>
      )}
      <p className="confirm-sub">We'll be in touch if we have any questions. See you soon!</p>
      <button className="btn-secondary" onClick={onNewBooking}>Book Another Stay</button>
    </div>
  );
}

function AdminView({ onClose, rate, setRate }) {
  const [pw, setPw] = useState('');
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState('');
  const [stays, setStays] = useState([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editRate, setEditRate] = useState(rate);

  async function login() {
    setError('');
    setLoading(true);
    const { data: result, error: fnError } = await supabase.functions.invoke('admin-data', {
      body: { password: pw },
    });
    setLoading(false);
    if (fnError || !result?.stays) {
      setError('Incorrect password');
      return;
    }
    setAuthed(true);
    setStays(result.stays);
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

  const filtered = stays.filter(s =>
    s.dog_name?.toLowerCase().includes(search.toLowerCase()) ||
    s.owner_name?.toLowerCase().includes(search.toLowerCase())
  );

  const byDog = {};
  filtered.forEach(s => {
    const key = `${s.dog_name}|${s.owner_name}`;
    if (!byDog[key]) byDog[key] = { dogName: s.dog_name, ownerName: s.owner_name, stays: [] };
    byDog[key].stays.push(s);
  });
  const dogs = Object.values(byDog);

  if (selected) {
    const dogStays = stays.filter(s => s.dog_name === selected.dogName && s.owner_name === selected.ownerName)
      .sort((a, b) => new Date(b.check_in) - new Date(a.check_in));
    return (
      <div className="admin-overlay">
        <div className="admin-panel">
          <div className="admin-header">
            <button className="back-btn" onClick={() => setSelected(null)}>← All Dogs</button>
            <button className="close-btn" onClick={onClose}>✕</button>
          </div>
          <h2>{selected.dogName}</h2>
          <p className="admin-owner">{selected.ownerName}</p>
          <div className="stay-history">
            {dogStays.map((s, i) => (
              <div key={i} className="stay-card">
                <div className="stay-dates">
                  <span>{formatDate(s.check_in)} {s.drop_time?.slice(0,5)}</span>
                  <span className="stay-arrow">→</span>
                  <span>{formatDate(s.check_out)} {s.pickup_time?.slice(0,5)}</span>
                </div>
                {s.estimated_cost && <div className="stay-cost">Est. ${s.estimated_cost}</div>}
                <div className="stay-meta">Signed {formatDate(s.submitted_at?.slice(0,10))} · {s.owner_email} · {s.owner_phone}</div>
                {s.dog_dob && <div className="stay-meta">DOB: {formatDate(s.dog_dob)} · Age at stay: {calcAge(s.dog_dob)}</div>}
                {s.notes && <div className="stay-notes">"{s.notes}"</div>}
                {s.aggression_history === 'yes' && <div className="stay-flag">⚠ Aggression noted: {s.aggression_detail}</div>}
                {s.health_concerns === 'yes' && <div className="stay-flag">⚕ Health note: {s.health_detail}</div>}
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
            <button className="btn-primary" style={{ padding: '6px 14px' }} onClick={() => setRate(Number(editRate))}>Save</button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#6B7A8A', marginTop: 4 }}>24-hour minimum · Current rate: ${rate}/day</div>
        </div>
        <input className="search-input" placeholder="Search by dog or owner name..." value={search} onChange={e => setSearch(e.target.value)} />
        <div className="admin-count">{loading ? 'Loading...' : `${stays.length} signed agreement${stays.length !== 1 ? 's' : ''} on file`}</div>
        {dogs.length === 0 && !loading && <p className="empty">No records found.</p>}
        <div className="dog-list">
          {dogs.map((d, i) => (
            <div key={i} className="dog-row" onClick={() => setSelected(d)}>
              <div className="dog-row-left">
                <div className="dog-row-name">{d.dogName}</div>
                <div className="dog-row-owner">{d.ownerName}</div>
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

export default function App() {
  const [step, setStep] = useState(0);
  const [showAdmin, setShowAdmin] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [currentStay, setCurrentStay] = useState(null);
  const [rate, setRate] = useState(DEFAULT_RATE);

  const [form, setForm] = useState({
    ownerName: '', ownerPhone: '', ownerEmail: '',
    emergencyName: '', emergencyPhone: '',
    dogName: '', dogBreed: '', dogDob: '',
    vetName: 'Select a veterinarian', spayNeuter: '',
    aggressionHistory: '', aggressionDetail: '',
    healthConcerns: '', healthDetail: '',
    checkIn: '', checkOut: '', dropTime: '', pickupTime: '', notes: '',
    agreed: false, signature: '',
  });

  function update(key, val) { setForm(f => ({ ...f, [key]: val })); }

  async function handleSubmit() {
    setSubmitting(true);
    const cost = calcCost(form.checkIn, form.checkOut, form.dropTime, form.pickupTime, rate);
    const record = {
      owner_name: form.ownerName,
      owner_phone: form.ownerPhone,
      owner_email: form.ownerEmail.toLowerCase(),
      emergency_name: form.emergencyName,
      emergency_phone: form.emergencyPhone,
      dog_name: form.dogName,
      dog_breed: form.dogBreed,
      dog_dob: form.dogDob || null,
      vet_name: form.vetName,
      spay_neuter: form.spayNeuter,
      aggression_history: form.aggressionHistory,
      aggression_detail: form.aggressionDetail,
      health_concerns: form.healthConcerns,
      health_detail: form.healthDetail,
      check_in: form.checkIn,
      check_out: form.checkOut,
      drop_time: form.dropTime || null,
      pickup_time: form.pickupTime || null,
      estimated_cost: cost ? parseFloat(cost) : null,
      notes: form.notes,
      signature: form.signature,
      submitted_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('stays').insert([record]);
    setSubmitting(false);
    if (!error) {
      setCurrentStay(record);
      setSubmitted(true);
      // Send confirmation text
      try {
        await supabase.functions.invoke('send-confirmation', {
          body: {
            owner_name: record.owner_name,
            owner_phone: record.owner_phone,
            dog_name: record.dog_name,
            check_in: record.check_in,
            check_out: record.check_out,
            drop_time: record.drop_time,
            pickup_time: record.pickup_time,
            estimated_cost: record.estimated_cost,
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
    setForm({
      ownerName: '', ownerPhone: '', ownerEmail: '',
      emergencyName: '', emergencyPhone: '',
      dogName: '', dogBreed: '', dogDob: '',
      vetName: 'Select a veterinarian', spayNeuter: '',
      aggressionHistory: '', aggressionDetail: '',
      healthConcerns: '', healthDetail: '',
      checkIn: '', checkOut: '', dropTime: '', pickupTime: '', notes: '',
      agreed: false, signature: '',
    });
    setStep(0); setSubmitted(false); setCurrentStay(null);
  }

  return (
    <div className="app">
      <Header onAdmin={() => setShowAdmin(true)} />
      <main className="main">
        {!submitted ? (
          <>
            <Progress step={step} total={5} />
            {step === 0 && <StepOwner data={form} onChange={update} onNext={() => setStep(1)} />}
            {step === 1 && <StepDog data={form} onChange={update} onNext={() => setStep(2)} onBack={() => setStep(0)} />}
            {step === 2 && <StepDates data={form} onChange={update} onNext={() => setStep(3)} onBack={() => setStep(1)} rate={rate} />}
            {step === 3 && <StepWaiver onNext={() => setStep(4)} onBack={() => setStep(2)} />}
            {step === 4 && <StepSign data={form} onChange={update} onSubmit={handleSubmit} onBack={() => setStep(3)} ownerName={form.ownerName} submitting={submitting} />}
          </>
        ) : (
          <Confirmation stay={currentStay} onNewBooking={reset} />
        )}
      </main>
      {showAdmin && <AdminView onClose={() => setShowAdmin(false)} rate={rate} setRate={setRate} />}
    </div>
  );
}
