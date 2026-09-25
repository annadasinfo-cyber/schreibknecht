// Bildgenerator fuer das Studio im Schreibknecht.
// Laeuft bei Vercel, haelt den OpenRouter-Schluessel versteckt
// und laesst nur die angemeldete Schreibknecht-Nutzerin durch.

export const config = { maxDuration: 60 };

const SUPABASE = "https://nafscbugauslcajtwixl.supabase.co";
const SUPABASE_KEY = "sb_publishable_32DoPNbrEB9ne7Iw-O4Jgg_FzNaLJYw";
const OR = "https://openrouter.ai/api/v1";

async function angemeldet(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return false;
  const r = await fetch(`${SUPABASE}/auth/v1/user`, { headers: { Authorization: auth, apikey: SUPABASE_KEY } });
  return r.ok;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") { res.status(405).json({ fehler: "nur POST" }); return; }
    if (!(await angemeldet(req))) { res.status(401).json({ fehler: "nicht angemeldet" }); return; }
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

    if (body.aktion === "bild") {
      const anfrage = {
        model: body.modell,
        messages: [{ role: "user", content: String(body.prompt || "").slice(0, 8000) }],
        modalities: ["image", "text"],
        image_config: { aspect_ratio: body.format || "16:9", image_size: "2K" },
        usage: { include: true },
      };
      let r = await fetch(`${OR}/chat/completions`, { method: "POST", headers: kopf, body: JSON.stringify(anfrage) });
      let j = await r.json();
      if (!r.ok && /image_size|image_config/i.test(JSON.stringify(j))) {
        delete anfrage.image_config.image_size;
        r = await fetch(`${OR}/chat/completions`, { method: "POST", headers: kopf, body: JSON.stringify(anfrage) });
        j = await r.json();
      }
      if (!r.ok) { res.status(r.status).json({ fehler: (j.error && j.error.message) || "Das Bild ging nicht" }); return; }
      const nachricht = j.choices && j.choices[0] && j.choices[0].message;
      const bilder = (nachricht && nachricht.images) || [];
      const erstes = bilder[0] && ((bilder[0].image_url && bilder[0].image_url.url) || (bilder[0].imageUrl && bilder[0].imageUrl.url));
      if (!erstes) {
        res.status(502).json({ fehler: "Das Modell hat kein Bild geschickt." + (nachricht && nachricht.content ? " Es schrieb: " + String(nachricht.content).slice(0, 300) : "") });
        return;
      }
      res.status(200).json({ bild: erstes, kosten: (j.usage && j.usage.cost) || null });
      return;
    }

    res.status(400).json({ fehler: "unbekannte Aktion" });
  } catch (e) {
    res.status(500).json({ fehler: String((e && e.message) || e) });
  }
}
