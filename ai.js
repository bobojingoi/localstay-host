// Photo AI helpers — OpenAI only (Gemini removed).
//  - describeImage: alt-text + short description (OpenAI vision model)
//  - analyzePhoto: per-photo vision analysis -> concrete correction brief (OpenAI)
//  - enhanceImage: analyses the photo, then applies a STRONG, decisive correction
//      (straighten verticals, brighten, boost colour) while keeping content authentic,
//      using OpenAI gpt-image-2 (high fidelity + aspect-ratio preserving size).
//      Requires OPENAI_API_KEY; no Gemini fallback.

async function describeImage(base64, mime) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { alt: "", description: "" };
  const model = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
  const dataUrl = "data:" + (mime || "image/jpeg") + ";base64," + base64;
  const prompt =
    "Ești asistent pentru un site de cazări turistice din România. Privește imaginea și răspunde DOAR cu JSON, în limba română: " +
    'cheia "alt" = descriere scurtă și factuală a imaginii (max 120 caractere, pentru atributul alt / SEO); ' +
    'cheia "description" = 1-2 propoziții de prezentare, atrăgătoare dar oneste, fără a inventa detalii care nu se văd.';
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl } }] }],
        response_format: { type: "json_object" }, max_tokens: 300, temperature: 0.4,
      }),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("OpenAI describe " + r.status + ": " + JSON.stringify(j).slice(0, 200));
    const txt = (((j.choices || [])[0] || {}).message || {}).content || "";
    const mt = String(txt).match(/\{[\s\S]*\}/);
    const o = JSON.parse(mt ? mt[0] : txt);
    return { alt: (o.alt || "").slice(0, 140), description: (o.description || "").slice(0, 400) };
  } catch (e) {
    console.error("describeImage failed:", e.message);
    return { alt: "", description: "" };
  } finally { clearTimeout(t); }
}

/* ---- Strong, decisive enhancement. Always analyse the photo first (per-image),
   then apply assertive geometry/light/colour corrections — while keeping the scene
   100% authentic (never add/remove/replace real content). ---- */

const STRONG_PROMPT =
  "Transform this accommodation photograph into a striking, professionally-shot real-estate image for a premium booking website. " +
  "Apply STRONG, decisive corrections so it looks clearly and noticeably better than the original — straight, bright, crisp, vivid and inviting — while remaining the SAME real place. " +
  "PERSPECTIVE / VERTICALS — be decisive: correct lens and perspective (keystone) distortion so that every vertical line in the scene becomes truly vertical, plumb and mutually parallel. Take a strong straight vertical edge in the image as reference — a door frame, window frame, wall corner, the edge of a wardrobe or cabinet, a radiator side — and align the whole image so all such edges run perfectly vertical (the top of each directly above its bottom, no leaning, no converging or diverging); straighten walls that lean in or out. Also remove any tilt/rotation so horizontal references (floor and ceiling lines, window sills, furniture tops) are level and the horizon is straight. Crop only minimally to hide the borders introduced by straightening. Never leave it crooked, tilted, leaning or with converging walls. " +
  "BRIGHTNESS — be decisive: make the space clearly bright and airy; substantially raise the overall exposure, strongly lift shadows to reveal detail in dark areas, recover blown highlights and even out harsh light. Leave no dim, dark or muddy areas. " +
  "COLOUR — be decisive: set a clean, accurate white balance (remove any yellow/green/blue cast) and add noticeable saturation and vibrance so colours look rich and appealing — blue skies, green grass, warm wood, crisp white linens — vivid and lively but still believable, not neon. " +
  "FINISH: add clarity, punchy-but-natural contrast and a crisp, polished, magazine-quality look; remove haze and reduce noise. " +
  "ABSOLUTE LIMITS (never break): it must stay the SAME real room/exterior/property, fully recognisable. Do NOT add, remove, move, replace, duplicate, redesign or reconstruct any object, furniture, wall, window, door, fixture, light, plant, view, person, sign, text or logo; no generative fill, inpainting or object removal; no fake sky, sunlight, lamps, reflections or shadows. Keep all real textures, materials and the real layout. Same content, dramatically better editing. " +
  "Return exactly one edited image, same framing and aspect ratio as the original.";

const ANALYZE_PROMPT =
  "You are inspecting ONE accommodation/real-estate photo before it is STRONGLY auto-enhanced for a booking website (perspective, brightness and colour). " +
  "Report ONLY the technical corrections needed — do NOT describe the room or its contents. Look carefully and be decisive. " +
  "Respond as compact JSON with keys: " +
  '"tilt" (is the image rotated / horizon not level? which way and roughly how many degrees, else "level"), ' +
  '"verticals" (are walls / door / window frames / furniture edges leaning or converging? which direction and how strong is the keystone distortion? else "ok"), ' +
  '"reference" (name 1-2 clear straight vertical edges in THIS photo to use as the plumb reference, e.g. "left door frame", "right wardrobe edge"), ' +
  '"exposure" (is it dark / underexposed, or are highlights blown? which areas are too dark, and how much brighter is needed?), ' +
  '"whiteBalance" (colour cast — warm/yellow, green, blue? else "neutral"), ' +
  '"saturation" (are colours dull/flat and need more vibrance, or fine?), ' +
  '"other" (noise, haze, low contrast... else "none"), ' +
  '"brief" (2-3 imperative sentences telling the retoucher exactly and decisively what to fix on THIS photo: which verticals to make plumb and how to level it, how much to brighten, which colours to boost — to make it perfectly straight, level, bright and appealing). ' +
  "Be specific.";

