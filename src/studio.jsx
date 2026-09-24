import React, { useState, useEffect, useRef, useCallback } from "react";

// ============================================================
// DAS STUDIO — hinter der tuer auf dem deckblatt.
// Filme (zoomloop) und aufnahme mit teleprompter.
// Filme und teleprompter-texte liegen in der datenbank,
// die bilder im ablagefach "studiobilder".
// Aufnahmen bleiben auf dem geraet (die waeren zu gross).
// ============================================================

const EIMER = "studiobilder";

export default function Studio({ api, zugang, URL_DB, KEY_DB, zurueck }) {
  const [ansicht, setAnsicht] = useState("liste");   // liste | film | aufnahme
  const [filme, setFilme] = useState([]);
  const [filmId, setFilmId] = useState(null);
  const [laedt, setLaedt] = useState(true);
  const [fehler, setFehler] = useState("");

  // vor dem ablagefach kurz sicherstellen, dass der zugang frisch ist
  const frisch = useCallback(async () => {
    const s = zugang();
    if (s && s.expires_at && s.expires_at - 120 < Date.now() / 1000) {
      try { await api("GET", "/rest/v1/studio_filme?select=id&limit=1"); } catch (e) {}
    }
    return zugang();
  }, [api, zugang]);

  const kopf = useCallback((s, typ) => {
    const h = { apikey: KEY_DB, Authorization: "Bearer " + s.access_token };
    if (typ) h["Content-Type"] = typ;
    return h;
  }, [KEY_DB]);

  const filmeHolen = useCallback(async () => {
    setLaedt(true); setFehler("");
    try {
      const l = await api("GET", "/rest/v1/studio_filme?select=id,name,created_at,daten&order=created_at.desc");
      setFilme(l || []);
    } catch (e) {
      const t = String(e.message || e);
      setFehler(/studio_filme|relation|does not exist|schema cache/i.test(t)
        ? "die studio-tabellen fehlen noch — bitte einmal studio.sql in supabase einspielen."
        : t);
    }
    setLaedt(false);
  }, [api]);

  useEffect(() => { filmeHolen(); }, [filmeHolen]);

  const neuerFilm = async () => {
    const name = prompt("wie soll der film heißen?", "neuer film");
    if (name === null) return;
    try {
      const r = await api("POST", "/rest/v1/studio_filme",
        { name: name.trim() || "neuer film", daten: {} }, { Prefer: "return=representation" });
      if (r && r[0]) { setFilme((l) => [r[0], ...l]); setFilmId(r[0].id); setAnsicht("film"); }
    } catch (e) { setFehler(String(e.message || e)); }
  };

  const umbenennen = async (f) => {
    const name = prompt("neuer name:", f.name);
    if (name === null || !name.trim()) return;
    setFilme((l) => l.map((x) => x.id === f.id ? { ...x, name: name.trim() } : x));
    try { await api("PATCH", `/rest/v1/studio_filme?id=eq.${f.id}`, { name: name.trim() }); }
    catch (e) { setFehler(String(e.message || e)); }
  };

  const filmWeg = async (f) => {
    const n = ((f.daten && f.daten.items) || []).length;
    if (!confirm(`„${f.name}" mit ${n} ${n === 1 ? "bild" : "bildern"} wirklich wegwerfen?`)) return;
    setFilme((l) => l.filter((x) => x.id !== f.id));
    try {
      const pfade = ((f.daten && f.daten.items) || []).map((it) => it.pfad).filter(Boolean);
      if (pfade.length) {
        const s = await frisch();
        await fetch(`${URL_DB}/storage/v1/object/${EIMER}`, {
          method: "DELETE", headers: kopf(s, "application/json"), body: JSON.stringify({ prefixes: pfade }),
        });
      }
      await api("DELETE", `/rest/v1/studio_filme?id=eq.${f.id}`);
    } catch (e) { setFehler(String(e.message || e)); }
  };

  // ---- helfer fuer die zoomloop ----
  const film = filme.find((f) => f.id === filmId) || null;
  const filmHilfe = useCallback((id) => ({
    speichern: async (daten) => {
      setFilme((l) => l.map((x) => x.id === id ? { ...x, daten } : x));
      await api("PATCH", `/rest/v1/studio_filme?id=eq.${id}`, { daten, updated_at: new Date().toISOString() });
    },
    hochladen: async (blob, bildId) => {
      const s = await frisch();
      const pfad = `${s.user.id}/${id}/${bildId}.jpg`;
      const r = await fetch(`${URL_DB}/storage/v1/object/${EIMER}/${pfad}`, {
        method: "POST", headers: { ...kopf(s, "image/jpeg"), "x-upsert": "true" }, body: blob,
      });
      if (!r.ok) throw new Error((await r.text()).slice(0, 160) || "hochladen ging nicht");
      return pfad;
    },
    holen: async (pfad) => {
      const s = await frisch();
      const r = await fetch(`${URL_DB}/storage/v1/object/authenticated/${EIMER}/${pfad}`, { headers: kopf(s) });
      if (!r.ok) throw new Error("bild fehlt");
      return await r.blob();
    },
    entfernen: async (pfad) => {
      try {
        const s = await frisch();
        await fetch(`${URL_DB}/storage/v1/object/${EIMER}/${pfad}`, { method: "DELETE", headers: kopf(s) });
      } catch (e) {}
    },
  }), [api, frisch, kopf, URL_DB]);

  // ---- helfer fuer den teleprompter ----
  const textHilfe = useCallback(() => ({
    holen: async () => (await api("GET", "/rest/v1/studio_texte?select=id,name,text&order=created_at.asc")) || [],
    neu: async (name, text) => {
      const r = await api("POST", "/rest/v1/studio_texte", { name, text }, { Prefer: "return=representation" });
      return r && r[0];
    },
    speichern: async (id, felder) =>
      api("PATCH", `/rest/v1/studio_texte?id=eq.${id}`, { ...felder, updated_at: new Date().toISOString() }),
    weg: async (id) => api("DELETE", `/rest/v1/studio_texte?id=eq.${id}`),
  }), [api]);

  return (
    <div className="studio">
      <StudioStil />
      <div className="st-kopf">
        <button className="st-knopf" onClick={ansicht === "film" ? () => setAnsicht("liste") : zurueck}>
          {ansicht === "film" ? "← filme" : "← schreibknecht"}
        </button>
        <span className="st-titel">{ansicht === "film" && film ? film.name : "studio"}</span>
        <span className="st-luft" />
        <button className={"st-knopf" + (ansicht !== "aufnahme" ? " an" : "")}
          onClick={() => setAnsicht(filmId && ansicht === "aufnahme" ? "film" : "liste")}>🎞 filme</button>
        <button className={"st-knopf" + (ansicht === "aufnahme" ? " an" : "")}
          onClick={() => setAnsicht("aufnahme")}>🎙 aufnahme</button>
      </div>

      <div className="st-rumpf">
        {ansicht === "liste" && (
          <div className="st-liste">
            {fehler && <p className="st-fehler" onClick={() => setFehler("")}>{fehler}</p>}
            {laedt ? <p className="st-leer">wird geholt …</p> : (
              <div className="st-kacheln">
                <button className="st-kachel neu" onClick={neuerFilm} title="neuer film">+</button>
                {filme.map((f) => {
                  const n = ((f.daten && f.daten.items) || []).length;
                  return (
                    <div key={f.id} className="st-kachelhuelle">
                      <button className="st-kachel" onClick={() => { setFilmId(f.id); setAnsicht("film"); }}>
                        <span className="st-kname">{f.name}</span>
                        <span className="st-kzeile">
                          <span>{n} {n === 1 ? "bild" : "bilder"}</span>
                          <span>{f.created_at ? new Date(f.created_at).toLocaleDateString("de-DE",
                            { day: "2-digit", month: "2-digit", year: "numeric" }) : ""}</span>
                        </span>
                      </button>
                      <button className="st-klein links" title="umbenennen" onClick={() => umbenennen(f)}>✎</button>
                      <button className="st-klein" title="wegwerfen" onClick={() => filmWeg(f)}>✕</button>
                    </div>
                  );
                })}
              </div>
            )}
            {!laedt && !fehler && !filme.length &&
              <p className="st-leer">noch kein film. leg mit dem + einen an.</p>}
          </div>
        )}

        {ansicht === "film" && film && (
          <ZoomloopRaum key={film.id} film={film} hilfe={filmHilfe(film.id)} />
        )}

        {ansicht === "aufnahme" && <AufnahmeRaum hilfe={textHilfe()} />}
      </div>
    </div>
  );
}

// ============================================================
// ZOOMLOOP
// ============================================================
function ZoomloopRaum({ film, hilfe }) {
  const ref = useRef(null);
  useEffect(() => {
    const aufraeumen = zoomloopStarten(ref.current, film, hilfe);
    return aufraeumen;
  }, []); // eslint-disable-line
  return <div className="zl" ref={ref} dangerouslySetInnerHTML={{ __html: ZL_HTML }} />;
}

const ZL_HTML = `
<div class="zl-app">
  <div class="zl-list">
    <button id="zl_add" class="zl-add">+ Bilder laden</button>
    <input id="zl_file" type="file" accept="image/*" multiple hidden>
    <div id="zl_thumbs" class="zl-thumbs"></div>
  </div>
  <div class="zl-stage">
    <canvas id="zl_cv" width="1280" height="720"></canvas>
    <div id="zl_hint" class="zl-hint">Bilder laden oder hier reinziehen</div>
  </div>
  <div class="zl-side">
    <h2>Ausschnitt</h2>
    <div id="zl_cpair" class="zl-pair">&ndash;</div>
    <canvas id="zl_cprev" class="zl-cprev" width="246" height="60"></canvas>
    <label>Verschieben <b id="zl_v_pan"></b></label><input type="range" id="zl_pan" min="-100" max="100" step="1" value="0">
    <h2>Einsetzen</h2>
    <div id="zl_pair" class="zl-pair">&ndash;</div>
    <label>Gr&ouml;&szlig;e <b id="zl_v_s"></b></label><input type="range" id="zl_s" min="8" max="70" step="0.5">
    <label>Drehung <b id="zl_v_r"></b></label><input type="range" id="zl_r" min="-180" max="180" step="1">
    <label>Weicher Rand <b id="zl_v_feather"></b></label><input type="range" id="zl_feather" min="0" max="30" step="1">
    <label>Form</label><select id="zl_shape"><option value="rect">Rechteck</option><option value="oval">Oval</option></select>
    <h2>Angleichen</h2>
    <label>Helligkeit <b id="zl_v_br"></b></label><input type="range" id="zl_br" min="40" max="160" step="1">
    <label>Kontrast <b id="zl_v_co"></b></label><input type="range" id="zl_co" min="40" max="160" step="1">
    <label>S&auml;ttigung <b id="zl_v_sa"></b></label><input type="range" id="zl_sa" min="0" max="200" step="1">
    <label>Farbton <b id="zl_v_hu"></b></label><input type="range" id="zl_hu" min="-180" max="180" step="1">
    <div class="zl-row" style="margin-top:10px"><button id="zl_reset">zur&uuml;cksetzen</button>
      <label class="zl-row" style="margin:0 0 0 auto"><input type="checkbox" id="zl_frame" checked> Rahmen</label></div>
    <h2>Film</h2>
    <label>Format</label>
    <select id="zl_fmt"><option value="1920x1080">1920 &times; 1080 &ndash; quer</option><option value="3840x2160">3840 &times; 2160 &ndash; quer 4K</option><option value="1080x1920">1080 &times; 1920 &ndash; hoch (Shorts/Reels)</option><option value="2160x3840">2160 &times; 3840 &ndash; hoch 4K</option><option value="1080x1080">1080 &times; 1080 &ndash; quadratisch</option></select>
    <label>Sekunden pro Bild <b id="zl_v_sec"></b></label><input type="range" id="zl_sec" min="1.5" max="20" step="0.5">
    <label>Atempause bei jedem Bild <b id="zl_v_ease"></b></label><input type="range" id="zl_ease" min="0" max="100" step="5">
    <label>N&auml;chstes Bild einblenden <b id="zl_v_fade"></b></label><input type="range" id="zl_fade" min="0" max="100" step="5">
    <label>Bilder pro Sekunde</label><select id="zl_fps"><option>60</option><option>30</option><option>25</option></select>
    <label class="zl-row" style="margin-top:10px"><input type="checkbox" id="zl_loop" checked> Endlos (letztes Bild zoomt zur&uuml;ck in Bild 1)</label>
    <button class="zl-big" id="zl_exp">MP4 exportieren</button>
    <div id="zl_prog" class="zl-prog"><i></i></div>
    <div id="zl_msg" class="zl-msg"></div>
  </div>
  <div class="zl-bar">
    <button id="zl_play">&#9654;</button>
    <input type="range" id="zl_scrub" min="0" max="1" step="0.001" value="0">
    <span id="zl_tt" class="zl-tt"></span>
  </div>
</div>`;

