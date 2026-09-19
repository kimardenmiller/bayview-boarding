import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

// CRA sets process.env.PUBLIC_URL at build time from the PUBLIC_URL env
// var (see package.json's build:staging script) - the one signal
// available here for which build this is, since public/index.html is a
// single shared template for both.
const isStaging = (process.env.PUBLIC_URL || '').includes('/staging');

if (isStaging) {
  // Staging is a testing sandbox with fake data - keep it out of search
  // results entirely (Sept 19, 2026). Production gets no such tag, so
  // it stays indexable by default.
  const meta = document.createElement('meta');
  meta.name = 'robots';
  meta.content = 'noindex, nofollow';
  document.head.appendChild(meta);
} else if (process.env.REACT_APP_GA_MEASUREMENT_ID) {
  // Google Analytics (Sept 19, 2026) - production only, so staging
  // traffic (testers poking around, Claude's own verification loads)
  // never pollutes real analytics. Standard gtag.js loader, added here
  // rather than as a static <script> in public/index.html since that
  // file is shared with the staging build and has no way to leave this
  // out on its own.
  const GA_ID = process.env.REACT_APP_GA_MEASUREMENT_ID;
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  gtag('js', new Date());
  gtag('config', GA_ID);
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<React.StrictMode><App /></React.StrictMode>);