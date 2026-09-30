import { supabase } from './supabase';

// Resolves either shape an About-page photo entry can be in: the
// hardcoded fallback (already a full `src` URL, no Supabase Storage
// involved at all - deliberately self-contained so it still works even
// if Storage itself is ever unreachable) or a live one fetched from
// settings.about_photos (just a `path` within the "about-photos"
// Storage bucket - getPublicUrl is a pure string-construction call, not
// a network request, so this is cheap to call inline at render time for
// every photo). Shared by both App.js's own AboutContent AND the lazy-
// loaded AdminPanel.js (its own About Photos editor shows the same
// thumbnails) - split into its own module (Sept 30, 2026, code-
// splitting) so neither has to import the other just for this.
export default function aboutPhotoSrc(photo) {
  if (photo.src) return photo.src;
  return supabase.storage.from('about-photos').getPublicUrl(photo.path).data.publicUrl;
}
