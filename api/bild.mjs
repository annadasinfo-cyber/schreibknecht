// Bildgenerator fuer das Studio im Schreibknecht.
// Laeuft bei Vercel, haelt den OpenRouter-Schluessel versteckt
// und laesst nur die angemeldete Schreibknecht-Nutzerin durch.

export const config = { maxDuration: 60 };

const SUPABASE = "https://nafscbugauslcajtwixl.supabase.co";
const SUPABASE_KEY = "sb_publishable_32DoPNbrEB9ne7Iw-O4Jgg_FzNaLJYw";
const OR = "https://openrouter.ai/api/v1";

async function angemeldet(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const r = await fetch(`${SUPABASE}/auth/v1/user`, { headers: { Authorization: auth, apikey: SUPABASE_KEY } });
  if (!r.ok) return null;
  return await r.json();
}

// Das fertige Bild direkt ins Ablagefach legen: ein 2K-Bild ist zu gross,
// um es als Antwort durch Vercel zu schicken
async function ablegen(auth, nutzer, datenUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(datenUrl || "");
  if (!m) return null;
  const typ = m[1], endung = /jpe?g/i.test(typ) ? "jpg" : /webp/i.test(typ) ? "webp" : "png";
  const pfad = `${nutzer.id}/ki/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${endung}`;
  const r = await fetch(`${SUPABASE}/storage/v1/object/studiobilder/${pfad}`, {
    method: "POST",
    headers: { Authorization: auth, apikey: SUPABASE_KEY, "Content-Type": typ, "x-upsert": "true" },
    body: Buffer.from(m[2], "base64"),
  });
  return r.ok ? pfad : null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") { res.status(405).json({ fehler: "nur POST" }); return; }
    const nutzer = await angemeldet(req);
    if (!nutzer) { res.status(401).json({ fehler: "nicht angemeldet" }); return; }
    const schluessel = process.env.OPENROUTER_API_KEY;
    if (!schluessel) { res.status(500).json({ fehler: "Der OpenRouter-Schluessel fehlt in Vercel (OPENROUTER_API_KEY)." }); return; }
    const kopf = {
      Authorization: `Bearer ${schluessel}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://schreibknecht.vercel.app",
      "X-Title": "Schreibknecht Studio",
    };
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    if (body.aktion === "guthaben") {
      const r = await fetch(`${OR}/credits`, { headers: kopf });
      const j = await r.json();
      if (!r.ok) { res.status(r.status).json({ fehler: (j.error && j.error.message) || "Guthaben ging nicht" }); return; }
      res.status(200).json({ gesamt: j.data.total_credits, verbraucht: j.data.total_usage });
      return;
    }

    if (body.aktion === "modelle") {
      const r = await fetch(`${OR}/models?output_modalities=image`, { headers: kopf });
      const j = await r.json();
      const liste = (j.data || []).map((m) => ({
        id: m.id, name: m.name,
        preis: m.pricing && (m.pricing.image || m.pricing.request || m.pricing.completion),
      }));
      res.status(200).json({ modelle: liste });
      return;
    }

    // ---- der Knecht im Pult: Sprachmodelle ----
    if (body.aktion === "textmodelle") {
      const r = await fetch(`${OR}/models`, { headers: kopf });
      const j = await r.json();
      const liste = (j.data || [])
        .filter((m) => {
          const a = m.architecture || {};
          const aus = a.output_modalities || ["text"];
          return aus.includes("text") && !aus.includes("image");
        })
        .map((m) => {
          const p = m.pricing || {};
          const frei = /:free$/.test(m.id) || (Number(p.prompt) === 0 && Number(p.completion) === 0);
          return { id: m.id, name: m.name, frei, ctx: m.context_length || null };
        })
        .sort((a, b) => (a.frei === b.frei ? a.name.localeCompare(b.name) : a.frei ? -1 : 1));
      res.status(200).json({ modelle: liste });
      return;
    }

    if (body.aktion === "chat") {
      const nachrichten = (Array.isArray(body.nachrichten) ? body.nachrichten : [])
        .slice(-42).map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 3200000) }));
      const r = await fetch(`${OR}/chat/completions`, {
        method: "POST", headers: kopf,
        body: JSON.stringify({ model: body.modell, messages: nachrichten, usage: { include: true } }),
      });
      let j = null; try { j = await r.json(); } catch (e) { j = {}; }
      if (!r.ok || (j.error && !j.choices)) {
        const e = j.error || {};
        const m = e.metadata || {};
        const genauer = (m.raw || m.provider_name) ? " (" + String(m.provider_name || "") + ": " + String(m.raw || "").slice(0, 300) + ")" : "";
        res.status(r.ok ? 502 : r.status).json({ fehler: (e.message || "Der Knecht schweigt gerade") + genauer + " [Modell: " + body.modell + "]" });
        return;
      }
      const antwort = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      res.status(200).json({ antwort: String(antwort || ""), kosten: (j.usage && j.usage.cost) || null });
      return;
    }

    if (body.aktion === "bild") {
      // erst das Ausgangsbild (wird bearbeitet), dann die Referenzbilder (nur Stil/Aussehen)
      const bildTeile = [];
      if (body.vorlage) bildTeile.push({ type: "image_url", image_url: { url: body.vorlage } });
      (Array.isArray(body.referenzen) ? body.referenzen.slice(0, 3) : [])
        .forEach((u) => bildTeile.push({ type: "image_url", image_url: { url: u } }));
      const text = String(body.prompt || "").slice(0, 8000);
      const anfrage = {
        model: body.modell,
        messages: [{
          role: "user",
          content: bildTeile.length ? [{ type: "text", text }].concat(bildTeile) : text,
        }],
        modalities: ["image", "text"],
        image_config: { aspect_ratio: body.format || "16:9", image_size: "2K" },
        usage: { include: true },
      };
      // Nicht jedes Modell kennt Groesse und Format. Klappt es nicht,
      // erst ohne Groesse versuchen, dann ganz ohne Bildeinstellungen.
      const senden = async () => {
        const r = await fetch(`${OR}/chat/completions`, { method: "POST", headers: kopf, body: JSON.stringify(anfrage) });
        let j = null; try { j = await r.json(); } catch (e) { j = {}; }
        return { r, j };
      };
      let { r, j } = await senden();
      if (!r.ok || (j.error && !j.choices)) {
        delete anfrage.image_config.image_size;
        ({ r, j } = await senden());
      }
      if (!r.ok || (j.error && !j.choices)) {
        delete anfrage.image_config;
        ({ r, j } = await senden());
      }
      if (!r.ok || (j.error && !j.choices)) {
        const e = j.error || {};
        const m = e.metadata || {};
        const genauer = (m.raw || m.provider_name) ? " (" + String(m.provider_name || "") + ": " + String(m.raw || "").slice(0, 300) + ")" : "";
        res.status(r.ok ? 502 : r.status).json({ fehler: (e.message || "Das Bild ging nicht") + genauer + " [Modell: " + body.modell + "]" });
        return;
      }
      const nachricht = j.choices && j.choices[0] && j.choices[0].message;
      const bilder = (nachricht && nachricht.images) || [];
      const erstes = bilder[0] && ((bilder[0].image_url && bilder[0].image_url.url) || (bilder[0].imageUrl && bilder[0].imageUrl.url));
      if (!erstes) {
        res.status(502).json({ fehler: "Das Modell hat kein Bild geschickt." + (nachricht && nachricht.content ? " Es schrieb: " + String(nachricht.content).slice(0, 300) : "") });
        return;
      }
      const kosten = (j.usage && j.usage.cost) || null;
      const pfad = await ablegen(req.headers.authorization, nutzer, erstes);
      if (pfad) { res.status(200).json({ pfad, kosten }); return; }
      if (erstes.length < 4000000) { res.status(200).json({ bild: erstes, kosten }); return; }
      res.status(500).json({ fehler: "Das Bild ist fertig, liess sich aber nicht ablegen." });
      return;
    }

    res.status(400).json({ fehler: "unbekannte Aktion" });
  } catch (e) {
    res.status(500).json({ fehler: String((e && e.message) || e) });
  }
}
