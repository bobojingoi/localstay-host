// Gemini helpers, all using the same GEMINI_API_KEY.
//  - describeImage: alt-text + short description (text model)
//  - enhanceImage: conservative photo correction that returns an edited image (Nano Banana)
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

async function enhanceImage(base64, mime) {
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
  console.error("enhanceImage: no image in response:", JSON.stringify(json).slice(0, 300));
  return null;
}

module.exports = { describeImage, enhanceImage, analyzeForEnhance };
