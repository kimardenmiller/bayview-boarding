import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from './supabase';
import Field from './Field';
import { formatDate, formatMoney, formatTime12h, groupPortalStays, todayISO, formatCancellationPolicy, vetDropdownOptions, portalDogToFormDog, dogProfileErrors, bookingFormFromPortal } from './calc';
import DogProfileFields from './DogProfileFields';

// "My Stays" client portal (Oct 29, 2026, on request - see FIXES.txt
// NEXT CHANGE LIST item 2; phase 1 read-only, phase 2 added cancelling -
// the portal function quotes each stay's fee, see StayCard below; phase 3
// (Oct 30, 2026) added date changes, "Book again", and editing the
// client's own info and dogs' profiles). Log in with a phone number
// + a texted 6-digit code; the portal Edge Function hands back a session
// token (good ~6 months) kept in localStorage, so a returning client
// usually lands straight on their stays. Lazy-loaded like BookingFlow/
// AdminPanel - a first-time visitor never needs it.
//
// localStorage can be missing or throw (private windows, blocked site
// data), and iPhone Safari clears it after 7 days without a visit - every
// access is guarded, and a missing token just means "log in again".
const TOKEN_KEY = 'bayviewPortalToken';

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* nothing to do - they'll just log in again next visit */ }
}

async function callPortal(body) {
  const { data, error } = await supabase.functions.invoke('portal', { body });
  // A non-2xx response surfaces as `error` with the function's own JSON
  // body on error.context - read it back so the real message (wrong code,
  // expired login) reaches the screen rather than a generic one.
  if (error) {
    try {
      const body = await error.context?.json?.();
      if (body?.error) return body;
    } catch { /* fall through */ }
    return { error: 'Something went wrong. Please try again.' };
  }
  return data || {};
}

function stayAmountLabel(s) {
  if (s.approval_status === 'cancelled') {
    const fee = Number(s.cancellation_fee) || 0;
    if (fee <= 0) return 'Cancelled · no fee';
    if (s.cancellation_fee_waived_at) return 'Cancelled · fee waived';
    const amount = `$${formatMoney(fee)}`;
    if (s.paid_at) return `Cancelled · paid ${amount} fee`;
    return `Cancelled · ${amount} cancellation fee`;
  }
  if (s.estimated_cost === null || s.estimated_cost === undefined) return null;
  const amount = `$${formatMoney(s.estimated_cost)}`;
  if (s.paid_at) return `Paid ${amount}`;
  if (s.billed_at) return `Billed ${amount}`;
  return `Estimate ${amount}`;
}

// What the client is agreeing to, in words, before they confirm.
function cancelFeeMessage(s) {
  if (s.approval_status === 'pending') return "This request hasn't been confirmed yet, so there's no fee to withdraw it.";
  if (!s.cancelFee) return 'There is no cancellation fee at this point.';
  return `Under our cancellation policy, a fee of $${formatMoney(s.cancelFee)} (${s.cancelFeePercent}% of your $${formatMoney(s.estimated_cost)} estimate) applies.`;
}

function stayDates(s) {
  return `${formatDate(s.check_in)} ${formatTime12h(s.drop_time)} → ${formatDate(s.check_out)} ${formatTime12h(s.pickup_time)}`;
}

