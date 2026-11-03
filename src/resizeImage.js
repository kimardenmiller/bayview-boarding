// Shrinks a photo in the browser before it's uploaded (Nov 3, 2026). Full-
// size phone photos (2-6 MB each) in the About gallery used up Supabase's
// free-plan bandwidth (5.5 GB/month) and took the whole project offline -
// every visitor who scrolled to About Us downloaded ~37 MB. Capping the long
// edge at MAX_PHOTO_EDGE and re-encoding as JPEG brings a typical photo to
// a few hundred KB, with no visible difference at the sizes they're shown.
//
// Used by both the admin About Photos upload and the dog photo picker.
// Best-effort throughout: anything the browser can't decode (e.g. HEIC on
// desktop Chrome) or a re-encode that wouldn't actually be smaller just
// uploads the original file, exactly as before this existed.
export const MAX_PHOTO_EDGE = 1600;
const JPEG_QUALITY = 0.82;
// Below this, a photo that already fits within MAX_PHOTO_EDGE isn't worth
// re-encoding (each re-encode loses a little quality).
const SMALL_ENOUGH_BYTES = 600_000;

export default async function resizeImage(file) {
  let url;
  try {
    const img = new Image();
    if (typeof img.decode !== 'function') return file;
    url = URL.createObjectURL(file);
    img.src = url;
    await img.decode();

    const { naturalWidth: w, naturalHeight: h } = img;
    if (!w || !h) return file;
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(w, h));
    if (scale === 1 && file.size <= SMALL_ENOUGH_BYTES) return file;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    // JPEG has no transparency - a transparent PNG would otherwise go black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Drawing an <img> (not an ImageBitmap) honors the photo's EXIF
    // rotation in every current browser, so portrait shots stay upright.
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    const name = (file.name || 'photo').replace(/\.[^.]*$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg' });
  } catch {
    return file;
  } finally {
    if (url) URL.revokeObjectURL?.(url);
  }
}
