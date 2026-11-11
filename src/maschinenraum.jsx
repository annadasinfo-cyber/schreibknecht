import React, { useState, useEffect, useRef, useCallback } from "react";

// ============================================================
// DER MASCHINENRAUM — hinter der zweiten tuer auf dem deckblatt.
// Operationen: ein satz, eine schaltung, ein puls.
//
// Die idee dahinter ist die symbolische Hieronymus-Maschine:
// wenn tinte auf papier reicht, reicht auch ein datensatz. Was
// die app hinzufuegt, ist der impuls — sonst waer es eine
// zeichnung.
//
// Der puls selbst laeuft in der DATENBANK (pg_cron, siehe
// maschinenraum.sql), nicht hier. Diese seite rechnet nur aus,
// wo er gerade steht, und zeigt es an. Fenster, nicht motor.
// ============================================================

const EIMER = "maschinenraum";

const neueId = () =>
  "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Ein handy-foto hat leicht zehn megabyte. Das dauert beim hochladen
// ewig und bringt auf einem kaestchen von 74 pixeln nichts. Also erst
// kleinrechnen — der schreibknecht macht das mit kartenbildern genauso.
const GUETE = 0.82;

function bildKleinrechnen(datei, kante) {
  // Jeder schritt hier kann in irgendeinem browser den rueckruf schuldig
  // bleiben — dann haengt alles. Darum: nichts ohne zeitlimit, und wenn
  // etwas nicht antwortet, geht es mit dem original weiter.
  const mitUhr = (versprechen, ms) => Promise.race([
    versprechen,
    new Promise((fertig) => setTimeout(() => fertig(null), ms)),
  ]);

  const malen = async () => {
    if (!/^image\//.test(datei.type || "")) return null;   // datei ist hier ein blob
    if (!datei.size || datei.size < 80 * 1024) return null;   // schon klein genug

    // bild holen: erst der kurze weg, sonst der alte ueber FileReader
    let quelle = null;
    if (typeof createImageBitmap === "function") {
      quelle = await mitUhr(createImageBitmap(datei).catch(() => null), 6000);
    }
    if (!quelle) {
      quelle = await mitUhr(new Promise((fertig) => {
        const leser = new FileReader();
        leser.onerror = () => fertig(null);
        leser.onload = () => {
          const bild = new Image();
          bild.onload = () => fertig(bild);
          bild.onerror = () => fertig(null);
          bild.src = leser.result;
        };
        leser.readAsDataURL(datei);
      }), 6000);
    }
    if (!quelle || !quelle.width) return null;

    const lang = Math.max(quelle.width, quelle.height);
    const mal = lang > kante ? kante / lang : 1;
    if (mal === 1 && datei.size < 600 * 1024) return null;   // lohnt nicht

    const br = Math.round(quelle.width * mal), ho = Math.round(quelle.height * mal);
    const tafel = document.createElement("canvas");
    tafel.width = br; tafel.height = ho;
    const stift = tafel.getContext("2d");
    stift.imageSmoothingQuality = "high";
    stift.drawImage(quelle, 0, 0, br, ho);
    if (quelle.close) try { quelle.close(); } catch {}

    const nimm = (art) => mitUhr(new Promise((fertig) => {
      try { tafel.toBlob((roh) => fertig(roh && roh.type === art ? roh : null), art, GUETE); }
      catch { fertig(null); }
    }), 6000);

    // jpeg zuerst: das kann jeder browser. webp nur, wenn es wirklich kleiner wird
    const jpeg = await nimm("image/jpeg");
    const webp = await nimm("image/webp");
    const beste = [
      webp && { blob: webp, endung: "webp" },
      jpeg && { blob: jpeg, endung: "jpg" },
    ].filter(Boolean).sort((x, y) => x.blob.size - y.blob.size)[0];

    if (beste && beste.blob.size < datei.size) return beste;
    return null;
  };

  // und ueber allem nochmal eine uhr: nach zehn sekunden das original
  return mitUhr(malen().catch(() => null), 10000);
}

// wie gross ein bild sein darf — ein schaltplan fuellt die ganze flaeche,
// eine sigille sitzt auf einem kaestchen
const KANTE = { schaltungen: 1800, sigillen: 1000, targets: 1000, bauteile: 1000 };

// Hashtags: jedes #wort in name, beschreibung, notiz oder herkunft.
const tagsAus = (x) => {
  const text = [x.name, x.beschreibung, x.notiz, x.herkunft].filter(Boolean).join(" ");
  const gefunden = text.match(/#[\p{L}\p{N}_-]+/gu) || [];
  return [...new Set(gefunden.map((g) => g.toLowerCase()))];
};
const SCHRAENKE = ["sigillen", "raten", "quellen", "hintergruende", "targets"];
const schrankName = (a) => (a === "hintergruende" ? "hintergründe" : a);

const ARTEN = [
  { wert: "target",      name: "target",     zeichen: "◎" },
  { wert: "trend",       name: "trend",      zeichen: "➜" },
  { wert: "verstaerker", name: "verstärker", zeichen: "⚡" },
];

// ---------- der puls, aus start und takt gerechnet ----------
const pulsJetzt = (op) => {
  if (!op || !op.aktiv || !op.gestartet) return 0;
  const sek = (Date.now() - new Date(op.gestartet).getTime()) / 1000;
  return Math.max(0, Math.floor(sek / Math.max(op.takt || 60, 1)));
};

// welches bauteil ist gerade dran?
const amZug = (op, bauteile) => {
  if (!op || !op.aktiv || !bauteile.length) return null;
  const sortiert = [...bauteile].sort((a, b) => (a.nummer - b.nummer) || (a.id < b.id ? -1 : 1));
  return sortiert[pulsJetzt(op) % sortiert.length] || null;
};

// schlaegt der server noch? (sein letzter puls darf nicht zu lange her sein)
const lebt = (op) => {
  if (!op || !op.aktiv) return true;
  if (!op.letzter_puls) return false;
  return Date.now() - new Date(op.letzter_puls).getTime() < 150000;
};

const seitWann = (iso) => {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + " sek";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60);
  if (h < 48) return h + " std";
  return Math.floor(h / 24) + " tage";
};

const taktText = (sek) => {
  if (sek < 60) return "alle " + sek + " sekunden";
  if (sek === 60) return "jede minute";
  if (sek % 3600 === 0) return "alle " + (sek / 3600) + " stunden";
  if (sek % 60 === 0) return "alle " + (sek / 60) + " minuten";
  return "alle " + sek + " sekunden";
};

// ============================================================
export default function Maschinenraum({ api: apiVomHaus, zugang, URL_DB, KEY_DB, zurueck }) {
  // SCHREIBEN GEHT HIER DIREKT, nicht ueber das sicherheitsnetz des hauses.
  // Das netz legt einen gescheiterten schreibvorgang still in eine
  // warteschlange, wenn der fehler nach funkloch klingt — und safari nennt
  // JEDEN fehler "Load failed". Dann steht ein eintrag auf dem schirm,
  // der nie gespeichert wurde, und niemand sagt es. In diesem raum gilt:
  // ein schreibvorgang gelingt, oder er meldet sich mit seinem grund.
  const api = useCallback(async (methode, pfad, koerper, extra) => {
    if (methode === "GET" || pfad.startsWith("/storage/")) return apiVomHaus(methode, pfad, koerper, extra);

    const einmal = async () => {
      const s = await zugang();
      if (!s) throw new Error("nicht angemeldet");
      const abbruch = new AbortController();
      const uhr = setTimeout(() => abbruch.abort(), 20000);
      try {
        const r = await fetch(URL_DB + pfad, {
          method: methode,
          headers: { apikey: KEY_DB, Authorization: "Bearer " + s.access_token,
                     "Content-Type": "application/json" },
          body: koerper === undefined ? undefined : JSON.stringify(koerper),
          signal: abbruch.signal,
        });
        if (!r.ok) {
          const e = new Error(`speichern abgelehnt (${r.status}): ` + (await r.text()).slice(0, 160));
          e.status = r.status;
          throw e;
        }
        const text = await r.text();
        return text ? JSON.parse(text) : null;
      } catch (e) {
        if (abbruch.signal.aborted) throw new Error("speichern: keine antwort nach 20 sekunden");
        throw e;
      } finally { clearTimeout(uhr); }
    };

    try { return await einmal(); }
    catch (e) {
      // zugang abgelaufen? ein lesender ruf ueber das haus erneuert ihn
      if (e.status === 401) {
        try { await apiVomHaus("GET", "/rest/v1/operationen?select=id&limit=1"); } catch {}
        return await einmal();
      }
      if (e.status) throw e;                       // die datenbank hat nein gesagt: so weitergeben
      // kein status: die anfrage kam gar nicht durch — einmal wiederholen
      try { return await einmal(); }
      catch (e2) {
        throw new Error("speichern ging nicht durch (" + String(e2 && e2.message)
          + ") — " + methode + " " + pfad.split("?")[0].replace("/rest/v1/", ""));
      }
    }
  }, [apiVomHaus, zugang, URL_DB, KEY_DB]);
  const [operationen, setOperationen] = useState([]);
  const [sigillen, setSigillen] = useState([]);
  const [raten, setRaten] = useState([]);
  const [quellen, setQuellen] = useState([]);
  const [plaene, setPlaene] = useState([]);       // schaltplaene zum wiederverwenden
  const [ziele, setZiele] = useState([]);         // targets: wer oder was, mit zeugen-bild
  const [offen, setOffen] = useState(null);       // id der offenen operation
  const [liest, setLiest] = useState(false);      // die auslese-seite ist offen
  const [tagMit, setTagMit] = useState("");       // hashtag, der in den naechsten schrank mitgeht
  const [schrank, setSchrank] = useState(null);   // "sigillen" | "raten" | "quellen"
  const [bilder, setBilder] = useState({});       // pfad -> signierte adresse
  const [meldung, setMeldung] = useState(null);
  const [bericht, setBericht] = useState(null);
  const [laedt, setLaedt] = useState(true);

  // MUSS stabil bleiben: der lade-effekt der operation haengt daran.
  // sonst holt jede tasteneingabe die ganze schaltung neu vom server.
  // Eine gute nachricht darf verschwinden, eine schlechte nicht —
  // sonst steht man da und weiss nicht, was passiert ist.
  // "gut" verschwindet von selbst, "laeuft" bleibt bis zur naechsten
  // meldung, "schlimm" bleibt, bis man es antippt.
  const sag = useCallback((t, art) => {
    if (!t) { setMeldung(null); return; }
    setMeldung({ text: t, art: art || "gut" });
    if (!art || art === "gut") setTimeout(() => setMeldung(null), 5000);
  }, []);

  // ---------- bilder ----------
  // Holt fuer jeden bildpfad eine zeitlich begrenzte adresse. Wenn das
  // misslingt, bleibt sonst nur ein leeres feld stehen und man sucht den
  // fehler bei sich — darum wird hier gesagt, woran es lag.
  const holBilder = useCallback(async (pfade, laut) => {
    const fehlen = [...new Set(pfade.filter(Boolean))];
    if (!fehlen.length) return [];
    const neu = {};
    const schiefgegangen = [];

    const einzeln = async (pfad) => {
      try {
        const e = await api("POST", `/storage/v1/object/sign/${EIMER}/${pfad}`,
          { expiresIn: 60 * 60 * 8 });
        if (e && e.signedURL) { neu[pfad] = URL_DB + "/storage/v1" + e.signedURL; return; }
        schiefgegangen.push(pfad + ": keine adresse zurück");
      } catch (err) {
        schiefgegangen.push(pfad + ": " + String(err && err.message).slice(0, 90));
      }
    };

    try {
      const d = await api("POST", `/storage/v1/object/sign/${EIMER}`,
        { paths: fehlen, expiresIn: 60 * 60 * 8 });
      if (!Array.isArray(d)) throw new Error("unerwartete antwort");
      for (const e of d) {
        if (e && e.signedURL && !e.error) neu[e.path] = URL_DB + "/storage/v1" + e.signedURL;
        else if (e && e.path) await einzeln(e.path);     // vielleicht klappt es allein
      }
    } catch (err) {
      for (const pfad of fehlen) await einzeln(pfad);
    }

    if (Object.keys(neu).length) setBilder((b) => ({ ...b, ...neu }));
    if (schiefgegangen.length && laut)
      sag("bild lässt sich nicht holen — " + schiefgegangen[0], "schlimm");
    return schiefgegangen;
  }, [api, URL_DB, sag]);

  // Jeder schritt wird gemeldet. Bleibt etwas stehen, sieht man genau,
  // wie weit es kam — statt vor einem leeren feld ohne auskunft.
  const hochladen = useCallback(async (datei, unterordner) => {
    if (!datei) throw new Error("gar keine datei angekommen");
    const kB = (n) => Math.round(n / 1024).toLocaleString("de") + " kB";
    const name = datei.name || "bild";
    const typ = datei.type || "application/octet-stream";

    // ZUERST in den speicher holen. Eine datei aus einem eingabefeld ist
    // nur ein verweis auf die platte; sobald react das feld neu zeichnet
    // — und das tut es bei jeder meldung — kann safari den verweis
    // fallenlassen, und der upload scheitert mit "Load failed".
    let roh;
    // HIER KEINE MELDUNG. Eine meldung zeichnet die seite neu, und dabei
    // laesst safari die datei fallen — das lesen muss als allererstes
    // geschehen, noch im selben atemzug wie die auswahl.
    try {
      // auch das lesen bekommt eine uhr: gibt der browser die datei nicht
      // her (z.b. weil sie nur in der iCloud liegt), haengt es sonst stumm
      const puffer = await Promise.race([
        datei.arrayBuffer(),
        new Promise((_, nein) => setTimeout(() => nein(new Error("keine antwort nach 30 sekunden")), 30000)),
      ]);
      roh = new Blob([puffer], { type: typ });
    } catch (e) {
      throw new Error("safari gibt die datei „" + name + "\" nicht her (" + String(e && e.message)
        + "). liegt sie vielleicht nur in der iCloud? leg sie einmal auf den schreibtisch und nimm sie von dort.");
    }

    sag(`1/4 ${name} · ${kB(roh.size)} · wird vorbereitet …`, "laeuft");
    const klein = await bildKleinrechnen(roh, KANTE[unterordner] || 1000);
    const inhalt = klein ? klein.blob : roh;
    const endung = klein ? klein.endung : (name.split(".").pop() || "png").toLowerCase();

    const s = await zugang();
    if (!s) throw new Error("nicht angemeldet");
    const pfad = `${s.user.id}/${unterordner}/${neueId()}.${endung}`;

    sag(`2/4 ${kB(inhalt.size)}${klein ? " (aus " + kB(datei.size) + ")" : " im original"}`
        + " wird hochgeladen …", "laeuft");

    // Ohne zeitlimit haengt eine stockende leitung stumm, und man sitzt
    // vor einer meldung, die sich nicht mehr ruehrt.
    const schicken = async () => {
      const abbruch = new AbortController();
      const uhr = setTimeout(() => abbruch.abort(), 90000);
      try {
        return await fetch(`${URL_DB}/storage/v1/object/${EIMER}/${pfad}`, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + s.access_token,
            apikey: KEY_DB,
            "Content-Type": inhalt.type || "application/octet-stream",
            "x-upsert": "true",
          },
          body: inhalt,
          signal: abbruch.signal,
        });
      } catch (e) {
        if (abbruch.signal.aborted)
          throw new Error("hochladen hat 90 sekunden nicht geantwortet — abgebrochen");
        throw e;
      } finally { clearTimeout(uhr); }
    };

    let r;
    try { r = await schicken(); }
    catch (e) {
      // ein abgewiesener versuch darf einmal wiederholt werden
      sag("2/4 erster versuch misslungen, zweiter läuft …", "laeuft");
      try { r = await schicken(); }
      catch (e2) { throw new Error("hochladen ging nicht: " + String(e2 && e2.message)); }
    }

    if (!r.ok)
      throw new Error(`hochladen abgelehnt (${r.status}): ` + (await r.text()).slice(0, 140));

    sag("3/4 liegt in der ablage, hole die adresse …", "laeuft");
    const schief = await holBilder([pfad], true);
    if (schief && schief.length) throw new Error(schief[0]);

    sag("4/4 fertig: " + pfad.split("/").slice(1).join("/"));
    return pfad;
  }, [zugang, URL_DB, KEY_DB, holBilder, sag]);

  // ---------- laden ----------
  const laden = useCallback(async () => {
    try {
      const [op, si, ra, qu, pl, zi] = await Promise.all([
        api("GET", "/rest/v1/operationen?select=*&order=zuletzt.desc"),
        api("GET", "/rest/v1/sigillen?select=*&order=name.asc"),
        api("GET", "/rest/v1/raten?select=*&order=name.asc"),
        api("GET", "/rest/v1/quellen?select=*&order=name.asc"),
        api("GET", "/rest/v1/hintergruende?select=*&order=name.asc"),
        api("GET", "/rest/v1/targets?select=*&order=name.asc"),
      ]);
      setOperationen(op || []);
      setSigillen(si || []);
      setRaten(ra || []);
      setQuellen(qu || []);
      setPlaene(pl || []);
      setZiele(zi || []);
      holBilder([
        ...(op || []).map((o) => o.hintergrund),
        ...(si || []).map((s) => s.bild),
        ...(pl || []).map((x) => x.bild),
        ...(zi || []).map((x) => x.bild),
      ]);
    } catch (e) {
      sag("laden ging nicht: " + String(e.message), "schlimm");
    }
    setLaedt(false);
  }, [api, holBilder]);

  useEffect(() => { laden(); }, [laden]);

  // die uhr fuer puls und LED — einmal zentral, nicht je bauteil
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const u = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(u);
  }, []);

  // das lebenszeichen vom server regelmaessig nachsehen
  useEffect(() => {
    const u = setInterval(async () => {
      try {
        const d = await api("GET", "/rest/v1/operationen?select=id,puls,letzter_puls,aktiv");
        if (!d) return;
        setOperationen((l) => l.map((o) => {
          const n = d.find((x) => x.id === o.id);
          return n ? { ...o, puls: n.puls, letzter_puls: n.letzter_puls, aktiv: n.aktiv } : o;
        }));
      } catch {}
    }, 30000);
    return () => clearInterval(u);
  }, [api]);

  // ---------- operationen ----------
  const operationAnlegen = async () => {
    const neu = {
      id: neueId(), titel: "", intention: "", target: "", takt: 60,
      aktiv: false, zuletzt: new Date().toISOString(),
    };
    try {
      await api("POST", "/rest/v1/operationen", neu);
      setOperationen((l) => [neu, ...l]);
      setOffen(neu.id);
    } catch (e) { sag(String(e.message), "schlimm"); }
  };

  // Text wird gebremst weggeschrieben — sonst eine anfrage je buchstabe.
  // Schalter, takt und datum gehen sofort, da wartet man nicht gern.
  const uhren = useRef({});
  const offenes = useRef({});

  const operationAendern = (id, was) => {
    setOperationen((l) => l.map((o) => (o.id === id ? { ...o, ...was } : o)));
    const schreiben = (stoff) => api("PATCH", `/rest/v1/operationen?id=eq.${id}`,
      { ...stoff, zuletzt: new Date().toISOString() }).catch((e) => sag(String(e.message), "schlimm"));

    const nurText = Object.keys(was).every(
      (k) => k === "intention" || k === "target" || k === "titel");
    if (!nurText) {
      const stoff = { ...offenes.current[id], ...was };
      offenes.current[id] = null;
      clearTimeout(uhren.current[id]);
      schreiben(stoff);
      return;
    }
    offenes.current[id] = { ...offenes.current[id], ...was };
    clearTimeout(uhren.current[id]);
    uhren.current[id] = setTimeout(() => {
      const stoff = offenes.current[id];
      offenes.current[id] = null;
      if (stoff) schreiben(stoff);
    }, 700);
  };

  // was noch offen ist, beim verlassen wegschreiben
  useEffect(() => () => {
    Object.keys(uhren.current).forEach((id) => {
      clearTimeout(uhren.current[id]);
      const stoff = offenes.current[id];
      if (stoff) api("PATCH", `/rest/v1/operationen?id=eq.${id}`,
        { ...stoff, zuletzt: new Date().toISOString() }).catch(() => {});
    });
  }, [api]);

  const operationWeg = async (id) => {
    const o = operationen.find((x) => x.id === id);
    if (!confirm(`operation „${(o && o.intention) || "ohne titel"}" löschen?\n\n`
      + "die schaltung und ihr logbuch sind dann weg. sigillen und raten bleiben.")) return;
    setOperationen((l) => l.filter((x) => x.id !== id));
    if (offen === id) setOffen(null);
    try { await api("DELETE", `/rest/v1/operationen?id=eq.${id}`); }
    catch (e) { sag(String(e.message), "schlimm"); }
  };

  // Nachsehen, ob die datenbank alles hat, was dieser raum braucht.
  // Fehlt ein stueck, sieht man es sonst erst daran, dass etwas still
  // nicht funktioniert.
  const nachsehen = async () => {
    setBericht(["wird geprüft …"]);
    const zeilen = [];
    const pruefe = async (name, was) => {
      try { await was(); zeilen.push("✓ " + name); }
      catch (e) { zeilen.push("✗ " + name + " — " + String(e && e.message).slice(0, 80)); }
    };

    for (const tab of ["operationen", "bauteile", "logbuch", "operation_quellen",
                       "sigillen", "raten", "quellen", "hintergruende", "targets", "auslesungen"])
      await pruefe("tabelle " + tab, () => api("GET", `/rest/v1/${tab}?select=*&limit=1`));

    await pruefe("spalte operationen.titel",
      () => api("GET", "/rest/v1/operationen?select=titel&limit=1"));
    await pruefe("spalte bauteile.target_id",
      () => api("GET", "/rest/v1/bauteile?select=target_id&limit=1"));

    // den eimer selbst fragen, nicht seinen inhalt: eine leere liste
    // kommt auch dann freundlich zurueck, wenn es ihn gar nicht gibt
    await pruefe("ablagefach " + EIMER, async () => {
      const si = await zugang();
      if (!si) throw new Error("nicht angemeldet");
      const r = await fetch(`${URL_DB}/storage/v1/bucket/${EIMER}`, {
        headers: { Authorization: "Bearer " + si.access_token, apikey: KEY_DB },
      });
      if (!r.ok) throw new Error(`(${r.status}) ` + (await r.text()).slice(0, 100));
    });

    // und einmal wirklich etwas hineinschreiben — nur so zeigt sich,
    // ob die zugriffsregel das hochladen erlaubt
    await pruefe("hineinschreiben dürfen", async () => {
      const si = await zugang();
      if (!si) throw new Error("nicht angemeldet");
      const pfad = `${si.user.id}/probe/${neueId()}.txt`;
      const r = await fetch(`${URL_DB}/storage/v1/object/${EIMER}/${pfad}`, {
        method: "POST",
        headers: { Authorization: "Bearer " + si.access_token, apikey: KEY_DB,
                   "Content-Type": "text/plain", "x-upsert": "true" },
        body: new Blob(["probe"], { type: "text/plain" }),
      });
      if (!r.ok) throw new Error(`(${r.status}) ` + (await r.text()).slice(0, 100));
      await fetch(`${URL_DB}/storage/v1/object/${EIMER}/${pfad}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + si.access_token, apikey: KEY_DB },
      }).catch(() => {});
    });

    await pruefe("der puls in der datenbank",
      () => api("POST", "/rest/v1/rpc/maschinenraum_puls", {}));

    setBericht(zeilen);
  };

  // Aus den angehakten treffern einer auslesung wird eine fertige schaltung:
  // das ziel als erstes kaestchen, jede rate und sigille als verstaerker im
  // kreis, quellen angehaengt, ein hintergrund als schaltplan. Die absicht
  // bleibt leer — die formuliert sie selbst, und erst dann laesst sich
  // anschalten.
  const operationAusLesung = async (a, gewaehlt) => {
    const opId = neueId();
    const jetzt = new Date().toISOString();
    const finde = (liste, e) => liste.find((x) => x.id === e.id) || liste.find((x) => x.name === e.name);
    const plan = gewaehlt.filter((e) => e.art === "hintergruende").map((e) => finde(plaene, e)).find((x) => x && x.bild);
    const op = {
      id: opId, titel: (a.frage || a.target || "aus einer auslesung").slice(0, 60),
      intention: "", target: a.target || "", takt: 60, aktiv: false, zuletzt: jetzt,
      ...(plan ? { hintergrund: plan.bild } : {}),
    };
    try {
      await api("POST", "/rest/v1/operationen", op);

      const ziel = ziele.find((x) => x.name.trim().toLowerCase() === (a.target || "").trim().toLowerCase());
      const teile = [{ bezeichnung: a.target || "ziel", art: "target", target_id: ziel ? ziel.id : null }];
      gewaehlt.forEach((e) => {
        if (e.art === "raten") {
          const r = finde(raten, e);
          teile.push({ bezeichnung: e.name, art: "verstaerker", rate_id: r ? r.id : null });
        } else if (e.art === "sigillen") {
          const g = finde(sigillen, e);
          teile.push({ bezeichnung: e.name, art: "verstaerker", sigille_id: g ? g.id : null });
        }
      });
      for (let i = 0; i < teile.length; i++) {
        const w = Math.PI + (i / teile.length) * 2 * Math.PI;      // im kreis, das ziel links
        await api("POST", "/rest/v1/bauteile", {
          id: neueId(), operation_id: opId, nummer: i + 1,
          x: 50 + 34 * Math.cos(w), y: 50 + 32 * Math.sin(w), ...teile[i],
        });
      }
      for (const e of gewaehlt.filter((x) => x.art === "quellen")) {
        const q = finde(quellen, e);
        if (q) await api("POST", "/rest/v1/operation_quellen", { operation_id: opId, quelle_id: q.id });
      }
      await api("POST", "/rest/v1/logbuch", {
        id: neueId(), operation_id: opId, art: "notiz", wann: jetzt,
        text: "aus der auslesung vom " + new Date(a.wann).toLocaleString("de") + ": "
          + (a.frage ? "frage „" + a.frage + "\" — " : "")
          + gewaehlt.map((e) => e.name + " (" + (e.wert > 0 ? "+" : "") + e.wert + ")").join(", "),
      });

      setOperationen((l) => [op, ...l]);
      setLiest(false);
      setOffen(opId);
      sag("operation angelegt — formuliere oben deine absicht, dann anschalten");
    } catch (e) { sag(String(e.message), "schlimm"); }
  };

  const dieOffene = (!schrank && !liest && operationen.find((o) => o.id === offen)) || null;

  // ---------- anzeige ----------
  return (
    <div className="mraum">
      <MaschinenStil />

      <div className="mkopf">
        <button className="mbtn" onClick={() => {
          if (liest) setLiest(false);
          else if (schrank) setSchrank(null);     // zurueck in die offene operation
          else if (offen) setOffen(null);
          else zurueck();
        }}>‹ {liest ? "maschinenraum" : schrank ? (offen ? "operation" : "maschinenraum")
              : offen ? "operationen" : "zurück"}</button>

        {dieOffene
          ? <input className="mtitel mtitelfeld" value={dieOffene.titel || ""}
              placeholder="operation" spellCheck={false}
              onChange={(e) => operationAendern(dieOffene.id, { titel: e.target.value })} />
          : <span className="mtitel">
              {liest ? "auslesen" : schrank === "hintergruende" ? "hintergründe" : schrank || "maschinenraum"}
            </span>}

        <span className="mfuell" />

        {!schrank && !liest && (
          <>
            {!offen && <button className="mbtn lesen" onClick={() => setLiest(true)}>auslesen</button>}
            <button className="mbtn" onClick={() => { setTagMit(""); setSchrank("sigillen"); }}>sigillen</button>
            <button className="mbtn" onClick={() => { setTagMit(""); setSchrank("raten"); }}>raten</button>
            <button className="mbtn" onClick={() => { setTagMit(""); setSchrank("quellen"); }}>quellen</button>
            <button className="mbtn" onClick={() => { setTagMit(""); setSchrank("hintergruende"); }}>hintergründe</button>
            <button className="mbtn" onClick={() => { setTagMit(""); setSchrank("targets"); }}>targets</button>
          </>
        )}
      </div>

      {meldung && (
        <div className={"mmeldung " + meldung.art} onClick={() => setMeldung(null)}>
          {meldung.text}
          {meldung.art === "schlimm" && <small>antippen zum schliessen</small>}
        </div>
      )}

      {laedt && <p className="mleer">wird geholt …</p>}

      {!laedt && liest && (
        <Auslesen api={api} sag={sag} zurOperation={operationAusLesung}
          alle={{ sigillen, raten, quellen, hintergruende: plaene, targets: ziele }} />
      )}

      {!laedt && !liest && schrank && (
        <Schrank key={schrank + "|" + tagMit}
          art={schrank} api={api} sag={sag} vorgabe={tagMit}
          wechseln={(a, tag) => { setTagMit(tag); setSchrank(a); }}
          alle={{ sigillen, raten, quellen, hintergruende: plaene, targets: ziele }}
          sigillen={sigillen} setSigillen={setSigillen}
          raten={raten} setRaten={setRaten}
          quellen={quellen} setQuellen={setQuellen}
          plaene={plaene} setPlaene={setPlaene}
          ziele={ziele} setZiele={setZiele}
          operationen={operationen}
          bilder={bilder} hochladen={hochladen}
        />
      )}

      {!laedt && !schrank && !liest && !dieOffene && bericht && (
        <div className="mbericht">
          <div className="mberichtkopf">
            <span className="mwandtitel">was die datenbank hat</span>
            <button className="mklein" onClick={() => setBericht(null)}>✕</button>
          </div>
          {bericht.map((z, i) => (
            <div key={i} className={z.startsWith("✗") ? "mzeile schlecht" : "mzeile gut"}>{z}</div>
          ))}
          {bericht.some((z) => z.startsWith("✗")) && (
            <p className="mhinweis">
              was hier ein ✗ hat, fehlt in supabase — dann kann die app es auch nicht.
            </p>
          )}
        </div>
      )}

      {!laedt && !schrank && !liest && !dieOffene && (
        <Uebersicht
          operationen={operationen} bilder={bilder} tick={tick}
          oeffnen={setOffen} anlegen={operationAnlegen} weg={operationWeg}
          nachsehen={nachsehen}
        />
      )}

      {!laedt && !schrank && dieOffene && (
        <OperationsSeite
          op={dieOffene} api={api} sag={sag} tick={tick}
          aendern={(was) => operationAendern(dieOffene.id, was)}
          sigillen={sigillen} raten={raten} quellen={quellen} plaene={plaene} ziele={ziele}
          bilder={bilder} hochladen={hochladen} holBilder={holBilder}
          rateDazu={(r) => setRaten((l) => [...l, r].sort(
            (a, b) => a.name.localeCompare(b.name, "de")))}
          planDazu={(x) => setPlaene((l) => [...l, x].sort(
            (a, b) => a.name.localeCompare(b.name, "de")))}
        />
      )}
    </div>
  );
}

// ============================================================
// DIE ÜBERSICHT — kacheln wie bei projekten und filmen
// ============================================================
function Uebersicht({ operationen, bilder, tick, oeffnen, anlegen, weg, nachsehen }) {
  // leicht schraege kacheln, aber immer gleich schief — aus der id gerechnet
  const kippung = (id) => {
    let z = 0;
    for (let i = 0; i < id.length; i++) z = (z * 31 + id.charCodeAt(i)) % 1000;
    return ((z % 180) - 90) / 90 * 2.2;
  };

  return (
    <div className="mfeld">
      <button className="mkachel neu" onClick={anlegen}>
        <span className="mplus">+</span>
        <span className="mkachelname">neue operation</span>
      </button>

      {operationen.map((o) => {
        const satz = o.titel || o.intention || "ohne titel";
        const puls = pulsJetzt(o);
        const gesund = lebt(o);
        return (
          <div className="mkachelhuelle" key={o.id}>
            <button className={"mkachel" + (o.aktiv ? " an" : "")}
              style={{ transform: `rotate(${kippung(o.id)}deg)` }}
              onClick={() => oeffnen(o.id)}>
              <span className="mkachelkopf">
                <Led an={o.aktiv} takt={o.takt} gestartet={o.gestartet} gesund={gesund} />
                <span className="mkachelzustand">
                  {o.aktiv ? (gesund ? "läuft" : "puls stockt") : o.beendet ? "beendet" : "aus"}
                </span>
              </span>
              <span className="mkachelsatz">{satz}</span>
              {o.target && <span className="mkachelziel">für {o.target}</span>}
              <span className="mkachelzeile">
                {o.aktiv && <span>{puls.toLocaleString("de")} impulse · seit {seitWann(o.gestartet)}</span>}
                {!o.aktiv && <span>{taktText(o.takt || 60)}</span>}
                {o.test_am && <span className="mtest">test {new Date(o.test_am).toLocaleDateString("de")}</span>}
              </span>
            </button>
            <button className="mweg" onClick={() => weg(o.id)} title="operation löschen">✕</button>
          </div>
        );
      })}

      {operationen.length === 0 && (
        <p className="mleer">noch keine operation. das + legt eine an.</p>
      )}

      <button className="mnachsehen" onClick={nachsehen}>
        nachsehen, ob die datenbank alles hat
      </button>
    </div>
  );
}

// ============================================================
// DIE LED — glüht auf, klingt nach. im takt der frequenz.
// ============================================================
function Led({ an, takt, gestartet, gesund }) {
  const [schlaegt, setSchlaegt] = useState(false);

  // Der schlag liegt auf dem WIRKLICHEN takt: gestartet + n mal takt.
  // Vorher lief eine CSS-uhr mit eigener rechnung, die mit dem puls in
  // der datenbank nichts zu tun hatte.
  useEffect(() => {
    if (!an) { setSchlaegt(false); return; }
    const t = Math.max(takt || 60, 1) * 1000;
    const start = gestartet ? new Date(gestartet).getTime() : Date.now();
    const hell = Math.min(650, t * 0.45);
    let takten, loeschen;

    const schlagen = () => {
      setSchlaegt(true);
      loeschen = setTimeout(() => setSchlaegt(false), hell);
      takten = setTimeout(schlagen, t);
    };

    // bis zum naechsten takt-moment warten, nicht sofort losschlagen
    const seit = Date.now() - start;
    takten = setTimeout(schlagen, t - (((seit % t) + t) % t));

    return () => { clearTimeout(takten); clearTimeout(loeschen); };
  }, [an, takt, gestartet]);

  return (
    <span className={"mled" + (an ? " an" : "") + (an && !gesund ? " krank" : "")
                     + (schlaegt && gesund ? " schlaegt" : "")}
      title={an ? (gesund ? "puls läuft im takt" : "der puls stockt — nachsehen") : "aus"}>
      <i />
      <b />
    </span>
  );
}

// ============================================================
// EINE OPERATION
// ============================================================
function OperationsSeite({ op, api, sag, tick, aendern, sigillen, raten, quellen, plaene, ziele,
                           bilder, hochladen, holBilder, rateDazu, planDazu }) {
  const [bauteile, setBauteile] = useState([]);
  const [eintraege, setEintraege] = useState([]);
  const [meine, setMeine] = useState([]);        // quellen-ids an dieser operation
  const [gewaehlt, setGewaehlt] = useState(null); // offenes bauteil
  const [platte, setPlatte] = useState(false);

  const feldRef = useRef(null);
  const zugRef = useRef(null);
  const uhren = useRef({});
  const [form, setForm] = useState(null);   // seitenverhaeltnis des schaltplans

  // ---------- laden ----------
  useEffect(() => {
    let fort = false;
    (async () => {
      try {
        const [b, l, q] = await Promise.all([
          api("GET", `/rest/v1/bauteile?select=*&operation_id=eq.${op.id}&order=nummer.asc`),
          api("GET", `/rest/v1/logbuch?select=*&operation_id=eq.${op.id}&order=wann.desc`),
          api("GET", `/rest/v1/operation_quellen?select=quelle_id&operation_id=eq.${op.id}`),
        ]);
        if (fort) return;
        setBauteile(b || []);
        setEintraege(l || []);
        setMeine((q || []).map((x) => x.quelle_id));
        holBilder([...(b || []).map((x) => x.bild), op.hintergrund]);
        // auch die bilder, die ueber sigille oder target haengen
      } catch (e) { sag(String(e.message), "schlimm"); }
    })();
    return () => { fort = true; };
  }, [op.id, api, sag, holBilder]);

  // ---------- bauteile ----------
  const bauteilAnlegen = async (art) => {
    const hoechste = bauteile.reduce((m, b) => Math.max(m, b.nummer || 0), 0);
    const neu = {
      id: neueId(), operation_id: op.id, bezeichnung: "",
      art: art || "verstaerker", x: 20 + Math.random() * 60, y: 20 + Math.random() * 55,
      nummer: hoechste + 1,
    };
    setBauteile((l) => [...l, neu]);
    setGewaehlt(neu.id);
    try { await api("POST", "/rest/v1/bauteile", neu); }
    catch (e) {
      setBauteile((l) => l.filter((b) => b.id !== neu.id));
      setGewaehlt(null);
      sag(String(e.message), "schlimm");
    }
  };

  const bauteilAendern = (id, was, sofort) => {
    setBauteile((l) => l.map((b) => (b.id === id ? { ...b, ...was } : b)));
    const schreiben = () => api("PATCH", `/rest/v1/bauteile?id=eq.${id}`, was)
      .catch((e) => sag(String(e.message), "schlimm"));
    if (sofort) { schreiben(); return; }
    clearTimeout(uhren.current[id]);
    uhren.current[id] = setTimeout(schreiben, 800);
  };

  // position waehlen heisst tauschen — sonst gaebe es luecken oder doppelte
  const nummerSetzen = (id, zahl) => {
    const b = bauteile.find((x) => x.id === id);
    if (!b || b.nummer === zahl) return;
    const anderer = bauteile.find((x) => x.id !== id && x.nummer === zahl);
    bauteilAendern(id, { nummer: zahl }, true);
    if (anderer) bauteilAendern(anderer.id, { nummer: b.nummer }, true);
  };

  const bauteilWeg = async (id) => {
    const weg = bauteile.find((b) => b.id === id);
    const rest = bauteile.filter((b) => b.id !== id);
    setBauteile(rest);
    if (gewaehlt === id) setGewaehlt(null);
    try {
      await api("DELETE", `/rest/v1/bauteile?id=eq.${id}`);
      // die luecke in der reihenfolge schliessen
      if (weg) for (const b of rest) {
        if ((b.nummer || 0) > (weg.nummer || 0)) bauteilAendern(b.id, { nummer: b.nummer - 1 }, true);
      }
    } catch (e) { sag(String(e.message), "schlimm"); }
  };

  // ---------- ziehen auf dem schaltplan ----------
  const griffAn = (e, b) => {
    if (e.button === 2) return;
    const feld = feldRef.current;
    if (!feld) return;
    e.preventDefault();
    const kasten = feld.getBoundingClientRect();
    zugRef.current = {
      id: b.id,
      dx: e.clientX - (kasten.left + (b.x / 100) * kasten.width),
      dy: e.clientY - (kasten.top + (b.y / 100) * kasten.height),
      bewegt: false,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  };

  const griffZieht = (e) => {
    const z = zugRef.current;
    const feld = feldRef.current;
    if (!z || !feld) return;
    const kasten = feld.getBoundingClientRect();
    const x = Math.max(1, Math.min(99, ((e.clientX - z.dx - kasten.left) / kasten.width) * 100));
    const y = Math.max(1, Math.min(99, ((e.clientY - z.dy - kasten.top) / kasten.height) * 100));
    z.bewegt = true;
    z.x = x; z.y = y;          // im zug mitfuehren — der state ist noch nicht nachgezogen
    setBauteile((l) => l.map((b) => (b.id === z.id ? { ...b, x, y } : b)));
  };

  const griffLos = () => {
    const z = zugRef.current;
    zugRef.current = null;
    if (!z) return;
    if (!z.bewegt) { setGewaehlt(z.id); return; }
    // die lage kommt aus dem zug, nicht aus dem state: bei schnellem
    // loslassen stuende dort noch der alte wert und wuerde zurueckgeschrieben
    bauteilAendern(z.id, { x: z.x, y: z.y }, true);
  };

  // wer draussen loslaesst, soll nicht weiterziehen muessen
  useEffect(() => {
    const auf = () => griffLos();
    window.addEventListener("pointerup", auf);
    window.addEventListener("pointercancel", auf);
    return () => {
      window.removeEventListener("pointerup", auf);
      window.removeEventListener("pointercancel", auf);
    };
  });

  // ---------- an und aus ----------
  const anschalten = () => {
    if (!op.intention.trim()) { sag("erst die absicht formulieren"); return; }
    aendern({ aktiv: true, gestartet: new Date().toISOString(), beendet: null, puls: 0,
              letzter_puls: new Date().toISOString() });
    eintragAnlegen("notiz", "angeschaltet");
  };

  const ausschalten = () => {
    aendern({ aktiv: false, beendet: new Date().toISOString() });
    eintragAnlegen("ende", "abgeschaltet");
  };

  // ---------- logbuch ----------
  const [neuerEintrag, setNeuerEintrag] = useState("");
  const eintragAnlegen = async (art, text) => {
    const e = { id: neueId(), operation_id: op.id, art, text, wann: new Date().toISOString() };
    setEintraege((l) => [e, ...l]);
    try { await api("POST", "/rest/v1/logbuch", e); }
    catch (err) { sag(String(err.message), "schlimm"); }
  };

  const eintragWeg = async (id) => {
    setEintraege((l) => l.filter((e) => e.id !== id));
    try { await api("DELETE", `/rest/v1/logbuch?id=eq.${id}`); } catch {}
  };

  // ---------- quellen an- und abhaengen ----------
  const quelleUm = async (qid) => {
    const dran = meine.includes(qid);
    setMeine((l) => (dran ? l.filter((x) => x !== qid) : [...l, qid]));
    try {
      if (dran) await api("DELETE",
        `/rest/v1/operation_quellen?operation_id=eq.${op.id}&quelle_id=eq.${qid}`);
      else await api("POST", "/rest/v1/operation_quellen",
        { operation_id: op.id, quelle_id: qid });
    } catch (e) { sag(String(e.message), "schlimm"); }
  };

  // ---------- hintergrund ----------
  // Ein eingelegter plan wandert gleich in den schrank — dort kannst du
  // ihm einen namen und eine beschreibung geben. Nicht jeder schaltplan
  // erklaert sich von selbst.
  const hintergrundWaehlen = async (datei) => {
    if (!datei) return;
    try {
      const pfad = await hochladen(datei, "schaltungen");
      const eintrag = {
        id: neueId(),
        name: (datei.name || "schaltplan").replace(/\.[^.]+$/, ""),
        bild: pfad, beschreibung: "",
      };
      await api("POST", "/rest/v1/hintergruende", eintrag);
      planDazu(eintrag);
      setForm(null);
      aendern({ hintergrund: pfad });
      sag("liegt jetzt auch im hintergrund-schrank — dort kannst du ihn benennen und beschreiben");
    } catch (e) { sag(String(e.message), "schlimm"); }
  };

  // Ein kaestchen zeigt sein eigenes bild — und wenn es keines hat, das
  // der verknuepften sigille oder des targets. Sonst muesste man jedes
  // bild zweimal einlegen.
  const bauteilBild = (b) => {
    if (b.bild) return b.bild;
    const z = b.target_id && ziele.find((x) => x.id === b.target_id);
    if (z && z.bild) return z.bild;
    const g = b.sigille_id && sigillen.find((x) => x.id === b.sigille_id);
    if (g && g.bild) return g.bild;
    return null;
  };

  const aktiv = amZug(op, bauteile);
  const puls = pulsJetzt(op);
  const gesund = lebt(op);
  const dasBauteil = bauteile.find((b) => b.id === gewaehlt) || null;

  return (
    <div className="mop">

      {/* ---------- der satz ---------- */}
      <div className="msatz">
        <label className="mhaelfte">
          <span className="msatzwort">meine absicht ist</span>
          <textarea className="mfeldgross" value={op.intention} rows={2}
            placeholder="… was eintreten soll, so wie du es prüfen würdest"
            onChange={(e) => aendern({ intention: e.target.value })} />
        </label>
        <label className="mhaelfte">
          <span className="msatzwort">für das ziel</span>
          <textarea className="mfeldgross ziel" value={op.target} rows={2}
            placeholder="… wer oder was"
            onChange={(e) => aendern({ target: e.target.value })} />
          {ziele.length > 0 && (
            <select className="mausschrank" value=""
              onChange={(e) => { if (e.target.value) aendern({ target: e.target.value }); }}>
              <option value="">aus dem target-schrank …</option>
              {ziele.map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}
            </select>
          )}
        </label>
      </div>

      {/* ---------- der maschinenteil ---------- */}
      <div className="mmaschine">
        <div className={"mschaltung" + (form ? " hatplan" : "")} ref={feldRef}
          style={form ? { aspectRatio: String(form) } : undefined}
          onPointerMove={griffZieht} onPointerUp={griffLos} onPointerCancel={griffLos}>

          {op.hintergrund && bilder[op.hintergrund]
            ? <img className="mgrund" src={bilder[op.hintergrund]} alt="" draggable={false}
                onLoad={(e) => {
                  const b = e.target;
                  if (b.naturalWidth && b.naturalHeight)
                    setForm(b.naturalWidth / b.naturalHeight);
                }} />
            : <div className="mgrundleer">
                <span>kein schaltplan</span>
                <small>lege unten ein bild ein — hieronymus-tafel, eigene zeichnung, was du willst</small>
              </div>}

          {/* die leitung von bauteil zu bauteil, in der reihenfolge */}
          {bauteile.length > 1 && (
            <svg className="mleitung" viewBox="0 0 100 100" preserveAspectRatio="none">
              {[...bauteile].sort((a, b) => a.nummer - b.nummer).map((b, i, arr) => {
                if (i === arr.length - 1) return null;
                const n = arr[i + 1];
                return <line key={b.id} x1={b.x} y1={b.y} x2={n.x} y2={n.y}
                  vectorEffect="non-scaling-stroke" />;
              })}
              {(() => {
                const arr = [...bauteile].sort((a, b) => a.nummer - b.nummer);
                const a = arr[arr.length - 1], b = arr[0];
                return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  className="zurueck" vectorEffect="non-scaling-stroke" />;
              })()}
            </svg>
          )}

          {bauteile.map((b) => (
            <div key={b.id}
              className={"mbauteil " + b.art
                + (aktiv && aktiv.id === b.id ? " amzug" : "")
                + (gewaehlt === b.id ? " gewaehlt" : "")}
              style={{ left: b.x + "%", top: b.y + "%" }}
              title={b.bezeichnung || ""}
              onPointerDown={(e) => griffAn(e, b)}>
              <span className="mnummer">{b.nummer}</span>
              {/* das art-zeichen bleibt sichtbar, auch wenn ein bild drin liegt */}
              <span className="martkreis">
                {(ARTEN.find((a) => a.wert === b.art) || ARTEN[2]).zeichen}
              </span>
              {(() => {
                const pfad = bauteilBild(b);
                return pfad && bilder[pfad]
                  ? <img src={bilder[pfad]} alt="" draggable={false} />
                  : <span className="mzeichen">
                      {(ARTEN.find((a) => a.wert === b.art) || ARTEN[2]).zeichen}
                    </span>;
              })()}
            </div>
          ))}
        </div>

        {/* ---------- die seitenwand ---------- */}
        <div className="mwand">

          <div className="mschalter">
            <Led an={op.aktiv} takt={op.takt} gestartet={op.gestartet} gesund={gesund} />
            <button className={"mhebel" + (op.aktiv ? " an" : "")}
              onClick={op.aktiv ? ausschalten : anschalten}>
              {op.aktiv ? "abschalten" : "anschalten"}
            </button>
          </div>

          {op.aktiv && (
            <div className="mstand">
              <b>{puls.toLocaleString("de")}</b> impulse
              <small>seit {seitWann(op.gestartet)}</small>
              {aktiv && <small>jetzt bei {aktiv.nummer} · {aktiv.bezeichnung || "ohne namen"}</small>}
              <small className={gesund ? "mgut" : "mschlecht"}>
                {gesund
                  ? "server-puls vor " + seitWann(op.letzter_puls)
                  : "der puls stockt — letztes lebenszeichen vor " + seitWann(op.letzter_puls)}
              </small>
            </div>
          )}

          <label className="mfeldchen">
            <span>takt</span>
            <select value={op.takt || 60}
              onChange={(e) => aendern({ takt: Number(e.target.value) })}>
              <option value={5}>alle 5 sekunden</option>
              <option value={15}>alle 15 sekunden</option>
              <option value={30}>alle 30 sekunden</option>
              <option value={60}>jede minute — ruhepuls</option>
              <option value={300}>alle 5 minuten</option>
              <option value={900}>alle 15 minuten</option>
              <option value={3600}>stündlich</option>
            </select>
          </label>

          <label className="mfeldchen">
            <span>test am</span>
            <input type="date" value={op.test_am || ""}
              onChange={(e) => aendern({ test_am: e.target.value || null })} />
          </label>

          <label className="mfeldchen">
            <span>schaltplan</span>
            <select value={plaene.some((x) => x.bild === op.hintergrund) ? op.hintergrund : ""}
              onChange={(e) => { setForm(null); aendern({ hintergrund: e.target.value || null }); }}>
              <option value="">
                {op.hintergrund && !plaene.some((x) => x.bild === op.hintergrund)
                  ? "— eigener —" : "— keiner —"}
              </option>
              {plaene.map((x) => <option key={x.id} value={x.bild}>{x.name}</option>)}
            </select>
          </label>

          <label className="mdateiknopf">
            neuen plan einlegen
            <input type="file" accept="image/*"
              onChange={(e) => hintergrundWaehlen(e.target.files && e.target.files[0])} />
          </label>

          <div className="mquellen">
            <span className="mwandtitel">weitere quellen</span>
            {quellen.length === 0 && <small className="mhinweis">noch keine angelegt</small>}
            {quellen.map((q) => (
              <label key={q.id} className="mquelle">
                <input type="checkbox" checked={meine.includes(q.id)}
                  onChange={() => quelleUm(q.id)} />
                <span>{q.name}</span>
              </label>
            ))}
          </div>

          <button className="mbtn breit" onClick={() => setPlatte((p) => !p)}>
            {platte ? "stick-platte zu" : "stick-platte"}
          </button>
        </div>
      </div>

      {/* ---------- bauteil hinzufügen ---------- */}
      <div className="mzeile">
        {ARTEN.map((a) => (
          <button key={a.wert} className="mbtn" onClick={() => bauteilAnlegen(a.wert)}>
            + {a.name}
          </button>
        ))}
      </div>

      {platte && <StickPlatte api={api} sag={sag} rateDazu={rateDazu} />}

      {/* ---------- das gewählte bauteil ---------- */}
      {dasBauteil && (
        <BauteilBlatt
          b={dasBauteil} aendern={bauteilAendern} weg={bauteilWeg}
          zu={() => setGewaehlt(null)} sigillen={sigillen} raten={raten}
          bilder={bilder} hochladen={hochladen} sag={sag} ziele={ziele}
          anzahl={bauteile.length} nummerSetzen={nummerSetzen}
        />
      )}

      {/* ---------- logbuch ---------- */}
      <div className="mlog">
        <span className="mwandtitel">logbuch</span>
        <p className="mhinweis">
          deine absicht ist der test. hier steht, was du siehst — und ob es durch ist.
        </p>
        <div className="mlogzeile">
          <input value={neuerEintrag} placeholder="was ist zu beobachten?"
            onChange={(e) => setNeuerEintrag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && neuerEintrag.trim()) {
                eintragAnlegen("notiz", neuerEintrag.trim());
                setNeuerEintrag("");
              }
            }} />
          <button className="mbtn" disabled={!neuerEintrag.trim()}
            onClick={() => { eintragAnlegen("notiz", neuerEintrag.trim()); setNeuerEintrag(""); }}>
            notiz
          </button>
          <button className="mbtn pruef" disabled={!neuerEintrag.trim()}
            onClick={() => { eintragAnlegen("test", neuerEintrag.trim()); setNeuerEintrag(""); }}>
            test
          </button>
        </div>
        {eintraege.map((e) => (
          <div key={e.id} className={"meintrag " + e.art}>
            <span className="mwann">{new Date(e.wann).toLocaleString("de",
              { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
            <span className="martzeichen">
              {e.art === "test" ? "◉" : e.art === "ende" ? "■" : "·"}
            </span>
            <span className="mtext">{e.text}</span>
            <button className="mklein" onClick={() => eintragWeg(e.id)} title="eintrag weg">✕</button>
          </div>
        ))}
        {eintraege.length === 0 && <small className="mhinweis">noch nichts eingetragen</small>}
      </div>
    </div>
  );
}

// ============================================================
// DAS BLATT FÜR EIN BAUTEIL
// ============================================================
function BauteilBlatt({ b, aendern, weg, zu, sigillen, raten, ziele, bilder, hochladen, sag,
                        anzahl, nummerSetzen }) {
  const bildWaehlen = async (datei) => {
    if (!datei) return;
    try {
      const pfad = await hochladen(datei, "bauteile");
      aendern(b.id, { bild: pfad, sigille_id: null }, true);
    } catch (e) { sag(String(e.message), "schlimm"); }
  };

  return (
    <div className="mblatt">
      <div className="mblattkopf">
        <span className="mnummer gross">{b.nummer}</span>
        <input className="mbezfeld" value={b.bezeichnung} placeholder="bezeichnung"
          onChange={(e) => aendern(b.id, { bezeichnung: e.target.value })} />
        <button className="mklein" onClick={zu} title="zuklappen">✕</button>
      </div>

      <div className="mblattreihe">
        <label className="mfeldchen">
          <span>art</span>
          <select value={b.art} onChange={(e) => aendern(b.id, { art: e.target.value }, true)}>
            {ARTEN.map((a) => <option key={a.wert} value={a.wert}>{a.name}</option>)}
          </select>
        </label>

        <label className="mfeldchen">
          <span>position</span>
          <select value={b.nummer}
            onChange={(e) => nummerSetzen(b.id, Number(e.target.value))}>
            {Array.from({ length: Math.max(anzahl, b.nummer) }, (_, i) => i + 1)
              .map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>

        <label className="mfeldchen">
          <span>sigille</span>
          <select value={b.sigille_id || ""}
            onChange={(e) => aendern(b.id, { sigille_id: e.target.value || null }, true)}>
            <option value="">—</option>
            {sigillen.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>

        <label className="mfeldchen">
          <span>rate</span>
          <select value={b.rate_id || ""}
            onChange={(e) => aendern(b.id, { rate_id: e.target.value || null }, true)}>
            <option value="">—</option>
            {raten.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.ziffern}</option>)}
          </select>
        </label>

        <label className="mfeldchen">
          <span>target</span>
          <select value={b.target_id || ""}
            onChange={(e) => {
              const id = e.target.value || null;
              const z = id && ziele.find((x) => x.id === id);
              aendern(b.id, z && !b.bezeichnung
                ? { target_id: id, bezeichnung: z.name } : { target_id: id }, true);
            }}>
            <option value="">—</option>
            {ziele.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
      </div>

      <div className="mblattreihe">
        <label className="mdateiknopf">
          {b.bild ? "bild wechseln" : "eigenes bild"}
          <input type="file" accept="image/*"
            onChange={(e) => bildWaehlen(e.target.files && e.target.files[0])} />
        </label>
        {(() => {
          const z = b.target_id && ziele.find((x) => x.id === b.target_id);
          const g = b.sigille_id && sigillen.find((x) => x.id === b.sigille_id);
          const pfad = b.bild || (z && z.bild) || (g && g.bild);
          if (!pfad || !bilder[pfad]) return null;
          return (
            <span className="mprobefeld">
              <img className="mprobe" src={bilder[pfad]} alt="" />
              {!b.bild && <small>aus {z && z.bild ? "dem target" : "der sigille"}</small>}
            </span>
          );
        })()}
        {/* was in den schraenken zu sigille, rate und target steht — zum
            nachlesen, geaendert wird es im schrank */}
        {(() => {
          const g = b.sigille_id && sigillen.find((x) => x.id === b.sigille_id);
          const r = b.rate_id && raten.find((x) => x.id === b.rate_id);
          const z = b.target_id && ziele.find((x) => x.id === b.target_id);
          const stuecke = [
            g && { art: "sigille", name: g.name, text: g.beschreibung },
            r && { art: "rate", name: r.name + (r.ziffern ? " · " + r.ziffern : ""), text: r.beschreibung },
            z && { art: "target", name: z.name, text: z.beschreibung },
          ].filter(Boolean);
          if (!stuecke.length) return <span className="mfuell" />;
          return (
            <div className="merklaerung">
              {stuecke.map((e) => (
                <div key={e.art}>
                  <span className="merklaerkopf"><i>{e.art}</i> {e.name}</span>
                  <p>{e.text || "— noch keine beschreibung im schrank —"}</p>
                </div>
              ))}
            </div>
          );
        })()}
        <button className="mbtn weg" onClick={() => weg(b.id)}>bauteil entfernen</button>
      </div>
    </div>
  );
}

// ============================================================
// DIE STICK-PLATTE
// Die platte erzeugt keinen widerstand — sie misst DEIN streichen.
// Schnell streichen laesst die ziffern rasen, langsamer werden laesst
// sie kriechen, anhalten haelt sie fest. Was beim abheben steht, ist
// die rate.
// ============================================================
function StickPlatte({ api, sag, rateDazu }) {
  const [laeuft, setLaeuft] = useState(false);
  const [rate, setRate] = useState([0, 0, 0]);
  const [gehalten, setGehalten] = useState(null);
  const [zug, setZug] = useState(0);          // wie stark gestrichen wird, 0..1
  const [name, setName] = useState("");

  const z = useRef({ x: 0, y: 0, t: 0, tempo: 0, stand: [0, 0, 0],
                     winkel: 0, strecke: 0 });

  // solange gestrichen wird, laufen die ziffern — im tempo der hand
  useEffect(() => {
    if (!laeuft) return;
    const uhr = setInterval(() => {
      const w = z.current;
      w.tempo *= 0.74;                        // ohne nachschub wird es ruhig
      if (w.tempo < 0.02) w.tempo = 0;
      const schritt = Math.round(w.tempo * 9);
      if (schritt > 0) {
        // jede walze zieht aus etwas anderem, was die hand tut:
        //   erste  — wie schnell gestrichen wird
        //   zweite — in welche richtung
        //   dritte — wie weit insgesamt
        const a = schritt;
        const b = 1 + Math.round(Math.abs(w.winkel) / Math.PI * 11);
        const c = 1 + (Math.round(w.strecke) % 13);
        w.stand = [
          (w.stand[0] + a) % 100,
          (w.stand[1] + b) % 100,
          (w.stand[2] + c) % 100,
        ];
        setRate(w.stand);
      }
      setZug(Math.min(w.tempo, 1));
    }, 60);
    return () => clearInterval(uhr);
  }, [laeuft]);

  const streichen = (e) => {
    const w = z.current;
    const t = performance.now();
    if (w.t) {
      const dt = Math.max(t - w.t, 1);
      const dx = e.clientX - w.x, dy = e.clientY - w.y;
      const weg = Math.hypot(dx, dy);
      // pixel je millisekunde, geglaettet
      w.tempo = Math.min(2.5, (weg / dt) * 0.55 + w.tempo * 0.45);
      if (weg > 0.5) w.winkel = Math.atan2(dy, dx);
      w.strecke += weg;
    }
    w.x = e.clientX; w.y = e.clientY; w.t = t;
  };

  const anfangen = (e) => {
    z.current = { x: e.clientX, y: e.clientY, t: performance.now(), tempo: 0,
                  winkel: 0, strecke: 0,
                  stand: gehalten ? [...gehalten] : [...rate] };
    setGehalten(null);
    setLaeuft(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  };

  const aufhoeren = () => {
    if (!laeuft) return;
    setLaeuft(false);
    setZug(0);
    setGehalten([...z.current.stand]);
    try { if (navigator.vibrate) navigator.vibrate(18); } catch {}
  };

  // auch wer draussen loslaesst, soll die rate bekommen
  useEffect(() => {
    if (!laeuft) return;
    const auf = () => aufhoeren();
    window.addEventListener("pointerup", auf);
    window.addEventListener("pointercancel", auf);
    return () => {
      window.removeEventListener("pointerup", auf);
      window.removeEventListener("pointercancel", auf);
    };
  });

  const speichern = async () => {
    if (!gehalten) return;
    const ziffern = gehalten.map((n) => String(n).padStart(2, "0")).join("-");
    const neu = {
      id: neueId(), name: name.trim() || ("rate " + ziffern),
      ziffern, beschreibung: "", herkunft: "selbst ertastet",
    };
    try {
      await api("POST", "/rest/v1/raten", neu);
      rateDazu(neu);                      // sofort in die liste, nicht erst nach neuladen
      sag("rate gespeichert: " + neu.name + " — steht jetzt im raten-schrank");
      setName(""); setGehalten(null);
    } catch (e) { sag(String(e.message), "schlimm"); }
  };

  const zeigt = gehalten || rate;

  return (
    <div className="mplatte">
      <div className="mplattekopf">
        <span className="mwandtitel">stick-platte</span>
        <span className={"mziffern" + (gehalten ? " haelt" : "")}>
          {zeigt.map((n, i) => <b key={i}>{String(n).padStart(2, "0")}</b>)}
        </span>
      </div>

      <div className={"mflaeche" + (laeuft ? " laeuft" : "") + (gehalten ? " haelt" : "")}
        style={laeuft ? { "--zug": zug } : undefined}
        onPointerDown={anfangen}
        onPointerMove={(e) => { if (laeuft) streichen(e); }}
        onPointerUp={aufhoeren}>
        <span className="mflaechentext">
          {gehalten ? "hier bist du h\u00e4ngengeblieben" : laeuft ? "" : "streichen"}
        </span>
        {laeuft && <span className="mspur" style={{ opacity: 0.25 + zug * 0.6 }} />}
      </div>

      {gehalten && (
        <div className="mzeile">
          <input value={name} placeholder="name f\u00fcr diese rate"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") speichern(); }} />
          <button className="mbtn" onClick={speichern}>in die datenbank</button>
          <button className="mbtn" onClick={() => { setGehalten(null); setRate([0,0,0]); }}>
            nochmal
          </button>
        </div>
      )}

      <p className="mhinweis">
        die platte erzeugt keinen widerstand \u2014 sie misst dein streichen.
        schnell streichen l\u00e4sst die ziffern rasen, langsamer werden l\u00e4sst sie
        kriechen. wo du anh\u00e4ltst, bleibt die rate stehen.
      </p>
    </div>
  );
}

// ============================================================
// AUSLESEN
// Drei ebenen zufall, jede aus einer anderen quelle:
//   1. weisses rauschen — aus dem programm (ein rechenverfahren)
//   2. entropie         — aus dem zufallsspeicher des geraets, den das
//                         betriebssystem aus hardware-ereignissen fuellt
//   3. dein moment      — start und stopp, auf die mikrosekunde
// Solange es laeuft, bekommt jeder eintrag bei jedem schritt einen wert
// zwischen -1 und 1 aus ebene 1 und 2 gemischt. Beim stopp kommt ebene 3
// mit gleichem gewicht dazu. Gezeigt werden die eintraege, deren summe
// am weitesten vom erwartbaren (null) abweicht.
// ============================================================
const mische = (a, b, i) => {
  let h = (a ^ ((b << 16) | (b >>> 16)) ^ Math.imul(i + 1, 0x9E3779B1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B);
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
  return (h ^ (h >>> 16)) >>> 0;
};
const LESBAR = ["raten", "sigillen", "quellen", "hintergruende"];

function Auslesen({ api, sag, alle, zurOperation }) {
  const [haken, setHaken] = useState({});         // welche treffer in die operation sollen
  const [baut, setBaut] = useState(false);
  const [target, setTarget] = useState("");
  const [frage, setFrage] = useState("");
  const [woraus, setWoraus] = useState({ raten: true, sigillen: true, quellen: false, hintergruende: false });
  const [tag, setTag] = useState("");
  const [laeuft, setLaeuft] = useState(false);
  const [ergebnis, setErgebnis] = useState(null);
  const [frueher, setFrueher] = useState([]);
  const lauf = useRef(null);
  const leinwand = useRef(null);

  useEffect(() => {
    api("GET", "/rest/v1/auslesungen?select=*&order=wann.desc&limit=12")
      .then((l) => setFrueher(l || [])).catch(() => {});
    return () => { if (lauf.current) clearInterval(lauf.current.uhr); };
  }, [api]);

  // woraus gelesen wird
  const wunschTag = tag.trim().toLowerCase().replace(/^#?/, "#");
  const kandidaten = LESBAR.filter((a) => woraus[a]).flatMap((a) =>
    ((alle && alle[a]) || [])
      .filter((x) => !tag.trim() || tagsAus(x).includes(wunschTag))
      .map((x) => ({ art: a, id: x.id, name: x.name, ziffern: x.ziffern || "",
                     text: x.beschreibung || x.notiz || "" })));
  const alleTags = [...new Set(LESBAR.filter((a) => woraus[a])
    .flatMap((a) => ((alle && alle[a]) || []).flatMap(tagsAus)))].sort();

  const start = () => {
    if (kandidaten.length < 2) { sag("zum auslesen braucht es mindestens zwei einträge in der auswahl", "schlimm"); return; }
    const k = kandidaten;
    const z = { k, summe: new Float64Array(k.length), n: 0, t0: performance.now(),
                rausch: ((Math.random() * 4294967296) >>> 0) || 1, uhr: null };
    lauf.current = z;
    setErgebnis(null); setLaeuft(true);

    z.uhr = setInterval(() => {
      const geraet = new Uint32Array(k.length);
      crypto.getRandomValues(geraet);                       // ebene 2
      for (let i = 0; i < k.length; i++) {
        let r = z.rausch;                                   // ebene 1: xorshift
        r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
        z.rausch = r >>> 0;
        z.summe[i] += mische(z.rausch, geraet[i], i) / 2147483648 - 1;
      }
      z.n++;

      // das rauschen sichtbar machen
      const lw = leinwand.current, stift = lw && lw.getContext && lw.getContext("2d");
      if (stift) {
        const bild = stift.createImageData(lw.width, lw.height);
        let r = z.rausch;
        for (let p = 0; p < bild.data.length; p += 4) {
          r ^= r << 13; r ^= r >>> 17; r ^= r << 5; r >>>= 0;
          const g = r & 255;
          bild.data[p] = g * 0.45; bild.data[p + 1] = g * 0.68; bild.data[p + 2] = g * 0.61; bild.data[p + 3] = 255;
        }
        stift.putImageData(bild, 0, 0);
      }
    }, 40);
  };

  const stopp = async () => {
    const z = lauf.current;
    if (!z) return;
    clearInterval(z.uhr);
    const t1 = performance.now();
    lauf.current = null;
    setLaeuft(false);
    if (z.n < 8) { sag("das war zu kurz — lass es einen moment laufen"); return; }

    // ebene 3: dein moment, mit demselben gewicht wie alles davor zusammen
    const moment = mische(Math.floor(z.t0 * 1000) >>> 0, Math.floor(t1 * 1000) >>> 0, z.n);
    const wurzel = Math.sqrt(z.n);
    const streuung = Math.sqrt((2 * z.n) / 3);
    const liste = z.k.map((e, i) => {
      const summe = z.summe[i] + (mische(moment, z.rausch, i) / 2147483648 - 1) * wurzel;
      return { ...e, wert: summe / streuung };
    }).sort((a, b) => Math.abs(b.wert) - Math.abs(a.wert));

    const oben = liste.slice(0, 7);
    const neu = {
      id: neueId(), target: target.trim(), frage: frage.trim(),
      woraus: LESBAR.filter((a) => woraus[a]).map(schrankName).join(", ") + (tag.trim() ? " · " + wunschTag : ""),
      treffer: oben.map((e) => ({ id: e.id, art: e.art, name: e.name, ziffern: e.ziffern, text: e.text,
                                  wert: Math.round(e.wert * 100) / 100 })),
      dauer_ms: Math.round(t1 - z.t0), wann: new Date().toISOString(),
    };
    setErgebnis({ ...neu, gesamt: z.k.length, schritte: z.n });
    try {
      await api("POST", "/rest/v1/auslesungen", neu);
      setFrueher((l) => [neu, ...l].slice(0, 12));
    } catch (e) { sag("die auslesung steht hier, ist aber nicht gespeichert: " + String(e.message), "schlimm"); }
  };

  // das protokoll: nur text, keine bilder, nichts vom maschinenraum
  const drucken = (a) => {
    const w = window.open("", "_blank", "width=720,height=900");
    if (!w) { sag("der browser hat das fenster blockiert", "schlimm"); return; }
    const sauber = (x) => String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
    w.document.write(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Protokoll</title><style>
      @page { margin: 22mm; } body { font-family: Georgia, serif; color: #111; line-height: 1.5; }
      h1 { font-size: 18pt; font-weight: normal; letter-spacing: .06em; margin: 0 0 2mm; }
      .kopf { font-size: 10.5pt; color: #444; margin-bottom: 8mm; border-bottom: 1px solid #999; padding-bottom: 4mm; }
      .t { margin: 0 0 5mm; page-break-inside: avoid; } .t b { font-size: 12.5pt; }
      .t i { font-style: normal; color: #555; font-size: 10pt; margin-left: 3mm; } .t p { margin: 1mm 0 0; font-size: 10.5pt; color: #333; }
    </style></head><body>
      <h1>Protokoll der Auslesung</h1>
      <div class="kopf">${new Date(a.wann).toLocaleString("de")}<br>
        Ziel: ${sauber(a.target) || "—"}<br>Frage: ${sauber(a.frage) || "—"}</div>
      ${(a.treffer || []).map((e, i) => `<div class="t"><b>${i + 1}. ${sauber(e.name)}</b>
        <i>${sauber(e.ziffern)}</i><p>${sauber(e.text)}</p></div>`).join("")}
    </body></html>`);
    w.document.close();
    setTimeout(() => { try { w.print(); } catch {} }, 400);
  };

  const weg = async (id) => {
    setFrueher((l) => l.filter((x) => x.id !== id));
    try { await api("DELETE", `/rest/v1/auslesungen?id=eq.${id}`); } catch (e) { sag(String(e.message), "schlimm"); }
  };

  // bei jeder neuen auslesung: die drei staerksten sind vorgewaehlt
  useEffect(() => {
    if (ergebnis) setHaken({ 0: true, 1: true, 2: true });
  }, [ergebnis && ergebnis.id]);

  const umwandeln = async () => {
    const gewaehlt = ergebnis.treffer.filter((_, i) => haken[i]);
    if (!gewaehlt.length) { sag("hake mindestens einen treffer an", "schlimm"); return; }
    setBaut(true);
    await zurOperation(ergebnis, gewaehlt);
    setBaut(false);
  };

  const zeig = ergebnis;
  const hoechst = zeig ? Math.max(...zeig.treffer.map((e) => Math.abs(e.wert)), 0.01) : 1;

  return (
    <div className="mlesen">
      <div className="msatz">
        <label className="mhaelfte">
          <span className="msatzwort">ziel</span>
          <input className="mfeldgross ziel einzeilig" value={target} placeholder="… wer oder was"
            list="mziele" onChange={(e) => setTarget(e.target.value)} />
          <datalist id="mziele">
            {((alle && alle.targets) || []).map((x) => <option key={x.id} value={x.name} />)}
          </datalist>
        </label>
        <label className="mhaelfte">
          <span className="msatzwort">frage</span>
          <input className="mfeldgross einzeilig" value={frage} placeholder="… was soll sich zeigen?"
            onChange={(e) => setFrage(e.target.value)} />
        </label>
      </div>

      <div className="mlesewahl">
        <span className="mwandtitel">gelesen wird aus</span>
        {LESBAR.map((a) => (
          <label key={a} className="mquelle">
            <input type="checkbox" checked={!!woraus[a]} disabled={laeuft}
              onChange={() => setWoraus((w) => ({ ...w, [a]: !w[a] }))} />
            <span>{schrankName(a)} <i>{((alle && alle[a]) || []).length}</i></span>
          </label>
        ))}
        <select className="mausschrank" value={tag} disabled={laeuft} onChange={(e) => setTag(e.target.value)}>
          <option value="">alle tags</option>
          {alleTags.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <span className="mfuell" />
        <span className="mlesezahl">{kandidaten.length} einträge in der auswahl</span>
      </div>

      <div className="mlesewerk">
        <canvas ref={leinwand} width={220} height={64} className={"mrauschen" + (laeuft ? " an" : "")} />
        <button className={"mhebel gross" + (laeuft ? " an" : "")} onClick={laeuft ? stopp : start}>
          {laeuft ? "stopp" : "start"}
        </button>
        <div className="mebenen">
          <span className={laeuft ? "an" : ""}>① rauschen</span>
          <span className={laeuft ? "an" : ""}>② entropie des geräts</span>
          <span className={zeig ? "an" : ""}>③ dein moment</span>
        </div>
      </div>

      {zeig && (
        <div className="mlog">
          <div className="mberichtkopf">
            <span className="mwandtitel">was sich gezeigt hat</span>
            <span className="mfuell" />
            <button className="mbtn lesen" disabled={baut} onClick={umwandeln}>
              {baut ? "wird gebaut …" : "angehakte in eine operation"}
            </button>
            <button className="mbtn" onClick={() => drucken(zeig)}>protokoll drucken</button>
          </div>
          <p className="mhinweis">
            {zeig.gesamt} einträge · {zeig.schritte} schritte · {(zeig.dauer_ms / 1000).toFixed(1)} sekunden
            {zeig.woraus ? " · " + zeig.woraus : ""}
          </p>
          {zeig.treffer.map((e, i) => (
            <div key={i} className={"mtreffer" + (haken[i] ? " gewaehlt" : "")}>
              <input type="checkbox" className="mtrefferhaken" checked={!!haken[i]}
                onChange={() => setHaken((h) => ({ ...h, [i]: !h[i] }))}
                title="in die operation übernehmen" />
              <span className="mnummer gross">{i + 1}</span>
              <div className="mtrefferleib">
                <div className="mtrefferkopf">
                  <b>{e.name}</b>
                  {e.ziffern && <span className="mtrefferrate">{e.ziffern}</span>}
                  <i>{schrankName(e.art)}</i>
                </div>
                {e.text && <p>{e.text}</p>}
                <div className="mbalken"><span style={{ width: (Math.abs(e.wert) / hoechst * 100) + "%" }} /></div>
              </div>
              <span className="mtrefferwert">{e.wert > 0 ? "+" : ""}{e.wert.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}

      {frueher.length > 0 && (
        <div className="mlog">
          <span className="mwandtitel">frühere auslesungen</span>
          {frueher.map((a) => (
            <div key={a.id} className="meintrag">
              <span className="mwann">{new Date(a.wann).toLocaleString("de",
                { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
              <span className="mtext">
                {(a.target || "ohne ziel")}{a.frage ? " — " + a.frage : ""}
                <small> · {(a.treffer || []).slice(0, 3).map((e) => e.name).join(", ")}</small>
              </span>
              <button className="mklein" onClick={() => setErgebnis({ ...a, gesamt: "?", schritte: "?" })}
                title="nochmal ansehen">◉</button>
              <button className="mklein" onClick={() => drucken(a)} title="protokoll drucken">⎙</button>
              <button className="mklein" onClick={() => weg(a.id)} title="löschen">✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// DIE DREI SCHRÄNKE — sigillen, raten, quellen
// ============================================================
function Schrank({ art, api, sag, sigillen, setSigillen, raten, setRaten,
                   quellen, setQuellen, plaene, setPlaene, ziele, setZiele,
                   operationen, bilder, hochladen, vorgabe, wechseln, alle }) {
  const [suche, setSuche] = useState(vorgabe || "");
  const [verweise, setVerweise] = useState({});   // id -> [operationsnamen]
  const [kaputt, setKaputt] = useState({});       // bildpfad -> adresse da, bild laedt nicht
  const [offenIds, setOffenIds] = useState({});   // id -> steht nur auf dem schirm, nicht in der datenbank
  const nachfragen = useRef({});

  // Ein eintrag gilt erst als gespeichert, wenn die datenbank ihn auf
  // nachfrage zurueckgibt. Vorher traegt er ein sichtbares zeichen —
  // sonst merkt man erst beim naechsten oeffnen, dass etwas fehlt.
  const sichern = (id, was) => {
    setOffenIds((o) => ({ ...o, [id]: true }));
    clearTimeout(nachfragen.current[id]);
    const fragen = async (versuch) => {
      try {
        const r = await api("GET", `/rest/v1/${tabelle}?id=eq.${id}&select=*`);
        const da = r && r[0];
        const stimmt = da && Object.keys(was || {}).every((k) => (da[k] ?? null) === (was[k] ?? null));
        if (stimmt) { setOffenIds((o) => { const n = { ...o }; delete n[id]; return n; }); return; }
      } catch {}
      if (versuch < 4) nachfragen.current[id] = setTimeout(() => fragen(versuch + 1), 2500);
      else sag("ein eintrag ist nicht in der datenbank angekommen — er steht nur hier auf dem schirm. "
             + "netz prüfen und die seite offen lassen.", "schlimm");
    };
    nachfragen.current[id] = setTimeout(() => fragen(1), 1200);
  };
  const uhren = useRef({});

  // woran man merkt, dass sich an den operationen wirklich etwas geaendert hat
  const kennung = operationen.map((o) => o.id + "|" + o.titel + "|" + o.target).join("~");

  const liste = art === "sigillen" ? sigillen : art === "raten" ? raten
              : art === "hintergruende" ? plaene : art === "targets" ? ziele : quellen;
  const setListe = art === "sigillen" ? setSigillen : art === "raten" ? setRaten
              : art === "hintergruende" ? setPlaene : art === "targets" ? setZiele : setQuellen;
  const tabelle = art;
  const mitBild = art === "sigillen" || art === "hintergruende" || art === "targets";

  // querverweise: wo ist das stueck schon im einsatz?
  useEffect(() => {
    let fort = false;
    (async () => {
      try {
        const spalte = art === "sigillen" ? "sigille_id" : art === "raten" ? "rate_id"
                     : art === "targets" ? "target_id" : null;
        const gefunden = {};
        if (art === "hintergruende") {
          // hier haengt der verweis am bildpfad, nicht an einer id
          plaene.forEach((x) => {
            operationen.forEach((o) => {
              if (o.hintergrund && o.hintergrund === x.bild)
                (gefunden[x.id] = gefunden[x.id] || []).push(o.titel || o.intention || "ohne titel");
            });
          });
        } else if (spalte) {
          if (art === "targets") {
            // ein target kann auch schlicht im satz oben stehen
            ziele.forEach((x) => operationen.forEach((o) => {
              if (o.target && o.target.trim() === x.name.trim())
                (gefunden[x.id] = gefunden[x.id] || []).push(o.titel || o.intention || "ohne titel");
            }));
          }
          const b = await api("GET",
            `/rest/v1/bauteile?select=operation_id,${spalte}&${spalte}=not.is.null`);
          (b || []).forEach((x) => {
            const id = x[spalte];
            if (!id) return;
            const op = operationen.find((o) => o.id === x.operation_id);
            if (!op) return;
            (gefunden[id] = gefunden[id] || []).push(op.intention || "ohne titel");
          });
        } else {
          const q = await api("GET", "/rest/v1/operation_quellen?select=operation_id,quelle_id");
          (q || []).forEach((x) => {
            const op = operationen.find((o) => o.id === x.operation_id);
            if (!op) return;
            (gefunden[x.quelle_id] = gefunden[x.quelle_id] || []).push(op.intention || "ohne titel");
          });
        }
        if (!fort) setVerweise(gefunden);
      } catch {}
    })();
    return () => { fort = true; };
    // nicht an [operationen] haengen — das array ist nach jedem puls neu,
    // obwohl sich an den namen nichts geaendert hat
  }, [art, api, kennung, plaene, ziele]);

  const anlegen = async () => {
    const neu = art === "raten"
      ? { id: neueId(), name: "neue rate", ziffern: "", beschreibung: "", herkunft: "" }
      : art === "sigillen"
        ? { id: neueId(), name: "neue sigille", beschreibung: "" }
        : art === "hintergruende"
          ? { id: neueId(), name: "neuer schaltplan", beschreibung: "" }
          : art === "targets"
            ? { id: neueId(), name: "neues target", beschreibung: "" }
            : { id: neueId(), name: "neue quelle", notiz: "" };
    setListe((l) => [neu, ...l]);
    try { await api("POST", `/rest/v1/${tabelle}`, neu); sichern(neu.id, {}); }
    catch (e) {
      // nicht gespeichert heisst: auch nicht anzeigen
      setListe((l) => l.filter((x) => x.id !== neu.id));
      sag(String(e.message), "schlimm");
    }
  };

  // Was noch nicht weggeschrieben ist, wird je eintrag GESAMMELT. Vorher
  // galt nur die letzte aenderung: wer name und beschreibung kurz
  // nacheinander tippte, verlor die erste.
  const haengig = useRef({});
  const aendern = (id, was, sofort) => {
    setListe((l) => l.map((x) => (x.id === id ? { ...x, ...was } : x)));
    haengig.current[id] = { ...haengig.current[id], ...was };
    const schreiben = () => {
      const stoff = haengig.current[id];
      if (!stoff) return;
      haengig.current[id] = null;
      api("PATCH", `/rest/v1/${tabelle}?id=eq.${id}`, stoff)
        .then(() => sichern(id, stoff))
        .catch((e) => sag(String(e.message), "schlimm"));
    };
    clearTimeout(uhren.current[id]);
    setOffenIds((o) => ({ ...o, [id]: true }));
    if (sofort) { schreiben(); return; }
    uhren.current[id] = setTimeout(schreiben, 700);
  };

  // beim verlassen des schranks nichts liegenlassen
  useEffect(() => () => {
    Object.keys(haengig.current).forEach((id) => {
      const stoff = haengig.current[id];
      if (stoff) api("PATCH", `/rest/v1/${tabelle}?id=eq.${id}`, stoff).catch(() => {});
    });
    Object.values(nachfragen.current).forEach(clearTimeout);
  }, [api, tabelle]);

  const weg = async (id) => {
    const x = liste.find((e) => e.id === id);
    if (!confirm(`„${(x && x.name) || ""}" löschen?`)) return;
    setListe((l) => l.filter((e) => e.id !== id));
    try { await api("DELETE", `/rest/v1/${tabelle}?id=eq.${id}`); }
    catch (e) { sag(String(e.message), "schlimm"); }
  };

  const bildWaehlen = async (id, datei) => {
    if (!datei) return;
    try {
      const pfad = await hochladen(datei,
        art === "sigillen" ? "sigillen" : art === "targets" ? "targets" : "schaltungen");
      setKaputt((k) => { const n = { ...k }; delete n[pfad]; return n; });
      aendern(id, { bild: pfad }, true);    // sofort schreiben, nicht erst in 700 ms
    } catch (e) { sag(String(e.message), "schlimm"); }
  };

  // drucken: ein sauberes blatt zum auflegen
  const drucken = (x) => {
    const w = window.open("", "_blank", "width=700,height=900");
    if (!w) { sag("der browser hat das fenster blockiert", "schlimm"); return; }
    const bild = x.bild && bilder[x.bild] ? `<img src="${bilder[x.bild]}">` : "";
    const ziffern = x.ziffern ? `<div class="z">${x.ziffern}</div>` : "";
    w.document.write(`<!doctype html><html lang="de"><head><meta charset="utf-8">
      <title>${(x.name || "").replace(/</g, "&lt;")}</title><style>
        @page { margin: 20mm; }
        body { font-family: Georgia, serif; text-align: center; color: #111; }
        h1 { font-size: 20pt; font-weight: normal; letter-spacing: .08em; margin: 0 0 6mm; }
        img { max-width: 120mm; max-height: 150mm; display: block; margin: 0 auto 8mm; }
        .z { font-family: monospace; font-size: 34pt; letter-spacing: .12em; margin: 10mm 0; }
        p { font-size: 11pt; color: #444; max-width: 120mm; margin: 0 auto; }
      </style></head><body>
      <h1>${(x.name || "").replace(/</g, "&lt;")}</h1>
      ${bild}${ziffern}
      <p>${(x.beschreibung || x.notiz || "").replace(/</g, "&lt;")}</p>
      </body></html>`);
    w.document.close();
    setTimeout(() => { try { w.print(); } catch {} }, 400);
  };

  const gefiltert = liste.filter((x) => {
    const s = suche.trim().toLowerCase();
    if (!s) return true;
    if (s.startsWith("#")) return tagsAus(x).includes(s);       // ein tag trifft genau
    return [x.name, x.beschreibung, x.notiz, x.ziffern, x.herkunft]
      .filter(Boolean).join(" ").toLowerCase().includes(s);
  });

  // alle tags dieses schranks, die haeufigsten zuerst
  const zaehlung = {};
  liste.forEach((x) => tagsAus(x).forEach((g) => { zaehlung[g] = (zaehlung[g] || 0) + 1; }));
  const alleTags = Object.keys(zaehlung).sort((a, b) => zaehlung[b] - zaehlung[a] || a.localeCompare(b, "de"));

  // ist ein tag gewaehlt: wo liegt er noch?
  const gewaehlterTag = suche.trim().toLowerCase().startsWith("#") ? suche.trim().toLowerCase() : "";
  const woanders = gewaehlterTag
    ? SCHRAENKE.filter((a) => a !== art)
        .map((a) => ({ a, n: ((alle && alle[a]) || []).filter((x) => tagsAus(x).includes(gewaehlterTag)).length }))
        .filter((e) => e.n > 0)
    : [];

  return (
    <div className="mschrank">
      <div className="mzeile">
        <input className="msuche" value={suche} placeholder="suchen … oder #tag"
          onChange={(e) => setSuche(e.target.value)} />
        <button className="mbtn" onClick={anlegen}>+ neu</button>
      </div>

      {(alleTags.length > 0 || gewaehlterTag) && (
        <div className="mtagleiste">
          {gewaehlterTag && (
            <button className="mtag weg" onClick={() => setSuche("")}>✕ alle zeigen</button>
          )}
          {alleTags.map((g) => (
            <button key={g} className={"mtag" + (g === gewaehlterTag ? " an" : "")}
              onClick={() => setSuche(g === gewaehlterTag ? "" : g)}>
              {g} <i>{zaehlung[g]}</i>
            </button>
          ))}
          {woanders.map((e) => (
            <button key={e.a} className="mtag fern" onClick={() => wechseln(e.a, gewaehlterTag)}>
              auch in {schrankName(e.a)} <i>{e.n}</i>
            </button>
          ))}
        </div>
      )}

      {gefiltert.map((x) => (
        <div className={"mstueck" + (offenIds[x.id] ? " ungesichert" : "")} key={x.id}>
          {offenIds[x.id] && <div className="mungesichert">wird gespeichert …</div>}
          <div className="mstueckkopf">
            <input className="mbezfeld" value={x.name}
              onChange={(e) => aendern(x.id, { name: e.target.value })} />
            <button className="mklein" onClick={() => drucken(x)} title="drucken, zum auflegen">⎙</button>
            <button className="mklein" onClick={() => weg(x.id)} title="löschen">✕</button>
          </div>

          <div className="mstueckleib">
            {mitBild && (
              <>
                <label className={"mbildfach" + (art === "hintergruende" ? " breit" : "")}>
                  {!x.bild
                    ? <span>bild wählen</span>
                    : !bilder[x.bild]
                      ? <span className="mfehlt">liegt in der ablage,<br />adresse fehlt</span>
                      : kaputt[x.bild]
                        ? <span className="mfehlt">adresse da,<br />bild lädt nicht</span>
                        : <img src={bilder[x.bild]} alt=""
                            onError={() => setKaputt((k) => ({ ...k, [x.bild]: true }))} />}
                  <input type="file" accept="image/*"
                    onChange={(e) => bildWaehlen(x.id, e.target.files && e.target.files[0])} />
                </label>
                <textarea className="mbeschreibung" value={x.beschreibung || ""} rows={4}
                  placeholder={art === "hintergruende"
                    ? "was ist das für eine schaltung, wofür taugt sie?"
                    : art === "targets"
                      ? "wer oder was ist das, was ist zu beachten?"
                      : "wofür ist sie gut?"}
                  onChange={(e) => aendern(x.id, { beschreibung: e.target.value })} />
              </>
            )}

            {art === "raten" && (
              <>
                <div className="mratenblock">
                  <input className="mziffernfeld" value={x.ziffern || ""} placeholder="42-17-9"
                    onChange={(e) => aendern(x.id, { ziffern: e.target.value })} />
                  <input className="mherkunft" value={x.herkunft || ""} placeholder="woher?"
                    onChange={(e) => aendern(x.id, { herkunft: e.target.value })} />
                </div>
                <textarea className="mbeschreibung" value={x.beschreibung || ""} rows={4}
                  placeholder="wofür ist sie gut?"
                  onChange={(e) => aendern(x.id, { beschreibung: e.target.value })} />
              </>
            )}

            {art === "quellen" && (
              <>
                <div className="mratenblock">
                  <label className="mfeldchen">
                    <span>gekoppelt über sigille</span>
                    <select value={x.sigille_id || ""}
                      onChange={(e) => aendern(x.id, { sigille_id: e.target.value || null })}>
                      <option value="">—</option>
                      {sigillen.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </label>
                  <label className="mfeldchen">
                    <span>oder über rate</span>
                    <select value={x.rate_id || ""}
                      onChange={(e) => aendern(x.id, { rate_id: e.target.value || null })}>
                      <option value="">—</option>
                      {raten.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </label>
                </div>
                <textarea className="mbeschreibung" value={x.notiz || ""} rows={4}
                  placeholder="welches gerät, wo steht es, was ist zu beachten?"
                  onChange={(e) => aendern(x.id, { notiz: e.target.value })} />
              </>
            )}
          </div>

          {tagsAus(x).length > 0 && (
            <div className="mtags">
              {tagsAus(x).map((g) => (
                <button key={g} className={"mtag klein" + (g === gewaehlterTag ? " an" : "")}
                  onClick={() => setSuche(g)}>{g}</button>
              ))}
            </div>
          )}

          {verweise[x.id] && verweise[x.id].length > 0 && (
            <div className="mverweis">
              läuft in: {[...new Set(verweise[x.id])].slice(0, 4).join(" · ")}
              {verweise[x.id].length > 4 && " …"}
            </div>
          )}
        </div>
      ))}

      {gefiltert.length === 0 && (
        <p className="mleer">
          {suche ? "nichts gefunden"
            : art === "hintergruende"
              ? "noch kein schaltplan — das + legt einen an. was du in einer operation einlegst, landet auch hier."
              : art === "targets"
                ? "noch kein target — das + legt eines an: name, zeugen-bild, beschreibung."
                : "noch nichts drin — das + legt an"}
        </p>
      )}
    </div>
  );
}

// ============================================================
// DER STIL — Sam Blackcat: dunkel, kupfer, grünspan.
// Eine alte Maschine, die nie jemand abgeschaltet hat.
// ============================================================
function MaschinenStil() {
  return (
    <style>{`
.mraum{
  --grund:#070a09; --grund2:#0d1310;
  --kupfer:#b87333; --kupfer2:#d99a57;
  --span:#4a7c6f; --span2:#6fae9c;
  --messing:#c4a747; --asche:#8a8f87;
  --glut:#e4642c;
  position:fixed; inset:0; z-index:40; overflow-y:auto; overflow-x:hidden;
  background:
    radial-gradient(85% 55% at 50% -10%, rgba(74,124,111,.12) 0%, transparent 60%),
    radial-gradient(60% 40% at 90% 100%, rgba(184,115,51,.10) 0%, transparent 60%),
    linear-gradient(var(--grund2), var(--grund));
  color:var(--asche);
  font-family:'Courier Prime', ui-monospace, monospace;
  padding:0 0 80px;
}
/* die platine im grund — feine leiterbahnen */
.mraum::before{
  content:""; position:fixed; inset:0; pointer-events:none; opacity:.14;
  background-image:
    linear-gradient(rgba(111,174,156,.5) 1px, transparent 1px),
    linear-gradient(90deg, rgba(111,174,156,.5) 1px, transparent 1px);
  background-size:52px 52px;
  mask-image:radial-gradient(70% 60% at 50% 40%, #000 20%, transparent 80%);
  -webkit-mask-image:radial-gradient(70% 60% at 50% 40%, #000 20%, transparent 80%);
}
.mraum > *{position:relative; z-index:1}
/* nicht auf die uebrige app verlassen: hier rechnet alles mit rahmen */
.mraum, .mraum *, .mraum *::before, .mraum *::after{box-sizing:border-box}

/* ---- kopfzeile ---- */
.mkopf{
  position:sticky; top:0; z-index:5; display:flex; align-items:center;
  gap:8px; flex-wrap:wrap;
  padding:12px clamp(12px,2vw,26px);
  background:linear-gradient(rgba(7,10,9,.97), rgba(7,10,9,.86));
  border-bottom:1px solid rgba(184,115,51,.28);
}
.mtitel{
  font-family:'IM Fell English SC', Georgia, serif; font-size:17px;
  letter-spacing:.2em; color:var(--messing);
}
.mfuell{flex:1}
/* der titel in der leiste — sieht aus wie beschriftung, ist aber ein feld */
.mtitelfeld{
  flex:1 1 220px; max-width:420px; min-width:0;
  background:transparent; border:1px solid transparent; border-radius:3px;
  padding:4px 8px; transition:.15s;
}
.mtitelfeld::placeholder{color:var(--messing); opacity:.45}
.mtitelfeld:hover{border-color:rgba(196,167,71,.25)}
.mtitelfeld:focus{outline:none; border-color:var(--messing); background:rgba(0,0,0,.3)}

.mbtn{
  font-family:inherit; font-size:11.5px; letter-spacing:.08em;
  padding:7px 13px; border-radius:3px; cursor:pointer;
  color:var(--span2); background:rgba(74,124,111,.08);
  border:1px solid rgba(74,124,111,.4); transition:.15s;
}
.mbtn:hover:not(:disabled){
  background:rgba(111,174,156,.18); border-color:var(--span2); color:#cfe8df;
}
.mbtn:disabled{opacity:.3; cursor:default}
.mbtn.breit{width:100%}
.mbtn.weg{color:#d98070; border-color:rgba(217,128,112,.4)}
.mbtn.weg:hover{background:rgba(217,128,112,.16); border-color:#d98070; color:#f0b0a4}
.mbtn.pruef{color:var(--messing); border-color:rgba(196,167,71,.45)}

.mklein{
  font-family:inherit; font-size:12px; line-height:1; padding:5px 8px;
  border-radius:3px; cursor:pointer; color:var(--asche);
  background:transparent; border:1px solid rgba(138,143,135,.28); transition:.15s;
}
.mklein:hover{color:var(--kupfer2); border-color:var(--kupfer)}

/* die meldung liegt unten ueber der seite und schiebt nichts weg —
   oben hat sie die knoepfe unter dem finger verrutschen lassen */
.mmeldung{
  position:fixed; z-index:60; left:clamp(12px,2vw,26px); right:clamp(12px,2vw,26px);
  bottom:calc(14px + env(safe-area-inset-bottom, 0px));
  margin:0; padding:10px 14px; border-radius:4px;
  font-size:12px; color:var(--messing);
  background:#14170f; border:1px solid rgba(196,167,71,.45);
  box-shadow:0 6px 24px rgba(0,0,0,.7);
}
/* eine schlechte nachricht verschwindet nicht von selbst */
.mmeldung.laeuft{
  color:var(--span2); background:#0f1815;
  border-color:rgba(111,174,156,.5);
}
.mmeldung.schlimm{
  color:#f0b0a4; background:#1c1210;
  border-color:rgba(217,128,112,.6); cursor:pointer;
  display:flex; justify-content:space-between; gap:14px; align-items:baseline;
}
.mmeldung.schlimm small{font-size:10px; opacity:.6; white-space:nowrap}

.mnachsehen{
  margin-top:26px; font-family:inherit; font-size:10.5px; letter-spacing:.08em;
  padding:7px 13px; border-radius:3px; cursor:pointer; align-self:flex-start;
  color:var(--asche); background:transparent;
  border:1px dashed rgba(138,143,135,.3); opacity:.6; transition:.15s;
}
.mnachsehen:hover{opacity:1; color:var(--span2); border-color:rgba(74,124,111,.5)}

.mbericht{
  margin:0 clamp(12px,2vw,26px); padding:14px 16px; border-radius:4px;
  background:linear-gradient(rgba(18,25,22,.85), rgba(10,15,13,.95));
  border:1px solid rgba(184,115,51,.3);
}
.mberichtkopf{display:flex; justify-content:space-between; align-items:center; margin-bottom:9px}
.mbericht .mzeile{font-size:11.5px; line-height:1.8; margin:0; display:block}
.mbericht .gut{color:var(--span2); opacity:.7}
.mbericht .schlecht{color:#f0b0a4}
.mleer{
  margin:40px auto; text-align:center; font-size:12.5px; color:var(--asche); opacity:.7;
}
.mhinweis{font-size:11px; color:var(--asche); opacity:.65; line-height:1.6; margin:4px 0}

/* ---- die LED ---- */
.mled{
  width:15px; height:15px; border-radius:50%; flex:0 0 auto;
  display:inline-flex; align-items:center; justify-content:center;
  background:radial-gradient(circle at 40% 35%, #1a211e, #080b0a 70%);
  box-shadow:inset 0 1px 2px rgba(0,0,0,.9), 0 0 0 1px rgba(138,143,135,.25);
}
.mled i{
  width:7px; height:7px; border-radius:50%; background:#2a322e; display:block;
}
/* an heisst: sie atmet — schwillt ruhig an und ab. Im takt kommt der
   schlag obendrauf: schlagartig hell, dann langsam aus, wie eine roehre.
   Das atmen liegt auf <i>, der schlag auf <b>, damit sich beide nicht
   ins gehege kommen. */
.mled{position:relative}
.mled.an i{
  background:var(--glut);
  animation:matmen 3.6s ease-in-out infinite;
}
@keyframes matmen{
  0%,100%{opacity:.22; box-shadow:0 0 2px 0 rgba(228,100,44,.15)}
  50%{opacity:.78; box-shadow:0 0 9px 3px rgba(228,100,44,.5)}
}
.mled b{
  position:absolute; left:50%; top:50%; width:9px; height:9px; margin:-4.5px 0 0 -4.5px;
  border-radius:50%; background:#ffc79a; opacity:0; pointer-events:none;
  box-shadow:0 0 0 1px rgba(255,170,110,.9), 0 0 16px 6px rgba(228,100,44,.9);
  transition:opacity 1.1s ease-out;
}
.mled.an.schlaegt b{opacity:1; transition:opacity .04s linear}
.mled.an{box-shadow:inset 0 1px 2px rgba(0,0,0,.9), 0 0 0 1px rgba(228,100,44,.3)}
.mled.krank i{
  background:#6b3520; opacity:.3;
  animation:mstockt 2.2s ease-in-out infinite; box-shadow:none;
}
@keyframes mstockt{0%,100%{opacity:.22}50%{opacity:.55}}
@media(prefers-reduced-motion:reduce){
  .mled.an i{animation:none; opacity:.6}
  .mled b{transition:none}
  .mled.krank i{animation:none; opacity:.4}
}

/* ---- übersicht ---- */
.mfeld{
  display:flex; flex-wrap:wrap; gap:16px; align-items:flex-start;
  padding:24px clamp(12px,2vw,26px);
}
.mkachelhuelle{position:relative}
.mkachel{
  display:flex; flex-direction:column; gap:7px; align-items:flex-start;
  width:265px; height:150px; padding:14px 16px; cursor:pointer; text-align:left;
  overflow:hidden;
  font-family:inherit; color:var(--asche); border-radius:4px;
  background:linear-gradient(rgba(20,28,24,.9), rgba(11,16,14,.95));
  border:1px solid rgba(184,115,51,.28);
  box-shadow:0 6px 18px rgba(0,0,0,.5);
  transition:.18s;
}
.mkachel:hover{
  border-color:var(--kupfer); transform:rotate(0deg) !important;
  box-shadow:0 8px 26px rgba(0,0,0,.65), 0 0 20px rgba(184,115,51,.14);
}
.mkachel.an{border-color:rgba(228,100,44,.45)}
.mkachelkopf{display:flex; align-items:center; gap:8px; width:100%}
.mkachelzustand{font-size:10px; letter-spacing:.14em; color:var(--asche); opacity:.8}
.mkachel.an .mkachelzustand{color:var(--glut); opacity:1}
.mkachelsatz{
  font-family:'IM Fell English SC', Georgia, serif; font-size:15px; line-height:1.35;
  color:var(--messing); letter-spacing:.02em;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
  overflow:hidden; max-width:100%;
}
.mkachelziel{font-size:11px; color:var(--span2); opacity:.9}
.mkachelzeile{
  display:flex; flex-wrap:wrap; gap:4px 10px; margin-top:auto;
  font-size:10px; letter-spacing:.06em; opacity:.7;
}
.mtest{color:var(--messing); opacity:1}
.mkachel.neu{
  height:150px; width:170px; align-items:center; justify-content:center;
  border-style:dashed; border-color:rgba(74,124,111,.4);
}
.mplus{font-size:26px; color:var(--span2); line-height:1}
.mkachelname{font-size:11px; letter-spacing:.12em}
.mweg{
  position:absolute; top:-7px; right:-7px; width:22px; height:22px; border-radius:50%;
  font-size:11px; line-height:1; cursor:pointer; opacity:0; transition:.15s;
  color:#d98070; background:rgba(10,14,12,.95);
  border:1px solid rgba(217,128,112,.5);
}
.mkachelhuelle:hover .mweg{opacity:1}

/* ---- eine operation ---- */
.mop{padding:20px clamp(12px,2vw,26px); max-width:1500px; margin:0 auto}

.msatz{
  display:flex; flex-wrap:wrap; align-items:stretch; gap:10px 16px;
  padding:18px 20px; border-radius:4px; margin-bottom:18px;
  background:linear-gradient(rgba(20,28,24,.75), rgba(11,16,14,.9));
  border:1px solid rgba(196,167,71,.22);
}
/* absicht und ziel sind gleich gross — zwei haelften nebeneinander */
.mhaelfte{display:flex; flex-direction:column; gap:6px; flex:1 1 320px; min-width:0}
.msatzwort{
  font-family:'IM Fell English SC', Georgia, serif; font-size:15px;
  letter-spacing:.1em; color:var(--messing); white-space:nowrap;
}
.mfeldgross{
  width:100%; min-width:0; resize:vertical; min-height:70px;
  font-family:'IM Fell English SC', Georgia, serif; font-size:17px; line-height:1.5;
  padding:8px 11px; border-radius:3px; color:#e0d7bc;
  background:rgba(0,0,0,.3); border:1px solid rgba(196,167,71,.25);
}
.mfeldgross.ziel{color:#cfe8df; border-color:rgba(74,124,111,.3)}
/* die kleine wahl unter dem ziel-feld */
.mausschrank{
  font-family:inherit; font-size:10.5px; letter-spacing:.06em; padding:4px 7px;
  border-radius:3px; color:var(--asche); background:rgba(0,0,0,.25);
  border:1px solid rgba(138,143,135,.2); align-self:flex-start; max-width:100%;
}
.mausschrank:hover{border-color:rgba(74,124,111,.5); color:var(--span2)}
.mausschrank option{background:#0d1310; color:var(--span2)}
.mfeldgross:focus{outline:none; border-color:var(--messing)}

/* ---- maschinenteil ---- */
.mmaschine{display:flex; gap:16px; align-items:stretch; flex-wrap:wrap}
.mschaltung{
  position:relative; flex:1 1 560px; min-width:0; min-height:420px;
  align-self:flex-start;
  border-radius:4px; overflow:hidden; touch-action:none;
  background:
    radial-gradient(70% 60% at 50% 45%, rgba(74,124,111,.07), transparent 70%),
    #0a0f0d;
  border:1px solid rgba(184,115,51,.3);
  box-shadow:inset 0 0 50px rgba(0,0,0,.8);
}
/* mit plan nimmt das feld dessen form an — dann deckt sich prozent
   im feld mit prozent auf der tafel, auf jedem schirm */
.mschaltung.hatplan{min-height:0; height:auto; flex-basis:auto}
.mgrund{
  position:absolute; inset:0; width:100%; height:100%;
  object-fit:contain; opacity:.72; pointer-events:none; user-select:none;
}
.mgrundleer{
  position:absolute; inset:0; display:flex; flex-direction:column;
  align-items:center; justify-content:center; gap:7px; text-align:center;
  color:var(--asche); opacity:.45; padding:20px; pointer-events:none;
}
.mgrundleer span{font-size:13px; letter-spacing:.1em}
.mgrundleer small{font-size:10.5px; max-width:300px; line-height:1.6}

.mleitung{position:absolute; inset:0; width:100%; height:100%; pointer-events:none}
.mleitung line{stroke:rgba(216,140,66,.95); stroke-width:2px; stroke-dasharray:8 5;
  filter:drop-shadow(0 0 2px rgba(0,0,0,.6))}
/* die leitung vom letzten zurueck zum ersten ist eine leitung wie
   jede andere — der stromkreis ist geschlossen, nicht halb */

.mbauteil{
  position:absolute; transform:translate(-50%,-50%); cursor:grab;
  display:flex; align-items:center; justify-content:center;
  width:74px; height:74px; padding:0; border-radius:4px;
  touch-action:none;
  background:linear-gradient(rgba(22,30,26,.96), rgba(12,17,15,.98));
  border:1px solid rgba(184,115,51,.4);
  box-shadow:0 3px 10px rgba(0,0,0,.6);
  transition:box-shadow .2s, border-color .2s;
}
.mbauteil:active{cursor:grabbing}
.mbauteil.target{border-color:rgba(111,174,156,.55)}
.mbauteil.trend{border-color:rgba(196,167,71,.55)}
.mbauteil.gewaehlt{border-color:var(--kupfer2); box-shadow:0 0 0 1px var(--kupfer2), 0 3px 14px rgba(0,0,0,.7)}
.mbauteil.amzug{
  border-color:var(--glut);
  box-shadow:0 0 0 1px var(--glut), 0 0 22px rgba(228,100,44,.45);
}
/* das bild fuellt das ganze kaestchen */
.mbauteil img{
  width:100%; height:100%; object-fit:cover; display:block;
  border-radius:3px; pointer-events:none;
}
.mzeichen{font-size:26px; line-height:1.3; color:var(--span2)}
.mbauteil.trend .mzeichen{color:var(--messing)}
.mbauteil.verstaerker .mzeichen{color:var(--kupfer2)}
.mnummer{
  position:absolute; top:-8px; left:-8px; width:19px; height:19px; border-radius:50%;
  font-size:10px; line-height:19px; text-align:center; color:var(--grund);
  background:var(--kupfer); font-weight:700; z-index:2;
}
/* das art-zeichen als eigener kleiner kreis neben der nummer —
   so bleibt es lesbar, auch wenn ein bild das kaestchen fuellt */
.martkreis{
  position:absolute; top:-8px; left:13px; width:19px; height:19px; border-radius:50%;
  font-size:10px; line-height:18px; text-align:center; z-index:1;
  background:#0b100e; border:1px solid rgba(184,115,51,.55); color:var(--kupfer2);
}
.mbauteil.target .martkreis{color:var(--span2); border-color:rgba(111,174,156,.6)}
.mbauteil.trend  .martkreis{color:var(--messing); border-color:rgba(196,167,71,.6)}
.mnummer.gross{position:static; width:26px; height:26px; line-height:26px; font-size:12px}
.mzeichen{line-height:1}

/* ---- die seitenwand ---- */
.mwand{
  flex:0 0 250px; display:flex; flex-direction:column; gap:12px;
  padding:16px; border-radius:4px;
  background:linear-gradient(rgba(18,25,22,.8), rgba(10,15,13,.92));
  border:1px solid rgba(184,115,51,.25);
}
.mwandtitel{
  font-family:'IM Fell English SC', Georgia, serif; font-size:12px;
  letter-spacing:.18em; color:var(--messing);
}
.mschalter{display:flex; align-items:center; gap:11px}
.mhebel{
  flex:1; font-family:inherit; font-size:12px; letter-spacing:.1em;
  padding:9px 12px; border-radius:3px; cursor:pointer;
  color:var(--span2); background:rgba(74,124,111,.1);
  border:1px solid rgba(74,124,111,.45); transition:.15s;
}
.mhebel:hover{background:rgba(111,174,156,.2); color:#cfe8df}
.mhebel.an{
  color:var(--glut); background:rgba(228,100,44,.12); border-color:rgba(228,100,44,.5);
}
.mhebel.an:hover{background:rgba(228,100,44,.22)}

.mstand{
  display:flex; flex-direction:column; gap:3px; padding:11px 12px; border-radius:3px;
  font-size:11px; background:rgba(0,0,0,.3); border:1px solid rgba(138,143,135,.15);
}
.mstand b{font-size:19px; color:var(--glut); font-weight:400; letter-spacing:.02em}
.mstand small{font-size:10px; opacity:.75; line-height:1.5}
.mgut{color:var(--span2) !important; opacity:.9 !important}
.mschlecht{color:#d98070 !important; opacity:1 !important}

.mfeldchen{display:flex; flex-direction:column; gap:4px; font-size:10.5px; letter-spacing:.08em}
.mfeldchen > span{color:var(--asche); opacity:.8}
.mfeldchen select, .mfeldchen input[type=date], .mfeldchen input[type=text]{
  font-family:inherit; font-size:11.5px; padding:6px 8px; border-radius:3px;
  color:var(--span2); background:rgba(0,0,0,.35);
  border:1px solid rgba(74,124,111,.3);
}
/* der eigene datei-knopf — der vom browser heisst "Choose File" */
.mdateiknopf{
  display:block; text-align:center; cursor:pointer;
  font-size:11.5px; letter-spacing:.08em; padding:8px 12px; border-radius:3px;
  color:var(--kupfer2); background:rgba(184,115,51,.08);
  border:1px dashed rgba(184,115,51,.45); transition:.15s;
}
.mdateiknopf:hover{background:rgba(184,115,51,.18); border-style:solid; color:#eab680}
/* das feld liegt unsichtbar ueber dem knopf statt display:none —
   damit oeffnet safari den waehler zuverlaessig */
.mdateiknopf{position:relative; overflow:hidden}
.mdateiknopf input{
  position:absolute; inset:0; width:100%; height:100%;
  opacity:0; cursor:pointer; font-size:0;
}
.mfeldchen select option{background:#0d1310}

.mquellen{display:flex; flex-direction:column; gap:5px}
.mquelle{display:flex; align-items:center; gap:7px; font-size:11px; cursor:pointer}
.mquelle input{accent-color:var(--kupfer)}

.mzeile{display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:14px 0}
.mzeile input{
  flex:1 1 200px; min-width:0; font-family:inherit; font-size:12px;
  padding:8px 11px; border-radius:3px; color:var(--span2);
  background:rgba(0,0,0,.3); border:1px solid rgba(74,124,111,.3);
}
.mzeile input:focus{outline:none; border-color:var(--span2)}

/* ---- blatt für ein bauteil ---- */
.mblatt{
  padding:14px 16px; border-radius:4px; margin:14px 0;
  background:linear-gradient(rgba(22,30,26,.9), rgba(12,17,15,.95));
  border:1px solid var(--kupfer);
}
.mblattkopf{display:flex; align-items:center; gap:10px; margin-bottom:12px}
.mbezfeld{
  flex:1; min-width:0; font-family:'IM Fell English SC', Georgia, serif;
  font-size:15px; letter-spacing:.06em; padding:5px 9px; border-radius:3px;
  color:var(--messing); background:rgba(0,0,0,.3);
  border:1px solid rgba(196,167,71,.25);
}
.mbezfeld:focus{outline:none; border-color:var(--messing)}
.mblattreihe{display:flex; flex-wrap:wrap; gap:14px; align-items:flex-end; margin-bottom:10px}
.mprobefeld{display:flex; flex-direction:column; gap:3px; align-items:center}
/* die erklaerung aus dem schrank, neben dem bild */
.merklaerung{
  flex:1 1 260px; min-width:0; align-self:stretch; display:flex; flex-direction:column; gap:8px;
  padding:9px 12px; border-radius:3px;
  background:rgba(0,0,0,.28); border:1px solid rgba(138,143,135,.18);
}
.merklaerkopf{font-size:11px; letter-spacing:.06em; color:var(--messing)}
.merklaerkopf i{font-style:normal; font-size:9.5px; opacity:.6; margin-right:6px; letter-spacing:.12em; color:var(--asche)}
.merklaerung p{margin:3px 0 0; font-size:11.5px; line-height:1.55; color:#b9beb5; white-space:pre-wrap}
.mprobefeld small{font-size:9px; opacity:.6; letter-spacing:.05em}
.mprobe{width:58px; height:58px; object-fit:contain; border-radius:3px; border:1px solid rgba(184,115,51,.3)}

/* ---- stick-platte ---- */
.mplatte{
  padding:16px; border-radius:4px; margin:14px 0;
  background:linear-gradient(rgba(18,25,22,.85), rgba(10,15,13,.95));
  border:1px solid rgba(74,124,111,.35);
}
.mplattekopf{display:flex; align-items:center; justify-content:space-between; margin-bottom:11px}
.mziffern{display:flex; gap:9px}
.mziffern b{
  font-size:25px; font-weight:400; letter-spacing:.06em; color:var(--messing);
  padding:3px 10px; border-radius:3px; background:rgba(0,0,0,.4);
  border:1px solid rgba(196,167,71,.25); min-width:48px; text-align:center;
}
.mflaeche{
  height:130px; border-radius:4px; cursor:grab; touch-action:none; user-select:none;
  display:flex; align-items:center; justify-content:center;
  background:
    repeating-linear-gradient(90deg, rgba(74,124,111,.07) 0 2px, transparent 2px 7px),
    linear-gradient(rgba(26,34,30,.9), rgba(14,19,17,.95));
  border:1px solid rgba(74,124,111,.3); transition:border-color .2s, filter .2s;
}
.mflaeche:active, .mflaeche.laeuft{cursor:grabbing; border-color:var(--span2)}
.mflaeche.haelt{border-color:var(--messing); box-shadow:inset 0 0 30px rgba(196,167,71,.12)}
.mflaechentext{font-size:11px; letter-spacing:.2em; opacity:.5; pointer-events:none}
.mziffern.haelt b{color:var(--glut); border-color:rgba(228,100,44,.4)}
.mspur{
  position:absolute; inset:0; pointer-events:none;
  background:repeating-linear-gradient(90deg,
    rgba(111,174,156,.35) 0 1px, transparent 1px 5px);
  animation:mwandert .5s linear infinite;
}
@keyframes mwandert{to{background-position:20px 0}}
.mflaeche{position:relative; overflow:hidden}

/* ---- logbuch ---- */
.mlog{
  padding:16px; border-radius:4px; margin-top:20px;
  background:linear-gradient(rgba(18,25,22,.7), rgba(10,15,13,.9));
  border:1px solid rgba(184,115,51,.22);
}
.mlogzeile{display:flex; gap:8px; margin:10px 0 14px; flex-wrap:wrap}
.mlogzeile input{
  flex:1 1 260px; min-width:0; font-family:inherit; font-size:12px;
  padding:8px 11px; border-radius:3px; color:var(--span2);
  background:rgba(0,0,0,.3); border:1px solid rgba(74,124,111,.3);
}
.meintrag{
  display:flex; gap:10px; align-items:baseline; padding:7px 2px;
  border-bottom:1px solid rgba(138,143,135,.1); font-size:12px;
}
.meintrag:last-child{border-bottom:0}
.mwann{font-size:10px; opacity:.55; white-space:nowrap; flex:0 0 auto}
.martzeichen{color:var(--asche); opacity:.6; flex:0 0 auto}
.meintrag.test .martzeichen{color:var(--messing); opacity:1}
.meintrag.ende .martzeichen{color:#d98070; opacity:1}
.mtext{flex:1; line-height:1.55; color:#b9beb5}
.meintrag .mklein{opacity:0; transition:.15s}
.meintrag:hover .mklein{opacity:1}

/* ---- die schränke ---- */
.mschrank{padding:20px clamp(12px,2vw,26px); max-width:1100px; margin:0 auto}
.msuche{flex:1 1 300px}
.mstueck{
  padding:14px 16px; border-radius:4px; margin-bottom:12px;
  background:linear-gradient(rgba(20,28,24,.8), rgba(11,16,14,.92));
  border:1px solid rgba(184,115,51,.22);
}
.mstueckkopf{display:flex; align-items:center; gap:9px; margin-bottom:11px}
/* steht nur auf dem schirm, noch nicht in der datenbank */
.mstueck.ungesichert{border-color:rgba(196,167,71,.6)}
.mungesichert{font-size:10px; letter-spacing:.1em; color:var(--messing); margin-bottom:7px}
.mstueckleib{display:flex; gap:14px; flex-wrap:wrap}
.mbildfach{
  width:118px; height:118px; flex:0 0 auto; border-radius:3px; cursor:pointer;
  display:flex; align-items:center; justify-content:center; overflow:hidden;
  background:rgba(0,0,0,.35); border:1px dashed rgba(184,115,51,.4);
  font-size:10px; letter-spacing:.08em; color:var(--asche); text-align:center;
}
.mbildfach:hover{border-color:var(--kupfer); color:var(--kupfer2)}
/* ein schaltplan ist breit, keine quadratische sigille */
.mbildfach.breit{width:200px; height:130px}
.mbildfach img{width:100%; height:100%; object-fit:contain}
.mfehlt{color:#d98070; font-size:9.5px; line-height:1.5; padding:6px}
.mbildfach{position:relative}
.mbildfach input{
  position:absolute; inset:0; width:100%; height:100%;
  opacity:0; cursor:pointer; font-size:0;
}
.mbeschreibung{
  flex:1 1 280px; min-width:0; resize:vertical; font-family:inherit; font-size:12px;
  line-height:1.6; padding:9px 11px; border-radius:3px; color:#b9beb5;
  background:rgba(0,0,0,.3); border:1px solid rgba(138,143,135,.2);
}
.mbeschreibung:focus{outline:none; border-color:var(--span2)}
.mratenblock{display:flex; flex-direction:column; gap:9px; flex:0 0 190px}
.mziffernfeld{
  font-family:inherit; font-size:19px; letter-spacing:.1em; text-align:center;
  padding:9px; border-radius:3px; color:var(--messing);
  background:rgba(0,0,0,.4); border:1px solid rgba(196,167,71,.3);
}
.mherkunft{
  font-family:inherit; font-size:11px; padding:7px 9px; border-radius:3px;
  color:var(--asche); background:rgba(0,0,0,.3);
  border:1px solid rgba(138,143,135,.2);
}
/* auslesen */
.mbtn.lesen{color:var(--kupfer2); border-color:rgba(184,115,51,.5); background:rgba(184,115,51,.1)}
.mbtn.lesen:hover{background:rgba(184,115,51,.22); border-color:var(--kupfer2); color:#f0c79a}
.mlesen{padding:20px clamp(12px,2vw,26px); max-width:1100px; margin:0 auto}
.mfeldgross.einzeilig{min-height:0; resize:none}
.mlesewahl{
  display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center; padding:12px 16px;
  border-radius:4px; margin-bottom:16px;
  background:linear-gradient(rgba(18,25,22,.8), rgba(10,15,13,.92));
  border:1px solid rgba(184,115,51,.22);
}
.mlesewahl .mquelle i{font-style:normal; opacity:.5; font-size:10px}
.mlesezahl{font-size:11px; color:var(--messing)}
.mlesewerk{display:flex; flex-wrap:wrap; align-items:center; gap:16px; margin-bottom:6px}
.mrauschen{
  width:220px; height:64px; border-radius:3px; image-rendering:pixelated;
  border:1px solid rgba(74,124,111,.35); background:#070a09; opacity:.35; transition:opacity .4s;
}
.mrauschen.an{opacity:1; border-color:var(--span2)}
.mhebel.gross{flex:0 0 190px; font-size:15px; padding:16px 12px; letter-spacing:.2em}
.mebenen{display:flex; flex-direction:column; gap:4px; font-size:10.5px; letter-spacing:.06em}
.mebenen span{opacity:.35; transition:.3s}
.mebenen span.an{opacity:1; color:var(--glut)}
.mtreffer{
  display:flex; gap:12px; align-items:flex-start; padding:11px 2px;
  border-bottom:1px solid rgba(138,143,135,.1);
}
.mtreffer:last-child{border-bottom:0}
.mtreffer.gewaehlt{background:rgba(184,115,51,.06)}
.mtrefferhaken{accent-color:var(--kupfer); width:16px; height:16px; margin-top:6px; flex:0 0 auto}
.mberichtkopf{gap:8px; flex-wrap:wrap}
.mtrefferleib{flex:1; min-width:0}
.mtrefferkopf{display:flex; flex-wrap:wrap; gap:4px 12px; align-items:baseline}
.mtrefferkopf b{font-family:'IM Fell English SC', Georgia, serif; font-size:16px; font-weight:400; color:var(--messing)}
.mtrefferkopf i{font-style:normal; font-size:10px; opacity:.55; letter-spacing:.08em}
.mtrefferrate{font-size:13px; color:var(--kupfer2); letter-spacing:.08em}
.mtrefferleib p{margin:4px 0 0; font-size:11.5px; line-height:1.55; color:#b9beb5}
.mbalken{height:3px; margin-top:7px; border-radius:2px; background:rgba(138,143,135,.12)}
.mbalken span{display:block; height:100%; border-radius:2px; background:var(--glut)}
.mtrefferwert{font-size:12px; color:var(--glut); flex:0 0 auto; padding-top:3px}
.meintrag .mtext small{opacity:.6}

/* hashtags */
.mtagleiste{display:flex; flex-wrap:wrap; gap:6px; margin:0 0 14px}
.mtags{display:flex; flex-wrap:wrap; gap:5px; margin-top:10px}
.mtag{
  font-family:inherit; font-size:11px; letter-spacing:.04em; padding:4px 9px;
  border-radius:12px; cursor:pointer; color:var(--span2);
  background:rgba(74,124,111,.1); border:1px solid rgba(74,124,111,.35); transition:.15s;
}
.mtag:hover{background:rgba(111,174,156,.22); color:#cfe8df}
.mtag.an{color:var(--grund); background:var(--span2); border-color:var(--span2)}
.mtag i{font-style:normal; opacity:.6; margin-left:3px; font-size:10px}
.mtag.klein{font-size:10px; padding:2px 8px}
.mtag.weg{color:var(--asche); background:transparent; border-style:dashed}
.mtag.fern{color:var(--kupfer2); background:rgba(184,115,51,.08); border-color:rgba(184,115,51,.4)}
.mverweis{
  margin-top:10px; padding-top:9px; font-size:10.5px; color:var(--span2); opacity:.8;
  border-top:1px solid rgba(74,124,111,.18); line-height:1.6;
}

/* ---- handy ---- */
@media(max-width:700px){
  .mop, .mschrank, .mfeld{padding-left:10px; padding-right:10px}
  .mmaschine{flex-direction:column}
  .mwand{flex:1 1 auto; width:100%}
  .mschaltung{min-height:320px; flex:0 0 auto; width:100%}
  .mschaltung.hatplan{min-height:0}
  /* kleinere kaestchen — auf schmalem schirm verdecken sie sonst die tafel */
  .mbauteil{width:58px; height:58px}
  .mzeichen{font-size:20px}
  .mnummer{width:17px; height:17px; line-height:17px; font-size:9px; top:-6px; left:-6px}
  .martkreis{width:17px; height:17px; line-height:16px; font-size:9px; top:-6px; left:11px}
  .mkachel{width:100%}
  .mkachelhuelle{width:100%}
  .msatzwort{font-size:13px; padding-top:3px}
  .mhaelfte{flex:1 1 100%}
  .mfeldgross{font-size:16px}
  .mstueckleib{flex-direction:column}
  .mratenblock{flex:1 1 auto}
  .mbtn{padding:9px 13px}
}
@media(max-width:700px) and (hover:none){
  .mweg, .meintrag .mklein{opacity:1}
}
`}</style>
  );
}