function zoomloopStarten(root, film, hilfe) {
  var $ = function (id) { return root.querySelector("#zl_" + id); };
  var DEF = { cx: 0, cy: 0, s: 0.08, r: 0, feather: 18, shape: "oval", br: 100, co: 100, sa: 100, hu: 0, pan: 0 };
  var daten = film.daten || {};
  var G = Object.assign({ W: 1920, H: 1080, sec: 20, ease: 0.8, fade: 0.5, fps: 60, loop: true }, daten.G || {});
  var items = [];
  var sel = 0, u = 0, playing = false, exporting = false, cancelExport = false, dead = false;
  var cv = $("cv"), ctx = cv.getContext("2d", { alpha: false });
  var smallCache = new Map(), bigCache = new Map(), urls = [];

  function msg(t) { $("msg").textContent = t || ""; }

  /* ---------- Speichern: 0,8 s nach der letzten Aenderung ---------- */
  var saveT = 0, saveOffen = false;
  function paket() {
    return { G: Object.assign({}, G), items: items.map(function (it) { return { id: it.id, name: it.name, pfad: it.pfad, p: it.p }; }) };
  }
  function jetztSpeichern() {
    if (!saveOffen) return;
    saveOffen = false;
    hilfe.speichern(paket()).catch(function (e) { msg("Speichern ging nicht: " + (e.message || e)); });
  }
  function save() { saveOffen = true; clearTimeout(saveT); saveT = setTimeout(jetztSpeichern, 800); }

  /* ---------- Mathe: Aehnlichkeitsabbildung als komplexe Zahl ---------- */
  function mul(a, b) { return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]; }
  function div(a, b) { var d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; }
  function compose(A, B) { var t = mul(A.m, B.t); return { m: mul(A.m, B.m), t: [A.t[0] + t[0], A.t[1] + t[1]] }; }
  function inverse(A) { var t = div(A.t, A.m); return { m: div([1, 0], A.m), t: [-t[0], -t[1]] }; }
  var ID = { m: [1, 0], t: [0, 0] };
  function place(p, W, H) { var a = p.r * Math.PI / 180; return { m: [p.s * Math.cos(a), p.s * Math.sin(a)], t: [p.cx * W, p.cy * H] }; }
  function power(p, W, H, f) {
    var T = place(p, W, H), a = p.r * Math.PI / 180 * f, sf = Math.pow(p.s, f);
    var mf = [sf * Math.cos(a), sf * Math.sin(a)];
    var fix = div(T.t, [1 - T.m[0], -T.m[1]]);
    return { m: mf, t: mul(fix, [1 - mf[0], -mf[1]]) };
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function clampH(v) { return Math.max(-0.5, Math.min(0.5, v)); }

  /* ---------- Ausschnitt ---------- */
  function cropRect(el, ar, pan) {
    var sw = el.naturalWidth, sh = el.naturalHeight, cw = sw, ch = sw / ar;
    if (ch > sh) { ch = sh; cw = sh * ar; }
    var o = pan || 0;
    return [(sw - cw) / 2 * (1 + o), (sh - ch) / 2 * (1 + o), cw, ch];
  }
  function slackOf(it) {
    var R = cropRect(it.el, G.W / G.H, 0);
    return { x: it.el.naturalWidth - R[2], y: it.el.naturalHeight - R[3] };
  }
  function keepOnMotif(host, kid, arA, panA, arB, panB) {
    var A = cropRect(host.el, arA, panA), B = cropRect(host.el, arB, panB), p = kid.p;
    var x = A[0] + (0.5 + p.cx) * A[2], y = A[1] + (0.5 + p.cy) * A[3];
    p.cx = clampH((x - B[0]) / B[2] - 0.5);
    p.cy = clampH((y - B[1]) / B[3] - 0.5);
  }

  /* ---------- Farben von Hand (Safari) ---------- */
  var HAS_FILTER = "filter" in CanvasRenderingContext2D.prototype;
  function adjustPixels(x, w, h, p) {
    var b = p.br / 100, c = p.co / 100, s = p.sa / 100, a = p.hu * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
    var S = [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
    var R = [0.213 + co * 0.787 - si * 0.213, 0.715 - co * 0.715 - si * 0.715, 0.072 - co * 0.072 + si * 0.928,
      0.213 - co * 0.213 + si * 0.143, 0.715 + co * 0.285 + si * 0.140, 0.072 - co * 0.072 - si * 0.283,
      0.213 - co * 0.213 - si * 0.787, 0.715 - co * 0.715 + si * 0.715, 0.072 + co * 0.928 + si * 0.072];
    var M = [], i, j, k;
    for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) { var v = 0; for (k = 0; k < 3; k++) v += R[i * 3 + k] * S[k * 3 + j]; M.push(v); }
    var g = b * c, o = 127.5 * (1 - c), O = [o * (M[0] + M[1] + M[2]), o * (M[3] + M[4] + M[5]), o * (M[6] + M[7] + M[8])];
    var id = x.getImageData(0, 0, w, h), d = id.data;
    for (i = 0; i < d.length; i += 4) {
      var r = d[i] * g, gg = d[i + 1] * g, bb = d[i + 2] * g;
      d[i] = M[0] * r + M[1] * gg + M[2] * bb + O[0]; d[i + 1] = M[3] * r + M[4] * gg + M[5] * bb + O[1]; d[i + 2] = M[6] * r + M[7] * gg + M[8] * bb + O[2];
    }
    x.putImageData(id, 0, 0);
  }

  /* ---------- Bild vorbereiten ---------- */
  function bake(it, maxW) {
    var el = it.el, p = it.p, ar = G.W / G.H;
    var R = cropRect(el, ar, p.pan);
    var bw = Math.max(64, Math.min(maxW, Math.round(R[2]))), bh = Math.max(2, Math.round(bw / ar));
    var c = document.createElement("canvas"); c.width = bw; c.height = bh;
    var x = c.getContext("2d");
    x.imageSmoothingQuality = "high";
    var adj = p.br !== 100 || p.co !== 100 || p.sa !== 100 || p.hu !== 0;
    if (adj && HAS_FILTER) x.filter = "brightness(" + p.br + "%) contrast(" + p.co + "%) saturate(" + p.sa + "%) hue-rotate(" + p.hu + "deg)";
    x.drawImage(el, R[0], R[1], R[2], R[3], 0, 0, bw, bh);
    if (HAS_FILTER) x.filter = "none"; else if (adj) adjustPixels(x, bw, bh, p);
    var mips = [c], w = bw, h = bh;
    while (w > 256) {
      w = w >> 1; h = Math.max(1, h >> 1);
      var m = document.createElement("canvas"); m.width = w; m.height = h;
      var mx = m.getContext("2d"); mx.imageSmoothingQuality = "high";
      mx.drawImage(mips[mips.length - 1], 0, 0, w, h); mips.push(m);
    }
    return mips;
  }
  function getBake(idx, big) {
    var it = items[idx], p = it.p;
    var key = [it.id, G.W, G.H, p.br, p.co, p.sa, p.hu, p.pan || 0].join("|");
    var cache = big ? bigCache : smallCache, e = cache.get(idx);
    if (e && e.key === key) { if (big) { cache.delete(idx); cache.set(idx, e); } return e.mips; }
    e = { key: key, mips: bake(it, big ? 3840 : 1600) };
    cache.delete(idx); cache.set(idx, e);
    if (big) while (cache.size > 8) cache.delete(cache.keys().next().value);
    return e.mips;
  }
  var tmpC = document.createElement("canvas"), tmpX = tmpC.getContext("2d");
  function softAt(sc, W) { var t = Math.max(0, 1 - sc / W); return Math.pow(t, 0.35) * smooth(Math.min(1, t / 0.05)); }
  function applyMask(x, W, H, p, soft) {
    var F = p.feather / 100 * soft, st = [0, 0.25, 0.5, 0.75, 1], i, g;
    x.globalCompositeOperation = "destination-in";
    if (F > 0.002) {
      for (var dir = 0; dir < 2; dir++) {
        g = dir ? x.createLinearGradient(0, -H / 2, 0, H / 2) : x.createLinearGradient(-W / 2, 0, W / 2, 0);
        for (i = 0; i < 5; i++) g.addColorStop(F * st[i], "rgba(0,0,0," + smooth(st[i]) + ")");
        for (i = 4; i >= 0; i--) g.addColorStop(1 - F * st[i], "rgba(0,0,0," + smooth(st[i]) + ")");
        x.fillStyle = g; x.fillRect(-W / 2, -H / 2, W, H);
      }
    }
    if (p.shape === "oval" && soft > 0.002) {
      x.save(); x.scale(W / 2, H / 2);
      g = x.createRadialGradient(0, 0, Math.max(0, 1 - 2 * Math.max(F, 0.06)), 0, 0, 1);
      for (i = 0; i < 5; i++) g.addColorStop(st[i], "rgba(0,0,0," + (1 - soft * smooth(st[i])) + ")");
      x.fillStyle = g; x.fillRect(-1, -1, 2, 2); x.restore();
    }
    x.globalCompositeOperation = "source-over";
  }

  /* ---------- Zeichnen ---------- */
  function segs() { return items.length < 2 ? 0 : (G.loop ? items.length : items.length - 1); }
  function render(c, W, H, uu, big, overlay, noFade) {
    var n = items.length;
    c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = "#000"; c.fillRect(0, 0, W, H);
    if (!n) return;
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
    var k = Math.floor(uu), f = uu - k;
    if (!G.loop && k >= n - 1) { k = n - 1; f = 0; }
    k = ((k % n) + n) % n;
    function kid(i) { return (G.loop || i < n - 1) ? (i + 1) % n : -1; }
    function dad(i) { return (G.loop || i > 0) ? (i - 1 + n) % n : -1; }
    var e = f * (1 - G.ease) + smooth(f) * G.ease;
    var F = noFade ? 0 : G.fade;
    function alphaAt(depth) { if (F <= 0) return 1; var t = depth - e; return t <= 0 ? 1 : Math.max(0, Math.min(1, 1 - t / F)); }
    var draws = [], V = ID;
    if (n > 1 && kid(k) >= 0) V = inverse(power(items[kid(k)].p, W, H, e));
    draws.push([k, V, 0]);
    var up = V, i = k, d;
    for (d = 0; d < 6 && n > 1; d++) { var pa = dad(i); if (pa < 0) break; up = compose(up, inverse(place(items[i].p, W, H))); draws.unshift([pa, up, -d - 1]); i = pa; }
    var dn = V, childV = null; i = k;
    for (d = 0; d < 8 && n > 1; d++) {
      var ch = kid(i); if (ch < 0) break;
      dn = compose(dn, place(items[ch].p, W, H));
      if (d === 0) childV = dn;
      if (Math.hypot(dn.m[0], dn.m[1]) * W < 2 || alphaAt(d + 1) <= 0) break;
      draws.push([ch, dn, d + 1]); i = ch;
    }
    draws.forEach(function (D) {
      var idx = D[0], T = D[1], A = alphaAt(D[2]);
      if (A <= 0) return;
      var p = items[idx].p, mips = getBake(idx, big), sc = Math.hypot(T.m[0], T.m[1]) * W, L = 0;
      while (L + 1 < mips.length && mips[L + 1].width >= sc) L++;
      var soft = (G.loop || idx > 0) ? softAt(sc, W) : 0;
      var oval = p.shape === "oval" && soft > 0.002;
      if (p.feather / 100 * soft <= 0.002 && !oval) {
        c.globalAlpha = A;
        c.setTransform(T.m[0], T.m[1], -T.m[1], T.m[0], T.t[0] + W / 2, T.t[1] + H / 2);
        c.drawImage(mips[L], -W / 2, -H / 2, W, H);
        return;
      }
      if (tmpC.width !== W || tmpC.height !== H) { tmpC.width = W; tmpC.height = H; }
      tmpX.setTransform(1, 0, 0, 1, 0, 0); tmpX.globalCompositeOperation = "source-over"; tmpX.globalAlpha = 1;
      tmpX.clearRect(0, 0, W, H); tmpX.imageSmoothingQuality = "high";
      tmpX.setTransform(T.m[0], T.m[1], -T.m[1], T.m[0], T.t[0] + W / 2, T.t[1] + H / 2);
      tmpX.drawImage(mips[L], -W / 2, -H / 2, W, H);
      applyMask(tmpX, W, H, p, soft);
      c.globalAlpha = A; c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(tmpC, 0, 0);
    });
    c.globalAlpha = 1;
    if (overlay && childV) {
      var s = Math.hypot(childV.m[0], childV.m[1]);
      c.setTransform(childV.m[0], childV.m[1], -childV.m[1], childV.m[0], childV.t[0] + W / 2, childV.t[1] + H / 2);
      c.lineWidth = 2 / s; c.setLineDash([10 / s, 8 / s]); c.strokeStyle = "rgba(217,164,65,.9)";
      c.strokeRect(-W / 2, -H / 2, W, H); c.setLineDash([]);
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
  }
  function editing() { return !playing && !exporting && Math.abs(u - Math.round(u)) < 1e-6; }
  function draw() {
    if (dead) return;
    render(ctx, cv.width, cv.height, u, false, editing() && $("frame").checked, editing());
    var S = segs();
    $("scrub").max = Math.max(S, 0.001); $("scrub").value = u;
    $("tt").textContent = S ? (u * G.sec).toFixed(1) + " / " + (S * G.sec).toFixed(0) + " s" : "";
    $("hint").style.display = items.length ? "none" : "";
  }

  /* ---------- Ausschnitt-Vorschau ---------- */
  var PREV_MAXH = 200;
  function prevGeom(it) {
    var c = $("cprev"), sw = it.el.naturalWidth, sh = it.el.naturalHeight;
    var k = Math.min(c.width / sw, PREV_MAXH / sh), w = sw * k, h = sh * k;
    return { k: k, w: w, h: h, ox: (c.width - w) / 2 };
  }
  function drawCropPrev() {
    var c = $("cprev"), it = items[sel];
    if (!it) { c.height = 60; c.getContext("2d").clearRect(0, 0, c.width, c.height); return; }
    var g = prevGeom(it), hh = Math.round(g.h);
    if (c.height !== hh) c.height = hh;
    var x = c.getContext("2d");
    x.clearRect(0, 0, c.width, c.height);
    x.drawImage(it.el, g.ox, 0, g.w, g.h);
    x.fillStyle = "rgba(0,0,0,.62)"; x.fillRect(g.ox, 0, g.w, g.h);
    var R = cropRect(it.el, G.W / G.H, it.p.pan);
    x.drawImage(it.el, R[0], R[1], R[2], R[3], g.ox + R[0] * g.k, R[1] * g.k, R[2] * g.k, R[3] * g.k);
    x.strokeStyle = "#d9a441"; x.lineWidth = 2;
    x.strokeRect(g.ox + R[0] * g.k + 1, R[1] * g.k + 1, R[2] * g.k - 2, R[3] * g.k - 2);
  }
  function setPan(v) {
    var it = items[sel]; if (!it) return;
    v = Math.max(-1, Math.min(1, v));
    var old = it.p.pan || 0; if (Math.abs(v - old) < 1e-6) return;
    var ch = child(), ar = G.W / G.H;
    if (ch) keepOnMotif(it, ch, ar, old, ar, v);
    it.p.pan = v;
  }
  function afterPan() { stop(); u = Math.min(sel, segs()); syncPanel(); draw(); }
  $("pan").addEventListener("input", function () { setPan(this.value / 100); afterPan(); });
  $("pan").addEventListener("change", function () { thumbs(); save(); });
  var cdrag = false;
  function panFromPointer(e) {
    var it = items[sel]; if (!it) return;
    var c = $("cprev"), r = c.getBoundingClientRect(), g = prevGeom(it), sl = slackOf(it);
    var mx = (e.clientX - r.left) * c.width / r.width, my = (e.clientY - r.top) * c.height / r.height, v;
    if (sl.x >= sl.y) { if (sl.x < 1) return; v = ((mx - g.ox) / g.k - it.el.naturalWidth / 2) / (sl.x / 2); }
    else { if (sl.y < 1) return; v = (my / g.k - it.el.naturalHeight / 2) / (sl.y / 2); }
    setPan(v); afterPan();
  }
  $("cprev").addEventListener("pointerdown", function (e) {
    if (exporting || !items[sel]) return;
    cdrag = true; this.setPointerCapture(e.pointerId); panFromPointer(e);
  });
  $("cprev").addEventListener("pointermove", function (e) { if (cdrag) panFromPointer(e); });
  function endPrevDrag() { if (!cdrag) return; cdrag = false; thumbs(); save(); }
  $("cprev").addEventListener("pointerup", endPrevDrag);
  $("cprev").addEventListener("pointercancel", endPrevDrag);

  /* ---------- Seitenleiste ---------- */
  function child() { var n = items.length; if (n < 2) return null; if (!G.loop && sel >= n - 1) return null; return items[(sel + 1) % n]; }
  var PK = ["s", "r", "feather", "shape", "br", "co", "sa", "hu"];
  function syncPanel() {
    var ch = child(), n = items.length, it = items[sel];
    $("pair").innerHTML = ch ? "Bild " + (sel + 1) + " &larr; hier sitzt Bild " + (((sel + 1) % n) + 1) : (n ? "letztes Bild &ndash; nichts einzusetzen" : "&ndash;");
    if (it) {
      var sl = slackOf(it), canPan = Math.max(sl.x, sl.y) >= 1, horiz = sl.x >= sl.y;
      var pv = Math.round((it.p.pan || 0) * 100);
      $("cpair").textContent = "Bild " + (sel + 1) + (canPan ? "" : " \u2013 passt genau, nichts zu verschieben");
      $("pan").disabled = !canPan; $("pan").value = pv;
      $("v_pan").textContent = pv === 0 ? "Mitte" : horiz ? (pv < 0 ? "\u2190 " + (-pv) + " %" : pv + " % \u2192") : (pv < 0 ? "\u2191 " + (-pv) + " %" : pv + " % \u2193");
    } else {
      $("cpair").innerHTML = "&ndash;"; $("pan").disabled = true; $("pan").value = 0; $("v_pan").textContent = "";
    }
    drawCropPrev();
    PK.forEach(function (k) {
      var el = $(k); el.disabled = !ch; if (!ch) return;
      el.value = k === "s" ? ch.p.s * 100 : ch.p[k];
      var v = $("v_" + k); if (v) v.textContent = k === "s" ? Math.round(ch.p.s * 100) + " %" : (k === "r" || k === "hu") ? ch.p[k] + "\u00b0" : ch.p[k] + " %";
    });
    $("v_sec").textContent = G.sec + " s"; $("v_ease").textContent = Math.round(G.ease * 100) + " %";
    $("v_fade").textContent = G.fade ? Math.round(G.fade * 100) + " %" : "aus";
    $("sec").value = G.sec; $("ease").value = G.ease * 100; $("fade").value = G.fade * 100; $("fps").value = G.fps; $("loop").checked = G.loop; $("fmt").value = G.W + "x" + G.H;
  }
  PK.forEach(function (k) {
    $(k).addEventListener("input", function () {
      var ch = child(); if (!ch) return;
      if (k === "shape") ch.p.shape = this.value; else if (k === "s") ch.p.s = this.value / 100; else ch.p[k] = +this.value;
      stop(); u = sel; syncPanel(); draw(); save();
    });
  });
  $("reset").onclick = function () { var ch = child(); if (!ch) return; ch.p = Object.assign({}, DEF, { pan: ch.p.pan || 0 }); syncPanel(); draw(); save(); };
  $("frame").onchange = draw;
  $("sec").oninput = function () { G.sec = +this.value; syncPanel(); draw(); save(); };
  $("ease").oninput = function () { G.ease = this.value / 100; syncPanel(); save(); };
  $("fade").oninput = function () { G.fade = this.value / 100; syncPanel(); draw(); save(); };
  $("fps").onchange = function () { G.fps = +this.value; save(); };
  $("loop").onchange = function () { G.loop = this.checked; u = Math.min(u, segs()); syncPanel(); draw(); save(); };
  $("fmt").onchange = function () {
    var a = this.value.split("x"), nW = +a[0], nH = +a[1];
    reframe(G.W / G.H, nW / nH);
    G.W = nW; G.H = nH;
    fitCanvas(); smallCache.clear(); bigCache.clear(); thumbs(); syncPanel(); draw(); save();
  };
  function reframe(arA, arB) {
    if (!items.length || Math.abs(arA - arB) < 1e-6) return;
    var n = items.length;
    items.forEach(function (it, i) {
      if (!G.loop && i === 0) return;
      var host = items[(i - 1 + n) % n], pan = host.p.pan || 0;
      keepOnMotif(host, it, arA, pan, arB, pan);
    });
  }
  function fitCanvas() { var k = 1280 / Math.max(G.W, G.H); cv.width = Math.round(G.W * k); cv.height = Math.round(G.H * k); }

  /* ---------- Bilderliste ---------- */
  function thumbs() {
    if (dead) return;
    var box = $("thumbs"); box.innerHTML = "";
    items.forEach(function (it, i) {
      var d = document.createElement("div"); d.className = "zl-th" + (i === sel ? " sel" : "");
      var n = document.createElement("span"); n.className = "zl-n"; n.textContent = i + 1;
      var c = document.createElement("canvas"); c.width = 160; c.height = Math.round(160 * G.H / G.W);
      var R = cropRect(it.el, G.W / G.H, it.p.pan);
      c.getContext("2d").drawImage(it.el, R[0], R[1], R[2], R[3], 0, 0, c.width, c.height);
      var b = document.createElement("div"); b.className = "zl-bt";
      [["\u25b2", -1], ["\u2715", 0], ["\u25bc", 1]].forEach(function (o) {
        var bt = document.createElement("button"); bt.textContent = o[1] === 0 ? "\u2715" : o[0];
        bt.title = o[1] === 0 ? "Bild entfernen" : (o[1] < 0 ? "nach vorn" : "nach hinten");
        bt.onclick = function (ev) {
          ev.stopPropagation();
          if (o[1] === 0) {
            if (!confirm("Bild " + (i + 1) + " aus dem Film nehmen?")) return;
            var weg = items.splice(i, 1)[0]; if (weg && weg.pfad) hilfe.entfernen(weg.pfad);
            sel = Math.max(0, Math.min(sel, items.length - 1));
          } else { var j = i + o[1]; if (j < 0 || j >= items.length) return; var t = items[i]; items[i] = items[j]; items[j] = t; sel = j; }
          smallCache.clear(); bigCache.clear(); u = Math.min(sel, segs()); stop(); thumbs(); syncPanel(); draw(); save();
        };
        b.appendChild(bt);
      });
      d.appendChild(n); d.appendChild(c); d.appendChild(b);
      d.onclick = function () { stop(); sel = i; u = Math.min(i, segs()); thumbs(); syncPanel(); draw(); };
      box.appendChild(d);
    });
  }
  function neueId() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }
  function bildAus(url) {
    return new Promise(function (res, rej) { var el = new Image(); el.onload = function () { res(el); }; el.onerror = rej; el.src = url; });
  }
  /* als JPEG ablegen, laengste Seite hoechstens 3000 px */
  function verkleinern(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), el = new Image();
      el.onload = function () {
        var w = el.naturalWidth, h = el.naturalHeight, k = Math.min(1, 3000 / Math.max(w, h));
        var c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
        var x = c.getContext("2d"); x.fillStyle = "#000"; x.fillRect(0, 0, c.width, c.height);
        x.imageSmoothingQuality = "high"; x.drawImage(el, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? res(b) : rej(new Error("umrechnen ging nicht")); }, "image/jpeg", 0.9);
      };
      el.onerror = function () { URL.revokeObjectURL(url); rej(new Error("kann ich nicht lesen")); };
      el.src = url;
    });
  }
  var laedtHoch = false;
  async function addFiles(files) {
    if (laedtHoch) return;
    var list = Array.prototype.slice.call(files).filter(function (f) { return /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|avif)$/i.test(f.name); });
    list.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
    if (!list.length) return;
    laedtHoch = true;
    var bad = [];
    for (var i = 0; i < list.length && !dead; i++) {
      var f = list[i];
      msg("Lade hoch: " + (i + 1) + " von " + list.length + " \u2026");
      try {
        var blob = await verkleinern(f), id = neueId();
        var pfad = await hilfe.hochladen(blob, id);
        var url = URL.createObjectURL(blob); urls.push(url);
        var el = await bildAus(url);
        items.push({ id: id, name: f.name, pfad: pfad, el: el, p: Object.assign({}, DEF) });
        thumbs(); syncPanel(); draw(); save();
      } catch (e) { bad.push(f.name + " (" + (e.message || e) + ")"); }
    }
    laedtHoch = false;
    msg(bad.length ? "" : "Alles hochgeladen.");
    if (bad.length && !dead) alert("Das hat nicht geklappt (HEIC? dann bitte als JPG):\n" + bad.join("\n"));
  }
  $("add").onclick = function () { $("file").click(); };
  $("file").onchange = function () { addFiles(this.files); this.value = ""; };
  function onDragOver(e) { e.preventDefault(); }
  function onDrop(e) { e.preventDefault(); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("drop", onDrop);

  /* ---------- Ziehen = Position, Mausrad = Groesse ---------- */
  var dragging = null;
  cv.addEventListener("pointerdown", function (e) {
    if (exporting) return;
    stop(); var n0 = Math.max(1, items.length), k0 = Math.round(u); u = sel = G.loop ? k0 % n0 : Math.min(k0, n0 - 1);
    var ch = child(); thumbs(); syncPanel(); draw(); if (!ch) return;
    dragging = { x: e.clientX, y: e.clientY, cx: ch.p.cx, cy: ch.p.cy };
    cv.setPointerCapture(e.pointerId); cv.classList.add("drag");
  });
  cv.addEventListener("pointermove", function (e) {
    if (!dragging) return; var ch = child(); if (!ch) return; var r = cv.getBoundingClientRect();
    ch.p.cx = clampH(dragging.cx + (e.clientX - dragging.x) / r.width);
    ch.p.cy = clampH(dragging.cy + (e.clientY - dragging.y) / r.height);
    draw();
  });
  function dragEnde() { if (dragging) { dragging = null; cv.classList.remove("drag"); save(); } }
  cv.addEventListener("pointerup", dragEnde);
  cv.addEventListener("pointercancel", dragEnde);
  cv.addEventListener("wheel", function (e) {
    e.preventDefault(); if (!editing()) return; var ch = child(); if (!ch) return;
    ch.p.s = Math.max(0.08, Math.min(0.7, ch.p.s * Math.exp(-e.deltaY * 0.0015)));
    syncPanel(); draw(); save();
  }, { passive: false });

  /* ---------- Abspielen ---------- */
  var last = 0;
  function tick(t) {
    if (!playing || dead) return;
    var S = segs(); if (!S) { stop(); return; }
    u += (t - last) / 1000 / G.sec; last = t; if (u >= S) u -= S;
    draw(); requestAnimationFrame(tick);
  }
  function stop() { playing = false; $("play").innerHTML = "&#9654;"; }
  $("play").onclick = function () {
    if (exporting) return;
    if (playing) { stop(); draw(); return; }
    if (!segs()) return;
    playing = true; this.innerHTML = "&#10073;&#10073;"; last = performance.now(); requestAnimationFrame(tick);
  };
  $("scrub").oninput = function () { stop(); u = +this.value; draw(); };

  /* ---------- MP4 ---------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function mp4Baustein() {
    if (window.Mp4Muxer) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.js";
      s.onload = res; s.onerror = function () { rej(new Error("MP4-Baustein nicht erreichbar")); };
      document.head.appendChild(s);
    });
  }
  $("exp").onclick = async function () {
    var knopf = this;
    if (exporting) { cancelExport = true; return; }
    var S = segs(); if (!S) { msg("Mindestens zwei Bilder."); return; }
    if (!("VideoEncoder" in window)) { msg("Der Export geht in Chrome am Rechner."); return; }
    try { await mp4Baustein(); } catch (e) { msg(e.message); return; }
    var W = G.W, H = G.H, fps = G.fps, total = Math.round(S * G.sec * fps), err = null;
    var rate = W * H > 1920 * 1080 ? 45e6 : 16e6;
    var handle = null, stream = null, target;
    if (window.showSaveFilePicker) {
      try {
        handle = await window.showSaveFilePicker({ suggestedName: (film.name || "zoomloop") + ".mp4", types: [{ description: "Video", accept: { "video/mp4": [".mp4"] } }] });
        stream = await handle.createWritable();
      } catch (e) {
        if (e && e.name === "AbortError") { msg("Abgebrochen."); return; }
        handle = null; stream = null;
      }
    }
    stop(); exporting = true; cancelExport = false; knopf.textContent = "Abbrechen";
    $("prog").style.display = "block"; var bar = $("prog").firstElementChild; bar.style.width = "0";
    msg("Wird vorbereitet \u2026 (ca. " + Math.round(total / fps * rate / 8 / 1e6) + " MB, " + total + " Bilder)");
    var done = false;
    try {
      var writes = Promise.resolve();
      target = stream ? new window.Mp4Muxer.StreamTarget({
        chunked: true, chunkSize: 4 * 1024 * 1024,
        onData: function (data, position) {
          var copy = data.slice();
          writes = writes.then(function () { return stream.write({ type: "write", position: position, data: copy }); });
        }
      }) : new window.Mp4Muxer.ArrayBufferTarget();
      var muxer = new window.Mp4Muxer.Muxer({ target: target, video: { codec: "avc", width: W, height: H, frameRate: fps }, fastStart: stream ? false : "in-memory" });
      var oc = document.createElement("canvas"); oc.width = W; oc.height = H;
      var ox = oc.getContext("2d", { alpha: false });
      var enc = new VideoEncoder({ output: function (c, m) { muxer.addVideoChunk(c, m); }, error: function (e) { err = e; } });
      var cfg = { codec: (W * H > 1920 * 1080 ? "avc1.640033" : "avc1.64002A"), width: W, height: H, bitrate: rate, framerate: fps };
      var sup = await VideoEncoder.isConfigSupported(cfg);
      if (!sup.supported) throw new Error("Dieses Format kann dein Browser nicht als MP4 kodieren.");
      enc.configure(cfg);
      var t0 = performance.now();
      for (var i = 0; i < total; i++) {
        if (cancelExport || err || dead) break;
        render(ox, W, H, G.loop ? i / total * S : i / (total - 1) * S, true, false, false);
        var vf = new VideoFrame(oc, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
        enc.encode(vf, { keyFrame: i % (fps * 2) === 0 }); vf.close();
        while (enc.encodeQueueSize > 8) await sleep(4);
        if (i % 4 === 0) {
          bar.style.width = (i / total * 100) + "%";
          var left = Math.ceil((performance.now() - t0) / (i + 1) * (total - i) / 1000);
          msg("Bild " + i + " von " + total + " \u2013 noch ca. " + (left > 90 ? Math.ceil(left / 60) + " min" : left + " s"));
          await sleep(0);
        }
      }
      if (err) throw err;
      if (!cancelExport && !dead) {
        await enc.flush(); muxer.finalize();
        if (stream) { await writes; await stream.close(); stream = null; }
        else {
          var a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([target.buffer], { type: "video/mp4" }));
          a.download = (film.name || "zoomloop") + ".mp4"; document.body.appendChild(a); a.click(); a.remove();
        }
        done = true;
        msg(handle ? "Fertig: " + handle.name + " ist gespeichert." : "Fertig \u2013 liegt im Download-Ordner.");
      } else {
        try { enc.close(); } catch (e) {}
        msg("Abgebrochen.");
      }
    } catch (e) {
      msg("Fehler: " + (e.message || e));
    }
    if (stream) { try { await stream.close(); } catch (e) {} }
    bigCache.clear(); exporting = false; knopf.textContent = "MP4 exportieren"; $("prog").style.display = "none"; draw();
    if (done && !dead) alert($("msg").textContent);
  };

  /* ---------- Start: Bilder aus dem Ablagefach holen ---------- */
  function onResize() { draw(); }
  window.addEventListener("resize", onResize);
  fitCanvas(); syncPanel(); draw();
  (async function () {
    var liste = (daten.items || []).filter(function (x) { return x && x.pfad; });
    if (!liste.length) return;
    var fertig = 0, fehlt = 0, raus = new Array(liste.length);
    msg("Hole Bilder: 0 von " + liste.length + " \u2026");
    var naechster = 0;
    async function arbeiter() {
      while (naechster < liste.length && !dead) {
        var i = naechster++, x = liste[i];
        try {
          var blob = await hilfe.holen(x.pfad);
          var url = URL.createObjectURL(blob); urls.push(url);
          var el = await bildAus(url);
          raus[i] = { id: x.id, name: x.name, pfad: x.pfad, el: el, p: Object.assign({}, DEF, x.p || {}) };
        } catch (e) { fehlt++; }
        fertig++;
        if (!dead) msg("Hole Bilder: " + fertig + " von " + liste.length + " \u2026");
      }
    }
    await Promise.all([arbeiter(), arbeiter(), arbeiter(), arbeiter()]);
    if (dead) return;
    items = raus.filter(Boolean).concat(items);
    sel = 0; u = 0;
    thumbs(); syncPanel(); draw();
    msg(fehlt ? fehlt + " Bild(er) fehlten im Ablagefach." : "");
  })();

  return function aufraeumen() {
    dead = true; playing = false; cancelExport = true;
    window.removeEventListener("resize", onResize);
    clearTimeout(saveT); jetztSpeichern();
    setTimeout(function () { urls.forEach(function (x) { URL.revokeObjectURL(x); }); }, 1000);
  };
}

