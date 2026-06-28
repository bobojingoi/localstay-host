// Photo AI helpers.
//  - describeImage: alt-text + short description (Gemini text model)
//  - analyzePhoto: per-photo vision analysis -> concrete correction brief (OpenAI or Gemini)
//  - enhanceImage: analyses the photo, then applies a STRONG, decisive correction
//      (straighten verticals, brighten, boost colour) while keeping content authentic.
//      Uses OpenAI gpt-image-2 when OPENAI_API_KEY is set (high fidelity + aspect-ratio
//      preserving size); otherwise Gemini (gemini-2.5-flash-image).
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

/* ---- Strong, decisive enhancement. Always analyse the photo first (per-image),
   then apply assertive geometry/light/colour corrections — while keeping the scene
   100% authentic (never add/remove/replace real content). ---- */

const STRONG_PROMPT =
  "Transform this accommodation photograph into a striking, professionally-shot real-estate image for a premium booking website. " +
  "Apply STRONG, decisive corrections so it looks clearly and noticeably better than the original — bright, crisp, vivid and inviting — while remaining the SAME real place. " +
  "GEOMETRY — be decisive: straighten the image and firmly correct any tilt and any leaning or converging verticals so that walls, door and window frames and furniture edges are truly vertical and the horizon perfectly level; fix lens / perspective (keystone) distortion; crop minimally to hide rotation borders. Never leave it crooked, tilted or leaning. " +
  "BRIGHTNESS — be decisive: make the space clearly bright and airy; substantially raise the overall exposure, strongly lift shadows to reveal detail in dark areas, recover blown highlights and even out harsh light. Leave no dim, dark or muddy areas. " +
  "COLOUR — be decisive: set a clean, accurate white balance (remove any yellow/green/blue cast) and add noticeable saturation and vibrance so colours look rich and appealing — blue skies, green grass, warm wood, crisp white linens — vivid and lively but still believable, not neon. " +
  "FINISH: add clarity, punchy-but-natural contrast and a crisp, polished, magazine-quality look; remove haze and reduce noise. " +
  "ABSOLUTE LIMITS (never break): it must stay the SAME real room/exterior/property, fully recognisable. Do NOT add, remove, move, replace, duplicate, redesign or reconstruct any object, furniture, wall, window, door, fixture, light, plant, view, person, sign, text or logo; no generative fill, inpainting or object removal; no fake sky, sunlight, lamps, reflections or shadows. Keep all real textures, materials and the real layout. Same content, dramatically better editing. " +
  "Return exactly one edited image, same framing and aspect ratio as the original.";

const ANALYZE_PROMPT =
  "You are inspecting ONE accommodation/real-estate photo before it is STRONGLY auto-enhanced for a booking website. " +
  "Report ONLY the technical corrections needed — do NOT describe the room or its contents. Look carefully and be decisive. " +
  "Respond as compact JSON with keys: " +
  '"tilt" (is the image tilted / horizon not level? which way and roughly how many degrees, else "level"), ' +
  '"verticals" (are walls / door / window frames leaning or converging? do they need perspective/keystone correction? else "ok"), ' +
  '"exposure" (is it dark / underexposed, or are highlights blown? which areas are too dark, and how much brighter is needed?), ' +
  '"whiteBalance" (colour cast — warm/yellow, green, blue? else "neutral"), ' +
  '"saturation" (are colours dull/flat and need more vibrance, or fine?), ' +
  '"other" (noise, haze, low contrast... else "none"), ' +
  '"brief" (2-3 imperative sentences telling the retoucher exactly and decisively what to fix on THIS photo: how to straighten it, how much to brighten, which colours to boost — to make it perfectly level, bright and appealing). ' +
  "Be specific.";

function composeBrief(o) {
  const skip = v => !v || /^(level|drept|straight|none|ok|neutral|no\b|n\/a|fine|good)/i.test(String(v).trim());
  const parts = [];
  if (!skip(o.tilt)) parts.push("Tilt: " + o.tilt);
  if (!skip(o.verticals)) parts.push("Verticals: " + o.verticals);
  if (!skip(o.perspective)) parts.push("Perspective: " + o.perspective);
  if (!skip(o.exposure)) parts.push("Exposure: " + o.exposure);
  if (!skip(o.whiteBalance)) parts.push("White balance: " + o.whiteBalance);
  if (!skip(o.saturation)) parts.push("Saturation: " + o.saturation);
  if (!skip(o.other)) parts.push("Other: " + o.other);
  let brief = (o.brief || "").trim();
  if (parts.length) brief += (brief ? " " : "") + parts.join("; ") + ".";
  return brief.slice(0, 800);
}

