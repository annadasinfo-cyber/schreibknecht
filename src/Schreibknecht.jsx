import React, { useState, useRef, useEffect, useCallback } from "react";

// ============================================================
// SCHREIBKNECHT · "write or die!" dr. wicked
// Jetzt mit Datenbank: was hier steht, steht auch am anderen Rechner.
// ============================================================

const URL_DB = "https://nafscbugauslcajtwixl.supabase.co";
const KEY_DB = "sb_publishable_32DoPNbrEB9ne7Iw-O4Jgg_FzNaLJYw";

const neueId = () => "id" + Math.random().toString(36).slice(2, 10);
// ============================================================
// DER VORLESER · nimmt die Stimme, die im Rechner steckt.
// Play und Pause — und zwar echtes Pausieren, nicht von vorn.
// Nur im Pult, sonst nirgends.
// ============================================================
function machVorleser() {
  let laeuft = null;
  return {
    da: typeof window !== "undefined" && "speechSynthesis" in window,
    lies(text, beiEnde) {
      const rede = window.speechSynthesis;
      rede.cancel();
      const t = (text || "").trim();
      if (!t) return false;
      const spruch = new SpeechSynthesisUtterance(t);
      spruch.lang = "de-DE";
      spruch.rate = 0.95;
      const stimmen = rede.getVoices().filter((v) => v.lang && v.lang.startsWith("de"));
      if (stimmen.length) spruch.voice = stimmen[0];
      spruch.onend = () => { laeuft = null; beiEnde && beiEnde(); };
      spruch.onerror = () => { laeuft = null; beiEnde && beiEnde(); };
      laeuft = spruch;
      rede.speak(spruch);
      return true;
    },
    anhalten() { window.speechSynthesis.pause(); },
    weiter() { window.speechSynthesis.resume(); },
    aus() { laeuft = null; window.speechSynthesis.cancel(); },
    redetGerade() { return !!laeuft; },
  };
}
const vorleser = typeof window !== "undefined" ? machVorleser() : { da: false };

// erst nach reihe, dann nach platz — wie man eine auslage liest
const sortiere = (a, b) => ((a.zeile || 0) - (b.zeile || 0)) || (a.pos - b.pos);
const zaehle = (t) => (t && t.trim() ? t.trim().split(/\s+/).filter(Boolean).length : 0);

// Anmeldung merken, wo es geht. In der Vorschau gibt es keinen Speicher —
// dann lebt sie eben nur bis zum Neuladen.
let sitzungMerk = null;
const sitzungLesen = () => {
  if (sitzungMerk) return sitzungMerk;
  try { const r = localStorage.getItem("sk:sitzung"); return r ? JSON.parse(r) : null; } catch { return null; }
};
const sitzungSchreiben = (s) => {
  sitzungMerk = s;
  try { s ? localStorage.setItem("sk:sitzung", JSON.stringify(s)) : localStorage.removeItem("sk:sitzung"); } catch {}
};

// ---------- Sprechen mit der Datenbank ----------
function machApi(sitzung, abmelden) {
  return async function api(methode, pfad, koerper, extra) {
    const r = await fetch(URL_DB + pfad, {
      method: methode,
      headers: {
        apikey: KEY_DB,
        Authorization: "Bearer " + (sitzung ? sitzung.access_token : KEY_DB),
        "Content-Type": "application/json",
        ...extra,
      },
      body: koerper === undefined ? undefined : JSON.stringify(koerper),
    });
    if (r.status === 401) { abmelden && abmelden(); throw new Error("abgemeldet"); }
    if (!r.ok) throw new Error((await r.text()).slice(0, 200) || ("status " + r.status));
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
}

// Kacheln liegen unregelmaessig — aber immer gleich unregelmaessig.
const streuung = (id) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 997;
  return { breit: [200, 250, 300, 230][h % 4], kipp: ((h % 5) - 2) * 0.35, hoch: (h % 3) * 4 };
};

// ---------- Kerze ----------
function Kerze({ seite, aus }) {
  return (
    <div className={"kerze " + seite + (aus ? " aus" : "")}
      title={aus ? "seit 45 minuten kein wort" : undefined} aria-hidden="true">
      <div className="flamme"><i /><b /><s className="rauch" /></div>
      <div className="docht" />
      <div className="wachs"><div className="tropfen t1" /><div className="tropfen t2" /></div>
    </div>
  );
}

// ---------- Anmeldung ----------
function Anmeldung({ anmelden, fehler, laeuft }) {
  const [mail, setMail] = useState("");
  const [wort, setWort] = useState("");
  return (
    <div className="pforte">
      <div className="pfortenkasten">
        <p className="pfortentext">der knecht kennt nur eine herrin.</p>
        <input className="ti" type="email" value={mail} placeholder="e-mail" autoComplete="username"
          onChange={(e) => setMail(e.target.value)} />
        <input className="ti" type="password" value={wort} placeholder="passwort" autoComplete="current-password"
          onChange={(e) => setWort(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && anmelden(mail, wort)} />
        <button className="btn gross" disabled={laeuft || !mail || !wort}
          onClick={() => anmelden(mail, wort)}>{laeuft ? "…" : "eintreten"}</button>
        {fehler && <p className="pfortenfehler">{fehler}</p>}
      </div>
    </div>
  );
}

// ---------- eine Karte ----------
function Karte({ karte, bildUrl, onText, onTitel, onBild, onDrehen, onWeg, onDoppeln, onSchneiden,
                inHand, aufPult, onAufsPult, onGriff, ziehend, zielMarke, angepeilt }) {
  const feld = useRef(null);

  // Der Browser macht sonst einen halbdurchsichtigen Abzug der Karte —
  // und erwischt dabei die im Raum gedrehte Rueckseite, also spiegelverkehrt.
  // Darum haengen wir ihm ein eigenes, lesbares Schildchen unter die Maus.
  return (
    <div data-ziel={zielMarke}
      className={"kartenplatz" + (ziehend ? " ziehend" : "") + (inHand ? " inhand" : "")
        + (angepeilt ? " angepeilt" : "")}>
      <button className="verbrennen" onClick={onWeg}
        title="karte verbrennen">✕</button>
      {/* die kartenkante — hier packt man an, und die karte folgt dem finger */}
      <div className="griff" onPointerDown={onGriff} title="karte nehmen und legen">
        <i /><i /><i />
      </div>
      <div className={"karte" + (karte.gedreht ? " um" : "")}>

        <div className="seite text">
          <textarea value={karte.text} onChange={(e) => onText(e.target.value)}
            placeholder="…" spellCheck={false} />
          <div className="fuss">
            <span className="woerter">{zaehle(karte.text) || ""}</span>
            <button className={"klein" + (aufPult ? " an" : "")} onClick={onAufsPult}
              title={aufPult ? "vom pult nehmen" : "gross aufschlagen"}>⤢</button>
            <button className="klein" onClick={onDoppeln} title="karte doppeln">⧉</button>
            <button className="klein" onClick={onSchneiden}
              title={inHand ? "liegt in der hand — nochmal tippen legt sie zurück" : "in die hand nehmen, woanders ablegen"}>✂</button>
            <button className="klein" onClick={onDrehen} title="umdrehen">↻</button>
          </div>
          <div className="druckkopie" aria-hidden="true">
            {bildUrl ? <img src={bildUrl} alt="" /> : null}
            {karte.titel ? <b>{karte.titel}</b> : null}{karte.text}
          </div>
        </div>

        <div className="seite bild">
          {bildUrl
            ? <img src={bildUrl} alt="" />
            : <button className="bildleer" onClick={() => feld.current && feld.current.click()}>
                <span className="siegel">{karte.bild ? "…" : "✧"}</span>
                <span>{karte.bild ? "wird geholt" : "bild wählen"}</span>
              </button>}
          <input ref={feld} type="file" accept="image/*" hidden
            onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) onBild(f); e.target.value = ""; }} />
          <div className="fuss">
            {karte.bild && <button className="klein" onClick={() => onBild(null)} title="bild entfernen">⌫</button>}
            <input className="kartentitel" value={karte.titel || ""} placeholder="beschriftung"
              onChange={(e) => onTitel(e.target.value)} />
            <button className="klein" onClick={onDrehen} title="umdrehen">↻</button>
          </div>
        </div>

      </div>
    </div>
  );
}