// ============================================================
// AUFNAHME mit TELEPROMPTER
// ============================================================
function AufnahmeRaum({ hilfe }) {
  const ref = useRef(null);
  useEffect(() => {
    const aufraeumen = aufnahmeStarten(ref.current, hilfe);
    return aufraeumen;
  }, []); // eslint-disable-line
  return <div className="au" ref={ref} dangerouslySetInnerHTML={{ __html: AU_HTML }} />;
}

const AU_HTML = `
<div class="au-app">
  <div class="au-kopf">
    <select id="au_wahl" class="au-wahl"></select>
    <button id="au_neu" title="neuer Text">+</button>
    <button id="au_umb" title="umbenennen">&#9998;</button>
    <button id="au_weg" title="Text wegwerfen">&#10005;</button>
    <span class="au-luft"></span>
    <button id="au_top" title="zum Anfang">&#8676;</button>
    <button id="au_text">Text</button>
    <button id="au_set">&#9881;</button>
  </div>
  <div id="au_setPanel" class="au-set" hidden>
    <div>
      <label>Schriftgr&ouml;&szlig;e <b id="au_v_size"></b></label><input type="range" id="au_size" min="20" max="96" step="1">
      <label>Tempo (wenn die Stimme nicht folgt) <b id="au_v_speed"></b></label><input type="range" id="au_speed" min="10" max="160" step="2">
    </div>
    <div>
      <label>Laufen</label>
      <select id="au_mode"><option value="voice">Text folgt meiner Stimme</option><option value="tempo">Gleichm&auml;&szlig;iges Tempo</option></select>
      <label class="au-chk"><input type="checkbox" id="au_mirror"> Spiegeln (f&uuml;r Glasaufsatz)</label>
      <label class="au-chk"><input type="checkbox" id="au_ns"> Rauschfilter vom Browser</label>
    </div>
  </div>
  <div id="au_stage" class="au-stage">
    <div class="au-mark"></div>
    <div id="au_scroller" class="au-scroller"><div id="au_words" class="au-words"></div></div>
    <div id="au_count" class="au-count"></div>
    <textarea id="au_ta" class="au-ta" hidden placeholder="Hier deinen Text einf&uuml;gen. Leerzeile = neuer Absatz."></textarea>
  </div>
  <div class="au-meter"><i id="au_meter"></i></div>
  <div id="au_take" class="au-take" hidden>
    <div class="au-row">
      <button data-p="raw">Roh</button>
      <button data-p="normal">Normal</button>
      <button data-p="studio">Studio &#10024;</button>
    </div>
    <audio id="au_player" controls></audio>
    <div class="au-row">
      <button id="au_save">Speichern</button>
      <button id="au_share" hidden>Teilen</button>
      <span class="au-luft"></span>
      <button id="au_discard">Verwerfen</button>
    </div>
  </div>
  <div class="au-fuss">
    <button id="au_rec" class="au-rec">&#9679; Aufnahme</button>
    <span id="au_status" class="au-status"></span>
  </div>
</div>`;