// Vision analysis via Gemini
async function analyzeGemini(base64, mime) {
  if (!process.env.GEMINI_API_KEY) return "";
  try {
    const json = await call(TEXT_MODEL, {
      contents: [{ parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: ANALYZE_PROMPT }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 450, responseMimeType: "application/json" },
    });
    let txt = partsOf(json).map(p => p.text || "").join("").trim();
    txt = txt.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    const mt = txt.match(/\{[\s\S]*\}/);
    return composeBrief(JSON.parse(mt ? mt[0] : txt));
  } catch (e) { console.error("analyzeGemini failed:", e.message); return ""; }
}

// Vision analysis via OpenAI (so analysis works even without a Gemini key)
async function analyzeOpenAI(base64, mime) {
  const key = process.env.OPENAI_API_KEY; if (!key) return "";
  const model = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
  const dataUrl = "data:" + (mime || "image/jpeg") + ";base64," + base64;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: [{ type: "text", text: ANALYZE_PROMPT }, { type: "image_url", image_url: { url: dataUrl } }] }],
        response_format: { type: "json_object" }, max_tokens: 450, temperature: 0.2,
      }),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("OpenAI vision " + r.status + ": " + JSON.stringify(j).slice(0, 200));
    const txt = (((j.choices || [])[0] || {}).message || {}).content || "";
    const mt = String(txt).match(/\{[\s\S]*\}/);
    return composeBrief(JSON.parse(mt ? mt[0] : txt));
  } catch (e) { console.error("analyzeOpenAI failed:", e.message); return ""; }
  finally { clearTimeout(t); }
}

// Pick the available vision provider for analysis (OpenAI preferred, Gemini fallback).
async function analyzePhoto(base64, mime) {
  if (process.env.OPENAI_API_KEY) { const b = await analyzeOpenAI(base64, mime); if (b) return b; }
  if (process.env.GEMINI_API_KEY) return analyzeGemini(base64, mime);
  return "";
}
// backward-compatible alias
const analyzeForEnhance = analyzePhoto;

async function enhanceImageGemini(base64, mime) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const brief = await analyzePhoto(base64, mime).catch(() => "");
  const prompt = STRONG_PROMPT + (brief ? (" Issues found in THIS exact photo — fix them decisively: " + brief) : "");
  const json = await call(IMAGE_MODEL, {
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: prompt }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"], temperature: 0.4 },
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

async function enhanceImageOpenAI(base64, mime) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY missing");
  const sharp = require("sharp");
  const inputBuf = Buffer.from(base64, "base64");
  // read dimensions for the aspect-preserving output size
  const meta = await sharp(inputBuf).metadata().catch(() => ({}));
  const size = makeApiSize(meta.width, meta.height);
  // send the image as-is (jpeg/png/webp supported by the API); re-encode only exotic formats
  let uploadBuf = inputBuf, uploadType = (mime || "image/jpeg"), fname = "photo.jpg";
  if (!/^image\/(jpeg|png|webp)$/i.test(uploadType)) { uploadBuf = await sharp(inputBuf).jpeg({ quality: 95 }).toBuffer(); uploadType = "image/jpeg"; }
  else fname = "photo." + (uploadType.split("/")[1] === "jpeg" ? "jpg" : uploadType.split("/")[1]);

  // analyse this exact photo, then apply a strong, tailored correction
  const brief = await analyzePhoto(base64, mime).catch(() => "");
  const prompt = STRONG_PROMPT + (brief ? (" Issues found in THIS exact photo — fix them decisively: " + brief) : "");

  const fd = new FormData();
  fd.append("model", OPENAI_IMAGE_MODEL);
  fd.append("image", new Blob([uploadBuf], { type: uploadType }), fname);
  fd.append("prompt", prompt);
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

module.exports = { describeImage, enhanceImage, enhanceImageGemini, enhanceImageOpenAI, analyzePhoto, analyzeForEnhance, analyzeOpenAI, analyzeGemini, makeApiSize };
