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

const ENHANCE_PROMPT =
  "Edit this original accommodation photograph for a premium booking platform. " +
  "This is a conservative real-estate photo correction: the result MUST remain the SAME real room/exterior/property, recognisable and authentic. " +
  "Allowed only: correct orientation and straighten; correct perspective and lens distortion conservatively so vertical lines look natural; " +
  "improve exposure, brightness, contrast, shadows, highlights and white balance naturally; increase clarity and colour balance subtly. " +
  "Strictly forbidden: do NOT add, remove, move, replace, redesign or reconstruct any object, furniture, wall, window, light, plant, person, text or logo; " +
  "no generative fill, no inpainting, no fake sunlight/lamps/shadows, no cinematic sky, no HDR look, no oversaturation, no stylisation. " +
  "Preserve all real textures and natural imperfections. Return exactly one edited image, same aspect ratio as closely as possible.";

async function enhanceImage(base64, mime) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const json = await call(IMAGE_MODEL, {
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: ENHANCE_PROMPT }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
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

module.exports = { describeImage, enhanceImage };
