import React, { useState, useEffect } from 'react';
import { supabase } from './supabase';
import Field from './Field';
import { formatDate, formatMoney, formatTime12h, groupPortalStays, todayISO } from './calc';

// "My Stays" client portal (Oct 29, 2026, on request - see FIXES.txt
// NEXT CHANGE LIST item 2, phase 1: read-only). Log in with a phone number
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
  if (s.estimated_cost === null || s.estimated_cost === undefined) return null;
  const amount = `$${formatMoney(s.estimated_cost)}`;
  if (s.paid_at) return `Paid ${amount}`;
  if (s.billed_at) return `Billed ${amount}`;
  return `Estimate ${amount}`;
}

function StayCard({ s }) {
  const [showWaiver, setShowWaiver] = useState(false);
  const amount = stayAmountLabel(s);
  return (
    <div className="portal-stay">
      <div className="portal-stay-dogs">{(s.dogNames || []).join(' & ') || 'Your dog'}</div>
      <div className="portal-stay-dates">
        {formatDate(s.check_in)} {formatTime12h(s.drop_time)} → {formatDate(s.check_out)} {formatTime12h(s.pickup_time)}
      </div>
      {amount && <div className="portal-stay-amount">{amount}</div>}
      {s.approval_status === 'denied' && s.denial_reason && (
        <div className="portal-stay-note">"{s.denial_reason}"</div>
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
    </div>
  );
}

function StaySection({ title, hint, stays }) {
  if (stays.length === 0) return null;
  return (
    <section className="portal-section">
      <h2 className="about-subhead">{title}</h2>
      {hint && <p className="portal-hint">{hint}</p>}
      {stays.map(s => <StayCard key={s.id} s={s} />)}
    </section>
  );
}

export default function ClientPortal({ onBack, onBookStay }) {
  const [token, setToken] = useState(readToken);
  const [phase, setPhase] = useState(() => (readToken() ? 'loading' : 'phone')); // phone | code | loading | stays
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [stays, setStays] = useState([]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setPhase('loading');
    callPortal({ action: 'stays', token }).then(data => {
      if (cancelled) return;
      if (data.error) {
        writeToken(null);
        setToken(null);
        setError(data.expired ? 'Your login has expired. Please log in again.' : data.error);
        setPhase('phone');
        return;
      }
      setOwnerName(data.ownerName || '');
      setStays(data.stays || []);
      setPhase('stays');
    });
    return () => { cancelled = true; };
  }, [token]);

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
    body = (
      <>
        {ownerName && <p style={{ textAlign: 'center' }}>Hi {ownerName.split(' ')[0]}!</p>}
        {stays.length === 0 && <p style={{ textAlign: 'center' }}>You don't have any stays with us yet.</p>}
        <StaySection title="Requested" hint="Waiting for us to confirm - we'll text you once we do." stays={groups.requested} />
        <StaySection title="Upcoming" stays={groups.upcoming} />
        <StaySection title="Past Stays" stays={groups.past} />
        <StaySection title="Declined" stays={groups.declined} />
        <button className="landing-cta" style={{ ...ctaStyle, marginTop: 20 }} onClick={onBookStay}>Book a Stay</button>
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
