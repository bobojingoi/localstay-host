// Photo AI helpers.
//  - describeImage: alt-text + short description (Gemini text model)
//  - analyzeForEnhance: per-photo vision analysis -> concrete correction brief (Gemini)
//  - enhanceImage: returns an edited image. Uses OpenAI gpt-image-2 when OPENAI_API_KEY
//      is set (high-fidelity edit + aspect-ratio-preserving size, like the LocalStay GPT
//      editor); otherwise falls back to Gemini (gemini-2.5-flash-image), two-pass.
const TEXT_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

function call(model, body) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Promise.reject(new Error("GEMINI_API_KEY missing"));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  return fetch(BASE + model + ":generateContent?key=" + key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).then(async r => {
    clearTimeout(t);
    const json = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error("Gemini " + r.status + ": " + JSON.stringify(json).slice(0, 300)); e.status = r.status; throw e; }
    return json;
  }, e => { clearTimeout(t); throw e; });
}

// pull all parts out of a response, regardless of camel/snake casing
function partsOf(json) {
  return ((((json.candidates || [])[0] || {}).content || {}).parts) || [];
}
function inlineOf(part) { return part.inline_data || part.inlineData || null; }

async function describeImage(base64, mime) {
  if (!process.env.GEMINI_API_KEY) return { alt: "", description: "" };
  const prompt =
    "Ești asistent pentru un site de cazări turistice din România. Privește imaginea și răspunde cu JSON, în limba română: " +
    'cheia "alt" = descriere scurtă și factuală a imaginii (max 120 caractere, pentru atributul alt / SEO); ' +
    'cheia "description" = 1-2 propoziții de prezentare, atrăgătoare dar oneste, fără a inventa detalii care nu se văd.';
  try {
    const json = await call(TEXT_MODEL, {
      contents: [{ parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 300, responseMimeType: "application/json" },
    });
    let txt = partsOf(json).map(p => p.text || "").join("").trim();
    txt = txt.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    const mt = txt.match(/\{[\s\S]*\}/);
    const o = JSON.parse(mt ? mt[0] : txt);
    return { alt: (o.alt || "").slice(0, 140), description: (o.description || "").slice(0, 400) };
  } catch (e) {
    console.error("describeImage failed:", e.message);
    return { alt: "", description: "" };
  }
}

/* ---- Two-pass enhancement: analyse the photo, then apply a tailored, assertive
   real-estate correction that keeps the scene 100% authentic (tone/colour/geometry only). ---- */

const ENHANCE_RULES =
  "You are a professional real-estate & hospitality photo retoucher preparing a photo for a premium booking website. " +
  "Make it look bright, clean, inviting and professionally shot — the kind of image that makes guests book — WITHOUT changing what the place actually looks like. " +
  "ABSOLUTE RULES (never break): keep the SAME real room/exterior/property, fully recognisable and authentic; " +
  "do NOT add, remove, move, replace, duplicate, redesign or reconstruct any object, furniture, wall, window, door, fixture, light, plant, view, person, sign, text or logo; " +
  "no generative fill, no inpainting, no new sky/sunlight/lamps/shadows/reflections/decor, no HDR halos, no cartoonish or oversaturated look, no added watermark. " +
  "Preserve real textures, materials and natural imperfections. The output must look like the SAME photo, professionally edited — not a different or AI-generated scene.";

const ENHANCE_GOALS =
  "Apply these corrections confidently — as strongly as needed to reach a polished, professional result — but only tone, colour and geometry, never content: " +
  "1) STRAIGHTEN & LEVEL: fix any tilt so the horizon is level; correct converging verticals / lens distortion so walls and lines look natural and upright; crop minimally to hide rotation borders. " +
  "2) BRIGHTNESS & EXPOSURE: open the image up, lift dark shadows to reveal detail, recover blown highlights, balance exposure so the space looks light, airy and well-lit (never flat, dark or muddy). " +
  "3) WHITE BALANCE & COLOUR: remove colour casts (yellow/green/blue); set a clean, natural balance so whites look white and wood/greenery look true; pleasant, realistic colour. " +
  "4) CLARITY & POLISH: gentle contrast, local clarity and a crisp, clean, magazine-quality finish; reduce noise and haze; keep it fully photorealistic. " +
  "Return exactly ONE edited image, same framing and aspect ratio as the original.";

// Pass 1 — vision analysis: produce concrete, per-photo correction notes (not a room description).
async function analyzeForEnhance(base64, mime) {
  if (!process.env.GEMINI_API_KEY) return "";
  const prompt =
    "Inspect this single accommodation/real-estate photo that will be auto-enhanced for a booking website. " +
    "Report ONLY the technical corrections it needs — do NOT describe the room or its contents. " +
    "Respond with a compact JSON object with keys: " +
    '"tilt" (is it tilted? which direction and roughly how many degrees, or "level"), ' +
    '"perspective" (converging verticals or lens distortion? or "ok"), ' +
    '"exposure" (under/over-exposed? which areas are too dark or blown out?), ' +
    '"whiteBalance" (any colour cast, e.g. warm/yellow, green, blue? or "neutral"), ' +
    '"other" (noise, dullness, low contrast, haze, flat colour... or "none"), ' +
    '"brief" (one or two imperative sentences telling the retoucher exactly what to fix on THIS photo to make it bright, level and professional). ' +
    "Be concise and specific.";
  try {
    const json = await call(TEXT_MODEL, {
      contents: [{ parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 400, responseMimeType: "application/json" },
    });
    let txt = partsOf(json).map(p => p.text || "").join("").trim();
    txt = txt.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    const mt = txt.match(/\{[\s\S]*\}/);
    const o = JSON.parse(mt ? mt[0] : txt);
    const skip = v => !v || /^(level|drept|straight|none|ok|neutral|no\b|n\/a)/i.test(String(v).trim());
    const parts = [];
    if (!skip(o.tilt)) parts.push("Tilt: " + o.tilt);
    if (!skip(o.perspective)) parts.push("Perspective: " + o.perspective);
    if (!skip(o.exposure)) parts.push("Exposure: " + o.exposure);
    if (!skip(o.whiteBalance)) parts.push("White balance: " + o.whiteBalance);
    if (!skip(o.other)) parts.push("Other: " + o.other);
    let brief = (o.brief || "").trim();
    if (parts.length) brief += (brief ? " " : "") + parts.join("; ") + ".";
    return brief.slice(0, 700);
  } catch (e) {
    console.error("analyzeForEnhance failed:", e.message);
    return "";
  }
}

async function enhanceImageGemini(base64, mime) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  // Pass 1: analyse this specific photo
  const brief = await analyzeForEnhance(base64, mime).catch(() => "");
  // Pass 2: apply a tailored, assertive correction
  const prompt = ENHANCE_RULES + " " + ENHANCE_GOALS +
    (brief ? (" Specific issues to fix in THIS exact photo: " + brief) : "");
  const json = await call(IMAGE_MODEL, {
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: prompt }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"], temperature: 0.35 },
  });
  for (const p of partsOf(json)) {
    const d = inlineOf(p);
    if (d && /^image\//.test(d.mime_type || d.mimeType || "")) {
      return { image: d.data, mime: d.mime_type || d.mimeType };
    }
  }
  console.error("enhanceImageGemini: no image in response:", JSON.stringify(json).slice(0, 300));
  return null;
}