// `changeOf` is the stay this one would replace (a pending date change);
// `pendingChange` is a date change already waiting on this one.
function StayCard({ s, onCancel, onChangeDates, onRebook, changeOf, pendingChange }) {
  const [showWaiver, setShowWaiver] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const amount = stayAmountLabel(s);

  async function confirmCancel() {
    setCancelling(true);
    setCancelError('');
    const error = await onCancel(s);
    setCancelling(false);
    if (error) setCancelError(error);
  }
  return (
    <div className="portal-stay">
      <div className="portal-stay-dogs">{(s.dogNames || []).join(' & ') || 'Your dog'}</div>
      <div className="portal-stay-dates">{stayDates(s)}</div>
      {amount && <div className="portal-stay-amount">{amount}</div>}
      {s.approval_status === 'denied' && s.denial_reason && (
        <div className="portal-stay-note">"{s.denial_reason}"</div>
      )}
      {changeOf && s.approval_status === 'pending' && (
        <div className="portal-stay-note">Date change for your {stayDates(changeOf)} stay, which stays booked until we confirm this.</div>
      )}
      {pendingChange && (
        <div className="portal-stay-note">Date change requested ({formatDate(pendingChange.check_in)} → {formatDate(pendingChange.check_out)}) - waiting for us to confirm.</div>
      )}
      {Array.isArray(s.waiver_snapshot) && s.waiver_snapshot.length > 0 && (
        <>
          <button className="back-btn" style={{ fontSize: '0.78rem', marginTop: 6 }} onClick={() => setShowWaiver(w => !w)}>
            {showWaiver ? 'Hide waiver as signed' : 'View waiver as signed'}
          </button>
          {showWaiver && (
            <div className="waiver-scroll" style={{ marginTop: 8, maxHeight: 260 }}>
              {s.waiver_snapshot.map((section, i) => (
                <div className="waiver-section" key={i}>
                  <div className="waiver-section-title">{section.title}</div>
                  <p>{section.body}</p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {!confirming && (s.canChangeDates || s.canCancel || onRebook) && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {s.canChangeDates && (
            <button className="back-btn" style={{ fontSize: '0.78rem', marginTop: 6 }} onClick={() => onChangeDates(s)}>Change dates</button>
          )}
          {s.canCancel && (
            <button className="back-btn" style={{ fontSize: '0.78rem', marginTop: 6 }} onClick={() => setConfirming(true)}>
              {s.approval_status === 'pending' ? 'Withdraw request' : 'Cancel stay'}
            </button>
          )}
          {onRebook && (
            <button className="back-btn" style={{ fontSize: '0.78rem', marginTop: 6 }} onClick={() => onRebook(s)}>Book again</button>
          )}
        </div>
      )}
      {s.canCancel && confirming && (
        <div className="portal-cancel-confirm">
          <p>{cancelFeeMessage(s)}</p>
          {cancelError && <div className="field-error" style={{ marginBottom: 8 }}>{cancelError}</div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-primary" style={{ padding: '6px 14px' }} disabled={cancelling} onClick={confirmCancel}>
              {cancelling ? 'Cancelling...' : s.approval_status === 'pending' ? 'Yes, Withdraw Request' : 'Yes, Cancel Stay'}
            </button>
            <button className="btn-secondary" style={{ padding: '6px 14px' }} disabled={cancelling} onClick={() => { setConfirming(false); setCancelError(''); }}>
              Keep It
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StaySection({ title, hint, stays, allStays, onCancel, onChangeDates, onRebook }) {
  if (stays.length === 0) return null;
  return (
    <section className="portal-section">
      <h2 className="about-subhead">{title}</h2>
      {hint && <p className="portal-hint">{hint}</p>}
      {stays.map(s => (
        <StayCard
          key={s.id} s={s}
          onCancel={onCancel} onChangeDates={onChangeDates} onRebook={onRebook}
          changeOf={s.replaces_stay_id ? allStays.find(x => x.id === s.replaces_stay_id) : null}
          pendingChange={allStays.find(x => x.replaces_stay_id === s.id && x.approval_status === 'pending')}
        />
      ))}
    </section>
  );
}

// Email + vet (phase 3). Name and phone are shown but not editable: the
// phone is the login, and the name is what each signed agreement matches.
function OwnerInfo({ owner, vets, onSave }) {
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState('');
  const [vetName, setVetName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function open() {
    setEmail(owner.email);
    setVetName(owner.vetName || 'Select a Vet');
    setError('');
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setError('');
    const err = await onSave({ email, vetName });
    setSaving(false);
    if (err) setError(err); else setEditing(false);
  }

  // A vet typed in before the clinic list changed still shows as chosen.
  const options = vetDropdownOptions(vets);
  if (vetName && !options.includes(vetName)) options.splice(1, 0, vetName);

  return (
    <section className="portal-section">
      <h2 className="about-subhead">Your Info</h2>
      {!editing ? (
        <div className="portal-stay">
          <div className="portal-stay-dogs">{owner.name}</div>
          <div className="portal-stay-dates">{owner.phone} · {owner.email}</div>
          <div className="portal-stay-dates">Vet: {owner.vetName || 'not set'}</div>
          <button className="back-btn" style={{ fontSize: '0.78rem', marginTop: 6 }} onClick={open}>Edit info</button>
        </div>
      ) : (
        <div className="portal-stay">
          <Field label="Email Address">
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" />
          </Field>
          <Field label="Veterinarian">
            <select value={vetName} onChange={e => setVetName(e.target.value)}>
              {options.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <p className="portal-hint">To change your name or phone number, please text us.</p>
          {error && <div className="field-error" style={{ marginBottom: 8 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" style={{ padding: '6px 14px' }} disabled={saving || !email.trim()} onClick={save}>
              {saving ? 'Saving...' : 'Save Info'}
            </button>
            <button className="btn-secondary" style={{ padding: '6px 14px' }} disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

// One dog's profile (phase 3) - the booking form's own dog fields
// (DogProfileFields), minus the name. Saving updates the dog's current
// profile only; every past stay keeps what was declared for it.
function DogCard({ dog, onSave }) {
  const [draft, setDraft] = useState(null); // the booking form's dog shape while editing
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    const e = dogProfileErrors(draft);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setSaving(true);
    setError('');
    const err = await onSave({
      id: dog.id,
      breed: draft.breed, dob: draft.dob, spayNeuter: draft.spayNeuter,
      aggressionHistory: draft.aggressionHistory, aggressionDetail: draft.aggressionDetail,
      healthConcerns: draft.healthConcerns, healthDetail: draft.healthDetail,
      photoPaths: draft.photos.filter(p => p.path).map(p => p.path),
    });
    setSaving(false);
    if (err) setError(err); else setDraft(null);
  }

  if (!draft) {
    const thumb = dog.photos.find(p => p.url);
    return (
      <div className="portal-stay" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        {thumb && <img src={thumb.url} alt={dog.name} className="dog-photo-thumb" />}
        <div style={{ flex: 1 }}>
          <div className="portal-stay-dogs">{dog.name}</div>
          <div className="portal-stay-dates">{dog.breed}</div>
          <button className="back-btn" style={{ fontSize: '0.78rem', marginTop: 6 }} onClick={() => { setDraft(portalDogToFormDog(dog)); setErrors({}); setError(''); }}>
            Edit {dog.name}'s profile
          </button>
        </div>
      </div>
    );
  }

  const uploading = draft.photos.some(p => p.uploading);
  return (
    <div className="portal-stay">
      <div className="portal-stay-dogs" style={{ marginBottom: 8 }}>{dog.name}</div>
      <DogProfileFields dog={draft} onField={(field, value) => setDraft(d => ({ ...d, [field]: value }))} errors={errors} showName={false} />
      {error && <div className="field-error" style={{ marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn-primary" style={{ padding: '6px 14px' }} disabled={saving || uploading} onClick={save}>
          {saving ? 'Saving...' : uploading ? 'Uploading...' : 'Save Profile'}
        </button>
        <button className="btn-secondary" style={{ padding: '6px 14px' }} disabled={saving} onClick={() => setDraft(null)}>Cancel</button>
      </div>
    </div>
  );
}

export default function ClientPortal({ onBack, onStartBooking, vets = [] }) {
  const [token, setToken] = useState(readToken);
  const [phase, setPhase] = useState(() => (readToken() ? 'loading' : 'phone')); // phone | code | loading | stays
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [stays, setStays] = useState([]);
  const [policy, setPolicy] = useState(null);
  const [owner, setOwner] = useState(null);
  const [dogs, setDogs] = useState([]);
  const [notice, setNotice] = useState('');

  // Only call setters, so they're stable (no deps) and the token effect
  // below can depend on them without ever re-running because of them.
  const applyStays = useCallback(data => {
    setOwnerName(data.ownerName || '');
    setStays(data.stays || []);
    setPolicy(data.cancellationPolicy || null);
    setOwner(data.owner || null);
    setDogs(data.dogs || []);
    setPhase('stays');
  }, []);

  const forgetLogin = useCallback(data => {
    writeToken(null);
    setToken(null);
    setError(data.expired ? 'Your login has expired. Please log in again.' : data.error);
    setPhase('phone');
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setPhase('loading');
    callPortal({ action: 'stays', token }).then(data => {
      if (cancelled) return;
      if (data.error) { forgetLogin(data); return; }
      applyStays(data);
    });
    return () => { cancelled = true; };
  }, [token, applyStays, forgetLogin]);

  // Returns an error message to show on the stay's own card, or null once
  // it's cancelled (the list then reloads, moving it to Cancelled). A fee
  // that changed since the page loaded (a cutoff just passed) refreshes the
  // list so the card shows the new amount before they confirm again.
  async function cancelStay(s) {
    setNotice('');
    const data = await callPortal({ action: 'cancel', token, stayId: s.id, expectedFee: s.cancelFee });
    if (data.expired) { forgetLogin(data); return null; }
    if (data.error) {
      if (data.cancelFee !== undefined) {
        setStays(list => list.map(x => (x.id === s.id ? { ...x, cancelFee: data.cancelFee, cancelFeePercent: data.cancelFeePercent } : x)));
      }
      return data.error;
    }
    const refreshed = await callPortal({ action: 'stays', token });
    if (!refreshed.error) applyStays(refreshed);
    setNotice(data.textSent
      ? "Your stay has been cancelled. We've texted you a confirmation."
      : 'Your stay has been cancelled.');
    return null;
  }

  // Profile edits hand back the whole refreshed payload. Returns an error
  // message for the editor to show, or null once saved.
  async function saveProfile(body) {
    setNotice('');
    const data = await callPortal({ ...body, token });
    if (data.expired) { forgetLogin(data); return null; }
    if (data.error) return data.error;
    applyStays(data);
    return null;
  }

  // Phase 3: each opens the booking form already filled in (App.js's
  // startPrefilledBooking). A date change is a brand-new request that
  // replaces `s` only once we approve it - submit-booking checks this
  // login owns `s`.
  const profile = { owner, dogs };
  function changeDates(s) {
    onStartBooking({ fields: bookingFormFromPortal(profile, s, { keepDates: true }), dateChange: { stay: s, token } });
  }
  function rebook(s) {
    onStartBooking({ fields: bookingFormFromPortal(profile, s, { keepDates: false }) });
  }

  async function requestCode() {
    setBusy(true);
    setError('');
    const data = await callPortal({ action: 'requestCode', phone });
    setBusy(false);
    if (data.error) { setError(data.error); return; }
    setCode('');
    setPhase('code');
  }

  async function verifyCode() {
    setBusy(true);
    setError('');
    const data = await callPortal({ action: 'verifyCode', phone, code });
    setBusy(false);
    if (data.error || !data.token) { setError(data.error || 'Something went wrong. Please try again.'); return; }
    writeToken(data.token);
    setToken(data.token);
  }

  function logOut() {
    callPortal({ action: 'logout', token });
    writeToken(null);
    setToken(null);
    setStays([]);
    setOwnerName('');
    setPhone('');
    setPhase('phone');
  }

  const errorBox = error && <div className="field-error" style={{ marginBottom: 12 }}>{error}</div>;
  const ctaStyle = { width: '100%', boxShadow: 'none' };

  let body;
  if (phase === 'loading') {
    body = <p style={{ textAlign: 'center' }}>Loading your stays...</p>;
  } else if (phase === 'phone') {
    body = (
      <>
        <p>Enter the phone number you booked with and we'll text you a 6-digit code to log in.</p>
        <Field label="Phone Number">
          <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="(415) 555-0100" type="tel" autoComplete="tel" />
        </Field>
        {errorBox}
        <button className="landing-cta" style={ctaStyle} disabled={!phone.trim() || busy} onClick={requestCode}>
          {busy ? 'Sending...' : 'Text Me a Code'}
        </button>
      </>
    );
  } else if (phase === 'code') {
    body = (
      <>
        <p>We texted a code to {phone}. It expires in 10 minutes.</p>
        <Field label="6-Digit Code">
          <input value={code} onChange={e => setCode(e.target.value)} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
        </Field>
        {errorBox}
        <button className="landing-cta" style={ctaStyle} disabled={code.replace(/\D/g, '').length !== 6 || busy} onClick={verifyCode}>
          {busy ? 'Checking...' : 'Log In'}
        </button>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14 }}>
          <button className="back-btn" onClick={() => { setError(''); setPhase('phone'); }}>Use a different number</button>
          <button className="back-btn" disabled={busy} onClick={requestCode}>Text a new code</button>
        </div>
      </>
    );
  } else {
    const groups = groupPortalStays(stays, todayISO());
    const sectionProps = { allStays: stays, onCancel: cancelStay, onChangeDates: changeDates };
    body = (
      <>
        {ownerName && <p style={{ textAlign: 'center' }}>Hi {ownerName.split(' ')[0]}!</p>}
        {notice && <div className="portal-notice">{notice}</div>}
        {stays.length === 0 && <p style={{ textAlign: 'center' }}>You don't have any stays with us yet.</p>}
        <StaySection title="Requested" hint="Waiting for us to confirm - we'll text you once we do." stays={groups.requested} {...sectionProps} />
        <StaySection title="Upcoming" stays={groups.upcoming} {...sectionProps} />
        <StaySection title="Past Stays" stays={groups.past} {...sectionProps} onRebook={rebook} />
        <StaySection title="Declined" stays={groups.declined} {...sectionProps} onRebook={rebook} />
        <StaySection title="Cancelled" stays={groups.cancelled} {...sectionProps} onRebook={rebook} />
        {owner && <OwnerInfo owner={owner} vets={vets} onSave={o => saveProfile({ action: 'updateOwner', owner: o })} />}
        {dogs.length > 0 && (
          <section className="portal-section">
            <h2 className="about-subhead">My Dogs</h2>
            <p className="portal-hint">Keeping these current means your next booking is already filled in.</p>
            {dogs.map(d => <DogCard key={d.id} dog={d} onSave={dog => saveProfile({ action: 'updateDog', dog })} />)}
          </section>
        )}
        {policy && (
          <p className="portal-hint" style={{ marginTop: 16 }}>
            Cancellation policy: {formatCancellationPolicy(policy)}, counted back from your drop-off time. Once drop-off has passed, please text us instead.
          </p>
        )}
        <button className="landing-cta" style={{ ...ctaStyle, marginTop: 20 }} onClick={() => onStartBooking({ fields: bookingFormFromPortal(profile, { dogIds: [] }, { keepDates: false }) })}>Book a Stay</button>
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button className="back-btn" onClick={logOut}>Log out</button>
        </div>
      </>
    );
  }

  return (
    <div className="about">
      <div className="about-content">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <h1 className="about-title about-title--center" style={{ marginTop: 20 }}>My Stays</h1>
        {body}
      </div>
    </div>
  );
}
