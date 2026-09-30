import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { WAIVER_SECTIONS } from './waiver';
import { supabase } from './supabase';
import { SETTINGS } from './settings';
import aboutPhotoSrc from './aboutPhotoSrc';
import './App.css';

// A plain public/ path, not a webpack import (Sept 30, 2026, on
// request - PageSpeed showed a 15.3s mobile LCP). A webpack-imported
// image only gets a discoverable URL once React has rendered - the
// browser's own HTML preload scanner can't see it at all until then,
// so the fetch doesn't even START until the full JS bundle has
// downloaded, parsed, and run. This is the single largest image on the
// page (the full-bleed landing hero) and was the LCP element, so that
// delay was directly the 15s. A public/ path is known before any JS
// runs at all, which is what makes the <link rel="preload"> in
// index.html (and fetchpriority="high" below) actually work - see
// SEO & Analytics in CLAUDE.md.
const HERO_DOG_URL = `${process.env.PUBLIC_URL}/img/hero-dog.jpg`;


// Fallback defaults, used until the `settings` Edge Function's response
// loads (App's useEffect below) and as calcCost's own parameter defaults
// for direct/pure-function callers (e.g. existing tests). The live,
// admin-configurable values come from Supabase - see the settings table
// migration and supabase/functions/settings/index.ts. Split into their
// own module (Sept 30, 2026, code-splitting - see defaults.js) since
// both this file and the lazy-loaded AdminPanel.js need them.
import { DEFAULT_RATE, DEFAULT_MINIMUM_STAY, DEFAULT_MULTI_DOG_DISCOUNT, DEFAULT_HOLIDAY_UPCHARGE, DEFAULT_VETS, DEFAULT_PACKING_LIST, DEFAULT_SMS_TEMPLATES, DEFAULT_SMS_FOOTER } from './defaults';
import { calcCostBreakdown, emptyDog } from './calc';
import Field from './Field';

// The booking flow (Owner Info through Sign/Confirmation) and the admin
// panel are both lazy-loaded (Sept 30, 2026, on request - PageSpeed
// Mobile was scoring 60, with FCP/TBT both still elevated after the
// image/font fixes - the two of them together are roughly two-thirds of
// this app's total JS, and neither is needed for the landing page any
// visitor actually lands on first). See BookingFlow.js/AdminPanel.js.
const BookingFlow = lazy(() => import('./BookingFlow'));
const AdminPanel = lazy(() => import('./AdminPanel'));

// Deliberately minimal - the gap it fills is normally just the time a
// chunk takes to download once, the first time a visitor crosses into
// that part of the app (near-instant on every visit after, since the
// browser caches the chunk) - not worth a bespoke spinner/animation for
// that brief a moment.
function LoadingFallback() {
  return <div className="empty">Loading…</div>;
}


