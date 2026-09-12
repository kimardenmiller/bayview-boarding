# Bayview Boarding — Project Brief for Claude

## What this is
A React web app for Bayview Boarding, a home-based dog boarding business run by 
Kim Miller and Estee Fletter at 210 Bayview Drive, San Rafael, CA.

## What it does
- Client intake form (5 steps: owner info, dog info, stay dates, waiver, signature)
- Electronic waiver with e-signature (legally binding under E-SIGN / UETA)
- Supabase database saves all submissions
- Phone-number-based returning client lookup
- Cost estimate based on drop-off/pick-up times at $105/day
- Twilio SMS confirmation texts (pending A2P carrier approval)
- Admin panel with stay history per dog

## Tech stack
- React (Create React App)
- Supabase (database + Edge Functions)
- Twilio (SMS via send-confirmation Edge Function)
- GitHub Pages hosting (kimardenmiller.github.io/bayview-boarding)
- Admin password: bayview2024
- Twilio phone: (650) 252-2433

## Key files
- src/App.js — main app
- src/settings.js — all configurable values (rates, vets, messages, packing list)
- src/waiver.js — full waiver text
- src/App.test.js — 7 passing tests (TDD)
- supabase/functions/send-confirmation/index.ts — Twilio SMS function
- FIXES.txt — current fix list and backlog

## Current priorities (v1.5)
1. Stay reminder SMS — cron job 24hrs before drop-off
2. Billing SMS — admin triggers from stay detail view
3. Rate persistence — save to Supabase so it survives page refresh
4. Phone lookup — confirm working end to end
5. Signature timestamp — add client timezone

## Rules
- Always run tests before committing (npm test -- --watchAll=false)
- All configurable values go in src/settings.js
- Follow TDD — write tests before new features
- Commit messages use format: "v1.x - description"