function aufnahmeStarten(root, hilfe) {
  var $ = function (id) { return root.querySelector("#au_" + id); };
  var dead = false;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function status(t) { if (!dead) $("status").textContent = t || ""; }

  /* ---------- Einstellungen (je Geraet) ---------- */
  var S = Object.assign({ size: 44, speed: 40, mode: "voice", mirror: false, ns: true, preset: "studio" },
    (function () { try { return JSON.parse(localStorage.getItem("studio:aufn")) || {}; } catch (e) { return {}; } })());
  function saveS() { try { localStorage.setItem("studio:aufn", JSON.stringify(S)); } catch (e) {} }

  /* ---------- Texte aus der Datenbank ---------- */
  var BEISPIEL = "Hier steht dein Text. Tipp oben auf \u201eText\u201c, um ihn zu bearbeiten.\n\nVor dem Start schiebst du den Text so hin, dass die Stelle, an der du anfangen willst, auf der goldenen Linie liegt.";
  var texte = [], curId = null, text = BEISPIEL;
  function wahlFuellen() {
    var w = $("wahl"); w.innerHTML = "";
    if (!texte.length) { var o = document.createElement("option"); o.textContent = "noch kein Text"; o.value = ""; w.appendChild(o); }
    texte.forEach(function (t) { var o = document.createElement("option"); o.value = t.id; o.textContent = t.name; w.appendChild(o); });
    w.value = curId || "";
  }
  function textWaehlen(id) {
    var t = texte.find(function (x) { return x.id === id; });
    curId = t ? t.id : null; text = t ? (t.text || "") : BEISPIEL;
    try { curId ? localStorage.setItem("studio:text", curId) : localStorage.removeItem("studio:text"); } catch (e) {}
    wahlFuellen(); renderWords(); $("scroller").scrollTop = 0;
  }
  (async function () {
    try {
      texte = await hilfe.holen();
      if (dead) return;
      var gemerkt = null; try { gemerkt = localStorage.getItem("studio:text"); } catch (e) {}
      textWaehlen(texte.some(function (t) { return t.id === gemerkt; }) ? gemerkt : (texte[0] ? texte[0].id : null));
    } catch (e) { status("Texte konnten nicht geholt werden: " + (e.message || e)); wahlFuellen(); }
  })();
  $("wahl").onchange = function () { if (!active) textWaehlen(this.value); else this.value = curId || ""; };
  $("neu").onclick = async function () {
    if (active) return;
    var name = prompt("Name f\u00fcr den neuen Text:", "Text " + (texte.length + 1));
    if (name === null) return;
    try {
      var t = await hilfe.neu(name.trim() || "Text", "");
      if (!t) return;
      texte.push(t); textWaehlen(t.id); oeffneEditor();
    } catch (e) { status("Anlegen ging nicht: " + (e.message || e)); }
  };
  $("umb").onclick = async function () {
    var t = texte.find(function (x) { return x.id === curId; }); if (!t) return;
    var name = prompt("Neuer Name:", t.name); if (name === null || !name.trim()) return;
    t.name = name.trim(); wahlFuellen();
    try { await hilfe.speichern(t.id, { name: t.name }); } catch (e) { status("Umbenennen ging nicht: " + (e.message || e)); }
  };
  $("weg").onclick = async function () {
    if (active) return;
    var t = texte.find(function (x) { return x.id === curId; }); if (!t) return;
    if (!confirm("\u201e" + t.name + "\u201c wirklich wegwerfen?")) return;
    texte = texte.filter(function (x) { return x.id !== t.id; });
    textWaehlen(texte[0] ? texte[0].id : null);
    try { await hilfe.weg(t.id); } catch (e) { status("Wegwerfen ging nicht: " + (e.message || e)); }
  };

  /* ---------- Teleprompter: Woerter ---------- */
  var words = [], pos = 0, doneUpTo = 0;
  function norm(s) { return s.toLowerCase().replace(/[^a-z0-9\u00e4\u00f6\u00fc\u00df]/g, ""); }
  function renderWords() {
    var box = $("words"); box.innerHTML = ""; words = []; doneUpTo = 0;
    text.split(/\n\s*\n/).forEach(function (par) {
      var p = document.createElement("p");
      par.split(/\s+/).forEach(function (tok) {
        if (!tok) return;
        var sp = document.createElement("span"); sp.className = "w"; sp.textContent = tok;
        p.appendChild(sp); p.appendChild(document.createTextNode(" "));
        var n = norm(tok); if (n) words.push({ el: sp, n: n });
      });
      box.appendChild(p);
    });
    applyLook();
  }
  function applyLook() { var box = $("words"); box.style.fontSize = S.size + "px"; box.classList.toggle("mirror", S.mirror); }
  function markY() { return $("scroller").clientHeight * 0.35; }
  function wordTop(i) { var sc = $("scroller"); return sc.scrollTop + words[i].el.getBoundingClientRect().top - sc.getBoundingClientRect().top; }
  function posAtMark() {
    var sc = $("scroller"), y = sc.getBoundingClientRect().top + markY();
    for (var i = 0; i < words.length; i++) { if (words[i].el.getBoundingClientRect().bottom >= y - 2) return i; }
    return 0;
  }
  function markDone(p) {
    var a = Math.min(doneUpTo, p), b = Math.max(doneUpTo, p);
    for (var i = a; i < b && i < words.length; i++) words[i].el.classList.toggle("done", i < p);
    doneUpTo = p;
  }

  /* ---------- Stimme folgen ---------- */
  var SRC = window.SpeechRecognition || window.webkitSpeechRecognition, recog = null, following = false, runMode = "tempo";
  var active = false, paused = false, curY = 0, tgtY = 0, lastT = 0;
  function setPos(p) {
    pos = Math.max(0, Math.min(words.length, p)); markDone(pos);
    if (!words.length) return;
    var i = Math.min(pos, words.length - 1);
    tgtY = wordTop(i) + S.size * 0.675 - markY();
  }
  function heard(t) {
    var h = t.split(/\s+/).map(norm).filter(Boolean);
    if (!h.length || !words.length) return;
    var tail = h.slice(-5), last = tail[tail.length - 1], best = -1, bestSc = 0;
    var from = Math.max(0, pos - 3), to = Math.min(words.length, pos + 40);
    for (var j = from; j < to; j++) {
      if (words[j].n !== last) continue;
      var sc = 1;
      for (var k = 1; k < tail.length && j - k >= 0; k++) { if (words[j - k].n === tail[tail.length - 1 - k]) sc++; }
      if (sc > bestSc || (sc === bestSc && Math.abs(j - pos) < Math.abs(best - pos))) { bestSc = sc; best = j; }
    }
    if (best < 0) return;
    var ok = bestSc >= 2 || best - pos < 3 || (last.length >= 4 && best - pos < 10);
    if (!ok || best + 1 < pos - 2) return;
    setPos(best + 1);
  }
  function startFollow() {
    if (!SRC) { runMode = "tempo"; status("Stimme folgen gibt es in diesem Browser nicht \u2013 der Text l\u00e4uft im Tempo."); return; }
    recog = new SRC(); recog.lang = "de-DE"; recog.continuous = true; recog.interimResults = true;
    recog.onresult = function (e) { var t = ""; for (var i = e.resultIndex; i < e.results.length; i++) t += " " + e.results[i][0].transcript; heard(t); };
    recog.onerror = function (e) {
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") {
        following = false; runMode = "tempo";
        status("Stimme folgen klappt hier gerade nicht \u2013 der Text l\u00e4uft im Tempo.");
      }
    };
    recog.onend = function () { if (following) { try { recog.start(); } catch (err) {} } };
    following = true;
    try { recog.start(); } catch (e) {}
  }
  function stopFollow() { following = false; if (recog) { try { recog.stop(); } catch (e) {} recog = null; } }

  /* ---------- Laufen lassen ---------- */
  function loop(t) {
    if (!active || dead) return;
    var dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
    var sc = $("scroller"), max = sc.scrollHeight - sc.clientHeight;
    if (!paused) {
      if (runMode === "tempo") curY += S.speed * (S.size / 44) * dt;
      else curY += (tgtY - curY) * Math.min(1, dt * 3);
      curY = Math.max(0, Math.min(max, curY));
      sc.scrollTop = curY;
    }
    requestAnimationFrame(loop);
  }
  function startPrompter() {
    var sc = $("scroller");
    markDone(0); pos = posAtMark(); markDone(pos);
    curY = sc.scrollTop; tgtY = curY; paused = false; runMode = S.mode; active = true;
    sc.classList.add("run");
    if (runMode === "voice") startFollow();
    lastT = performance.now(); requestAnimationFrame(loop);
  }
  function stopPrompter() { active = false; stopFollow(); $("scroller").classList.remove("run"); }
  function togglePause() {
    if (!active) return;
    paused = !paused;
    status(paused ? "Text angehalten \u2013 Aufnahme l\u00e4uft weiter. Nochmal tippen zum Weiterlaufen." : "Aufnahme l\u00e4uft");
  }
  $("stage").addEventListener("click", function (e) { if (e.target !== $("ta")) togglePause(); });
  function onKey(e) { if (e.code === "Space" && document.activeElement !== $("ta") && active) { e.preventDefault(); togglePause(); } }
  document.addEventListener("keydown", onKey);

  /* ---------- Aufnahme ---------- */
  var WORKLET = "class R extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.i=0;}" +
    "process(inp){var c=inp[0]&&inp[0][0];if(c){for(var k=0;k<c.length;k++){this.b[this.i++]=c[k];" +
    "if(this.i===2048){this.port.postMessage(this.b.slice(0));this.i=0;}}}return true;}}registerProcessor('rec',R);";
  var ac = null, wlReady = false, stream = null, srcNode = null, recNode = null, muteNode = null;
  var chunks = [], capturing = false, raw = null, sr = 48000, wake = null, state = "idle";
  function onChunk(d) {
    var pk = 0; for (var i = 0; i < d.length; i++) { var a = Math.abs(d[i]); if (a > pk) pk = a; }
    meter(pk); if (capturing) chunks.push(d);
  }
  function meter(pk) {
    if (dead) return;
    var db = 20 * Math.log10(pk + 1e-9), w = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
    var m = $("meter"); m.style.width = w + "%"; m.classList.toggle("hot", db > -3);
  }
  async function openMic() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: S.ns, channelCount: 1 } });
    if (ac.state !== "running") await ac.resume();
    sr = ac.sampleRate; chunks = [];
    srcNode = ac.createMediaStreamSource(stream);
    recNode = null;
    if (ac.audioWorklet) {
      try {
        if (!wlReady) { await ac.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }))); wlReady = true; }
        recNode = new AudioWorkletNode(ac, "rec");
        recNode.port.onmessage = function (e) { onChunk(e.data); };
      } catch (e) { recNode = null; }
    }
    if (!recNode) {
      recNode = ac.createScriptProcessor(4096, 1, 1);
      recNode.onaudioprocess = function (e) { onChunk(new Float32Array(e.inputBuffer.getChannelData(0))); };
    }
    muteNode = ac.createGain(); muteNode.gain.value = 0;
    srcNode.connect(recNode); recNode.connect(muteNode); muteNode.connect(ac.destination);
  }
  function closeMic() {
    try { srcNode.disconnect(); recNode.disconnect(); muteNode.disconnect(); } catch (e) {}
    if (recNode && recNode.port) recNode.port.onmessage = null;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; meter(0);
    var n = 0; chunks.forEach(function (c) { n += c.length; });
    var out = new Float32Array(n), o = 0;
    chunks.forEach(function (c) { out.set(c, o); o += c.length; });
    chunks = [];
    return out;
  }
  function setBtn() {
    if (dead) return;
    var b = $("rec");
    b.innerHTML = state === "rec" ? "&#9632; Stopp" : "&#9679; Aufnahme";
    b.classList.toggle("stop", state === "rec");
    b.disabled = state === "busy" || state === "count";
  }
  $("rec").onclick = async function () {
    if (state === "rec") { stopAll(); return; }
    if (state !== "idle") return;
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    ac.resume();
    state = "busy"; setBtn(); $("take").hidden = true; schliesseEditor(false);
    try { await openMic(); }
    catch (e) { state = "idle"; setBtn(); status("Kein Zugriff aufs Mikro: " + (e.message || e)); return; }
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request("screen"); } catch (e) {}
    state = "count"; setBtn();
    var c = $("count"); c.style.display = "flex";
    for (var k = 3; k > 0; k--) { c.textContent = k; await sleep(800); if (dead) return; }
    c.style.display = "none";
    capturing = true; state = "rec"; setBtn(); status("Aufnahme l\u00e4uft");
    startPrompter();
  };
  function stopAll() {
    capturing = false; stopPrompter(); raw = closeMic();
    if (wake) { try { wake.release(); } catch (e) {} wake = null; }
    state = "idle"; setBtn();
    if (raw.length < sr * 0.5) { status("Die Aufnahme war zu kurz."); raw = null; return; }
    cache = {}; showTake();
  }

  /* ---------- Klangkette ---------- */
  function coefHP(f, Q, fs) {
    var w = 2 * Math.PI * f / fs, cs = Math.cos(w), al = Math.sin(w) / (2 * Q), a0 = 1 + al;
    return [(1 + cs) / 2 / a0, -(1 + cs) / a0, (1 + cs) / 2 / a0, -2 * cs / a0, (1 - al) / a0];
  }
  function coefHS(f, Q, Gd, fs) {
    var A = Math.pow(10, Gd / 40), w = 2 * Math.PI * f / fs, cs = Math.cos(w), al = Math.sin(w) / (2 * Q), sq = 2 * Math.sqrt(A) * al;
    var a0 = (A + 1) - (A - 1) * cs + sq;
    return [A * ((A + 1) + (A - 1) * cs + sq) / a0, -2 * A * ((A - 1) + (A + 1) * cs) / a0, A * ((A + 1) + (A - 1) * cs - sq) / a0,
      2 * ((A - 1) - (A + 1) * cs) / a0, ((A + 1) - (A - 1) * cs - sq) / a0];
  }
  function bq(x, c) {
    var y = new Float32Array(x.length), x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) {
      var v = x[i], o = c[0] * v + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o;
    }
    return y;
  }
  function scale(x, g) { for (var i = 0; i < x.length; i++) x[i] *= g; return x; }
  function gate(x, fs) {
    var n = x.length, bl = Math.round(0.02 * fs), pw = [];
    for (var s = 0; s + bl <= n; s += bl) { var m = 0; for (var i = s; i < s + bl; i++) m += x[i] * x[i]; pw.push(m / bl); }
    if (pw.length < 5) return x;
    var so = pw.slice().sort(function (a, b) { return a - b; });
    var floor = so[Math.floor(so.length * 0.1)] + 1e-12, loud = so[Math.floor(so.length * 0.9)] + 1e-12;
    var thr = Math.max(floor * Math.pow(10, 0.6), Math.min(floor * Math.pow(10, 0.8), loud * 0.01));
    var a = Math.exp(-1 / (0.01 * fs)), env = 0, g = 1, hold = 0, H = Math.round(0.1 * fs);
    var op = 1 - Math.exp(-1 / (0.002 * fs)), cl = 1 - Math.exp(-1 / (0.08 * fs)), low = Math.pow(10, -12 / 20);
    var y = new Float32Array(n);
    for (var j = 0; j < n; j++) {
      env = a * env + (1 - a) * x[j] * x[j];
      var open;
      if (env > thr) { open = true; hold = H; } else if (hold > 0) { hold--; open = true; } else open = false;
      var t = open ? 1 : low;
      g += (t - g) * (t > g ? op : cl);
      y[j] = x[j] * g;
    }
    return y;
  }
  function normRMS(x, fs, targetDb) {
    var bl = Math.round(0.05 * fs), pw = [];
    for (var s = 0; s + bl <= x.length; s += bl) { var m = 0; for (var i = s; i < s + bl; i++) m += x[i] * x[i]; pw.push(m / bl); }
    if (!pw.length) return x;
    pw.sort(function (a, b) { return b - a; });
    var top = pw.slice(0, Math.max(1, Math.floor(pw.length / 2))), mean = 0;
    top.forEach(function (v) { mean += v; }); mean /= top.length;
    return scale(x, Math.pow(10, targetDb / 20) / Math.sqrt(mean + 1e-12));
  }
  function satCurve(k) {
    var n = 2048, c = new Float32Array(n), d = Math.tanh(k);
    for (var i = 0; i < n; i++) { var v = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * v) / d; }
    return c;
  }
  function renderOffline(oc) {
    return new Promise(function (res) {
      oc.oncomplete = function (e) { res(e.renderedBuffer); };
      var p = oc.startRendering(); if (p && p.then) p.then(res);
    });
  }
  async function chain(x, fs, studio) {
    var OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var oc = new OC(1, x.length, fs), b = oc.createBuffer(1, x.length, fs);
    b.getChannelData(0).set(x);
    var s = oc.createBufferSource(); s.buffer = b;
    function f(type, freq, Q, gain) {
      var n = oc.createBiquadFilter(); n.type = type; n.frequency.value = freq; n.Q.value = Q;
      if (gain !== undefined) n.gain.value = gain; return n;
    }
    var eq = [f("highpass", 80, 0.707)];
    if (studio) eq.push(f("lowshelf", 120, 0.7, 2.5));
    eq.push(f("peaking", 280, 1, -2.5), f("peaking", 4000, 0.9, 2), f("highshelf", 10000, 0.7, studio ? 3 : 1.5));
    var prev = s; eq.forEach(function (n) { prev.connect(n); prev = n; });
    var sum = oc.createGain();
    if (studio) {
      var dry = oc.createGain(), sh = oc.createWaveShaper(), wet = oc.createGain();
      sh.curve = satCurve(2); sh.oversample = "4x"; wet.gain.value = 0.25;
      prev.connect(dry); dry.connect(sum); prev.connect(sh); sh.connect(wet); wet.connect(sum);
    } else prev.connect(sum);
    var comp = oc.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.1; comp.knee.value = 6;
    sum.connect(comp); comp.connect(oc.destination);
    if (studio) {
      var c2 = oc.createDynamicsCompressor(), g2 = oc.createGain();
      c2.threshold.value = -30; c2.ratio.value = 6; c2.attack.value = 0.005; c2.release.value = 0.15; c2.knee.value = 3;
      g2.gain.value = 1.4;
      sum.connect(c2); c2.connect(g2); g2.connect(oc.destination);
    }
    s.start(0);
    var r = await renderOffline(oc);
    return new Float32Array(r.getChannelData(0));
  }
  function deess(x, fs) {
    var n = x.length, hb = bq(x, coefHP(6000, 0.707, fs)), ms = 0;
    for (var i = 0; i < n; i++) ms += x[i] * x[i];
    var thr = Math.sqrt(ms / n + 1e-12) * Math.pow(10, -10 / 20);
    var at = 1 - Math.exp(-1 / (0.001 * fs)), rl = 1 - Math.exp(-1 / (0.05 * fs)), env = 0, minG = Math.pow(10, -9 / 20);
    var y = new Float32Array(n);
    for (var j = 0; j < n; j++) {
      var a = Math.abs(hb[j]); env += (a - env) * (a > env ? at : rl);
      var g = 1; if (env > thr) { g = Math.pow(thr / env, 0.75); if (g < minG) g = minG; }
      y[j] = x[j] - hb[j] * (1 - g);
    }
    return y;
  }
  function lufs(x, fs) {
    var k = bq(bq(x, coefHS(1681.974450955533, 0.7071752369554196, 3.999843853973347, fs)), coefHP(38.13547087602444, 0.5003270373238773, fs));
    var bl = Math.round(0.4 * fs), st = Math.round(0.1 * fs), z = [];
    for (var s = 0; s + bl <= k.length; s += st) { var m = 0; for (var i = s; i < s + bl; i++) m += k[i] * k[i]; z.push(m / bl); }
    if (!z.length) { var mm = 0; for (var j = 0; j < k.length; j++) mm += k[j] * k[j]; z.push(mm / Math.max(1, k.length)); }
    function L(v) { return -0.691 + 10 * Math.log10(v + 1e-15); }
    function mean(a) { var t = 0; a.forEach(function (v) { t += v; }); return t / a.length; }
    var g1 = z.filter(function (v) { return L(v) > -70; }); if (!g1.length) return -70;
    var rel = L(mean(g1)) - 10;
    var g2 = g1.filter(function (v) { return L(v) > rel; });
    return L(mean(g2.length ? g2 : g1));
  }
  function loudTo(x, fs, target) { var l = lufs(x, fs); if (l <= -69) return x; return scale(x, Math.pow(10, (target - l) / 20)); }
  function limit(x, fs, ceilDb) {
    var c = Math.pow(10, ceilDb / 20), L = Math.max(1, Math.round(0.005 * fs)), n = x.length;
    var req = new Float32Array(n), w = new Float32Array(n), dq = new Int32Array(n), h = 0, t = 0, i;
    for (i = 0; i < n; i++) { var a = Math.abs(x[i]); req[i] = a > c ? c / a : 1; }
    for (i = n - 1; i >= 0; i--) {
      while (t > h && req[dq[t - 1]] >= req[i]) t--;
      dq[t++] = i;
      while (dq[h] > i + L) h++;
      w[i] = req[dq[h]];
    }
    var g = 1, att = 1 - Math.exp(-1 / (0.0015 * fs)), rel = 1 - Math.exp(-1 / (0.08 * fs)), y = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var tg = w[i]; g += (tg - g) * (tg < g ? att : rel);
      var v = x[i] * g; if (v > c) v = c; else if (v < -c) v = -c; y[i] = v;
    }
    return y;
  }
  async function processTake(x, fs, p) {
    if (p !== "raw") x = gate(x, fs);
    x = normRMS(x, fs, -20);
    if (p !== "raw") { x = await chain(x, fs, p === "studio"); x = deess(x, fs); }
    x = loudTo(x, fs, -14);
    return limit(x, fs, -1);
  }
  function wav24(x, fs) {
    var n = x.length, buf = new ArrayBuffer(44 + n * 3), v = new DataView(buf);
    function ws(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    ws(0, "RIFF"); v.setUint32(4, 36 + n * 3, true); ws(8, "WAVE"); ws(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, fs, true);
    v.setUint32(28, fs * 3, true); v.setUint16(32, 3, true); v.setUint16(34, 24, true); ws(36, "data"); v.setUint32(40, n * 3, true);
    for (var i = 0, o = 44; i < n; i++, o += 3) {
      var s = Math.max(-1, Math.min(1, x[i])), q = Math.round(s * 8388607);
      v.setUint8(o, q & 255); v.setUint8(o + 1, (q >> 8) & 255); v.setUint8(o + 2, (q >> 16) & 255);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  /* ---------- Ergebnis ---------- */
  var cache = {}, curUrl = null, lastBlob = null;
  function fmt(sec) { var m = Math.floor(sec / 60), s = Math.round(sec % 60); return m + ":" + (s < 10 ? "0" : "") + s; }
  function fname() {
    var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return "aufnahme-" + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + "-" + S.preset + ".wav";
  }
  function markPreset() { root.querySelectorAll("[data-p]").forEach(function (b) { b.classList.toggle("on", b.dataset.p === S.preset); }); }
  async function renderPreset(p) {
    if (!raw) return;
    status("Wird veredelt \u2026"); await sleep(30);
    try {
      if (!cache[p]) cache[p] = await processTake(raw.slice(), sr, p);
      if (dead) return;
      lastBlob = wav24(cache[p], sr);
      if (curUrl) URL.revokeObjectURL(curUrl);
      curUrl = URL.createObjectURL(lastBlob); $("player").src = curUrl;
      status("Fertig \u2013 h\u00f6r rein. L\u00e4nge " + fmt(raw.length / sr));
    } catch (e) { status("Fehler beim Veredeln: " + (e.message || e)); }
  }
  async function showTake() { $("take").hidden = false; markPreset(); await renderPreset(S.preset); }
  root.querySelectorAll("[data-p]").forEach(function (b) {
    b.onclick = function () { S.preset = this.dataset.p; saveS(); markPreset(); renderPreset(S.preset); };
  });
  $("save").onclick = function () {
    if (!curUrl) return;
    var a = document.createElement("a"); a.href = curUrl; a.download = fname();
    document.body.appendChild(a); a.click(); a.remove();
  };
  if (navigator.canShare) $("share").hidden = false;
  $("share").onclick = async function () {
    if (!lastBlob) return;
    var f = new File([lastBlob], fname(), { type: "audio/wav" });
    try { if (navigator.canShare({ files: [f] })) await navigator.share({ files: [f] }); else status("Teilen geht hier nicht \u2013 nimm Speichern."); }
    catch (e) {}
  };
  $("discard").onclick = function () {
    raw = null; cache = {}; lastBlob = null; $("take").hidden = true;
    $("player").removeAttribute("src"); if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null; }
    status("");
  };

  /* ---------- Bedienung oben ---------- */
  function syncSet() {
    $("size").value = S.size; $("v_size").textContent = S.size + " px";
    $("speed").value = S.speed; $("v_speed").textContent = S.speed;
    $("mode").value = S.mode; $("mirror").checked = S.mirror; $("ns").checked = S.ns;
  }
  $("set").onclick = function () { $("setPanel").hidden = !$("setPanel").hidden; this.classList.toggle("on", !$("setPanel").hidden); };
  $("size").oninput = function () { S.size = +this.value; syncSet(); applyLook(); saveS(); };
  $("speed").oninput = function () { S.speed = +this.value; syncSet(); saveS(); };
  $("mode").onchange = function () { S.mode = this.value; saveS(); };
  $("mirror").onchange = function () { S.mirror = this.checked; applyLook(); saveS(); };
  $("ns").onchange = function () { S.ns = this.checked; saveS(); };
  $("top").onclick = function () { if (active) return; $("scroller").scrollTop = 0; markDone(0); };
  function oeffneEditor() {
    var ta = $("ta"); if (active) return;
    ta.value = text === BEISPIEL && !curId ? "" : text; ta.hidden = false; ta.focus();
    $("text").classList.add("on"); $("text").textContent = "Fertig";
  }
  async function schliesseEditor(speichern) {
    var ta = $("ta"); if (ta.hidden) return;
    ta.hidden = true; $("text").classList.remove("on"); $("text").textContent = "Text";
    if (speichern === false) return;
    var neu = ta.value.trim();
    if (!neu) { renderWords(); return; }
    text = neu; renderWords(); $("scroller").scrollTop = 0;
    try {
      if (curId) {
        var t = texte.find(function (x) { return x.id === curId; }); if (t) t.text = text;
        await hilfe.speichern(curId, { text: text });
      } else {
        var angelegt = await hilfe.neu("Text " + (texte.length + 1), text);
        if (angelegt) { texte.push(angelegt); curId = angelegt.id; wahlFuellen(); try { localStorage.setItem("studio:text", curId); } catch (e) {} }
      }
      status("Text gespeichert.");
    } catch (e) { status("Speichern ging nicht: " + (e.message || e)); }
  }
  $("text").onclick = function () { if ($("ta").hidden) oeffneEditor(); else schliesseEditor(); };

  /* ---------- Start ---------- */
  syncSet(); wahlFuellen(); renderWords(); setBtn();

  return function aufraeumen() {
    if (!$("ta").hidden) schliesseEditor();
    dead = true; active = false; capturing = false;
    stopFollow();
    document.removeEventListener("keydown", onKey);
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    if (wake) { try { wake.release(); } catch (e) {} }
    if (ac) { try { ac.close(); } catch (e) {} }
    if (curUrl) URL.revokeObjectURL(curUrl);
  };
}

// ============================================================
// STIL
// ============================================================
function StudioStil() {
  return (
    <style>{`
.studio{
  position:fixed; inset:0; z-index:70; display:flex; flex-direction:column;
  background:#0b0907; color:#e6d9bb;
  font:14px/1.4 'Courier Prime', ui-monospace, monospace;
  padding-top:env(safe-area-inset-top,0px); padding-bottom:env(safe-area-inset-bottom,0px);
  --st-linie:#2c2319; --st-feld:#15110c; --st-dim:#8d7c63; --st-rot:#b8452f; --st-gold:#e08b3c; --st-hell:#ffd79a;
}
.studio *{box-sizing:border-box}
.studio button, .studio select, .studio input, .studio textarea{font-family:inherit}
.st-kopf{display:flex; gap:8px; align-items:center; padding:8px 12px; border-bottom:1px solid var(--st-linie); background:#110d09; flex-wrap:wrap}
.st-titel{font-family:'IM Fell English SC', Georgia, serif; font-size:19px; color:var(--st-hell); letter-spacing:.04em; margin-left:6px}
.st-luft{flex:1}
.st-knopf{background:var(--st-feld); color:#e6d9bb; border:1px solid var(--st-linie); border-radius:4px; padding:7px 12px; cursor:pointer; font-size:13px}
.st-knopf:hover{border-color:var(--st-gold)}
.st-knopf.an{border-color:var(--st-gold); color:var(--st-hell)}
.st-rumpf{flex:1; min-height:0; position:relative; overflow:auto}
.st-liste{padding:22px}
.st-kacheln{display:flex; flex-wrap:wrap; gap:14px; align-items:flex-start}
.st-kachelhuelle{position:relative; width:230px}
.st-kachel{
  width:100%; min-height:96px; padding:16px 18px; cursor:pointer; text-align:left;
  display:flex; flex-direction:column; justify-content:space-between; gap:10px;
  border:1px solid rgba(168,135,79,.35); border-radius:3px; color:#e6d9bb;
  background:linear-gradient(168deg, rgba(230,217,187,.10), rgba(230,217,187,.04));
  box-shadow:0 8px 18px rgba(0,0,0,.5);
}
.st-kachel:hover{border-color:rgba(242,179,87,.6)}
.st-kachel.neu{width:96px; align-items:center; justify-content:center; border-style:dashed; background:transparent; font-size:26px; color:#a87a42}
.st-kname{font-family:'IM Fell English SC', Georgia, serif; font-size:19px; color:var(--st-hell)}
.st-kzeile{display:flex; justify-content:space-between; font-size:11px; color:var(--st-dim); letter-spacing:.06em}
.st-klein{position:absolute; top:-7px; right:-7px; width:22px; height:22px; border-radius:50%;
  border:1px solid rgba(168,135,79,.35); background:#14110c; color:var(--st-dim); font-size:10px; cursor:pointer; opacity:0; transition:.15s}
.st-klein.links{right:20px}
.st-kachelhuelle:hover .st-klein{opacity:1}
@media (hover:none){ .st-klein{opacity:1} }
.st-leer{color:var(--st-dim); font-style:italic; margin-top:18px}
.st-fehler{color:#e8a08c; background:rgba(141,50,38,.2); border:1px solid rgba(141,50,38,.5); padding:10px 12px; border-radius:4px; cursor:pointer}

/* ---------- zoomloop ---------- */
.zl{height:100%}
.zl-app{display:grid; grid-template-columns:190px 1fr 270px; grid-template-rows:1fr auto; height:100%; font:14px/1.4 Georgia,"Times New Roman",serif}
.zl-list{grid-column:1; grid-row:1/3; background:#120e0a; border-right:1px solid var(--st-linie); overflow-y:auto; padding:10px}
.zl-stage{grid-column:2; grid-row:1; display:flex; align-items:center; justify-content:center; padding:14px; min-height:0; min-width:0; position:relative}
#zl_cv{max-width:100%; max-height:100%; background:#000; cursor:grab; box-shadow:0 0 40px #000; touch-action:none}
#zl_cv.drag{cursor:grabbing}
.zl-hint{position:absolute; color:var(--st-dim); text-align:center; pointer-events:none; font-style:italic; font-size:17px}
.zl-bar{grid-column:2; grid-row:2; display:flex; gap:10px; align-items:center; padding:10px 14px; border-top:1px solid var(--st-linie); background:#120e0a}
.zl-bar input[type=range]{flex:1}
.zl-tt{color:var(--st-dim); font-size:12px; width:90px; text-align:right}
.zl-side{grid-column:3; grid-row:1/3; background:#120e0a; border-left:1px solid var(--st-linie); overflow-y:auto; padding:12px}
.zl h2{font-size:12px; letter-spacing:.18em; text-transform:uppercase; color:var(--st-gold); margin:16px 0 8px; font-weight:normal}
.zl h2:first-child{margin-top:0}
.zl label{display:block; margin:8px 0 2px; color:var(--st-dim); font-size:12px}
.zl label b{color:#e6d9bb; font-weight:normal; float:right}
.zl input[type=range]{width:100%; accent-color:var(--st-rot)}
.zl select, .zl button{background:#0b0907; color:#e6d9bb; border:1px solid var(--st-linie); padding:6px 8px; font:inherit; border-radius:3px}
.zl select{width:100%}
.zl button{cursor:pointer}
.zl button:hover{border-color:var(--st-gold)}
.zl-big{width:100%; padding:10px !important; background:var(--st-rot) !important; border-color:var(--st-rot) !important; color:#fff !important; margin-top:10px}
.zl-add{width:100%; margin-bottom:10px}
.zl-th{display:flex; gap:6px; align-items:center; padding:5px; border:1px solid transparent; border-radius:4px; margin-bottom:4px; cursor:pointer}
.zl-th.sel{border-color:var(--st-rot); background:#21180f}
.zl-th canvas{width:80px; flex:none; display:block}
.zl-n{color:var(--st-dim); font-size:11px; width:16px; text-align:right}
.zl-bt{display:flex; flex-direction:column; gap:2px; margin-left:auto}
.zl-bt button{padding:0 5px !important; font-size:10px; line-height:15px}
.zl-row{display:flex; gap:6px; align-items:center}
.zl-row input[type=checkbox]{accent-color:var(--st-rot)}
.zl-prog{height:6px; background:#0b0907; border:1px solid var(--st-linie); margin-top:8px; display:none}
.zl-prog i{display:block; height:100%; width:0; background:var(--st-gold)}
.zl-msg{color:var(--st-dim); font-size:12px; margin-top:6px; min-height:1.4em}
.zl-pair{color:#e6d9bb; font-size:13px; margin-bottom:4px}
.zl-cprev{width:100%; display:block; margin:4px 0; cursor:grab; touch-action:none}
@media (max-width:820px){
  .zl-app{grid-template-columns:1fr; grid-template-rows:auto auto auto auto; height:auto}
  .zl-stage{grid-column:1; grid-row:1; height:52vh; padding:8px}
  .zl-bar{grid-column:1; grid-row:2}
  .zl-list{grid-column:1; grid-row:3; border-right:0; border-top:1px solid var(--st-linie); overflow-x:auto; overflow-y:hidden}
  .zl-thumbs{display:flex; gap:6px}
  .zl-th{flex:none; flex-direction:column}
  .zl-bt{flex-direction:row; margin-left:0}
  .zl-side{grid-column:1; grid-row:4; border-left:0; border-top:1px solid var(--st-linie)}
  .zl select, .zl input{font-size:16px}
}

/* ---------- aufnahme ---------- */
.au{height:100%}
.au-app{display:flex; flex-direction:column; height:100%}
.au-kopf{display:flex; gap:6px; align-items:center; padding:8px 12px; border-bottom:1px solid var(--st-linie); background:#110d09}
.au-wahl{max-width:46%; min-width:0}
.au-luft{flex:1}
.au button, .au select{background:#0b0907; color:#e6d9bb; border:1px solid var(--st-linie); padding:7px 11px; border-radius:4px; cursor:pointer; font-size:14px}
.au button:disabled{opacity:.5}
.au button.on{border-color:var(--st-gold); color:var(--st-hell)}
.au-set{padding:4px 12px 12px; background:#110d09; border-bottom:1px solid var(--st-linie); display:grid; grid-template-columns:1fr 1fr; gap:0 16px}
.au-set[hidden]{display:none}
.au label{display:block; color:var(--st-dim); font-size:12px; margin-top:8px}
.au label b{float:right; color:#e6d9bb; font-weight:normal}
.au input[type=range]{width:100%; accent-color:var(--st-rot)}
.au-set select{width:100%}
.au-chk{display:flex !important; align-items:center; gap:6px; color:#e6d9bb !important; font-size:14px !important; margin-top:10px}
.au-chk input{accent-color:var(--st-rot)}
.au-stage{flex:1; position:relative; min-height:0; overflow:hidden}
.au-scroller{position:absolute; inset:0; overflow-y:auto; -webkit-overflow-scrolling:touch}
.au-scroller.run{overflow-y:hidden}
.au-words{padding:35vh 7vw 75vh; line-height:1.35; font-family:Georgia,"Times New Roman",serif; color:#efe4c9}
.au-words p{margin:0 0 .8em}
.au-words .w.done{color:#5f5344}
.au-words.mirror{transform:scaleX(-1)}
.au-mark{position:absolute; left:0; right:0; top:35%; border-top:2px solid rgba(224,139,60,.55); z-index:2; pointer-events:none}
.au-mark:before{content:"\\25B6"; position:absolute; left:3px; top:-.8em; color:var(--st-gold); font-size:16px}
.au-count{position:absolute; inset:0; display:none; align-items:center; justify-content:center; font-size:120px; color:var(--st-gold); background:rgba(11,9,7,.6); z-index:3; font-family:'IM Fell English SC', Georgia, serif}
.au-ta{position:absolute; inset:0; width:100%; height:100%; background:#0b0907; color:#e6d9bb; border:0; padding:16px; font:18px/1.5 Georgia,serif; z-index:4; resize:none}
.au-ta[hidden]{display:none}
.au-meter{height:6px; background:#000}
.au-meter i{display:block; height:100%; width:0; background:var(--st-gold)}
.au-meter i.hot{background:var(--st-rot)}
.au-fuss{display:flex; gap:10px; align-items:center; padding:10px 12px; background:#110d09; border-top:1px solid var(--st-linie)}
.au button.au-rec{background:var(--st-rot); border-color:var(--st-rot); color:#fff; padding:12px 20px; font-size:17px}
.au button.au-rec.stop{background:#0b0907; color:var(--st-rot)}
.au-status{color:var(--st-dim); font-size:13px; flex:1}
.au-take{padding:8px 12px 14px; background:#110d09; border-top:1px solid var(--st-linie)}
.au-take[hidden]{display:none}
.au-row{display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:6px 0}
.au audio{width:100%; margin:6px 0}
@media (max-width:560px){
  .au-set{grid-template-columns:1fr}
  .au select, .au textarea{font-size:16px}
}
`}</style>
  );
}