/* =====================================================================
   OpenAI gpt-image-2 path (matches the trusted LocalStay GPT editor):
   high-fidelity edit + an explicit output size that preserves the
   original aspect ratio. Used when OPENAI_API_KEY is set.
   ===================================================================== */
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
// gpt-image-2 output constraints
const MIN_OUTPUT_PIXELS = 655360, MAX_OUTPUT_PIXELS = 8294400, MAX_OUTPUT_EDGE = 3840;
const MAX_OUTPUT_LONG_SIDE = +(process.env.OPENAI_MAX_LONG_SIDE || 3072);
const MIN_API_ASPECT_RATIO = 1 / 3, MAX_API_ASPECT_RATIO = 3;
const r16up = v => Math.max(16, Math.ceil(v / 16) * 16);
const r16down = v => Math.max(16, Math.floor(v / 16) * 16);

// Build a valid gpt-image-2 size string that keeps the input aspect ratio. Null if unsupported.
function makeApiSize(width, height) {
  if (!width || !height) return null;
  const ratio = width / height;
  if (ratio > MAX_API_ASPECT_RATIO || ratio < MIN_API_ASPECT_RATIO) return null; // wider than 3:1 — skip explicit size
  const pixels = width * height, longSide = Math.max(width, height);
  const maxScaleLong = Math.min(MAX_OUTPUT_LONG_SIDE, MAX_OUTPUT_EDGE) / longSide;
  const maxScalePix = Math.sqrt(MAX_OUTPUT_PIXELS / pixels);
  const maxScale = Math.min(maxScaleLong, maxScalePix);
  const minScalePix = Math.sqrt(MIN_OUTPUT_PIXELS / pixels);
  let scale = 1;
  if (pixels < MIN_OUTPUT_PIXELS) scale = minScalePix;
  else if (longSide > Math.min(MAX_OUTPUT_LONG_SIDE, MAX_OUTPUT_EDGE) || pixels > MAX_OUTPUT_PIXELS) scale = maxScale;
  if (scale > maxScale + 1e-9) return null;
  let tw = r16up(width * scale), th = r16up(height * scale);
  let cp = tw * th, cl = Math.max(tw, th);
  if (cp > MAX_OUTPUT_PIXELS || cl > Math.min(MAX_OUTPUT_LONG_SIDE, MAX_OUTPUT_EDGE)) {
    const down = Math.min(Math.sqrt(MAX_OUTPUT_PIXELS / cp), Math.min(MAX_OUTPUT_LONG_SIDE, MAX_OUTPUT_EDGE) / cl);
    tw = r16down(tw * down); th = r16down(th * down);
  }
  let guard = 0;
  while (tw * th < MIN_OUTPUT_PIXELS && guard++ < 400) {
    if (tw >= th) { tw += 16; th = r16up(tw / ratio); } else { th += 16; tw = r16up(th * ratio); }
    if (Math.max(tw, th) > Math.min(MAX_OUTPUT_LONG_SIDE, MAX_OUTPUT_EDGE)) return null;
  }
  if (tw * th > MAX_OUTPUT_PIXELS) return null;
  return tw + "x" + th;
}