// ---------- Projekt-Seite ----------
function ProjektSeite({ projekt, api, bilder, holBild, hochladen, aendere, zurueck, sag,
                       hand, setHand, laden }) {
  const [zug, setZug] = useState(null);      // {ai, id, karte, dx, dy, x, y, laeuft}
  const [ziel, setZiel] = useState(null);   // worauf gerade gezeigt wird
  const zugRef = useRef(null);
  const zielRef = useRef(null);

  // ---- die karte am finger ----
  // eigene mechanik statt der browser-ziehmechanik: die ist fuers verschieben
  // von dateien gedacht, ruckelt, laesst nicht aus textfeldern greifen und
  // kann kein handy. so folgt die karte dem zeiger eins zu eins.
  const griffAn = (e, ai, k) => {
    if (e.button != null && e.button !== 0) return;
    const kasten = e.currentTarget.closest(".kartenplatz").getBoundingClientRect();
    const z = { ai, id: k.id, karte: k, laeuft: false,
      dx: e.clientX - kasten.left, dy: e.clientY - kasten.top,
      x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY };
    zugRef.current = z;
    setZug(z);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  };

  useEffect(() => {
    const bewegt = (e) => {
      const z = zugRef.current;
      if (!z) return;
      const weit = Math.abs(e.clientX - z.startX) + Math.abs(e.clientY - z.startY);
      if (!z.laeuft && weit < 5) return;          // erst ab fuenf pixeln zaehlt es
      z.laeuft = true; z.x = e.clientX; z.y = e.clientY;
      setZug({ ...z });
      // was liegt unter dem finger?
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const feld = el && el.closest && el.closest("[data-ziel]");
      const neuZiel = feld ? feld.getAttribute("data-ziel") : null;
      if (neuZiel !== zielRef.current) { zielRef.current = neuZiel; setZiel(neuZiel); }
    };
    const los = () => {
      const z = zugRef.current, t = zielRef.current;
      zugRef.current = null; zielRef.current = null;
      setZug(null); setZiel(null);
      if (!z || !z.laeuft || !t) return;
      const [art, ai, pos, zeile] = t.split(":");
      if (art === "spalt") dazwischen(Number(ai), Number(pos), Number(zeile), z.id);
      else legeHin(z, Number(ai), Number(pos), Number(zeile));
    };
    window.addEventListener("pointermove", bewegt);
    window.addEventListener("pointerup", los);
    window.addEventListener("pointercancel", los);
    return () => {
      window.removeEventListener("pointermove", bewegt);
      window.removeEventListener("pointerup", los);
      window.removeEventListener("pointercancel", los);
    };
  }); // absichtlich bei jedem durchlauf neu — so kennen die zuhoerer den aktuellen stand
  const [mitBild, setMitBild] = useState(true);
  const [mischt, setMischt] = useState(null);
  const [nurDieser, setNurDieser] = useState(null);
  const [pult, setPult] = useState([]);   // bis zu zwei karten-ids, gross aufgeschlagen
  const [liest, setLiest] = useState(null);   // {id, pause} — wer gerade vorgelesen wird
  const [asche, setAsche] = useState(null);  // zuletzt verbrannte karte, kurz zurueckholbar

  // die asche kuehlt nach einer halben minute aus
  useEffect(() => {
    if (!asche) return;
    const t = setTimeout(() => setAsche(null), Math.max(0, asche.bis - Date.now()));
    return () => clearTimeout(t);
  }, [asche]);
  const uhren = useRef({});

  // eine karte aufs pult legen. die dritte schiebt die aelteste runter.
  const aufsPult = (id) => setPult((l) =>
    l.includes(id) ? l.filter((x) => x !== id) : [...l, id].slice(-2));
  const vomPult = (id) => setPult((l) => l.filter((x) => x !== id));

  // vorlesen: play und pause. pause haelt an, wo er ist — nicht von vorn.
  const vorlesen = (id, text) => {
    if (liest && liest.id === id) {
      if (liest.pause) { vorleser.weiter(); setLiest({ id, pause: false }); }
      else { vorleser.anhalten(); setLiest({ id, pause: true }); }
      return;
    }
    if (!vorleser.lies(text, () => setLiest(null))) return;
    setLiest({ id, pause: false });
  };
  const vorlesenAus = () => { vorleser.aus(); setLiest(null); };

  // beim schliessen des pults hoert er auf
  useEffect(() => { if (!pult.length && liest) vorlesenAus(); }, [pult.length]); // eslint-disable-line
  useEffect(() => () => vorleser.aus && vorleser.aus(), []);

  // escape schliesst das pult
  useEffect(() => {
    if (!pult.length) return;
    const z = (e) => { if (e.key === "Escape") setPult([]); };
    window.addEventListener("keydown", z);
    return () => window.removeEventListener("keydown", z);
  }, [pult.length]);

  // finde eine karte im ganzen projekt, egal in welchem abschnitt sie liegt
  const findeKarte = (id) => {
    for (let ai = 0; ai < projekt.abschnitte.length; ai++) {
      const ki = projekt.abschnitte[ai].karten.findIndex((k) => k.id === id);
      if (ki >= 0) return { ai, ki, karte: projekt.abschnitte[ai].karten[ki],
        abschnitt: projekt.abschnitte[ai] };
    }
    return null;
  };

  const abschnittDrucken = (id) => {
    setNurDieser(id);
    setTimeout(() => { window.print(); setTimeout(() => setNurDieser(null), 400); }, 60);
  };

  // sofort auf dem schirm, zwei sekunden spaeter in der datenbank
  const setText = (ai, ki, wert) => {
    const k = projekt.abschnitte[ai].karten[ki];
    aendere((p) => { p.abschnitte[ai].karten[ki].text = wert; });
    clearTimeout(uhren.current[k.id]);
    uhren.current[k.id] = setTimeout(() => {
      api("PATCH", `/rest/v1/karten?id=eq.${k.id}`, { text: wert }).catch((e) => sag(String(e.message)));
    }, 2000);
  };

  // beschriftung auf der bildseite
  const setTitel2 = (ai, ki, wert) => {
    const k = projekt.abschnitte[ai].karten[ki];
    aendere((p) => { p.abschnitte[ai].karten[ki].titel = wert; });
    clearTimeout(uhren.current["t" + k.id]);
    uhren.current["t" + k.id] = setTimeout(() => {
      api("PATCH", `/rest/v1/karten?id=eq.${k.id}`, { titel: wert }).catch(() => {});
    }, 1200);
  };

  const drehen = (ai, ki) => {
    const k = projekt.abschnitte[ai].karten[ki];
    const neu = !k.gedreht;
    aendere((p) => { p.abschnitte[ai].karten[ki].gedreht = neu; });
    api("PATCH", `/rest/v1/karten?id=eq.${k.id}`, { gedreht: neu }).catch(() => {});
    if (neu && k.bild) holBild(k.bild);
  };

  const karteZu = (ai, pos, zeile) => {
    const a = projekt.abschnitte[ai];
    const z = zeile != null ? zeile : 0;
    const inZ = a.karten.filter((k) => (k.zeile || 0) === z);
    const platz = pos != null ? pos : (inZ.length ? Math.max(...inZ.map((k) => k.pos)) + 1 : 0);
    const neu = { id: neueId(), abschnitt_id: a.id, text: "", titel: "", bild: null,
      gedreht: false, pos: platz, zeile: z };
    aendere((p) => { p.abschnitte[ai].karten = [...p.abschnitte[ai].karten, neu].sort(sortiere); });
    api("POST", "/rest/v1/karten", neu).catch((e) => sag(String(e.message)));
  };

  // eine Karte doppeln — landet gleich daneben
  const karteDoppeln = (ai, k) => {
    const a = projekt.abschnitte[ai];
    const z = k.zeile || 0;
    const belegt = new Set(a.karten.filter((x) => (x.zeile || 0) === z).map((x) => x.pos));
    let platz = k.pos + 1;
    while (belegt.has(platz)) platz++;          // erster freier platz dahinter
    const neu = { id: neueId(), abschnitt_id: a.id, text: k.text, titel: k.titel || "",
      bild: k.bild, gedreht: false, pos: platz, zeile: z };
    aendere((p) => { p.abschnitte[ai].karten = [...p.abschnitte[ai].karten, neu].sort(sortiere); });
    api("POST", "/rest/v1/karten", neu).catch((e) => sag(String(e.message)));
    if (k.bild) holBild(k.bild);
  };

  // in die Hand nehmen — wie eine echte Karte, die man hochhebt
  const schneiden = (k) => {
    setHand((h) => (h && h.id === k.id
      ? null
      : { id: k.id, name: (k.titel || k.text || "").trim().slice(0, 40) }));
  };

  // und woanders wieder hinlegen
  const ablegenAusHand = async (ai, pos, zeile) => {
    const a = projekt.abschnitte[ai];
    try {
      await api("PATCH", `/rest/v1/karten?id=eq.${hand.id}`, { abschnitt_id: a.id, pos, zeile });
      setHand(null);
      await laden();
    } catch (e) { sag(String(e.message)); }
  };

  // Verbrennen mit Netz: erst fragen, dann 30 sekunden lang zurueckholbar
  const karteWeg = (ai, ki) => {
    const k = projekt.abschnitte[ai].karten[ki];
    const name = (k.titel || k.text || "").trim().slice(0, 50);
    const woerter = zaehle(k.text);
    if (woerter > 3 && !confirm(
      `„${name || "diese karte"}" verbrennen?\n\n${woerter} wörter gehen dabei weg.`)) return;
    aendere((p) => { p.abschnitte[ai].karten.splice(ki, 1); });
    api("DELETE", `/rest/v1/karten?id=eq.${k.id}`).catch(() => {});
    setAsche({ karte: { ...k }, bis: Date.now() + 30000 });
  };

  // die verbrannte karte kommt zurueck, wenn man schnell genug ist
  const ausDerAsche = async () => {
    if (!asche) return;
    const k = asche.karte;
    setAsche(null);
    try {
      await api("POST", "/rest/v1/karten", k);
      await laden();
    } catch (e) { sag(String(e.message)); }
  };

  const setBild = async (ai, ki, datei) => {
    const k = projekt.abschnitte[ai].karten[ki];
    if (!datei) {
      aendere((p) => { p.abschnitte[ai].karten[ki].bild = null; });
      api("PATCH", `/rest/v1/karten?id=eq.${k.id}`, { bild: null }).catch(() => {});
      return;
    }
    try {
      sag("bild wird abgelegt …");
      const pfad = await hochladen(datei, k.id);
      aendere((p) => { p.abschnitte[ai].karten[ki].bild = pfad; });
      await api("PATCH", `/rest/v1/karten?id=eq.${k.id}`, { bild: pfad });
      holBild(pfad);
      sag("");
    } catch (e) { sag("bild ging nicht: " + String(e.message)); }
  };

  const abschnittZu = () => {
    const neu = { id: neueId(), projekt_id: projekt.id, titel: "neuer abschnitt", pos: projekt.abschnitte.length };
    aendere((p) => { p.abschnitte.push({ ...neu, karten: [] }); });
    api("POST", "/rest/v1/abschnitte", neu).catch((e) => sag(String(e.message)));
  };

  // einen trennstrich hoeher oder tiefer legen
  const abschnittRuecken = (ai, richtung) => {
    const ziel = ai + richtung;
    if (ziel < 0 || ziel >= projekt.abschnitte.length) return;
    const a = projekt.abschnitte[ai], b = projekt.abschnitte[ziel];
    aendere((p) => {
      const x = p.abschnitte[ai];
      p.abschnitte[ai] = { ...p.abschnitte[ziel], pos: ai };
      p.abschnitte[ziel] = { ...x, pos: ziel };
    });
    api("PATCH", `/rest/v1/abschnitte?id=eq.${a.id}`, { pos: ziel }).catch(() => {});
    api("PATCH", `/rest/v1/abschnitte?id=eq.${b.id}`, { pos: ai }).catch(() => {});
  };

  const abschnittWeg = (ai) => {
    const a = projekt.abschnitte[ai];
    if (a.karten.length && !confirm(`„${a.titel}" mit ${a.karten.length} karten entfernen?`)) return;
    aendere((p) => { p.abschnitte.splice(ai, 1); });
    api("DELETE", `/rest/v1/abschnitte?id=eq.${a.id}`).catch(() => {});
  };

  const setTitel = (ai, wert) => {
    const a = projekt.abschnitte[ai];
    aendere((p) => { p.abschnitte[ai].titel = wert; });
    clearTimeout(uhren.current[a.id]);
    uhren.current[a.id] = setTimeout(() => {
      api("PATCH", `/rest/v1/abschnitte?id=eq.${a.id}`, { titel: wert }).catch(() => {});
    }, 1200);
  };

  // Reihenfolge in der Datenbank nachziehen
  // eine Karte auf einen bestimmten Platz setzen
  const setzePos = (karteId, pos, zeile, abschnittId) =>
    api("PATCH", `/rest/v1/karten?id=eq.${karteId}`, { pos, zeile, abschnitt_id: abschnittId }).catch(() => {});

  // A.I.M. — mischen. Die BELEGTEN Plaetze bleiben, nur die Karten
  // wechseln untereinander die Fächer. Luecken bleiben Luecken.
  const mischen = (ai) => {
    const a = projekt.abschnitte[ai];
    setMischt(a.id);
    setTimeout(() => {
      let neu = [];
      aendere((p) => {
        const k = p.abschnitte[ai].karten;
        const faecher = k.map((x) => ({ pos: x.pos, zeile: x.zeile || 0 }));
        const gemischt = [...k];
        for (let i = gemischt.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [gemischt[i], gemischt[j]] = [gemischt[j], gemischt[i]];
        }
        gemischt.forEach((x, i) => { x.pos = faecher[i].pos; x.zeile = faecher[i].zeile; });
        gemischt.sort(sortiere);
        p.abschnitte[ai].karten = gemischt;
        neu = gemischt.map((x) => ({ id: x.id, pos: x.pos, zeile: x.zeile }));
      });
      neu.forEach((x) => setzePos(x.id, x.pos, x.zeile, a.id));
      setTimeout(() => setMischt(null), 420);
    }, 260);
  };

  // auf einen Platz ziehen. Ist er frei, wandert die Karte hin.
  // Liegt dort schon eine, tauschen die beiden die Plaetze.
  const legeHin = (zug, zielA, zielPos, zielZeile) => {
    if (!zug) return;
    const vonAb = projekt.abschnitte[zug.ai];
    const nachAb = projekt.abschnitte[zielA];
    const karte = vonAb.karten.find((k) => k.id === zug.id);
    if (!karte) return;
    const dort = nachAb.karten.find((k) => k.pos === zielPos && (k.zeile || 0) === zielZeile);
    if (dort && dort.id === karte.id) return;

    const altePos = karte.pos, alteZeile = karte.zeile || 0, alterAb = vonAb.id;
    aendere((p) => {
      const vk = p.abschnitte[zug.ai].karten;
      const nk = p.abschnitte[zielA].karten;
      const i = vk.findIndex((k) => k.id === karte.id);
      const [raus] = vk.splice(i, 1);
      if (dort) {
        const j = nk.findIndex((k) => k.id === dort.id);
        const getauscht = { ...dort, pos: altePos, zeile: alteZeile };
        if (zug.ai !== zielA) { nk.splice(j, 1); vk.push(getauscht); }
        else nk[j] = getauscht;
      }
      nk.push({ ...raus, pos: zielPos, zeile: zielZeile });
      p.abschnitte[zielA].karten = nk.sort(sortiere);
      p.abschnitte[zug.ai].karten = vk.sort(sortiere);
    });
    setzePos(karte.id, zielPos, zielZeile, nachAb.id);
    if (dort) setzePos(dort.id, altePos, alteZeile, alterAb);
  };

  // ZWISCHEN zwei karten schieben: alles ab hier rueckt einen platz weiter,
  // dann faellt die karte in die entstandene luecke.
  const dazwischen = async (zielA, zielPos, zielZeile, karteId) => {
    const nachAb = projekt.abschnitte[zielA];
    const ruecken = nachAb.karten.filter(
      (k) => (k.zeile || 0) === zielZeile && k.pos >= zielPos && k.id !== karteId);
    try {
      // von hinten nach vorn, damit sich nichts gegenseitig ueberholt
      for (const k of [...ruecken].sort((x, y) => y.pos - x.pos)) {
        await api("PATCH", `/rest/v1/karten?id=eq.${k.id}`, { pos: k.pos + 1 });
      }
      await api("PATCH", `/rest/v1/karten?id=eq.${karteId}`,
        { abschnitt_id: nachAb.id, pos: zielPos, zeile: zielZeile });
      await laden();
    } catch (e) { sag(String(e.message)); }
    setHand(null);
  };

  return (
    <>
      <div className="leiste">
        <button className="btn" onClick={zurueck}>‹ alle projekte</button>
        <input className="projektname" value={projekt.name}
          style={{ width: Math.max(14, (projekt.name || "").length + 2) + "ch" }}
          onChange={(e) => {
            const v = e.target.value;
            aendere((p) => { p.name = v; });
            clearTimeout(uhren.current[projekt.id]);
            uhren.current[projekt.id] = setTimeout(() => {
              api("PATCH", `/rest/v1/projekte?id=eq.${projekt.id}`, { name: v }).catch(() => {});
            }, 1200);
          }} />
        <span className="fuellung" />
        <label className="schalter">
          <input type="checkbox" checked={mitBild} onChange={(e) => setMitBild(e.target.checked)} />
          bilder mitdrucken
        </label>
        <button className="btn" onClick={() => window.print()}>drucken</button>
      </div>

      <div className={"blatt" + (mitBild && !nurDieser ? "" : " ohnebild") + (nurDieser ? " einzeln" : "")}>
        {projekt.abschnitte.map((a, ai) => (
          <section key={a.id}
            className={"abschnitt" + (mischt === a.id ? " mischt" : "") + (nurDieser === a.id ? " gedruckt" : "")}>

            <div className="trennstrich">
              <input className="strichtitel" value={a.titel}
                style={{ width: Math.max(10, (a.titel || "").length + 2) + "ch" }}
                onChange={(e) => setTitel(ai, e.target.value)} />
              <span className="abzahl">
                {a.karten.reduce((x, k) => x + zaehle(k.text), 0).toLocaleString("de-DE")}
              </span>
              <span className="linie" />
              <button className="wuerfel" onClick={() => mischen(ai)}
                title="karten mischen — neue nachbarschaften">⚄</button>
              <button className="klein" onClick={() => abschnittDrucken(a.id)}
                title="nur diesen abschnitt drucken, ohne bilder">⎙</button>
              <button className="klein" onClick={() => karteZu(ai)} title="karte anlegen">+</button>
              <button className="klein" onClick={() => abschnittRuecken(ai, -1)} disabled={ai === 0}
                title="abschnitt höher legen">↑</button>
              <button className="klein" onClick={() => abschnittRuecken(ai, 1)}
                disabled={ai === projekt.abschnitte.length - 1} title="abschnitt tiefer legen">↓</button>
              <button className="klein weg" onClick={() => abschnittWeg(ai)} title="abschnitt entfernen">✕</button>
            </div>

            {/* ein abschnitt ist eine auslage aus REIHEN und PLAETZEN.
                luecken duerfen bleiben. die reihen ueber und unter erscheinen
                nur, solange eine karte in der luft ist — sonst waere alles
                voller platzhalter. */}
            {(() => {
              const inDerLuft = !!((zug && zug.laeuft) || hand);
              const zeilenDa = a.karten.length ? a.karten.map((k) => k.zeile || 0) : [0];
              const vonZ = Math.min(...zeilenDa);
              const bisZ = Math.max(...zeilenDa);
              const reihen = [];
              for (let z = vonZ; z <= bisZ; z++) reihen.push(z);

              // die zwei streifen fuer eine NEUE reihe liegen in reserviertem
              // rand — sie erscheinen nur beim ziehen, verschieben aber nichts.
              const streifen = inDerLuft ? [
                <button key="oben" className={"neuezeile oben" + (ziel === `feld:${ai}:0:${vonZ - 1}` ? " angepeilt" : "")}
                  data-ziel={`feld:${ai}:0:${vonZ - 1}`} title="neue reihe darüber"
                  onClick={() => hand && ablegenAusHand(ai, 0, vonZ - 1)} />,
                <button key="unten" className={"neuezeile unten" + (ziel === `feld:${ai}:0:${bisZ + 1}` ? " angepeilt" : "")}
                  data-ziel={`feld:${ai}:0:${bisZ + 1}`} title="neue reihe darunter"
                  onClick={() => hand && ablegenAusHand(ai, 0, bisZ + 1)} />,
              ] : null;

              return [streifen, reihen.map((z) => {
                const inZ = a.karten.filter((k) => (k.zeile || 0) === z);
                const belegt = new Map(inZ.map((k) => [k.pos, k]));
                const hoechste = inZ.length ? Math.max(...inZ.map((k) => k.pos)) : -1;
                const anzahl = Math.max(hoechste + 2, 4);

                return (
                  <div className={"reihe" + (inDerLuft ? " hebt" : "")} key={"z" + z}>
                    {Array.from({ length: anzahl }, (_, pos) => {
                      const k = belegt.get(pos);
                      const marke = `feld:${ai}:${pos}:${z}`;
                      const spaltMarke = `spalt:${ai}:${pos}:${z}`;
                      const spalt = inDerLuft && k ? (
                        <button key={"sp" + z + "-" + pos}
                          className={"spalt" + (ziel === spaltMarke ? " an" : "")}
                          data-ziel={spaltMarke} title="hier dazwischen schieben"
                          onClick={() => hand && dazwischen(ai, pos, z, hand.id)}>
                          <i />
                        </button>
                      ) : null;
                      if (k) {
                        const ki = a.karten.findIndex((x) => x.id === k.id);
                        return (
                          <React.Fragment key={k.id}>
                          {spalt}
                          <Karte karte={k} bildUrl={k.bild ? bilder[k.bild] : null}
                            ziehend={zug && zug.laeuft && zug.id === k.id}
                            zielMarke={marke} angepeilt={ziel === marke}
                            onGriff={(e) => griffAn(e, ai, k)}
                            onText={(v) => setText(ai, ki, v)}
                            onTitel={(v) => setTitel2(ai, ki, v)}
                            onBild={(f) => setBild(ai, ki, f)}
                            onDrehen={() => drehen(ai, ki)}
                            onDoppeln={() => karteDoppeln(ai, k)}
                            onSchneiden={() => schneiden(k)}
                            inHand={hand && hand.id === k.id}
                            aufPult={pult.includes(k.id)}
                            onAufsPult={() => aufsPult(k.id)}
                            onWeg={() => karteWeg(ai, ki)} />
                          </React.Fragment>
                        );
                      }
                      return (
                        <button key={"leer" + z + "-" + pos}
                          className={"kartenplatz leer" + (hand ? " ablage" : "") + (ziel === marke ? " angepeilt" : "")}
                          data-ziel={marke}
                          title={hand ? "karte aus der hand hier ablegen" : "hier eine karte anlegen"}
                          onClick={() => (hand ? ablegenAusHand(ai, pos, z) : karteZu(ai, pos, z))}>
                          <span className="siegelzeichen">{hand ? "✋" : "🐾"}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })];
            })()}
          </section>
        ))}

        <button className="abschnittneu" onClick={abschnittZu}>+ trennstrich</button>
      </div>

      {/* DAS PULT — klappt unter der auslage auf, die karten oben bleiben sichtbar.
          bis zu zwei karten nebeneinander, aus beliebigen abschnitten. */}
      {/* die karte, die gerade am finger haengt */}
      {zug && zug.laeuft && (
        <div className="amfinger" style={{ left: zug.x - zug.dx, top: zug.y - zug.dy }}>
          {zug.karte.titel ? <b>{zug.karte.titel}</b> : null}
          <span>{(zug.karte.text || "").trim()}</span>
        </div>
      )}

      {asche && (
        <div className="ascheleiste">
          <span className="handzeichen">✦</span>
          <span className="handtext">
            {(asche.karte.titel || asche.karte.text || "eine karte").trim().slice(0, 50)}
          </span>
          <span className="handhinweis">verbrannt</span>
          <button className="btn" onClick={ausDerAsche}>zurückholen</button>
          <button className="klein" onClick={() => setAsche(null)}>✕</button>
        </div>
      )}

      {pult.length > 0 && (
        <div className="pult">
          <div className="pultkopf">
            <span className="pultname">pult</span>
            <span className="pulthinweis">
              {pult.length === 1 ? "eine karte — leg eine zweite dazu" : "zwei karten"}
            </span>
            <span className="fuellung" />
            <button className="klein" onClick={() => setPult([])} title="pult schließen · esc">✕</button>
          </div>
          <div className={"pultblatt" + (pult.length === 2 ? " zwei" : "")}>
            {pult.map((id) => {
              const f = findeKarte(id);
              if (!f) return null;
              return (
                <div className="bogen" key={id}>
                  <div className="bogenkopf">
                    <input className="bogentitel" value={f.karte.titel || ""} placeholder="beschriftung"
                      onChange={(e) => setTitel2(f.ai, f.ki, e.target.value)} />
                    <span className="bogenort">{f.abschnitt.titel}</span>
                    <button className="klein" onClick={() => vomPult(id)} title="vom pult nehmen">✕</button>
                  </div>
                  {f.karte.bild && bilder[f.karte.bild] && (
                    <img className="bogenbild" src={bilder[f.karte.bild]} alt="" />
                  )}
                  <textarea className="bogenfeld" value={f.karte.text} spellCheck={false}
                    placeholder="…" onChange={(e) => setText(f.ai, f.ki, e.target.value)} />
                  <div className="druckkopie" aria-hidden="true">
                    {f.karte.titel ? <b>{f.karte.titel}</b> : null}{f.karte.text}
                  </div>
                  <div className="bogenfuss">
                    {vorleser.da && (
                      <>
                        <button className="klein" onClick={() => vorlesen(id, f.karte.text)}
                          disabled={!f.karte.text.trim()}
                          title={liest && liest.id === id && !liest.pause ? "anhalten" : "vorlesen"}>
                          {liest && liest.id === id && !liest.pause ? "❚❚" : "▶"}
                        </button>
                        {liest && liest.id === id && (
                          <button className="klein" onClick={vorlesenAus} title="von vorn / aus">■</button>
                        )}
                      </>
                    )}
                    <span className="fuellung" />
                    {zaehle(f.karte.text).toLocaleString("de-DE")} wörter
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

// ---------- Deckblatt ----------
function Deckblatt({ projekte, anlegen, oeffnen, weg, kopieren }) {
  return (
    <div className="deckblatt">
      <div className="kachelfeld">
        {projekte.map((p) => {
          const s = streuung(p.id);
          const n = p.abschnitte.reduce((x, a) => x + a.karten.length, 0);
          return (
            <div key={p.id} className="kachelhuelle" style={{ width: s.breit, marginTop: s.hoch }}>
              <button className="kachel" onClick={() => oeffnen(p.id)}
                style={{ transform: `rotate(${s.kipp}deg)` }}>
                <span className="kachelname">{p.name}</span>
                <span className="kachelzeile">
                  <span>{n} {n === 1 ? "karte" : "karten"}</span>
                  <span className="kacheldatum">
                    {p.created_at
                      ? new Date(p.created_at).toLocaleDateString("de-DE",
                          { day: "2-digit", month: "2-digit", year: "numeric" })
                      : ""}
                  </span>
                </span>
              </button>
              <button className="kachelkopie" title="projekt kopieren" onClick={() => kopieren(p)}>⧉</button>
              <button className="kachelweg" title="projekt entfernen" onClick={() => weg(p)}>✕</button>
            </div>
          );
        })}
        <button className="kachel neu" onClick={anlegen}><span className="plus">+</span></button>
      </div>
      {!projekte.length && <p className="leerwort">noch nichts. leg ein projekt an.</p>}
    </div>
  );
}

const STILLE = 45 * 60 * 1000;

// ---------- App ----------
export default function Schreibknecht() {
  const [sitzung, setSitzung] = useState(sitzungLesen);
  const [fehler, setFehler] = useState("");
  const [laeuft, setLaeuft] = useState(false);
  const [projekte, setProjekte] = useState([]);
  const [offen, setOffen] = useState(null);
  const [bilder, setBilder] = useState({});
  const [msg, setMsg] = useState("");
  const [geladen, setGeladen] = useState(false);
  const [hand, setHand] = useState(null);   // ausgeschnittene karte, wartet aufs ablegen
  const zuletztUhr = useRef(null);

  const abmelden = useCallback(() => {
    sitzungSchreiben(null); setSitzung(null); setGeladen(false);
    setProjekte([]); setOffen(null); setBilder({});
  }, []);

  const api = useCallback(machApi(sitzung, abmelden), [sitzung, abmelden]);

  const anmelden = async (mail, wort) => {
    setLaeuft(true); setFehler("");
    try {
      const r = await fetch(URL_DB + "/auth/v1/token?grant_type=password", {
        method: "POST",
        headers: { apikey: KEY_DB, "Content-Type": "application/json" },
        body: JSON.stringify({ email: mail, password: wort }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error_description || d.msg || d.message || "geht nicht");
      sitzungSchreiben(d); setSitzung(d);
    } catch (e) { setFehler(String(e.message)); }
    setLaeuft(false);
  };

  // ---- alles holen ----
  const laden = useCallback(async () => {
    try {
      const [pr, ab, ka] = await Promise.all([
        api("GET", "/rest/v1/projekte?select=*&order=zuletzt.desc"),
        api("GET", "/rest/v1/abschnitte?select=*&order=pos.asc"),
        api("GET", "/rest/v1/karten?select=*&order=pos.asc"),
      ]);
      setProjekte((pr || []).map((p) => ({
        ...p,
        abschnitte: (ab || []).filter((a) => a.projekt_id === p.id)
          .map((a) => ({ ...a, karten: (ka || []).filter((k) => k.abschnitt_id === a.id) })),
      })));
      setGeladen(true);
    } catch (e) { setMsg(String(e.message)); }
  }, [api]);

  useEffect(() => { if (sitzung) laden(); }, [sitzung, laden]);

  // ---- Bilder: fuer einen Pfad eine Adresse besorgen ----
  const holBild = useCallback(async (pfad) => {
    if (!pfad) return;
    try {
      const d = await api("POST", `/storage/v1/object/sign/kartenbilder/${pfad}`, { expiresIn: 3600 });
      if (d && d.signedURL) setBilder((b) => ({ ...b, [pfad]: URL_DB + "/storage/v1" + d.signedURL }));
    } catch {}
  }, [api]);

  // beim Laden alle vorhandenen Bilder anfordern
  const geholt = useRef({});
  useEffect(() => {
    if (!geladen) return;
    projekte.forEach((p) => p.abschnitte.forEach((a) => a.karten.forEach((k) => {
      if (k.bild && !geholt.current[k.bild]) { geholt.current[k.bild] = true; holBild(k.bild); }
    })));
  }, [geladen, projekte, holBild]);

  // ---- Bild ablegen ----
  const hochladen = useCallback(async (datei, karteId) => {
    const endung = (datei.name.split(".").pop() || "jpg").toLowerCase();
    const pfad = `${sitzung.user.id}/${karteId}.${endung}`;
    const r = await fetch(`${URL_DB}/storage/v1/object/kartenbilder/${pfad}`, {
      method: "POST",
      headers: {
        apikey: KEY_DB,
        Authorization: "Bearer " + sitzung.access_token,
        "x-upsert": "true",
        "Content-Type": datei.type || "application/octet-stream",
      },
      body: datei,
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 160));
    return pfad;
  }, [sitzung]);

  // ---- ein Projekt aendern ----
  const aendere = (fn) => {
    setProjekte((l) => {
      const neu = l.map((p) => {
        if (p.id !== offen) return p;
        const kopie = { ...p, abschnitte: p.abschnitte.map((a) => ({ ...a, karten: [...a.karten] })) };
        fn(kopie);
        return { ...kopie, zuletzt: new Date().toISOString() };
      });
      return [...neu].sort((a, b) => String(b.zuletzt || "").localeCompare(String(a.zuletzt || "")));
    });
    clearTimeout(zuletztUhr.current);
    const id = offen;
    zuletztUhr.current = setTimeout(() => {
      api("PATCH", `/rest/v1/projekte?id=eq.${id}`, { zuletzt: new Date().toISOString() }).catch(() => {});
    }, 3000);
  };

  const projektAnlegen = async () => {
    const p = { id: neueId(), name: "ohne titel",
      zuletzt: new Date().toISOString(), created_at: new Date().toISOString() };
    const a = { id: neueId(), projekt_id: p.id, titel: "erster abschnitt", pos: 0 };
    setProjekte((l) => [{ ...p, abschnitte: [{ ...a, karten: [] }] }, ...l]);
    setOffen(p.id);
    try {
      await api("POST", "/rest/v1/projekte", p);
      await api("POST", "/rest/v1/abschnitte", a);
    } catch (e) { setMsg(String(e.message)); }
  };

  // ein Projekt mit allem drin kopieren — neue Kennungen, gleicher Inhalt
  const projektKopieren = async (p) => {
    try {
      setMsg("wird kopiert …");
      const neuP = { id: neueId(), name: p.name + " (kopie)",
        zuletzt: new Date().toISOString(), created_at: new Date().toISOString() };
      await api("POST", "/rest/v1/projekte", neuP);
      for (let i = 0; i < p.abschnitte.length; i++) {
        const a = p.abschnitte[i];
        const neuA = { id: neueId(), projekt_id: neuP.id, titel: a.titel, pos: i };
        await api("POST", "/rest/v1/abschnitte", neuA);
        const karten = a.karten.map((k, n) => ({
          id: neueId(), abschnitt_id: neuA.id, text: k.text, bild: k.bild, gedreht: false, pos: n,
        }));
        if (karten.length) await api("POST", "/rest/v1/karten", karten);
      }
      await laden();
      setMsg("");
    } catch (e) { setMsg(String(e.message)); }
  };

  const projektWeg = (p) => {
    if (!confirm(`„${p.name}" mit allem drin entfernen?`)) return;
    setProjekte((l) => l.filter((x) => x.id !== p.id));
    api("DELETE", `/rest/v1/projekte?id=eq.${p.id}`).catch(() => {});
  };

  // ---- die Kerze ----
  const gesamt = projekte.reduce((s, p) => s + p.abschnitte.reduce(
    (x, a) => x + a.karten.reduce((y, k) => y + zaehle(k.text), 0), 0), 0);
  const [erloschen, setErloschen] = useState(false);
  const zuletztWort = useRef(Date.now());
  useEffect(() => { zuletztWort.current = Date.now(); setErloschen(false); }, [gesamt]);
  useEffect(() => {
    const t = setInterval(() => setErloschen(Date.now() - zuletztWort.current > STILLE), 15000);
    return () => clearInterval(t);
  }, []);

  const projekt = projekte.find((p) => p.id === offen) || null;

  return (
    <div className="huette">
      <Stil />
      <div className={"schein" + (erloschen ? " gedaempft" : "")} aria-hidden="true" />

      <header className={"kopf" + (erloschen ? " halbdunkel" : "")}>
        <Kerze seite="links" />
        <div className="titelblock">
          <h1>Schreibknecht</h1>
          <p className="motto">„write or die!" <span>dr. wicked</span></p>
        </div>
        <Kerze seite="rechts" aus={erloschen} />
      </header>

      <main className="tisch">
        {!sitzung
          ? <Anmeldung anmelden={anmelden} fehler={fehler} laeuft={laeuft} />
          : !geladen
            ? <p className="leerwort">wird geholt …</p>
            : projekt
              ? <ProjektSeite projekt={projekt} api={api} bilder={bilder} holBild={holBild}
                  hochladen={hochladen} aendere={aendere} zurueck={() => setOffen(null)} sag={setMsg}
                  hand={hand} setHand={setHand} laden={laden} />
              : <Deckblatt projekte={projekte} anlegen={projektAnlegen}
                  oeffnen={setOffen} weg={projektWeg} kopieren={projektKopieren} />}
        {msg && <p className="meldung" onClick={() => setMsg("")}>{msg}</p>}
      </main>

      {hand && (
        <div className="handleiste">
          <span className="handzeichen">✋</span>
          <span className="handtext">{hand.name || "leere karte"}</span>
          <span className="handhinweis">liegt in der hand — in einem abschnitt ablegen</span>
          <button className="klein" onClick={() => setHand(null)} title="zurücklegen">✕</button>
        </div>
      )}

      {sitzung && <button className="raus" onClick={abmelden} title="abmelden">⏻</button>}
    </div>
  );
}

// ---------- Stil ----------
function Stil() {
  return (
    <style>{`
@import url('https://fonts.googleapis.com/css2?family=IM+Fell+English+SC&family=IM+Fell+English:ital@0;1&family=Courier+Prime:ital,wght@0,400;0,700;1,400&display=swap');

.huette{
  --pergament:#e6d9bb; --pergament2:#d6c49e; --tinte:#2a2118;
  --kerze:#f2b357; --kerze2:#ffdda0; --messing:#a8874f; --nebel:#6f6350;
  position:relative; min-height:100vh; padding:0 0 80px;
  background:
    radial-gradient(120% 80% at 50% -10%, rgba(242,179,87,.13) 0%, transparent 58%),
    radial-gradient(140% 100% at 50% 40%, transparent 40%, rgba(0,0,0,.45) 100%),
    linear-gradient(#16120d, #0c0a07);
  background-attachment: fixed;
  color:var(--pergament);
  font-family:'Courier Prime', ui-monospace, monospace;
}
.huette *{box-sizing:border-box}
.schein{
  position:fixed; inset:0; pointer-events:none; z-index:0;
  background:radial-gradient(60% 45% at 50% 8%, rgba(242,179,87,.10), transparent 70%);
  animation:atmen 6s ease-in-out infinite;
}
@keyframes atmen{0%,100%{opacity:.75}50%{opacity:1}}
.schein.gedaempft{opacity:.42; transition:opacity 2.4s ease}

.kopf{
  position:relative; z-index:1;
  display:flex; align-items:flex-end; justify-content:center; gap:clamp(14px,5vw,60px);
  padding:44px 20px 30px; border-bottom:1px solid rgba(168,135,79,.22);
}
.titelblock{text-align:center; padding-bottom:6px}
.kopf h1{
  margin:0; font-family:'IM Fell English SC', Georgia, serif; font-weight:400;
  font-size:clamp(30px,7vw,62px); letter-spacing:.05em; line-height:1; color:var(--kerze2);
  text-shadow:0 0 22px rgba(242,179,87,.4), 0 2px 0 rgba(0,0,0,.6);
}
.kopf.halbdunkel h1{color:#c9b184; text-shadow:0 0 10px rgba(242,179,87,.14); transition:2s ease}
.motto{
  margin:10px 0 0; font-family:'IM Fell English', Georgia, serif; font-style:italic;
  font-size:clamp(12px,2.2vw,16px); color:var(--nebel); letter-spacing:.06em;
}
.motto span{font-style:normal; opacity:.6; font-size:.85em; margin-left:6px}

.kerze{width:clamp(20px,4vw,30px); flex:0 0 auto; position:relative}
.kerze .wachs{
  height:clamp(60px,11vw,96px); border-radius:3px 3px 2px 2px; position:relative; overflow:hidden;
  background:linear-gradient(100deg,#3a3226 0%,#6e6350 22%,#cbbb99 48%,#7a6d57 72%,#332c22 100%);
  box-shadow:inset 0 -8px 12px rgba(0,0,0,.5);
}
.tropfen{position:absolute; width:5px; border-radius:0 0 4px 4px; background:rgba(230,217,187,.5)}
.t1{left:22%; top:0; height:32%} .t2{right:26%; top:0; height:18%}
.kerze .docht{width:2px; height:6px; background:#2a2118; margin:0 auto -2px; position:relative; z-index:2}
.flamme{position:relative; height:clamp(26px,5vw,38px); display:flex; align-items:flex-end; justify-content:center}
.flamme i, .flamme b{position:absolute; bottom:0; border-radius:50% 50% 42% 42%; display:block}
.flamme i{
  width:60%; height:100%;
  background:radial-gradient(ellipse at 50% 75%, #fff3cf 0%, var(--kerze) 45%, rgba(242,140,40,.75) 70%, transparent 78%);
  filter:blur(.4px); animation:zucken 2.4s ease-in-out infinite; transform-origin:50% 100%;
}
.flamme b{
  width:210%; height:210%; bottom:-40%;
  background:radial-gradient(circle, rgba(242,179,87,.30) 0%, transparent 62%);
  animation:zucken 3.7s ease-in-out infinite reverse;
}
@keyframes zucken{
  0%,100%{transform:scale(1,1) translateX(0) skewX(0deg)}
  25%{transform:scale(.94,1.08) translateX(-.6px) skewX(-3deg)}
  50%{transform:scale(1.05,.95) translateX(.5px) skewX(2deg)}
  75%{transform:scale(.97,1.04) translateX(-.3px) skewX(-1deg)}
}
.rauch{
  position:absolute; bottom:60%; left:50%; width:2px; height:26px; opacity:0;
  background:linear-gradient(to top, rgba(200,190,175,.5), transparent);
  border-radius:2px; transform-origin:50% 100%;
}
.kerze.aus .flamme i, .kerze.aus .flamme b{opacity:0; transform:scale(.2,.1); transition:.7s ease-in}
.kerze.aus .rauch{animation:rauchen 3.2s ease-out .25s 1 forwards}
.kerze.aus .wachs{filter:saturate(.45) brightness(.72)}
@keyframes rauchen{
  0%{opacity:.65; transform:translateX(-50%) translateY(0) scaleY(.3)}
  60%{opacity:.35; transform:translateX(-50%) translateY(-22px) scaleY(1) skewX(-8deg)}
  100%{opacity:0; transform:translateX(-50%) translateY(-46px) scaleY(1.4) skewX(6deg)}
}
@media(prefers-reduced-motion:reduce){.flamme i,.flamme b,.schein,.rauch{animation:none}}

.tisch{position:relative; z-index:1; max-width:1120px; margin:0 auto; padding:26px 20px}

/* ---- Pforte ---- */
.pforte{display:flex; justify-content:center; padding:40px 0}
.pfortenkasten{
  width:min(340px,92vw); display:flex; flex-direction:column; gap:12px;
  border:1px solid rgba(168,135,79,.3); border-radius:4px; padding:26px 22px;
  background:rgba(0,0,0,.22);
}
.pfortentext{
  margin:0 0 6px; font-family:'IM Fell English', Georgia, serif; font-style:italic;
  font-size:13px; color:var(--nebel); text-align:center;
}
.pfortenfehler{margin:2px 0 0; font-size:11.5px; color:#e08070; text-align:center}
.btn.gross{padding:11px; font-size:13px; letter-spacing:.12em}
.raus{
  position:fixed; right:14px; bottom:14px; z-index:5; width:34px; height:34px; border-radius:50%;
  border:1px solid rgba(168,135,79,.3); background:rgba(0,0,0,.4); color:var(--nebel);
  cursor:pointer; font-size:13px;
}
.raus:hover{color:var(--kerze2); border-color:rgba(242,179,87,.5)}

.ti{
  font-family:inherit; font-size:13px; padding:9px 11px; color:var(--pergament);
  background:rgba(0,0,0,.25); border:1px solid rgba(168,135,79,.3); border-radius:3px;
}
.ti:focus{outline:none; border-color:rgba(242,179,87,.55)}
.ti::placeholder{color:var(--nebel)}

.meldung{
  margin-top:18px; font-size:11.5px; color:#e0b26a; cursor:pointer;
  border:1px solid rgba(224,178,106,.3); border-radius:3px; padding:8px 11px;
}

/* ---- Deckblatt ---- */
.deckblatt{padding-top:14px}
.kachelfeld{display:flex; flex-wrap:wrap; gap:14px; align-items:flex-start}
.kachelhuelle{position:relative}
.kachel{
  width:100%; min-height:96px; padding:16px 18px; cursor:pointer; text-align:left;
  display:flex; flex-direction:column; justify-content:space-between; gap:10px;
  border:1px solid rgba(168,135,79,.35); border-radius:3px;
  background:linear-gradient(168deg, rgba(230,217,187,.10), rgba(230,217,187,.04));
  box-shadow:0 8px 18px rgba(0,0,0,.5), inset 0 1px 0 rgba(230,217,187,.10);
  color:var(--pergament); transition:transform .18s ease, box-shadow .18s ease, border-color .18s;
  font-family:inherit;
}
.kachel:hover{
  border-color:rgba(242,179,87,.6);
  box-shadow:0 12px 26px rgba(0,0,0,.6), 0 0 26px rgba(242,179,87,.16);
  transform:translateY(-3px) rotate(0deg) !important;
}
.kachelweg{
  position:absolute; top:-7px; right:-7px; width:22px; height:22px; border-radius:50%;
  border:1px solid rgba(168,135,79,.35); background:#14110c; color:var(--nebel);
  font-size:10px; cursor:pointer; opacity:0; transition:.15s;
}
.kachelhuelle:hover .kachelweg{opacity:1}
.kachelweg:hover{color:#e08070; border-color:rgba(141,50,38,.7)}
.kachelname{font-family:'IM Fell English SC', Georgia, serif; font-size:19px; letter-spacing:.03em; color:var(--kerze2)}
.kachelzeile{
  display:flex; align-items:baseline; gap:10px;
  font-size:11px; color:var(--nebel); letter-spacing:.08em;
}
.kacheldatum{margin-left:auto; font-size:10px; opacity:.75; white-space:nowrap}
.kachel.neu{
  width:96px; min-height:96px; align-items:center; justify-content:center;
  border-style:dashed; background:transparent;
}
.kachel.neu .plus{font-size:26px; color:var(--messing)}
.leerwort{color:var(--nebel); font-style:italic; margin-top:22px}

/* ---- Leiste ---- */
.leiste{display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:22px}
.fuellung{flex:1}
.btn{
  font-family:inherit; font-size:12px; letter-spacing:.06em; padding:7px 13px; cursor:pointer;
  color:var(--pergament2); background:transparent; border:1px solid rgba(168,135,79,.35);
  border-radius:2px; transition:.15s;
}
.btn:hover:not(:disabled){color:var(--kerze2); border-color:rgba(242,179,87,.55)}
.btn:disabled{opacity:.4; cursor:default}
.projektname{
  font-family:'IM Fell English SC', Georgia, serif; font-size:22px; letter-spacing:.03em;
  color:var(--kerze2); background:transparent; border:0; border-bottom:1px solid transparent;
  padding:2px 4px; min-width:160px;
}
.projektname:focus{outline:none; border-bottom-color:rgba(242,179,87,.5)}
.schalter{display:flex; align-items:center; gap:6px; font-size:11px; color:var(--nebel); cursor:pointer}
.schalter input{accent-color:var(--kerze)}

/* ---- Trennstrich ---- */
.abschnitt{margin-bottom:34px; transition:opacity .26s}
.abschnitt.mischt{opacity:.25}
.trennstrich{display:flex; align-items:center; gap:10px; margin-bottom:14px}
.strichtitel{
  font-family:'IM Fell English SC', Georgia, serif; font-size:14px; letter-spacing:.14em;
  color:var(--messing); background:transparent; padding:3px 8px; width:auto; min-width:60px;
  border:1px solid rgba(168,135,79,.25); border-radius:2px;
}
.strichtitel:focus{outline:none; color:var(--kerze2); border-color:rgba(242,179,87,.5)}
.abzahl{font-size:10px; color:var(--nebel); letter-spacing:.06em; flex:0 0 auto}
.linie{flex:1; height:1px; background:linear-gradient(90deg, rgba(168,135,79,.45), rgba(168,135,79,.08))}
.wuerfel{
  font-size:18px; line-height:1; padding:4px 9px; cursor:pointer; color:var(--kerze);
  background:transparent; border:1px solid rgba(242,179,87,.3); border-radius:2px; transition:.15s;
}
.wuerfel:hover{background:rgba(242,179,87,.12); box-shadow:0 0 14px rgba(242,179,87,.25); transform:rotate(-12deg)}
.klein{
  font-family:inherit; font-size:12px; line-height:1; padding:5px 8px; cursor:pointer;
  color:var(--nebel); background:transparent; border:1px solid rgba(168,135,79,.22);
  border-radius:2px; transition:.15s;
}
.klein:hover{color:var(--kerze2); border-color:rgba(242,179,87,.45)}
.klein.weg:hover{color:#e08070; border-color:rgba(141,50,38,.7)}
.abschnittneu{
  font-family:inherit; font-size:11px; letter-spacing:.12em; color:var(--nebel); cursor:pointer;
  background:transparent; border:1px dashed rgba(168,135,79,.3); border-radius:2px; padding:9px 16px;
}
.abschnittneu:hover{color:var(--kerze2); border-color:rgba(242,179,87,.4)}

/* ---- Karten ---- */
/* eine reihe ist EINE reihe — sie bricht nicht mehr um, sondern schiebt sich
   zur seite. sonst sieht eine lange reihe wie zwei aus und beim aufnehmen
   einer karte springt der umbruch. */
.reihe{
  display:flex; flex-wrap:nowrap; gap:14px; align-items:flex-start; margin-bottom:14px;
  overflow-x:auto; overflow-y:visible; padding-bottom:6px;
  scrollbar-width:thin; scrollbar-color:rgba(168,135,79,.35) transparent;
}
.reihe::-webkit-scrollbar{height:8px}
.reihe::-webkit-scrollbar-track{background:transparent}
.reihe::-webkit-scrollbar-thumb{background:rgba(168,135,79,.3); border-radius:4px}
.reihe:hover::-webkit-scrollbar-thumb{background:rgba(242,179,87,.45)}
.reihe:last-child{margin-bottom:0}
/* die reihen ueber und unter — nur da, solange eine karte in der luft ist */
.reihe.nurluft{opacity:.5; animation:luft .25s ease-out}
.reihe.nurluft .kartenplatz.leer{height:96px}
@keyframes luft{from{opacity:0; transform:translateY(-6px)}to{opacity:.5; transform:none}}
.kartenplatz{width:198px; height:268px; perspective:1100px; flex:0 0 auto}
/* das schildchen, das an der maus haengt — lesbar und richtigherum */
/* die karte, die am finger haengt — folgt dem zeiger eins zu eins */
.amfinger{
  position:fixed; z-index:60; pointer-events:none;
  width:198px; height:268px; padding:14px 13px;
  display:flex; flex-direction:column; gap:7px;
  border:1px solid rgba(42,33,24,.55); border-radius:12px;
  background:
    repeating-linear-gradient(0deg, rgba(120,95,55,.05) 0 2px, transparent 2px 5px),
    linear-gradient(155deg,#e6d9bb,#d6c49e);
  color:#2a2118; overflow:hidden;
  font-family:'Courier Prime', ui-monospace, monospace; font-size:13px; line-height:1.6;
  box-shadow:0 20px 42px rgba(0,0,0,.75);
  transform:rotate(-2deg) scale(1.03); transform-origin:50% 20%;
}
.amfinger b{
  font-family:'IM Fell English SC', Georgia, serif; font-weight:400; font-size:12px;
  letter-spacing:.05em; opacity:.7;
}
.amfinger span{white-space:pre-wrap; overflow:hidden}

/* die kartenkante zum anfassen */
.griff{
  position:absolute; top:0; left:0; right:0; height:22px; z-index:2;
  display:flex; align-items:center; justify-content:center; gap:4px;
  cursor:grab; touch-action:none; border-radius:12px 12px 0 0;
  opacity:0; transition:opacity .15s;
}
.griff:active{cursor:grabbing}
.kartenplatz:hover .griff{opacity:1}
.griff i{width:3px; height:3px; border-radius:50%; background:rgba(42,33,24,.4)}
.kartenplatz.angepeilt .seite{
  border-color:var(--kerze); box-shadow:0 0 0 2px rgba(242,179,87,.45), 0 10px 22px rgba(0,0,0,.55);
}
.kartenplatz.leer.angepeilt{
  border-color:var(--kerze); background:rgba(242,179,87,.16); color:var(--kerze2);
}

/* der platz, von dem die karte kommt, wird leer — wie auf dem tisch */
.kartenplatz.ziehend .karte{opacity:0; transition:none}
.kartenplatz.ziehend{
  border:1px dashed rgba(242,179,87,.45); border-radius:12px;
  background:rgba(242,179,87,.05);
}
.karte{
  position:relative; width:100%; height:100%; transform-style:preserve-3d;
  transition:transform .55s cubic-bezier(.2,.8,.3,1);
}
.karte.um{transform:rotateY(180deg)}
.seite{
  position:absolute; inset:0; backface-visibility:hidden; border-radius:12px;
  display:flex; flex-direction:column; overflow:hidden; border:1px solid rgba(42,33,24,.55);
  box-shadow:0 10px 22px rgba(0,0,0,.55), inset 0 0 30px rgba(120,95,55,.16);
}
.seite.text{
  background:
    repeating-linear-gradient(0deg, rgba(120,95,55,.05) 0 2px, transparent 2px 5px),
    linear-gradient(155deg, var(--pergament) 0%, var(--pergament2) 100%);
  color:var(--tinte);
}
.seite.text textarea{
  flex:1; width:100%; resize:none; border:0; background:transparent; padding:14px 13px 6px;
  font-family:'Courier Prime', monospace; font-size:13px; line-height:1.6; color:var(--tinte);
  /* damit die maus-geste im kaertchen scrollt und nicht die ganze seite */
  overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch;
  scrollbar-width:thin; scrollbar-color:rgba(42,33,24,.3) transparent;
}
.seite.text textarea::-webkit-scrollbar{width:8px}
.seite.text textarea::-webkit-scrollbar-track{background:transparent}
.seite.text textarea::-webkit-scrollbar-thumb{
  background:rgba(42,33,24,.28); border-radius:4px; border:2px solid transparent;
  background-clip:content-box;
}
.seite.text textarea:hover::-webkit-scrollbar-thumb{background:rgba(42,33,24,.45); background-clip:content-box}
.seite.text textarea:focus{outline:none}
.seite.text textarea::placeholder{color:rgba(42,33,24,.3)}
.seite.bild{transform:rotateY(180deg); background:linear-gradient(155deg, #241d15, #171208)}
.kartentitel{
  flex:1; min-width:0; font-family:'IM Fell English SC', Georgia, serif; font-size:11px;
  letter-spacing:.04em; color:var(--kerze2); background:transparent; border:0; padding:2px 4px;
}
.kartentitel:focus{outline:none; background:rgba(242,179,87,.08); border-radius:2px}
.kartentitel::placeholder{color:var(--nebel); font-style:italic; font-size:10px}
.seite.bild img{width:100%; flex:1; object-fit:cover; min-height:0}
.bildleer{
  flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px;
  background:transparent; border:0; cursor:pointer; color:var(--messing);
  font-family:inherit; font-size:11px; letter-spacing:.1em;
}
.bildleer .siegel{font-size:26px; color:rgba(242,179,87,.55)}
.bildleer:hover{color:var(--kerze2)}
.fuss{
  display:flex; align-items:center; gap:5px; padding:6px 8px;
  border-top:1px solid rgba(42,33,24,.2); background:rgba(0,0,0,.10);
}
.seite.bild .fuss{border-top-color:rgba(168,135,79,.2)}
.woerter{flex:1; font-size:10px; color:rgba(42,33,24,.45); letter-spacing:.06em}
.seite .klein{border-color:rgba(42,33,24,.2); color:rgba(42,33,24,.5)}
.seite .klein:hover{color:var(--tinte); border-color:rgba(42,33,24,.5)}
.seite.bild .klein{border-color:rgba(168,135,79,.25); color:var(--nebel)}
.seite.bild .klein:hover{color:var(--kerze2)}
/* ---- hand: karte ausgeschnitten und woanders ablegen ---- */
.kartenplatz.inhand .karte{opacity:.42; filter:saturate(.5)}
.kartenplatz.inhand .seite{border-style:dashed; box-shadow:none}
.kartenplatz.leer.ablage{
  border-color:rgba(242,179,87,.55); background:rgba(242,179,87,.06); color:var(--kerze2);
}
.kartenplatz.leer.ablage:hover{background:rgba(242,179,87,.14); box-shadow:0 0 20px rgba(242,179,87,.2)}
.handleiste{
  position:fixed; left:50%; bottom:16px; transform:translateX(-50%); z-index:6;
  display:flex; align-items:center; gap:10px; padding:9px 14px; border-radius:4px;
  border:1px solid rgba(242,179,87,.45); background:rgba(20,17,12,.94);
  box-shadow:0 8px 26px rgba(0,0,0,.6); max-width:min(560px,92vw);
}
.handzeichen{font-size:15px}
.handtext{
  font-family:'IM Fell English', Georgia, serif; font-style:italic; font-size:13px;
  color:var(--kerze2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.handhinweis{font-size:10px; letter-spacing:.06em; color:var(--nebel); white-space:nowrap}
@media(max-width:640px){.handhinweis{display:none}}
.kachelkopie{
  position:absolute; top:-7px; right:19px; width:22px; height:22px; border-radius:50%;
  border:1px solid rgba(168,135,79,.35); background:#14110c; color:var(--nebel);
  font-size:10px; cursor:pointer; opacity:0; transition:.15s;
}
.kachelhuelle:hover .kachelkopie{opacity:1}
.kachelkopie:hover{color:var(--kerze2); border-color:rgba(242,179,87,.5)}

/* leere faecher halten sich zurueck: in ruhe fast unsichtbar,
   beim drueberfahren ein siegel, und hell sobald eine karte in der luft ist */
.kartenplatz.leer{
  display:flex; align-items:center; justify-content:center; height:268px;
  border:1px dashed rgba(168,135,79,.16); border-radius:12px; background:transparent;
  color:var(--messing); font-size:24px; cursor:pointer; transition:.2s;
}
/* zwei stufen, keine blasse: die tatze ist immer voll da — und wird
   noch etwas waermer, sobald eine karte in der luft ist */
.siegelzeichen{
  font-size:30px; opacity:1; transition:filter .2s, transform .2s;
  filter:grayscale(0) brightness(1.05) drop-shadow(0 0 8px rgba(242,179,87,.5));
}
.kartenplatz.leer:hover{border-color:rgba(242,179,87,.4); color:var(--kerze2)}
.kartenplatz.leer:hover .siegelzeichen{transform:scale(1.08)}
.reihe.hebt .kartenplatz.leer{border-color:rgba(168,135,79,.35)}
.reihe.hebt .siegelzeichen{
  filter:grayscale(0) brightness(1.15) drop-shadow(0 0 14px rgba(242,179,87,.75));
}

/* ---- DAS PULT ---- */
.pult{
  margin-top:26px; border-top:1px solid rgba(168,135,79,.28); padding-top:18px;
  animation:pultauf .28s cubic-bezier(.2,.9,.3,1);
}
@keyframes pultauf{from{opacity:0; transform:translateY(-10px)}to{opacity:1; transform:none}}
.pultkopf{display:flex; align-items:center; gap:12px; margin-bottom:14px}
.pultname{
  font-family:'IM Fell English SC', Georgia, serif; font-size:14px; letter-spacing:.2em;
  color:var(--kerze2);
}
.pulthinweis{font-size:10.5px; letter-spacing:.06em; color:var(--nebel)}
.pultblatt{display:grid; grid-template-columns:1fr; gap:18px}
.pultblatt.zwei{grid-template-columns:1fr 1fr}
@media(max-width:820px){.pultblatt.zwei{grid-template-columns:1fr}}

.bogen{
  display:flex; flex-direction:column; min-height:440px; border-radius:12px; overflow:hidden;
  border:1px solid rgba(42,33,24,.55);
  background:
    repeating-linear-gradient(0deg, rgba(120,95,55,.05) 0 2px, transparent 2px 5px),
    linear-gradient(155deg, var(--pergament) 0%, var(--pergament2) 100%);
  color:var(--tinte); box-shadow:0 12px 30px rgba(0,0,0,.55), inset 0 0 40px rgba(120,95,55,.14);
}
.bogenkopf{
  display:flex; align-items:center; gap:10px; padding:10px 14px;
  border-bottom:1px solid rgba(42,33,24,.18); background:rgba(0,0,0,.07);
}
.bogentitel{
  flex:1; min-width:0; font-family:'IM Fell English SC', Georgia, serif; font-size:14px;
  letter-spacing:.05em; color:var(--tinte); background:transparent; border:0; padding:2px 4px;
}
.bogentitel:focus{outline:none; background:rgba(42,33,24,.07); border-radius:3px}
.bogentitel::placeholder{color:rgba(42,33,24,.35); font-style:italic}
.bogenort{
  font-family:var(--term,'Courier Prime'); font-size:9.5px; letter-spacing:.12em;
  color:rgba(42,33,24,.5); text-transform:uppercase; white-space:nowrap;
}
.bogen .klein{border-color:rgba(42,33,24,.22); color:rgba(42,33,24,.5)}
.bogen .klein:hover{color:var(--tinte); border-color:rgba(42,33,24,.5)}
.bogenbild{width:100%; max-height:200px; object-fit:cover; flex:0 0 auto}
.bogenfeld{
  flex:1; width:100%; resize:none; border:0; background:transparent; padding:20px 24px;
  font-family:'Courier Prime', monospace; font-size:14.5px; line-height:1.85; color:var(--tinte);
}
.bogenfeld:focus{outline:none}
.bogenfeld::placeholder{color:rgba(42,33,24,.28)}
.bogenfuss{
  display:flex; align-items:center; gap:6px;
  padding:8px 14px; border-top:1px solid rgba(42,33,24,.18); background:rgba(0,0,0,.07);
  font-size:10px; letter-spacing:.06em; color:rgba(42,33,24,.5);
}
.bogenfuss .klein:disabled{opacity:.35; cursor:default}
.klein.an{color:var(--kerze2); border-color:rgba(242,179,87,.5); background:rgba(242,179,87,.1)}
.seite .klein.an{color:var(--tinte); border-color:rgba(42,33,24,.55); background:rgba(42,33,24,.1)}

/* das kreuz zum verbrennen sitzt jetzt OBEN in der ecke, weit weg
   vom umblaettern — sie hatte sich aus versehen eine karte geloescht */
.verbrennen{
  position:absolute; top:-8px; right:-8px; z-index:3; width:24px; height:24px; border-radius:50%;
  border:1px solid rgba(168,135,79,.4); background:#14110c; color:var(--nebel);
  font-size:11px; cursor:pointer; opacity:0; transition:.15s;
}
.kartenplatz:hover .verbrennen{opacity:1}
.verbrennen:hover{color:#e08070; border-color:rgba(141,50,38,.75); background:#1d100d}
.kartenplatz{position:relative}

/* die asche — zurueckholen, solange sie noch warm ist */
.ascheleiste{
  position:fixed; left:50%; bottom:16px; transform:translateX(-50%); z-index:7;
  display:flex; align-items:center; gap:10px; padding:9px 14px; border-radius:4px;
  border:1px solid rgba(224,128,112,.5); background:rgba(24,14,12,.96);
  box-shadow:0 8px 26px rgba(0,0,0,.65); max-width:min(560px,92vw);
}
.ascheleiste .handzeichen{color:#e08070}

/* der einfuege-strich zwischen zwei karten nimmt KEINEN platz weg —
   er liegt ueber der luecke, damit sich beim ziehen nichts verschiebt */
.spalt{
  flex:0 0 0; width:0; height:0; padding:0; border:0; background:transparent;
  margin:0 -7px;                /* hebt den abstand auf, den die reihe sonst dazugibt */
  position:relative; overflow:visible;
}
.spalt i{
  position:absolute; top:0; left:-9px; width:18px; height:268px; cursor:pointer;
  display:block; background:transparent;
}
.spalt i::after{
  content:""; position:absolute; top:12%; left:50%; margin-left:-1.5px;
  width:3px; height:76%; border-radius:2px; background:rgba(242,179,87,.3); transition:.15s;
}
.spalt i:hover::after, .spalt.an i::after{
  background:var(--kerze); width:5px; margin-left:-2.5px; box-shadow:0 0 14px rgba(242,179,87,.6);
}

/* die streifen fuer eine neue reihe liegen im reservierten rand des abschnitts */
.abschnitt{position:relative; padding:15px 0}
.neuezeile{
  position:absolute; left:0; right:0; height:13px; padding:0; cursor:pointer;
  border:1px dashed rgba(242,179,87,.3); border-radius:7px;
  background:rgba(242,179,87,.05); transition:.15s;
}
.neuezeile.oben{top:0}
.neuezeile.unten{bottom:0}
.neuezeile:hover, .neuezeile.angepeilt{
  border-color:var(--kerze); background:rgba(242,179,87,.2);
  box-shadow:0 0 16px rgba(242,179,87,.3);
}

/* im druck steht der text vollstaendig da, nicht im abgeschnittenen feld */
.druckkopie{display:none}

/* am handy: karten schmaler, ziehen geht dort ohnehin nicht — dafuer ✂ und ✋ */
@media(max-width:560px){
  .kartenplatz, .kartenplatz.leer{width:100%; max-width:340px}
  .spalt{width:100%; height:20px; margin:-7px 0}
  .spalt i{width:70%; height:3px}
  .reihe{gap:10px}
}

/* ---- Druck ---- */
@media print{
  .huette{background:#fff; color:#111}
  .schein,.kopf .kerze,.leiste,.wuerfel,.klein,.abschnittneu,.kartenplatz.leer,.raus,.meldung,.handleiste,.kartenplatz.ablage,.pult{display:none !important}
  .kopf{border-color:#ccc; padding:0 0 12px}
  .kopf h1{color:#111; text-shadow:none}
  .blatt.einzeln .abschnitt{display:none}
  .blatt.einzeln .abschnitt.gedruckt{display:block}
  .kartenplatz{height:auto; width:auto; page-break-inside:avoid; perspective:none}
  .karte{transform:none !important; height:auto; transform-style:flat}
  .seite{position:static; box-shadow:none; border-color:#bbb; height:auto}
  .seite.bild, .seite.text textarea, .fuss, .verbrennen, .spalt, .ascheleiste, .griff, .amfinger{display:none !important}
  .bogenfeld, .bogenfuss, .bogenkopf .klein{display:none !important}
  .seite.text{background:none; border:0}
  .druckkopie{
    display:block; white-space:pre-wrap; color:#111; padding:6px 0 14px;
    font-family:'Courier Prime', monospace; font-size:11pt; line-height:1.5;
  }
  .druckkopie b{display:block; font-weight:700; margin-bottom:5px}
  .druckkopie img{display:block; max-width:70mm; margin:0 0 8px; border:1px solid #ccc}
  .blatt.ohnebild .druckkopie img{display:none}
  .neuezeile{display:none !important}
  .reihe{display:block; margin:0}
  .bogen{border:0; background:none; box-shadow:none; min-height:0}
  .strichtitel{color:#111; border:0; width:auto !important; font-weight:700}
  .abzahl,.linie{display:none}
}
`}</style>
  );
}
