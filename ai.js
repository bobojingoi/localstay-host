// Generate Romanian alt-text + a short marketing description from an image, using Gemini.
// Non-blocking: if the key is missing or the call fails, returns empty strings.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

async function describeImage(base64, mime) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { alt: "", description: "" };

  const prompt =
    "Ești asistent pentru un site de cazări turistice din România. " +
    "Privește imaginea și răspunde STRICT cu un singur JSON valid, fără text în plus și fără blocuri de cod, în limba română: " +
    '{"alt":"<descriere scurtă și factuală a imaginii, max 120 caractere, pentru atributul alt și SEO>",' +
    '"description":"<1-2 propoziții de prezentare, atrăgătoare dar oneste, fără a inventa detalii care nu se văd>"}';

  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent?key=" + key;
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 300 },
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) return { alt: "", description: "" };
    const j = await r.json();
    let txt = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || "").join("").trim();
    txt = txt.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    const o = JSON.parse(txt);
    return { alt: (o.alt || "").slice(0, 140), description: (o.description || "").slice(0, 400) };
  } catch (e) {
    return { alt: "", description: "" };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { describeImage };