// Same conservative, trusted "platform-ready" brief used by the GPT editor.
const PLATFORM_READY_PROMPT =
  "Edit this original accommodation photograph for a premium accommodation booking platform. " +
  "Primary goal: a cleaner, brighter, professionally presented version of the SAME photograph, keeping the property fully authentic, recognisable and trustworthy. " +
  "This is a conservative real-estate photo correction. The final image must remain the same real room/exterior/property, not a redesigned or reimagined version. " +
  "Allowed edits only: correct orientation and straighten; correct lens distortion and perspective conservatively so walls, doors, windows, furniture and vertical lines look naturally aligned; " +
  "improve framing only if required after perspective correction, with a minimal crop; improve exposure, brightness, contrast, shadows, highlights and white balance naturally; increase clarity, colour balance and vibrance to a clean professional look. " +
  "Strict preservation: do NOT add, remove, move, hide, replace, redesign or reconstruct any object; do not change architecture, layout, dimensions, furniture, bedding, textiles, finishes, flooring, ceiling, doors, windows, radiators, lights, plants, artwork, vehicles, people, signage, logos or text; " +
  "preserve all real textures and natural imperfections; no generative fill, inpainting, object removal, relighting, fake sunlight/lamps/reflections/shadows or cinematic sky; do not turn lights/windows on or off; no HDR-like, oversaturated, overly sharp, stylised or AI-generated look; do not crop aggressively, widen the room or alter proportions. " +
  "Visual target: natural premium accommodation photography — straight, balanced, realistic, naturally bright, neutral colour balance, with visible detail in shadows and highlights. " +
  "Return exactly one edited image, preserving the original aspect ratio as closely as possible.";

async function enhanceImageOpenAI(base64, mime) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY missing");
  const sharp = require("sharp");
  const inputBuf = Buffer.from(base64, "base64");
  // read dimensions for the aspect-preserving output size (same as the GPT script)
  const meta = await sharp(inputBuf).metadata().catch(() => ({}));
  const size = makeApiSize(meta.width, meta.height);
  // send the image as-is (jpeg/png/webp supported by the API); re-encode only exotic formats
  let uploadBuf = inputBuf, uploadType = (mime || "image/jpeg"), fname = "photo.jpg";
  if (!/^image\/(jpeg|png|webp)$/i.test(uploadType)) { uploadBuf = await sharp(inputBuf).jpeg({ quality: 95 }).toBuffer(); uploadType = "image/jpeg"; }
  else fname = "photo." + (uploadType.split("/")[1] === "jpeg" ? "jpg" : uploadType.split("/")[1]);

  // single pass — identical to the LocalStay GPT editor (platform-ready prompt, verbatim)
  const fd = new FormData();
  fd.append("model", OPENAI_IMAGE_MODEL);
  fd.append("image", new Blob([uploadBuf], { type: uploadType }), fname);
  fd.append("prompt", PLATFORM_READY_PROMPT);
  if (size) fd.append("size", size);
  fd.append("quality", process.env.OPENAI_IMAGE_QUALITY || "high");
  fd.append("output_format", "jpeg");
  fd.append("output_compression", "95");
  fd.append("n", "1");

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 240000);
  let json;
  try {
    const r = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: "Bearer " + key },
      body: fd,
      signal: ctrl.signal,
    });
    json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("OpenAI " + r.status + ": " + JSON.stringify(json).slice(0, 300));
  } finally { clearTimeout(t); }

  const b64 = json && json.data && json.data[0] && json.data[0].b64_json;
  if (!b64) { console.error("enhanceImageOpenAI: no image in response:", JSON.stringify(json).slice(0, 300)); return null; }
  return { image: b64, mime: "image/jpeg" };
}

// Provider dispatcher: prefer gpt-image-2 (the trusted GPT editor) when configured, else Gemini.
async function enhanceImage(base64, mime) {
  if (process.env.OPENAI_API_KEY) {
    try { return await enhanceImageOpenAI(base64, mime); }
    catch (e) {
      console.error("enhanceImageOpenAI failed:", e.message);
      if (process.env.GEMINI_API_KEY) return enhanceImageGemini(base64, mime); // graceful fallback
      throw e;
    }
  }
  return enhanceImageGemini(base64, mime);
}

module.exports = { describeImage, enhanceImage, enhanceImageGemini, enhanceImageOpenAI, analyzeForEnhance, makeApiSize };