function composeBrief(o) {
  const skip = v => !v || /^(level|drept|straight|none|ok|neutral|no\b|n\/a|fine|good)/i.test(String(v).trim());
  const parts = [];
  if (!skip(o.tilt)) parts.push("Tilt: " + o.tilt);
  if (!skip(o.verticals)) parts.push("Verticals: " + o.verticals);
  if (!skip(o.perspective)) parts.push("Perspective: " + o.perspective);
  if (o.reference && !skip(o.reference)) parts.push("Use as vertical reference: " + o.reference);
  if (!skip(o.exposure)) parts.push("Exposure: " + o.exposure);
  if (!skip(o.whiteBalance)) parts.push("White balance: " + o.whiteBalance);
  if (!skip(o.saturation)) parts.push("Saturation: " + o.saturation);
  if (!skip(o.other)) parts.push("Other: " + o.other);
  let brief = (o.brief || "").trim();
  if (parts.length) brief += (brief ? " " : "") + parts.join("; ") + ".";
  return brief.slice(0, 800);
}

// Vision analysis via OpenAI only.
async function analyzePhoto(base64, mime) {
  if (process.env.OPENAI_API_KEY) { const b = await analyzeOpenAI(base64, mime); if (b) return b; }
  return "";
}
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

// backward-compatible alias
const analyzeForEnhance = analyzePhoto;

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

// Provider: OpenAI gpt-image-2 only (Gemini removed).
async function enhanceImage(base64, mime) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing — optimizarea AI necesită OpenAI");
  return enhanceImageOpenAI(base64, mime);
}

/* =====================================================================
   Facebook group posts — generate a base post + N slightly different
   variants (one per group) so they are not flagged as duplicate spam.
   ===================================================================== */
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";

async function generateFbPosts(opts) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY missing — generarea textului necesită OpenAI");
  const o = opts || {};
  const count = Math.max(1, Math.min(30, +o.count || 1));
  const groupNames = Array.isArray(o.groups) ? o.groups.slice(0, count) : [];
  const sys =
    "Ești copywriter de marketing pentru cazări turistice din România. Scrii postări pentru grupuri de Facebook, în limba română — atractive, calde, credibile și conforme cu regulile grupurilor (fără clickbait agresiv, fără MAJUSCULE excesive, fără promisiuni exagerate). " +
    "Generezi un text de bază și mai multe VARIANTE ușor diferite ale aceleiași postări: deschidere diferită, alte emoji, altă ordine a frazelor, sinonime — ca să NU pară duplicate când sunt postate în grupuri diferite. Miezul ofertei rămâne identic în toate.";
  const brief = [
    "Proprietate: " + (o.propertyName || "cazare"),
    o.location ? ("Locație: " + o.location) : "",
    "Ocazie / tip postare: " + (o.occasion || "ofertă"),
    o.details ? ("Ce vrea hotelierul să transmită (preț, reducere, perioadă, mesaj): " + o.details) : "",
    "Ton: " + (o.tone || "prietenos"),
    (o.emoji === false) ? "Fără emoji." : "Folosește câteva emoji potrivite, cu măsură.",
    (o.includeLink && o.url) ? ("Include acest link la final: " + o.url) : "Nu include niciun link.",
    "Număr de variante necesare: " + count + (groupNames.length ? (". Nume grupuri (doar pentru context, NU le scrie în postare): " + groupNames.join("; ")) : "")
  ].filter(Boolean).join("\n");
  const user = brief +
    '\n\nRăspunde DOAR cu JSON valid, fără alt text: {"base":"<postarea de bază>","variants":["<varianta 1>","<varianta 2>", ...]} cu exact ' + count + " variante în array.";
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({
        model: OPENAI_TEXT_MODEL,
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        response_format: { type: "json_object" }, temperature: 0.9, max_tokens: 1800,
      }),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("OpenAI " + r.status + ": " + JSON.stringify(j).slice(0, 200));
    const txt = (((j.choices || [])[0] || {}).message || {}).content || "";
    const mt = String(txt).match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(mt ? mt[0] : txt);
    let variants = Array.isArray(parsed.variants) ? parsed.variants.filter(v => typeof v === "string" && v.trim()) : [];
    const base = (parsed.base && String(parsed.base).trim()) || variants[0] || "";
    if (!variants.length && base) variants = [base];
    while (variants.length < count) variants.push(variants[variants.length % variants.length] || base); // pad if the model returned fewer
    return { base, variants: variants.slice(0, count) };
  } finally { clearTimeout(t); }
}

module.exports = { describeImage, enhanceImage, enhanceImageOpenAI, analyzePhoto, analyzeForEnhance, analyzeOpenAI, makeApiSize, generateFbPosts };