// The About content used to live on its own separate page, one tap away
// via "Learn more" - a real tester ("JK") flagged that extra tap as
// unnecessary friction (Submit Idea, Sept 19, 2026): "I should be able
// to scroll down and see everything you currently have on the About Us
// page." Landing now renders its own hero, then AboutContent directly
// below it in normal page flow - "Learn more" (and the nav menu's
// "About Us", from anywhere else in the app - see App's scrollToAbout)
// scrolls to it instead of navigating to a separate screen.
function Landing({ onStart, onLearnMore, aboutSectionRef, aboutPhotos }) {
  return (
    <>
      <div className="landing">
        {/* Lowercase, not the fetchPriority camelCase React 19 added
            special handling for (Sept 30, 2026, caught via a console
            warning in the Jest suite while code-splitting - this React
            version, 18.3.1, doesn't recognize the camelCase prop at all
            and warns that it needs spelling this way to actually reach
            the DOM; the original commit's fetchPriority spelling was
            silently doing nothing in every real browser). */}
        <img className="landing-img" src={HERO_DOG_URL} alt="A happy dog boarding with Bayview Boarding on a Marin hillside trail" fetchpriority="high" />
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
      <div className="about" ref={aboutSectionRef}>
        <div className="about-content">
          <AboutContent onStart={onStart} aboutPhotos={aboutPhotos} />
        </div>
      </div>
    </>
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

// Fallback only (Sept 21, 2026) - used until the public settings fetch
// resolves, or if it/Supabase Storage is ever unreachable, so the About
// section never shows literally no photos at all. The real,
// admin-manageable list now lives in Supabase (settings.about_photos,
// see the migration + Admin > About Photos) with the actual image files
// in Storage instead of this git-tracked public/ folder - these 6 were
// migrated there directly, so in normal operation this constant is
// never actually rendered, only kept as a safety net.
const DEFAULT_ABOUT_PHOTOS = [
  { src: `${process.env.PUBLIC_URL}/img/about/1-choco.jpeg`, alt: 'Choco' },
  { src: `${process.env.PUBLIC_URL}/img/about/2-milo.jpeg`, alt: 'Milo' },
  { src: `${process.env.PUBLIC_URL}/img/about/3-china-camp-shoreline-trail.jpg`, alt: 'China Camp shoreline trail' },
  { src: `${process.env.PUBLIC_URL}/img/about/4-bayview-dog-room.jpg`, alt: 'The dog room at Bayview' },
  { src: `${process.env.PUBLIC_URL}/img/about/5-bayview-acre.jpg`, alt: 'The acre at Bayview' },
  { src: `${process.env.PUBLIC_URL}/img/about/6-china-camp-bay-line.jpg`, alt: 'China Camp, along the bay' },
];

// Approximate-location map (About page "Location" section). A specific
// point Kim placed ~300 yards past the actual address (Sept 16, 2026),
// not the real street address itself - see the note in that section's
// own text. The embed (iframe) uses the coordinates directly; the click-
// through link reuses Kim's own Google Maps short link verbatim rather
// than reconstructing one, so it's guaranteed to open the exact same spot
// he picked.
const ABOUT_MAP_COORDS = '37.980802,-122.484319';
const ABOUT_MAP_EMBED_URL = `https://maps.google.com/maps?q=${ABOUT_MAP_COORDS}&z=16&output=embed`;
const ABOUT_MAP_LINK_URL = 'https://maps.app.goo.gl/xWg4sCFVpevDCKd16';

// The base profile URL, reused as-is by both the visible "21 ratings on
// Rover" link below (with its own #:~:text= scroll-to-review fragment
// appended) and the LocalBusiness structured data's sameAs (Sept 23,
// 2026) - kept as one constant so the two can't drift apart.
const ROVER_PROFILE_URL = 'https://www.rover.com/members/kim-m-dog-paradise-above-loch-lomond/';

// Google's own direct-to-review-form short link for the Bayview
// Boarding Business Profile (Sept 26, 2026, on request, once the
// profile itself was set up and verified) - a SEPARATE review pool
// from Rover above, and the one that actually counts toward Google's
// own local search ranking, so worth surfacing on its own rather than
// folding it into the Rover mentions.
const GOOGLE_REVIEW_URL = 'https://g.page/r/CX9YK-LEWX_nEAI/review';

// Content adapted from the Bayview Boarding Rover profile - embedded
// directly on the Landing page (see Landing above) rather than behind
// its own "Learn more" tap, so first-time visitors can see who they're
// trusting with their dog just by scrolling, before they commit to
// starting the booking flow.
function AboutContent({ onStart, aboutPhotos }) {
  // Injects LocalBusiness structured data (Sept 23, 2026, on request) -
  // every field here mirrors something already visibly on this page
  // (name, phone, city/state, the same already-fuzzed map point used by
  // the Location section below - never the exact address, same privacy
  // stance - and the 5.0/21-ratings figures shown just below the
  // gallery), which is what Google's structured-data guidelines
  // actually require: it must match visible content, not add anything
  // new. AboutContent only renders as part of Landing, so this only
  // mounts once per visit to the landing page - but Landing itself
  // unmounts/remounts when navigating mid-booking back to it via the
  // header wordmark (see that test), so cleanup on unmount matters here
  // to avoid piling up duplicate <script> tags in <head> each time.
  useEffect(() => {
    const [latitude, longitude] = ABOUT_MAP_COORDS.split(',').map(Number);
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'LocalBusiness',
      name: 'Bayview Boarding',
      // Kept in sync by hand with public/index.html's meta description -
      // same duplication trade-off already accepted there for og:image
      // (see CLAUDE.md's SEO & Analytics section).
      description: 'Home-based dog boarding in San Rafael, CA, run by Kim Miller and Estee Fletter. Book a stay, see photos and reviews, and get an instant cost estimate.',
      // HERO_DOG_URL is already a full absolute URL in a real build
      // (package.json's build script sets an explicit absolute
      // PUBLIC_URL) - window.location.origin was only ever needed
      // because the old value here was relative.
      image: HERO_DOG_URL,
      url: `${window.location.origin}${process.env.PUBLIC_URL}/`,
      telephone: SETTINGS.PHONE,
      address: { '@type': 'PostalAddress', addressLocality: 'San Rafael', addressRegion: 'CA', addressCountry: 'US' },
      geo: { '@type': 'GeoCoordinates', latitude, longitude },
      sameAs: [ROVER_PROFILE_URL],
      aggregateRating: { '@type': 'AggregateRating', ratingValue: '5.0', reviewCount: '21', bestRating: '5' },
    });
    document.head.appendChild(script);
    return () => script.remove();
  }, []);

  return (
    <>
      <h1 className="about-title about-title--center">Dog Paradise <br />Above <br />Loch Lomond</h1>
      <p className="about-tagline">
        Home-based dog boarding in San Rafael, CA, in Marin County's Loch
        Lomond neighborhood, right at the China Camp State Park trailhead.
      </p>
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
          {aboutPhotos.map((p, i) => (
            <img key={p.path || p.src || i} className="about-gallery-img" src={aboutPhotoSrc(p)} alt={p.alt} loading="lazy" />
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
          China Camp State Park trailhead - map below shows a nearby point,
          not our exact address; we'll share that once your stay is booked.
        </p>
        <div className="about-map">
          <iframe
            title="Approximate location - Loch Lomond, San Rafael, CA"
            src={ABOUT_MAP_EMBED_URL}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
          <a
            className="about-map-overlay"
            href={ABOUT_MAP_LINK_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open this location in Google Maps"
          />
        </div>

        <h2 className="about-subhead">Schedule</h2>
        <p>
          We are home throughout the week, early risers, and readily
          available to care for your dog with walks, play time, and fetch.
        </p>

        <div className="about-rating">
          <span className="stars-inline">★★★★★</span> <strong>5.0</strong> ·{' '}
          <a
            className="link-blue"
            href={`${ROVER_PROFILE_URL}#:~:text=be%20cared%20for.-,View,-all`}
            target="_blank"
            rel="noopener noreferrer"
          >
            21 ratings on Rover
          </a>
        </div>
        <div className="about-reviews">
          {ABOUT_REVIEWS.map((r, i) => (
            <div className="about-review" key={i}>
              <p className="about-review-stars" aria-label="5 out of 5 stars">★★★★★</p>
              <p className="about-review-quote">"{r.quote}"</p>
              <p className="about-review-author">— {r.author} · {r.date}</p>
            </div>
          ))}
        </div>
        <p className="about-google-review-prompt">
          Had a great stay?{' '}
          <a className="link-blue" href={GOOGLE_REVIEW_URL} target="_blank" rel="noopener noreferrer">
            Leave us a Google review
          </a>
        </p>

      <button className="landing-cta" onClick={onStart}>Book My Stay</button>
    </>
  );
}

// Hamburger nav - one instance, rendered by App itself on every screen
// (landing+about, contact, and the booking flow), rather than duplicated
// per page. Fixed-position, dark translucent pill so it reads over both
// the hero photo and plain white pages without needing per-page theming.
// Admin is back in this menu (Sept 2026), a deliberate reversal of the
// earlier "no visible Admin entry point" decision (v1.5.13) per explicit
// request - it's still fully password-gated server-side (see AdminView),
// so this trades obscurity for convenience, not security.
function NavMenu({ onAbout, onContact, onSubmitIdea, onBookStay, onAdmin }) {
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
            <button className="nav-menu-item" onClick={() => go(onBookStay)}>Book a Stay</button>
            <button className="nav-menu-item" onClick={() => go(onAbout)}>About Us</button>
            <button className="nav-menu-item" onClick={() => go(onContact)}>Contact Us</button>
            <button className="nav-menu-item" onClick={() => go(onSubmitIdea)}>Submit Idea</button>
            <button className="nav-menu-item" onClick={() => go(onAdmin)}>Admin</button>
            {/* Plain static pages (public/privacy.html, public/terms.html),
                not part of the SPA - open in a new tab (Sept 26, 2026, on
                request) so a client mid-booking never loses their
                in-progress form by navigating away. Previously only
                linked from the <noscript> fallback in index.html,
                invisible to any real (JS-enabled) visitor - Google's own
                OAuth consent screen asking for reachable privacy/terms
                URLs is what surfaced that gap. */}
            <a className="nav-menu-item" href="privacy.html" target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>Privacy Policy</a>
            <a className="nav-menu-item" href="terms.html" target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>Terms &amp; Conditions</a>
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

// "Submit Idea" - lets testers report bugs/ideas without costing anything
// per submission (SMS costs money; this is just a DB write). Persisted in
// `feedback` rather than texted, so it's an actual reviewable queue in
// admin (open/considered/done) instead of scrollback in a text thread -
// see the migration for the full rationale.
function SubmitIdea({ onBack }) {
  const [form, setForm] = useState({ message: '', name: '', contact: '' });
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error

  function update(key, val) { setForm(f => ({ ...f, [key]: val })); }

  function getErrors() {
    const e = {};
    if (!form.name.trim()) e.name = 'Required';
    if (!form.message.trim()) e.message = 'Required';
    return e;
  }

  const canSend = Object.keys(getErrors()).length === 0;

  async function handleSend() {
    const e = getErrors();
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setStatus('sending');
    const { data, error } = await supabase.functions.invoke('feedback', { body: form });
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
          <h1 className="about-title about-title--center" style={{ marginTop: 20 }}>Thanks!</h1>
          <p style={{ textAlign: 'center' }}>We've got it and will take a look.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="about">
      <div className="about-content">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <h1 className="about-title about-title--center" style={{ marginTop: 20 }}>Submit Idea</h1>
        <p>
          Found a bug, or have an idea to make this better? List as many as
          you'd like in one message - every one gets reviewed.
        </p>
        <Field label="Your Name" error={errors.name}>
          <input value={form.name} onChange={e => update('name', e.target.value)} placeholder="Jane Smith" />
        </Field>
        <Field label="Ideas / Bugs" error={errors.message}>
          <textarea
            value={form.message}
            onChange={e => update('message', e.target.value)}
            placeholder={'Feel free to list as many as you\'d like, e.g.:\n1. ...\n2. ...\n3. ...'}
            rows={8}
          />
        </Field>
        <Field label="Email or Phone (optional, in case we follow up)">
          <input value={form.contact} onChange={e => update('contact', e.target.value)} placeholder="jane@email.com" />
        </Field>
        {status === 'error' && (
          <div className="field-error" style={{ marginBottom: 12 }}>
            Something went wrong sending this. Please try again.
          </div>
        )}
        <button className="landing-cta" style={{ width: '100%', boxShadow: 'none' }} disabled={!canSend || status === 'sending'} onClick={handleSend}>
          {status === 'sending' ? 'Sending...' : 'Submit'}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  // Landing page by default, but a bookmarked/linked URL (?book) jumps
  // straight into the booking flow instead - same pattern as ?admin
  // below (Sept 26, 2026, on request - a direct "start booking" link
  // for Google Business Profile's booking-link field, which wants
  // customers dropped right into checkout, not a marketing page first).
  const [showLanding, setShowLanding] = useState(() => !new URLSearchParams(window.location.search).has('book'));
  const [showContact, setShowContact] = useState(false);
  const [showSubmitIdea, setShowSubmitIdea] = useState(false);
  const [step, setStep] = useState(0);
  // Admin has no visible entry point in the UI anymore - reached only via a
  // bookmarked URL (?admin), e.g. https://.../bayview-boarding/?admin
  const [showAdmin, setShowAdmin] = useState(() => new URLSearchParams(window.location.search).has('admin'));
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [currentStay, setCurrentStay] = useState(null);
  const [rate, setRate] = useState(DEFAULT_RATE);
  const [minimumStay, setMinimumStay] = useState(DEFAULT_MINIMUM_STAY);
  const [multiDogDiscount, setMultiDogDiscount] = useState(DEFAULT_MULTI_DOG_DISCOUNT);
  const [holidayUpcharge, setHolidayUpcharge] = useState(DEFAULT_HOLIDAY_UPCHARGE);
  const [vets, setVets] = useState(DEFAULT_VETS);
  const [packingList, setPackingList] = useState(DEFAULT_PACKING_LIST);
  const [aboutPhotos, setAboutPhotos] = useState(DEFAULT_ABOUT_PHOTOS);
  const [smsTemplates, setSmsTemplates] = useState(DEFAULT_SMS_TEMPLATES);
  const [smsFooter, setSmsFooter] = useState(DEFAULT_SMS_FOOTER);

  // Admin-configurable settings (day rate, multi-dog discount, holiday
  // upcharge, vet list, packing list, SMS templates - Sept 16, 2026 added
  // the last two) are persisted in Supabase now, not hardcoded - every
  // visitor needs the current values to see correct pricing and the
  // current vet list, so this is a public, unauthenticated read (see
  // supabase/functions/settings/index.ts), not gated behind admin login.
  // The hook-declared defaults above are just what's shown until this
  // resolves.
  useEffect(() => {
    supabase.functions.invoke('settings', { body: {} }).then(({ data, error }) => {
      if (error || !data || data.error) return; // keep the defaults
      if (typeof data.dayRate === 'number') setRate(data.dayRate);
      if (typeof data.minimumStay === 'number') setMinimumStay(data.minimumStay);
      if (typeof data.multiDogDiscount === 'number') setMultiDogDiscount(data.multiDogDiscount);
      if (typeof data.holidayUpcharge === 'number') setHolidayUpcharge(data.holidayUpcharge);
      if (Array.isArray(data.vets)) setVets(data.vets);
      if (Array.isArray(data.packingList)) setPackingList(data.packingList);
      if (data.smsConfirmation || data.smsReminder || data.smsBilling || data.smsPickupReminder || data.smsRequestReceived || data.smsDenied) {
        setSmsTemplates({
          confirmation: data.smsConfirmation ?? DEFAULT_SMS_TEMPLATES.confirmation,
          reminder: data.smsReminder ?? DEFAULT_SMS_TEMPLATES.reminder,
          billing: data.smsBilling ?? DEFAULT_SMS_TEMPLATES.billing,
          pickupReminder: data.smsPickupReminder ?? DEFAULT_SMS_TEMPLATES.pickupReminder,
          requestReceived: data.smsRequestReceived ?? DEFAULT_SMS_TEMPLATES.requestReceived,
          denied: data.smsDenied ?? DEFAULT_SMS_TEMPLATES.denied,
        });
      }
      if (data.smsFooter) setSmsFooter(data.smsFooter);
      // Unlike vets/packingList, an empty list here is valid (a real,
      // if unlikely, "no photos uploaded yet" state) - always trust the
      // live fetch once it resolves, rather than only overriding the
      // fallback when non-empty.
      if (Array.isArray(data.aboutPhotos)) setAboutPhotos(data.aboutPhotos);
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
    const breakdown = calcCostBreakdown(form.checkIn, form.checkOut, form.dropTime, form.pickupTime, rate, form.dogs.length, multiDogDiscount, holidayUpcharge, minimumStay);
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
        photoPaths: d.photos.filter(p => p.path).map(p => p.path),
      })),
      checkIn: form.checkIn,
      checkOut: form.checkOut,
      dropTime: form.dropTime || null,
      pickupTime: form.pickupTime || null,
      notes: form.notes,
      estimatedCost: breakdown ? parseFloat(breakdown.total.toFixed(2)) : null,
      signature: form.signature,
      clientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // Exactly what was shown and agreed to at StepWaiver, captured at
      // submission time so a later edit to src/waiver.js can never
      // retroactively change what this client is on record as having
      // signed (Sept 16, 2026) - see the migration for the full rationale.
      waiverSnapshot: WAIVER_SECTIONS,
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
        cost_breakdown: breakdown,
        multi_dog_discount: multiDogDiscount,
      };
      setCurrentStay(confirmation);
      setSubmitted(true);
      // A submission is a request now, not an instant booking (Sept 21,
      // 2026, on request - see Submit Idea from Estee) - this text just
      // acknowledges receipt; the real confirmation only goes out once
      // admin approves it from the new admin Requests section
      // (approveRequest below).
      try {
        await supabase.functions.invoke('send-confirmation', {
          body: {
            type: 'request_received',
            owner_name: confirmation.owner_name,
            owner_phone: form.ownerPhone,
            dog_name: confirmation.dog_name,
            check_in: confirmation.check_in,
            check_out: confirmation.check_out,
            drop_time: confirmation.drop_time,
            pickup_time: confirmation.pickup_time,
            estimated_cost: confirmation.estimated_cost,
            message_template: smsTemplates.requestReceived,
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
    minimumStay, setMinimumStay,
    multiDogDiscount, setMultiDogDiscount,
    holidayUpcharge, setHolidayUpcharge,
    vets, setVets,
    packingList, setPackingList,
    aboutPhotos, setAboutPhotos,
    smsTemplates, setSmsTemplates,
    smsFooter, setSmsFooter,
  };

  // Mutually-exclusive top-level views. Each nav function clears the
  // others explicitly rather than relying on ordering, so there's no way
  // to land on two views at once regardless of which one was previously
  // showing. About is no longer its own view (see Landing/AboutContent
  // above) - scrollToAbout below is what "About Us" and "Learn more"
  // both call instead of a goToAbout nav function.
  function goToLanding() { setShowLanding(true); setShowContact(false); setShowSubmitIdea(false); }
  function goToContact() { setShowContact(true); setShowLanding(false); setShowSubmitIdea(false); }
  function goToSubmitIdea() { setShowSubmitIdea(true); setShowLanding(false); setShowContact(false); }
  function goToBooking() { setShowLanding(false); setShowContact(false); setShowSubmitIdea(false); }

  // Scrolls to the embedded About section on the Landing page - if
  // Landing isn't currently showing, navigates there first and scrolls
  // once it's mounted (see the effect below, keyed off pendingScrollToAbout).
  const aboutSectionRef = useRef(null);
  const [pendingScrollToAbout, setPendingScrollToAbout] = useState(false);
  function scrollToAbout() {
    if (showLanding && aboutSectionRef.current) {
      aboutSectionRef.current.scrollIntoView({ behavior: 'smooth' });
    } else {
      goToLanding();
      setPendingScrollToAbout(true);
    }
  }
  useEffect(() => {
    if (showLanding && pendingScrollToAbout && aboutSectionRef.current) {
      aboutSectionRef.current.scrollIntoView({ behavior: 'smooth' });
      setPendingScrollToAbout(false);
    }
  }, [showLanding, pendingScrollToAbout]);

  const navMenu = (
    <NavMenu onAbout={scrollToAbout} onContact={goToContact} onSubmitIdea={goToSubmitIdea} onBookStay={goToBooking} onAdmin={() => setShowAdmin(true)} />
  );

  let pageContent;
  if (showContact) {
    pageContent = <ContactUs onBack={goToLanding} />;
  } else if (showSubmitIdea) {
    pageContent = <SubmitIdea onBack={goToLanding} />;
  } else if (showLanding) {
    pageContent = <Landing onStart={goToBooking} onLearnMore={scrollToAbout} aboutSectionRef={aboutSectionRef} aboutPhotos={aboutPhotos} />;
  } else {
    // Lazy-loaded (Sept 30, 2026, code-splitting) - see BookingFlow.js.
    // The Suspense fallback only ever shows for the brief moment the
    // chunk takes to download the first time; every prop here is passed
    // straight through unchanged from what used to be inline.
    pageContent = (
      <Suspense fallback={<LoadingFallback />}>
        <BookingFlow
          onTitleClick={scrollToAbout}
          step={step} setStep={setStep}
          submitted={submitted}
          form={form} onChange={update}
          vets={vets} multiDogDiscount={multiDogDiscount}
          rate={rate} minimumStay={minimumStay} holidayUpcharge={holidayUpcharge}
          onSubmit={handleSubmit} submitting={submitting}
          currentStay={currentStay} onNewBooking={reset}
        />
      </Suspense>
    );
  }

  return (
    <div className="app">
      {pageContent}
      {navMenu}
      {showAdmin && (
        <Suspense fallback={<LoadingFallback />}>
          <AdminPanel {...adminProps} />
        </Suspense>
      )}
    </div>
  );
}
