// roots.js — Roots Leads matching engine.
//
// Pure, dependency-free module (no DB, no network). Three jobs:
//   1) enrichUnit(unit)   -> derives the unit-side profile from a property JSON
//                            (same shape as master_unitate.json).
//   2) profileLead(answers) -> derives the client-side profile from Google Form answers.
//   3) matchLeadToUnits(lead, units) -> ranks enriched units for a lead.
//
// Design rules (see chat history):
//   - Taxonomy is 1:1 with catalog_facilitati.json. Signals are matched by EXACT
//     normalized string (never substring — "Bar" would otherwise catch "Minibar").
//   - norm() folds diacritics + lowercases, so ţ/ț, ş/ș, Și/și all collapse.
//   - Soft layer = profile_scores (cosine). Hard layer = region/capacity/price/constraints.
//   - Missing unit data is treated as NEUTRAL (no penalty), never as a hard fail.

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------
function norm(s) {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks (diacritics)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
function normSet(arr) {
  const s = new Set();
  for (const x of arr) s.add(norm(x));
  return s;
}

// ---------------------------------------------------------------------------
// UNIT-SIDE persona lexicon — exact catalog strings, grouped by persona.
// Every string below was verified to exist in catalog_facilitati.json.
// ---------------------------------------------------------------------------
const UNIT_SIGNALS = {
  familie: normSet([
    "Teren de joacă pentru copii", "Club pentru copii", "Babysitting",
    "Camere pentru familii", "Piscină pentru copii", "Piscină acoperită pentru copii",
    "Porți de siguranță pentru copiii mici", "Servicii pentru copii",
    "Capace de siguranță pentru prize", "Cărucioare",
    "Echipament de joacă pentru exterior", "Zonă de joacă înăuntru",
    "Jocuri și puzzle-uri", "Cărți, DVD-uri, muzică pentru copii",
  ]),
  cuplu: normSet([
    "Jacuzzi", "Jacuzzi cu funcție de masaj cu apă", "Cadă cu hidromasaj", "Cadă spa",
    "Ciubar", "Masaj de cuplu", "Masaj pentru tot corpul", "Lounge Spa",
    "Facilități spa", "Pachete Spa", "Spa",
  ]),
  grup: normSet([
    "Grătar", "Karaoke", "Bar", "Biliard", "Tenis de masă",
    "Divertisment de seară", "Snack bar", "Șemineu în aer liber",
  ]),
  aventura: normSet([
    "Drumeţii", "Tururi cu bicicleta", "Tururi de mers pe jos", "Călărie",
    "Caiac", "Pescuit", "Ciclism", "Scufundări",
    "Facilităţi de sporturi nautice la proprietate",
  ]),
  schi: normSet([
    "Acces direct la pârtiile de schi", "Depozit schiuri", "Şcoală de schi",
    "Închiriere echipament de schi la proprietate", "Vânzare permise de schi", "Schi",
  ]),
  wellness: normSet([
    "Saună", "Fitness", "Sală de fitness", "Centru de fitness", "Sesiuni de yoga",
    "Sesiuni de fitness", "Antrenor personal", "Zonă de relaxare", "Wellness",
    "Spa și centru de wellness", "Baie în aer liber", "Vestiare fitness", "Pachete Spa",
  ]),
  business: normSet([
    "Birou", "Business centre", "Fax", "Săli de conferinţă şi petreceri",
  ]),
  rustic: normSet([
    "Rustic", "Preparate traditionale", "Langa padure", "Fara vecini", "A-frame",
  ]),
};

// ENVIRONMENT signals (mostly from top-level benefits[] + location.zones).
const ENV_SIGNALS = {
  munte_padure: normSet(["Langa padure", "Vedere la munte"]),
  mare_plaja: normSet(["Acces direct la plajă", "Vedere la mare", "Plajă exclusivă"]),
  lac_rau: normSet(["Langa rau", "Vedere la lac"]),
  rural_izolat: normSet(["Fara vecini", "Rustic"]),
};

// CONSTRAINT signals (unit capabilities). pets/accessible/non_smoking.
const CONSTRAINT_SIGNALS = {
  pets: normSet(["Castroane pentru animale de companie", "Coş pentru animale de companie"]),
  accessible: normSet([
    "Amenajări pentru persoane cu mobilitate redusă",
    "Amenajări pentru persoanele cu mobilitate redusă",
    "Facilităţi pentru persoane cu mobilitate redusă",
    "Toaletă adaptată pentru persoane cu mobilitate redusă",
  ]),
  non_smoking: normSet([
    "Camere pentru nefumători", "Camere destinate nefumătorilor",
    "Fumatul interzis în toate spaţiile publice şi private",
  ]),
};

const PERSONAS = Object.keys(UNIT_SIGNALS);

// ---------------------------------------------------------------------------
// Helpers to pull the flat facility-name pool out of a property JSON.
// ---------------------------------------------------------------------------
function collectFacilityNames(unit) {
  const out = [];
  const g = (unit && unit.general) || {};
  const push = (v) => { if (v != null && v !== "") out.push(String(v)); };

  // top-level benefits
  for (const b of asArray(unit && unit.benefits)) push(b);
  for (const b of asArray(g.benefits)) push(b);

  // mostAppreciatedFacilities [{name, premiumFacility}]
  for (const f of asArray(g.mostAppreciatedFacilities)) push(f && (f.name || f));

  // allFacilities.* -> arrays of {name} or strings
  const all = g.allFacilities || {};
  for (const k of Object.keys(all)) {
    for (const f of asArray(all[k])) push(f && (f.name || f));
  }
  // activities.* -> arrays
  const act = (g.activities) || {};
  for (const k of Object.keys(act)) {
    for (const f of asArray(act[k])) push(f && (f.name || f));
  }
  // services.* -> arrays
  const srv = (g.services) || {};
  for (const k of Object.keys(srv)) {
    for (const f of asArray(srv[k])) push(f && (f.name || f));
  }
  return out;
}
function asArray(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }

function hasFastWifi(names) {
  // business signal: any "WiFi ... N Mbps" with N >= 50
  for (const n of names) {
    const m = /(\d{2,4})\s*mbps/i.exec(n);
    if (m && Number(m[1]) >= 50) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// enrichUnit
// ---------------------------------------------------------------------------
function enrichUnit(unit) {
  const g = (unit && unit.general) || {};
  const bi = g.basicInfo || {};
  const names = collectFacilityNames(unit);
  const normNames = new Set(names.map(norm));

  // ---- profile_scores: fraction of a persona's signals that are present ----
  const profile_scores = {};
  for (const p of PERSONAS) {
    const sig = UNIT_SIGNALS[p];
    let hit = 0;
    for (const s of sig) if (normNames.has(s)) hit++;
    if (p === "business" && hasFastWifi(names)) hit++;
    profile_scores[p] = sig.size ? +Math.min(1, hit / sig.size).toFixed(3) : 0;
  }
  const dominant_profiles = PERSONAS
    .filter((p) => profile_scores[p] >= 0.15)
    .sort((a, b) => profile_scores[b] - profile_scores[a])
    .slice(0, 3);
  const tourist_segments = dominant_profiles.slice();

  // ---- environment (benefits/zones + facility hints) ----
  const environment = [];
  for (const [env, sig] of Object.entries(ENV_SIGNALS)) {
    for (const s of sig) if (normNames.has(s)) { environment.push(env); break; }
  }
  // zones can add oras / munte via category / slopes
  for (const z of asArray(g.location && g.location.zones)) {
    const cat = norm(z && z.category);
    if (/oras|urban|city/.test(cat) && !environment.includes("oras")) environment.push("oras");
    if (asArray(z && z.slopes).length && !environment.includes("munte_padure")) environment.push("munte_padure");
  }
  if (asArray(g.location && g.location.nearbyBeaches).some((b) => b && b.name) && !environment.includes("mare_plaja")) {
    environment.push("mare_plaja");
  }

  // ---- quality_score 0..100 ----
  const rs = unit && unit.reviewSummary ? unit.reviewSummary : {};
  const stars = num(bi.starRating);
  const premiumCount = asArray(g.mostAppreciatedFacilities).filter((f) => f && f.premiumFacility).length;
  const rating = num(rs.generalRating); // usually 0..10
  let q = 0, wsum = 0;
  if (stars != null) { q += (stars / 5) * 40; wsum += 40; }
  if (rating != null) { q += (rating / 10) * 40; wsum += 40; }
  // premium facilities: up to 20 pts, saturates at ~8 premium facilities
  q += Math.min(premiumCount / 8, 1) * 20; wsum += 20;
  const quality_score = wsum ? Math.round((q / wsum) * 100) : null;

  // ---- capacity ----
  const capacity = {
    persons: num(bi.unitCapacity),
    rooms: num(bi.roomsNumber),
    entire_unit: bi.entireUnitRental === true || norm(bi.entireUnitRental) === "true",
  };

  // ---- region ----
  const region = {
    county: str(bi.county),
    city: str(bi.city),
    locality: str(bi.locality),
    lat: num(bi.latitude),
    lng: num(bi.longitude),
  };

  // ---- price_band (lei/night, representative) ----
  const price = representativePrice(unit);
  const price_band = price.band;

  // ---- constraints (capabilities) ----
  const constraints = {};
  for (const [c, sig] of Object.entries(CONSTRAINT_SIGNALS)) {
    constraints[c] = [...sig].some((s) => normNames.has(s));
  }
  // policies can override pets/smoking if present
  const pol = g.policies || {};
  const petPol = norm(pol.petsPolicy);
  if (petPol) constraints.pets = /permis|allowed|acceptat|da\b|yes/.test(petPol) && !/nu sunt|not allowed|interzis/.test(petPol);

  return {
    profile_scores, dominant_profiles, tourist_segments,
    environment, quality_score, capacity, region,
    price: { nightly_lei: price.nightly_lei, band: price_band, currency: price.currency },
    constraints,
  };
}

function representativePrice(unit) {
  const prices = [];
  let currency = null;
  for (const room of asArray(unit && unit.rooms)) {
    for (const per of asArray(room && room.periods)) {
      const w = num(per && per.adult_week_price);
      const we = num(per && per.adult_weekend_price);
      if (w != null) prices.push(w);
      if (we != null) prices.push(we);
      if (!currency && per && per.currency) currency = String(per.currency);
    }
  }
  if (!prices.length) return { nightly_lei: null, band: null, currency };
  prices.sort((a, b) => a - b);
  let nightly = prices[Math.floor(prices.length / 2)]; // median
  // normalize EUR -> lei (~5) so bands (which are in lei) compare fairly
  if (currency && /eur|€/i.test(currency)) nightly = Math.round(nightly * 5);
  return { nightly_lei: nightly, band: leiBand(nightly), currency };
}

// Budget bands aligned to the Google Form options (lei / night, whole group).
const BAND_ORDER = ["<1000", "1000-1500", "1500-2000", "2000-3000", "3000-4000", ">4000"];
function leiBand(v) {
  if (v == null) return null;
  if (v < 1000) return "<1000";
  if (v < 1500) return "1000-1500";
  if (v < 2000) return "1500-2000";
  if (v < 3000) return "2000-3000";
  if (v < 4000) return "3000-4000";
  return ">4000";
}
function bandIndex(b) { return BAND_ORDER.indexOf(b); }

// ===========================================================================
// FORM-SIDE: map Google Form answers -> lead profile.
// ===========================================================================

// Map a raw Google question title -> canonical key (matched by normalized substring).
const QUESTION_MAP = [
  ["nume si prenume", "name"], ["nume", "name"],
  ["telefon", "phone"], ["whatsapp", "phone"],
  ["orasul din care", "origin_city"],
  ["ocazie ai venit la roots", "occasion"], ["pentru ce ocazie", "occasion"],
  ["cu cine calatoresti", "companions"],
  ["tip de cazare preferi", "unit_type"],
  ["cum inchiriezi", "rental_mode"],
  ["facilitati conteaza", "facilities"],
  ["pentru ce perioade cauti", "period"],
  ["cand cauti cazare", "lead_time"],
  ["bugetul obisnuit", "budget"], ["care este bugetul", "budget"],
  ["te convinge sa rezervi", "booking_drivers"],
  ["unde cauti de obicei", "source"],
  ["destinatii din romania", "destination"],
  ["tip de oferta", "offer_type"],
  ["de acord sa primesti", "consent"],
  ["e-mail", "email"], ["email", "email"],
];
function mapRawAnswers(raw) {
  // raw: { "<question title>": "<answer or [answers]>" }  -> { canonicalKey: value }
  const out = {};
  for (const [q, v] of Object.entries(raw || {})) {
    const nq = norm(q);
    for (const [needle, key] of QUESTION_MAP) {
      if (nq.includes(needle)) { out[key] = v; break; }
    }
  }
  return out;
}

// Convenience: turn an answer into a normalized array of option strings.
function opts(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[;,]\s*/);
  return arr.map(norm).filter(Boolean);
}
function includesAny(list, needles) {
  return needles.some((n) => list.some((x) => x.includes(norm(n))));
}

function profileLead(answers) {
  // answers may be raw (question titles) or already-canonical. Detect & map.
  const canonicalKeys = ["occasion","companions","unit_type","facilities","period","budget","destination","booking_drivers","rental_mode"];
  const a = canonicalKeys.some((k) => k in (answers || {})) ? answers : mapRawAnswers(answers);

  const scores = Object.fromEntries(PERSONAS.map((p) => [p, 0]));
  const add = (p, w) => { if (p in scores) scores[p] += w; };
  const environment_pref = new Set();
  const constraints_req = {};
  const ranking_weights = { profile: 1, quality: 0, price: 0, region: 0, entire: 0 };
  const season = new Set();

  // occasion (single)
  const occ = opts(a.occasion);
  if (includesAny(occ, ["prietenii"])) add("grup", 2);
  if (includesAny(occ, ["familie"])) add("familie", 2);
  if (includesAny(occ, ["aniversare", "petrecere"])) { add("grup", 1.5); add("cuplu", 0.5); }
  if (includesAny(occ, ["team building", "corporate"])) { add("business", 2); add("grup", 1); }
  if (includesAny(occ, ["sarbatori", "revelion", "craciun"])) { add("grup", 1); season.add("iarna"); }

  // companions (multi) — also a capacity hint
  const comp = opts(a.companions);
  if (includesAny(comp, ["familia"])) add("familie", 2);
  if (includesAny(comp, ["prietenii"])) add("grup", 2);
  if (includesAny(comp, ["cuplu"])) add("cuplu", 2);
  if (includesAny(comp, ["colegii", "echipa"])) add("business", 1.5);
  if (includesAny(comp, ["grup mixt"])) { add("familie", 1); add("grup", 1); }
  const capacity_hint = (includesAny(comp, ["grup mixt", "prietenii", "colegii"]) ? "large"
    : includesAny(comp, ["familia"]) ? "medium"
    : includesAny(comp, ["cuplu"]) ? "small" : null);

  // unit_type (multi)
  const ut = opts(a.unit_type);
  if (includesAny(ut, ["a-frame", "a frame"])) { add("cuplu", 1); add("rustic", 1); }
  if (includesAny(ut, ["glamping"])) { add("aventura", 1.5); add("rustic", 1); }
  if (includesAny(ut, ["cabana"])) { add("rustic", 1.5); environment_pref.add("munte_padure"); }
  if (includesAny(ut, ["apartament"])) environment_pref.add("oras");
  if (includesAny(ut, ["premium", "boutique"])) ranking_weights.quality += 1;
  if (includesAny(ut, ["piscina", "spa", "wellness"])) { add("wellness", 2); add("cuplu", 1); }
  if (includesAny(ut, ["grupuri mari"])) add("grup", 2);
  if (includesAny(ut, ["vila privata"])) ranking_weights.entire += 1;

  // rental_mode (single)
  const rm = opts(a.rental_mode);
  if (includesAny(rm, ["integral"])) ranking_weights.entire += 1;

  // facilities (multi)
  const fac = opts(a.facilities);
  if (includesAny(fac, ["ciubar"])) { add("cuplu", 1); add("wellness", 1); }
  if (includesAny(fac, ["sauna"])) add("wellness", 1.5);
  if (includesAny(fac, ["piscina"])) { add("wellness", 1); add("familie", 0.5); }
  if (includesAny(fac, ["gratar"])) add("grup", 1);
  if (includesAny(fac, ["firepit", "living mare", "spatiu comun"])) add("grup", 1);
  if (includesAny(fac, ["loc de joaca"])) add("familie", 1.5);
  if (includesAny(fac, ["teren", "activitati"])) add("aventura", 1.5);
  if (includesAny(fac, ["view", "natura"])) environment_pref.add("munte_padure");
  if (includesAny(fac, ["aproape de oras"])) environment_pref.add("oras");
  if (includesAny(fac, ["pet friendly"])) constraints_req.pets = true;

  // period (single) -> season + which price to weigh
  const per = opts(a.period);
  if (includesAny(per, ["iarna", "craciun", "revelion"])) { season.add("iarna"); add("schi", 1); environment_pref.add("munte_padure"); }
  if (includesAny(per, ["vara"])) { season.add("vara"); environment_pref.add("mare_plaja"); }
  if (includesAny(per, ["vacante scolare"])) add("familie", 1);

  // budget (single)
  const budgetBand = budgetToBand(opts(a.budget));

  // destination (single) -> region + env
  const dest = firstOpt(a.destination);
  const region_pref = destToRegion(dest);
  for (const e of destToEnv(dest)) environment_pref.add(e);

  // booking_drivers (multi) -> ranking weights
  const bd = opts(a.booking_drivers);
  if (includesAny(bd, ["pret bun"])) ranking_weights.price += 1.5;
  if (includesAny(bd, ["facilitati premium"])) ranking_weights.quality += 1.5;
  if (includesAny(bd, ["recenzii bune"])) ranking_weights.quality += 1;
  if (includesAny(bd, ["locatie buna"])) ranking_weights.region += 1;
  if (includesAny(bd, ["intimitate"])) ranking_weights.entire += 1.5;

  // normalize profile_scores to 0..1
  const max = Math.max(1, ...Object.values(scores));
  const profile_scores = {};
  for (const p of PERSONAS) profile_scores[p] = +(scores[p] / max).toFixed(3);

  const client_type_primary = PERSONAS.reduce((best, p) =>
    profile_scores[p] > (profile_scores[best] || 0) ? p : best, PERSONAS[0]);

  return {
    profile_scores, client_type_primary,
    environment_pref: [...environment_pref],
    price_band: budgetBand,
    region_pref,
    capacity_hint,
    season: [...season],
    constraints_req,
    ranking_weights,
  };
}

function firstOpt(v) { const o = opts(v); return o[0] || null; }
function budgetToBand(list) {
  const s = list.join(" ");
  if (/sub 1\.?000|<\s*1000/.test(s)) return "<1000";
  if (/1\.?000\s*[-–]\s*1\.?500/.test(s)) return "1000-1500";
  if (/1\.?500\s*[-–]\s*2\.?000/.test(s)) return "1500-2000";
  if (/2\.?000\s*[-–]\s*3\.?000/.test(s)) return "2000-3000";
  if (/3\.?000\s*[-–]\s*4\.?000/.test(s)) return "3000-4000";
  if (/peste 4\.?000|>\s*4000/.test(s)) return ">4000";
  return null;
}
function destToRegion(d) {
  if (!d) return null;
  if (/brasov|poiana|bran|moieciu|fundata|rasnov|zarnesti/.test(d)) return { county: "Brasov" };
  if (/prahova/.test(d)) return { county: "Prahova" };
  if (/sibiu/.test(d)) return { county: "Sibiu" };
  if (/maramures/.test(d)) return { county: "Maramures" };
  if (/bucovina|suceava/.test(d)) return { county: "Suceava" };
  if (/litoral/.test(d)) return { region: "litoral" };
  if (/delta/.test(d)) return { region: "delta" };
  return { raw: d };
}
function destToEnv(d) {
  if (!d) return [];
  if (/litoral/.test(d)) return ["mare_plaja"];
  if (/delta/.test(d)) return ["lac_rau"];
  if (/brasov|poiana|bran|moieciu|fundata|rasnov|zarnesti|prahova|maramures|bucovina/.test(d)) return ["munte_padure"];
  return [];
}

// ===========================================================================
// MATCHING
// ===========================================================================
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const p of PERSONAS) {
    const x = a[p] || 0, y = b[p] || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// units: [{ slug, enrichment }]  ->  ranked [{ slug, score, reasons, penalties }]
function matchLeadToUnits(lead, units, opts2) {
  const cfg = Object.assign({ minScore: 0, limit: 10 }, opts2 || {});
  const rw = lead.ranking_weights || {};
  const out = [];

  for (const u of units) {
    const e = u.enrichment || u;
    const reasons = [], penalties = [];
    let hardFail = false;

    // --- soft: profile cosine ---
    const cos = cosine(lead.profile_scores || {}, e.profile_scores || {});
    let score = cos; // base 0..1

    // shared dominant personas -> reason
    const shared = PERSONAS.filter((p) => (lead.profile_scores[p] || 0) >= 0.4 && (e.profile_scores[p] || 0) >= 0.15);
    if (shared.length) reasons.push("persona: " + shared.join(", "));

    // --- environment (soft-hard) ---
    if ((lead.environment_pref || []).length && (e.environment || []).length) {
      const hit = lead.environment_pref.filter((x) => e.environment.includes(x));
      if (hit.length) { score += 0.15 * hit.length; reasons.push("mediu: " + hit.join(", ")); }
      else { score -= 0.1; penalties.push("mediu diferit"); }
    }

    // --- region (hard-ish: penalize on known mismatch) ---
    if (lead.region_pref && lead.region_pref.county && e.region && e.region.county) {
      if (norm(lead.region_pref.county) === norm(e.region.county)) { score += 0.2; reasons.push("regiune: " + e.region.county); }
      else { score -= 0.4; penalties.push("alt judet (" + e.region.county + ")"); }
    }

    // --- price (hard: drop if unit clearly over budget) ---
    if (lead.price_band && e.price && e.price.band) {
      const diff = bandIndex(e.price.band) - bandIndex(lead.price_band);
      if (diff <= 0) { score += 0.1 * (rw.price || 0.5); reasons.push("in buget"); }
      else if (diff === 1) { score -= 0.2; penalties.push("usor peste buget"); }
      else { hardFail = true; penalties.push("peste buget"); }
    }

    // --- capacity (hard-ish) ---
    if (lead.capacity_hint && e.capacity && e.capacity.persons != null) {
      const need = lead.capacity_hint === "large" ? 6 : lead.capacity_hint === "medium" ? 3 : 2;
      if (e.capacity.persons >= need) reasons.push("incape grupul");
      else { score -= 0.3; penalties.push("capacitate mica (" + e.capacity.persons + ")"); }
    }
    if ((rw.entire || 0) > 0 && e.capacity && e.capacity.entire_unit) { score += 0.1; reasons.push("unitate integrala"); }

    // --- constraints (hard) ---
    const req = lead.constraints_req || {};
    if (req.pets && e.constraints && e.constraints.pets === false) { hardFail = true; penalties.push("nu acceptă animale"); }
    if (req.accessible && e.constraints && e.constraints.accessible === false) { hardFail = true; penalties.push("fără accesibilitate"); }

    // --- quality tilt (driven by lead ranking weights) ---
    if ((rw.quality || 0) > 0 && e.quality_score != null) {
      score += (rw.quality) * 0.1 * (e.quality_score / 100);
      if (e.quality_score >= 70) reasons.push("calitate ridicată (" + e.quality_score + ")");
    }

    if (hardFail) continue;
    score = Math.max(0, +score.toFixed(4));
    if (score >= cfg.minScore) out.push({ slug: u.slug, score, reasons, penalties });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, cfg.limit);
}

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------
function num(v) { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function str(v) { return v == null || v === "" ? null : String(v); }

module.exports = {
  norm,
  enrichUnit,
  profileLead,
  mapRawAnswers,
  matchLeadToUnits,
  PERSONAS,
  BAND_ORDER,
};
