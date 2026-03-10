import { useState, useEffect, useCallback, useRef } from "react";

// ══════════════════════════════════════════════════════════════════════
//  CRYPTO HELPERS  (AES-GCM via Web Crypto API)
// ══════════════════════════════════════════════════════════════════════
async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" },
    keyMat, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

async function encrypt(text, password, saltB64) {
  const salt = b64ToArr(saltB64);
  const key = await deriveKey(password, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
  return arrToB64(iv) + "." + arrToB64(new Uint8Array(ct));
}

async function decrypt(cipher, password, saltB64) {
  try {
    const [ivB64, ctB64] = cipher.split(".");
    const salt = b64ToArr(saltB64);
    const key = await deriveKey(password, salt);
    const iv = b64ToArr(ivB64);
    const ct = b64ToArr(ctB64);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch { return null; }
}

async function hashPassword(password) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(password + "lumos_salt_2025"));
  return arrToB64(new Uint8Array(buf));
}

function arrToB64(arr) { return btoa(String.fromCharCode(...arr)); }
function b64ToArr(b64) { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)); }
function genSalt() { return arrToB64(crypto.getRandomValues(new Uint8Array(16))); }

// ══════════════════════════════════════════════════════════════════════
//  STORAGE HELPERS
// ══════════════════════════════════════════════════════════════════════
async function sGet(key) {
  try { const r = await window.storage.get(key, true); return r ? JSON.parse(r.value) : null; }
  catch { return null; }
}
async function sSet(key, val) {
  try { await window.storage.set(key, JSON.stringify(val), true); return true; }
  catch { return false; }
}
async function sList(prefix) {
  try { const r = await window.storage.list(prefix, true); return r?.keys || []; }
  catch { return []; }
}

// ══════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════════════════════════════════
const STATUS = {
  good:   { label: "Ça va bien",        color: "#34d399", bg: "#022c1e", emoji: "🌿", id: "good" },
  medium: { label: "Pas au top",        color: "#fbbf24", bg: "#1c1305", emoji: "🌤", id: "medium" },
  bad:    { label: "Journée difficile", color: "#f87171", bg: "#1c0505", emoji: "🌧", id: "bad" },
  crisis: { label: "Idées sombres",     color: "#c084fc", bg: "#120320", emoji: "🌑", id: "crisis" },
};

const MONTHS_FR = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
const DAYS_FR   = ["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"];

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function fmtDate(key) {
  if (!key) return "";
  const [y,m,d] = key.split("-");
  return `${parseInt(d)} ${MONTHS_FR[parseInt(m)-1]} ${y}`;
}

// ══════════════════════════════════════════════════════════════════════
//  CLAUDE SUMMARY
// ══════════════════════════════════════════════════════════════════════
async function generateSummary(text, status) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 600,
      system: `Tu es un assistant bienveillant synthétisant des journaux de santé mentale pour un suivi psychiatrique.
Réponds UNIQUEMENT en JSON: {"resume":"...","emotions":["..."],"signaux":["..."],"positifs":["..."]}
- resume: 2-3 phrases du ressenti principal
- emotions: 2-4 mots-clés d'émotions
- signaux: éléments importants pour le médecin (peut être vide [])
- positifs: ressources ou points d'appui (peut être vide [])`,
      messages: [{ role: "user", content: `Statut: ${STATUS[status]?.label}\nJournal:\n${text}` }]
    })
  });
  const data = await res.json();
  const raw = data.content?.map(b => b.text||"").join("") || "{}";
  return JSON.parse(raw.replace(/```json|```/g,"").trim());
}

// ══════════════════════════════════════════════════════════════════════
//  ROOT APP
// ══════════════════════════════════════════════════════════════════════
export default function App() {
  const [screen, setScreen] = useState("splash"); // splash|landing|login|register|app
  const [user, setUser]     = useState(null); // { username, salt, passHash }
  const [entries, setEntries] = useState({});
  const [appLoading, setAppLoading] = useState(false);
  const [sessionPass, setSessionPass] = useState(""); // kept in memory only

  // Sub-screens inside app
  const [appView, setAppView]       = useState("home");
  const [selectedDay, setSelectedDay] = useState(null);
  const [calYear, setCalYear]       = useState(new Date().getFullYear());
  const [calMonth, setCalMonth]     = useState(new Date().getMonth());

  // Journal state
  const [jStatus, setJStatus] = useState(null);
  const [jText, setJText]     = useState("");
  const [jSummary, setJSummary] = useState(null);
  const [jSaving, setJSaving]   = useState(false);
  const [jSaved, setJSaved]     = useState(false);

  useEffect(() => {
    setTimeout(() => setScreen("landing"), 1800);
  }, []);

  // ── AUTH ──
  const handleRegister = async ({ username, password }) => {
    const userKey = `user:${username.toLowerCase()}`;
    const existing = await sGet(userKey);
    if (existing) return "Ce nom d'utilisateur est déjà pris.";
    const salt = genSalt();
    const passHash = await hashPassword(password);
    await sSet(userKey, { username, salt, passHash });
    setUser({ username, salt });
    setSessionPass(password);
    setEntries({});
    setScreen("app");
    setAppView("home");
    return null;
  };

  const handleLogin = async ({ username, password }) => {
    const userKey = `user:${username.toLowerCase()}`;
    const userData = await sGet(userKey);
    if (!userData) return "Aucun compte avec ce nom d'utilisateur.";
    const passHash = await hashPassword(password);
    if (passHash !== userData.passHash) return "Mot de passe incorrect.";
    setUser(userData);
    setSessionPass(password);
    // Load + decrypt entries
    setAppLoading(true);
    const keys = await sList(`entry:${username.toLowerCase()}:`);
    const loaded = {};
    for (const k of keys) {
      const raw = await sGet(k);
      if (!raw) continue;
      const decrypted = await decrypt(raw.cipher, password, userData.salt);
      if (decrypted) {
        const entry = JSON.parse(decrypted);
        const dateKey = k.split(":").pop();
        loaded[dateKey] = entry;
      }
    }
    setEntries(loaded);
    setAppLoading(false);
    setScreen("app");
    setAppView("home");
    return null;
  };

  const handleLogout = () => {
    setUser(null); setSessionPass(""); setEntries({});
    setScreen("landing");
  };

  // ── SAVE ENTRY ──
  const saveEntry = useCallback(async () => {
    if (!jStatus || !user) return;
    setJSaving(true);
    let summary = jSummary;
    if (jText.trim() && !summary) {
      try { summary = await generateSummary(jText, jStatus); setJSummary(summary); }
      catch {}
    }
    const key = todayKey();
    const entry = { status: jStatus, text: jText, summary, date: key };
    const cipher = await encrypt(JSON.stringify(entry), sessionPass, user.salt);
    const storageKey = `entry:${user.username.toLowerCase()}:${key}`;
    await sSet(storageKey, { cipher });
    setEntries(prev => ({ ...prev, [key]: entry }));
    setJSaving(false); setJSaved(true);
    setTimeout(() => { setJSaved(false); setAppView("calendar"); }, 1400);
  }, [jStatus, jText, jSummary, user, sessionPass]);

  const openJournal = (status) => {
    const key = todayKey();
    const ex = entries[key];
    setJStatus(ex?.status || status);
    setJText(ex?.text || "");
    setJSummary(ex?.summary || null);
    setJSaved(false);
    setAppView("journal");
  };

  // ══ RENDER ══
  if (screen === "splash") return <Splash />;
  if (screen === "landing") return <Landing onLogin={() => setScreen("login")} onRegister={() => setScreen("register")} />;
  if (screen === "login")   return <AuthScreen mode="login" onSubmit={handleLogin} onSwitch={() => setScreen("register")} onBack={() => setScreen("landing")} />;
  if (screen === "register") return <AuthScreen mode="register" onSubmit={handleRegister} onSwitch={() => setScreen("login")} onBack={() => setScreen("landing")} />;

  if (appLoading) return <LoadingScreen label="Déchiffrement de tes données…" />;

  return (
    <AppShell user={user} onLogout={handleLogout}>
      {appView === "home" && (
        <HomeView entries={entries} onJournal={openJournal} onCalendar={() => setAppView("calendar")} username={user.username} />
      )}
      {appView === "journal" && (
        <JournalView
          status={jStatus} setStatus={setJStatus}
          text={jText} setText={setJText}
          summary={jSummary}
          onSave={saveEntry} saving={jSaving} saved={jSaved}
          onBack={() => setAppView("home")}
        />
      )}
      {appView === "calendar" && (
        <CalendarView
          entries={entries} year={calYear} month={calMonth}
          setYear={setCalYear} setMonth={setCalMonth}
          onDay={(k) => { setSelectedDay(k); setAppView("day-detail"); }}
          onBack={() => setAppView("home")}
        />
      )}
      {appView === "day-detail" && (
        <DayDetail
          entry={entries[selectedDay]} date={selectedDay}
          onBack={() => setAppView("calendar")}
          onEdit={() => {
            if (selectedDay === todayKey()) {
              const e = entries[selectedDay];
              setJStatus(e?.status||"good"); setJText(e?.text||""); setJSummary(e?.summary||null); setJSaved(false);
              setAppView("journal");
            }
          }}
        />
      )}
    </AppShell>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  SCREENS
// ══════════════════════════════════════════════════════════════════════

function Splash() {
  return (
    <div style={S.splash}>
      <Aurora />
      <div style={{ textAlign:"center", zIndex:1 }}>
        <div style={{ fontSize:64, marginBottom:16, animation:"pulse 2s ease-in-out infinite" }}>🌙</div>
        <h1 style={S.splashTitle}>Lumos</h1>
        <p style={{ color:"#7c8fd0", fontSize:15, letterSpacing:"0.15em", textTransform:"uppercase" }}>Suivi de santé mentale</p>
      </div>
      <style>{`@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}`}</style>
    </div>
  );
}

function Landing({ onLogin, onRegister }) {
  return (
    <div style={S.landingRoot}>
      <Aurora />
      <div style={S.landingContent}>
        <div style={{ textAlign:"center", marginBottom:48 }}>
          <div style={{ fontSize:56, marginBottom:12 }}>🌙</div>
          <h1 style={S.splashTitle}>Lumos</h1>
          <p style={{ color:"#7c8fd0", fontSize:14, marginTop:8, lineHeight:1.7, maxWidth:280, margin:"8px auto 0" }}>
            Ton espace privé pour suivre ta santé mentale.<br/>
            <span style={{ color:"#4a5580", fontSize:12 }}>Données chiffrées · Privé · Pour toi et ton médecin</span>
          </p>
        </div>

        <div style={S.featureGrid}>
          {[
            ["🔒","Chiffrement AES-256","Tes données sont chiffrées avec ton mot de passe"],
            ["📅","Calendrier coloré","Visualise ton humeur sur le temps"],
            ["✨","Résumés IA","Synthèses à partager avec ta psychiatre"],
            ["👤","Compte personnel","Accède depuis n'importe quel appareil"],
          ].map(([icon,title,desc]) => (
            <div key={title} style={S.featureCard}>
              <span style={{ fontSize:24 }}>{icon}</span>
              <div>
                <p style={{ color:"#c7d2f0", fontWeight:700, fontSize:13, margin:0 }}>{title}</p>
                <p style={{ color:"#4a5580", fontSize:11, margin:"2px 0 0", lineHeight:1.5 }}>{desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:12, marginTop:32 }}>
          <button style={S.btnPrimary} onClick={onRegister}>Créer mon compte</button>
          <button style={S.btnSecondary} onClick={onLogin}>J'ai déjà un compte</button>
        </div>
      </div>
    </div>
  );
}

function AuthScreen({ mode, onSubmit, onSwitch, onBack }) {
  const isLogin = mode === "login";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm]   = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  const handle = async () => {
    setError("");
    if (!username.trim() || !password) { setError("Tous les champs sont requis."); return; }
    if (!isLogin && password !== confirm) { setError("Les mots de passe ne correspondent pas."); return; }
    if (!isLogin && password.length < 8) { setError("Mot de passe : 8 caractères minimum."); return; }
    setLoading(true);
    const err = await onSubmit({ username: username.trim(), password });
    if (err) { setError(err); setLoading(false); }
  };

  return (
    <div style={S.authRoot}>
      <Aurora />
      <div style={S.authCard}>
        <button style={S.ghostBack} onClick={onBack}>← Retour</button>
        <div style={{ textAlign:"center", marginBottom:28 }}>
          <div style={{ fontSize:36, marginBottom:8 }}>🌙</div>
          <h2 style={S.authTitle}>{isLogin ? "Connexion" : "Créer un compte"}</h2>
          {!isLogin && <p style={{ color:"#4a5580", fontSize:12, marginTop:6, lineHeight:1.6 }}>
            Ton mot de passe chiffre toutes tes données.<br/>
            <strong style={{color:"#f87171"}}>Impossible de le récupérer si perdu.</strong>
          </p>}
        </div>

        <div style={S.fieldGroup}>
          <label style={S.label}>Nom d'utilisateur</label>
          <input style={S.input} value={username} onChange={e=>setUsername(e.target.value)}
            placeholder="ex: marie_p" onKeyDown={e=>e.key==="Enter"&&handle()} />
        </div>
        <div style={S.fieldGroup}>
          <label style={S.label}>Mot de passe</label>
          <input style={S.input} type="password" value={password} onChange={e=>setPassword(e.target.value)}
            placeholder="••••••••" onKeyDown={e=>e.key==="Enter"&&handle()} />
        </div>
        {!isLogin && (
          <div style={S.fieldGroup}>
            <label style={S.label}>Confirmer le mot de passe</label>
            <input style={S.input} type="password" value={confirm} onChange={e=>setConfirm(e.target.value)}
              placeholder="••••••••" onKeyDown={e=>e.key==="Enter"&&handle()} />
          </div>
        )}

        {error && <div style={S.errorBox}>{error}</div>}

        <button style={{ ...S.btnPrimary, marginTop:8, opacity: loading?0.6:1 }} onClick={handle} disabled={loading}>
          {loading ? "⏳ Chargement…" : isLogin ? "Se connecter" : "Créer mon compte"}
        </button>

        <p style={{ textAlign:"center", color:"#4a5580", fontSize:13, marginTop:20 }}>
          {isLogin ? "Pas encore de compte ?" : "Déjà un compte ?"}{" "}
          <span style={{ color:"#818cf8", cursor:"pointer", textDecoration:"underline" }} onClick={onSwitch}>
            {isLogin ? "S'inscrire" : "Se connecter"}
          </span>
        </p>
      </div>
    </div>
  );
}

function AppShell({ user, onLogout, children }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div style={S.appRoot}>
      <Stars />
      <div style={S.topNav}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:20 }}>🌙</span>
          <span style={{ color:"#c7d2f0", fontWeight:700, fontFamily:"'Crimson Pro',Georgia,serif", fontSize:18 }}>Lumos</span>
        </div>
        <div style={{ position:"relative" }}>
          <button style={S.avatarBtn} onClick={()=>setMenuOpen(p=>!p)}>
            <span style={{ fontSize:14 }}>👤</span>
            <span style={{ color:"#c7d2f0", fontSize:13 }}>{user.username}</span>
            <span style={{ color:"#4a5580", fontSize:11 }}>▾</span>
          </button>
          {menuOpen && (
            <div style={S.dropdown}>
              <div style={S.dropdownItem}>
                <span style={{ fontSize:10, color:"#4a5580" }}>🔒 Données chiffrées</span>
              </div>
              <div style={{ ...S.dropdownItem, cursor:"pointer", color:"#f87171" }} onClick={()=>{setMenuOpen(false);onLogout();}}>
                ⎋ Se déconnecter
              </div>
            </div>
          )}
        </div>
      </div>
      <div style={S.appContent}>{children}</div>
    </div>
  );
}

function LoadingScreen({ label }) {
  return (
    <div style={{ ...S.splash, gap:16 }}>
      <Aurora />
      <div style={{ fontSize:40, animation:"spin 1.5s linear infinite" }}>🔓</div>
      <p style={{ color:"#818cf8", fontSize:14 }}>{label}</p>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  APP VIEWS
// ══════════════════════════════════════════════════════════════════════

function HomeView({ entries, onJournal, onCalendar, username }) {
  const today = todayKey();
  const ex = entries[today];
  const streak = computeStreak(entries);
  const monthCount = countThisMonth(entries);

  return (
    <div style={S.page}>
      <div style={S.homeHeader}>
        <p style={{ color:"#4a5580", fontSize:13, margin:0 }}>{fmtDate(today)}</p>
        <h2 style={{ color:"#c7d2f0", fontSize:22, margin:"4px 0 0", fontFamily:"'Crimson Pro',Georgia,serif" }}>
          Bonjour, {username} 👋
        </h2>
        <p style={{ color:"#5a6590", fontSize:14, marginTop:4 }}>Comment te sens-tu aujourd'hui ?</p>
      </div>

      {ex && (
        <div style={{ ...S.todayBadge, borderColor: STATUS[ex.status]?.color+"66" }}>
          <span style={{ fontSize:18 }}>{STATUS[ex.status]?.emoji}</span>
          <span style={{ color:"#8898c0", fontSize:13 }}>Déjà renseigné · {STATUS[ex.status]?.label}</span>
        </div>
      )}

      <div style={S.bigBtns}>
        <GlowBtn emoji="🌿" label="Ça va bien" color="#34d399" onClick={() => onJournal("good")} />
        <GlowBtn emoji="🌧" label="Ça ne va pas" color="#fb923c" onClick={() => onJournal("medium")} />
      </div>

      <div style={S.statsRow}>
        {[["📅",Object.keys(entries).length,"Jours suivis"],["🔥",`${streak}j`,"Série"],["📊",monthCount,"Ce mois"]].map(([e,v,l])=>(
          <div key={l} style={S.statCard}>
            <span style={{ fontSize:20 }}>{e}</span>
            <span style={{ color:"#c7d2f0", fontWeight:800, fontSize:20 }}>{v}</span>
            <span style={{ color:"#4a5580", fontSize:11 }}>{l}</span>
          </div>
        ))}
      </div>

      <button style={S.calendarBtn} onClick={onCalendar}>📅 Mon calendrier</button>
    </div>
  );
}

function GlowBtn({ emoji, label, color, onClick }) {
  const [h, setH] = useState(false);
  return (
    <button style={{ ...S.glowBtn, borderColor: h ? color : color+"44", boxShadow: h ? `0 0 28px ${color}44` : "none", transform: h?"scale(1.04)":"scale(1)" }}
      onMouseEnter={()=>setH(true)} onMouseLeave={()=>setH(false)} onClick={onClick}>
      <span style={{ fontSize:34 }}>{emoji}</span>
      <span style={{ color, fontWeight:700, fontSize:14, marginTop:6, fontFamily:"'Crimson Pro',Georgia,serif" }}>{label}</span>
    </button>
  );
}

function JournalView({ status, setStatus, text, setText, summary, onSave, saving, saved, onBack }) {
  return (
    <div style={S.page}>
      <TopBar title="Mon journal" onBack={onBack} />

      <p style={S.sectionLabel}>Comment tu te sens ?</p>
      <div style={S.statusGrid}>
        {Object.values(STATUS).map(s => (
          <button key={s.id}
            style={{ ...S.statusChip, borderColor: status===s.id ? s.color : "#1e2444", background: status===s.id ? s.bg : "transparent", color: status===s.id ? s.color : "#4a5580" }}
            onClick={() => setStatus(s.id)}>
            <span style={{ fontSize:18 }}>{s.emoji}</span>
            <span style={{ fontSize:11, marginTop:3, lineHeight:1.3 }}>{s.label}</span>
          </button>
        ))}
      </div>

      {status === "crisis" && (
        <div style={S.crisisBox}>
          <p style={{ color:"#e879f9", fontWeight:800, margin:0, fontSize:15 }}>Tu n'es pas seul·e 💜</p>
          <p style={{ color:"#c4b0d8", fontSize:13, margin:"8px 0 0", lineHeight:1.7 }}>
            Le <strong style={{color:"#f0abfc"}}>3114</strong> est disponible 24h/24 pour t'écouter.<br/>
            Ce que tu écris ici reste entièrement privé et chiffré.
          </p>
        </div>
      )}

      <p style={{ ...S.sectionLabel, marginTop:20 }}>Écris librement</p>
      <textarea style={S.textarea} value={text} onChange={e=>setText(e.target.value)} rows={8}
        placeholder="Pas de jugement ici… écris ce qui te passe par la tête, même en vrac." />

      {summary && <SummaryCard summary={summary} status={status} />}

      <button style={{ ...S.btnPrimary, marginTop:16, opacity:(!status||saving)?0.5:1 }}
        disabled={!status||saving} onClick={onSave}>
        {saving ? "⏳ Analyse & chiffrement…" : saved ? "✅ Enregistré !" : "Enregistrer & analyser"}
      </button>
    </div>
  );
}

function SummaryCard({ summary, status }) {
  const s = STATUS[status] || STATUS.good;
  return (
    <div style={{ ...S.summaryCard, borderColor: s.color+"44" }}>
      <p style={{ color: s.color, fontWeight:700, fontSize:13, marginBottom:10 }}>✨ Résumé généré par l'IA</p>
      <p style={{ color:"#c7d2f0", fontSize:14, lineHeight:1.8, marginBottom:10 }}>{summary.resume}</p>
      {summary.emotions?.length > 0 && (
        <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:10 }}>
          {summary.emotions.map((e,i)=><span key={i} style={{ padding:"3px 10px", borderRadius:20, fontSize:12, background:s.color+"22", color:s.color, fontWeight:600 }}>{e}</span>)}
        </div>
      )}
      {summary.signaux?.length > 0 && (
        <div style={{ marginTop:8 }}>
          <p style={{ color:"#4a5580", fontSize:11, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:6 }}>À noter pour ton médecin</p>
          {summary.signaux.map((sig,i)=><p key={i} style={{ color:"#a0aec8", fontSize:13, margin:"4px 0", paddingLeft:12, borderLeft:`2px solid ${s.color}` }}>• {sig}</p>)}
        </div>
      )}
      {summary.positifs?.length > 0 && (
        <div style={{ marginTop:8 }}>
          {summary.positifs.map((p,i)=><p key={i} style={{ color:"#6a8060", fontSize:13, margin:"3px 0" }}>💚 {p}</p>)}
        </div>
      )}
    </div>
  );
}

function CalendarView({ entries, year, month, setYear, setMonth, onDay, onBack }) {
  const first = new Date(year, month, 1).getDay();
  const offset = (first + 6) % 7;
  const days = new Date(year, month+1, 0).getDate();
  const cells = Array(offset).fill(null).concat(Array.from({length:days},(_,i)=>i+1));
  const today = todayKey();

  const prevM = () => { if(month===0){setMonth(11);setYear(y=>y-1);}else setMonth(m=>m-1); };
  const nextM = () => { if(month===11){setMonth(0);setYear(y=>y+1);}else setMonth(m=>m+1); };

  const monthPfx = `${year}-${String(month+1).padStart(2,"0")}`;
  const counts = {good:0,medium:0,bad:0,crisis:0};
  Object.entries(entries).filter(([k])=>k.startsWith(monthPfx)).forEach(([,e])=>{if(counts[e.status]!==undefined)counts[e.status]++;});

  return (
    <div style={S.page}>
      <TopBar title="Calendrier" onBack={onBack} />
      <div style={S.calNav}>
        <button style={S.navBtn} onClick={prevM}>‹</button>
        <span style={{ color:"#c7d2f0", fontWeight:700, fontSize:16, fontFamily:"'Crimson Pro',Georgia,serif" }}>{MONTHS_FR[month]} {year}</span>
        <button style={S.navBtn} onClick={nextM}>›</button>
      </div>
      <div style={S.calGrid}>
        {DAYS_FR.map(d=><div key={d} style={S.calHead}>{d}</div>)}
        {cells.map((day,i)=>{
          if(!day) return <div key={`x${i}`}/>;
          const key=`${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
          const entry=entries[key]; const s=entry?STATUS[entry.status]:null;
          const isT=key===today;
          return (
            <div key={key} style={{ ...S.calCell, background:s?s.bg:"#070710", border: isT?`2px solid #818cf8`:`1px solid ${s?.color||"#12152a"}`, cursor:entry?"pointer":"default" }}
              onClick={()=>entry&&onDay(key)}>
              <span style={{ fontSize:10, color:s?.color||"#2a3060", fontWeight:isT?800:400 }}>{day}</span>
              {s&&<span style={{ fontSize:12, marginTop:1 }}>{s.emoji}</span>}
            </div>
          );
        })}
      </div>
      <div style={S.legend}>
        {Object.values(STATUS).map(s=>(
          <div key={s.id} style={{ display:"flex", alignItems:"center", gap:6 }}>
            <div style={{ width:8, height:8, borderRadius:"50%", background:s.color }}/>
            <span style={{ color:"#4a5580", fontSize:12 }}>{s.label} ({counts[s.id]})</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DayDetail({ entry, date, onBack, onEdit }) {
  if (!entry) return (
    <div style={S.page}><TopBar title="Détail" onBack={onBack} />
      <p style={{ color:"#4a5580", textAlign:"center", marginTop:40 }}>Aucune entrée pour ce jour.</p>
    </div>
  );
  const s = STATUS[entry.status];
  return (
    <div style={S.page}>
      <TopBar title={fmtDate(date)} onBack={onBack} />
      <div style={{ display:"flex", alignItems:"center", gap:12, padding:"16px 18px", borderRadius:16, background:s.bg, border:`1px solid ${s.color}44`, marginBottom:16 }}>
        <span style={{ fontSize:36 }}>{s.emoji}</span>
        <span style={{ color:s.color, fontWeight:700, fontSize:18, fontFamily:"'Crimson Pro',Georgia,serif" }}>{s.label}</span>
      </div>
      {entry.summary && <SummaryCard summary={entry.summary} status={entry.status} />}
      {entry.text && (
        <>
          <p style={{ ...S.sectionLabel, marginTop:16 }}>Journal brut</p>
          <div style={S.rawText}>{entry.text}</div>
        </>
      )}
      {date === todayKey() && (
        <button style={{ ...S.btnSecondary, marginTop:16 }} onClick={onEdit}>✏️ Modifier</button>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  SHARED UI
// ══════════════════════════════════════════════════════════════════════
function TopBar({ title, onBack }) {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20, paddingTop:4 }}>
      <button style={S.ghostBack} onClick={onBack}>← Retour</button>
      <span style={{ color:"#c7d2f0", fontWeight:700, fontSize:16, fontFamily:"'Crimson Pro',Georgia,serif" }}>{title}</span>
      <div style={{ width:60 }}/>
    </div>
  );
}

function Aurora() {
  return (
    <div style={{ position:"fixed", inset:0, zIndex:0, overflow:"hidden", pointerEvents:"none" }}>
      <div style={{ position:"absolute", width:600, height:600, borderRadius:"50%", background:"radial-gradient(circle, #1a1a6e22 0%, transparent 70%)", top:-200, left:-100, animation:"aurora1 8s ease-in-out infinite alternate" }}/>
      <div style={{ position:"absolute", width:500, height:500, borderRadius:"50%", background:"radial-gradient(circle, #0d3b5e22 0%, transparent 70%)", bottom:-100, right:-50, animation:"aurora2 10s ease-in-out infinite alternate" }}/>
      <style>{`
        @keyframes aurora1{from{transform:translate(0,0) scale(1)}to{transform:translate(40px,30px) scale(1.1)}}
        @keyframes aurora2{from{transform:translate(0,0) scale(1)}to{transform:translate(-30px,20px) scale(1.05)}}
      `}</style>
    </div>
  );
}

function Stars() {
  const stars = Array.from({length:50},(_,i)=>({ l:`${(i*37)%100}%`, t:`${(i*53)%100}%`, s:Math.random()*1.5+0.5, d:Math.random()*5 }));
  return (
    <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:0 }}>
      {stars.map((s,i)=>(
        <div key={i} style={{ position:"absolute", left:s.l, top:s.t, width:s.s, height:s.s, borderRadius:"50%", background:"#fff", opacity:0.15, animation:`tw ${2+s.d}s infinite alternate` }}/>
      ))}
      <style>{`@keyframes tw{from{opacity:0.05}to{opacity:0.3}}`}</style>
    </div>
  );
}

// ── Utils ──
function computeStreak(entries) {
  let streak=0, d=new Date();
  while(true) {
    const k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    if(!entries[k]) break; streak++; d.setDate(d.getDate()-1);
  }
  return streak;
}
function countThisMonth(entries) {
  const d=new Date(), pfx=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  return Object.keys(entries).filter(k=>k.startsWith(pfx)).length;
}

// ══════════════════════════════════════════════════════════════════════
//  STYLES
// ══════════════════════════════════════════════════════════════════════
const S = {
  splash: { minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"#05050f", gap:8, position:"relative" },
  splashTitle: { color:"#c7d2f0", fontSize:38, margin:0, fontFamily:"'Crimson Pro',Georgia,serif", letterSpacing:"0.05em" },
  landingRoot: { minHeight:"100vh", background:"#05050f", display:"flex", alignItems:"center", justifyContent:"center", position:"relative", padding:"20px" },
  landingContent: { position:"relative", zIndex:1, maxWidth:380, width:"100%", padding:"32px 24px", background:"#0a0a1a", borderRadius:24, border:"1px solid #1a1a3a" },
  featureGrid: { display:"flex", flexDirection:"column", gap:12 },
  featureCard: { display:"flex", alignItems:"flex-start", gap:12, padding:"12px 14px", background:"#0f0f22", borderRadius:12, border:"1px solid #1a1a3a" },
  authRoot: { minHeight:"100vh", background:"#05050f", display:"flex", alignItems:"center", justifyContent:"center", position:"relative", padding:"20px" },
  authCard: { position:"relative", zIndex:1, maxWidth:360, width:"100%", padding:"32px 28px", background:"#0a0a1a", borderRadius:24, border:"1px solid #1a1a3a" },
  authTitle: { color:"#c7d2f0", fontSize:24, margin:0, fontFamily:"'Crimson Pro',Georgia,serif" },
  fieldGroup: { marginBottom:16 },
  label: { display:"block", color:"#4a5580", fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:6 },
  input: { width:"100%", background:"#0f0f22", border:"1px solid #1a1a3a", borderRadius:10, color:"#c7d2f0", fontSize:15, padding:"12px 14px", outline:"none", boxSizing:"border-box", fontFamily:"inherit" },
  errorBox: { background:"#1c050a", border:"1px solid #f8717166", borderRadius:10, padding:"10px 14px", color:"#f87171", fontSize:13, marginBottom:12 },
  btnPrimary: { width:"100%", padding:"14px", borderRadius:14, background:"linear-gradient(135deg,#3b4fc8,#6366f1)", color:"#fff", border:"none", fontSize:15, fontWeight:700, cursor:"pointer" },
  btnSecondary: { width:"100%", padding:"14px", borderRadius:14, background:"transparent", color:"#818cf8", border:"1px solid #818cf8", fontSize:15, fontWeight:600, cursor:"pointer" },
  ghostBack: { color:"#818cf8", background:"none", border:"none", cursor:"pointer", fontSize:13, padding:"4px 0" },
  appRoot: { minHeight:"100vh", background:"#05050f", position:"relative" },
  topNav: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 20px", borderBottom:"1px solid #0f0f22", position:"sticky", top:0, background:"#05050fcc", backdropFilter:"blur(12px)", zIndex:10 },
  avatarBtn: { display:"flex", alignItems:"center", gap:8, background:"#0f0f22", border:"1px solid #1a1a3a", borderRadius:20, padding:"6px 14px", cursor:"pointer" },
  dropdown: { position:"absolute", right:0, top:"110%", background:"#0f0f22", border:"1px solid #1a1a3a", borderRadius:12, overflow:"hidden", minWidth:180, zIndex:20 },
  dropdownItem: { padding:"12px 16px", fontSize:13, color:"#8898c0", borderBottom:"1px solid #1a1a3a" },
  appContent: { maxWidth:480, margin:"0 auto", padding:"0 16px" },
  page: { paddingTop:20, paddingBottom:60 },
  homeHeader: { paddingTop:8, marginBottom:16 },
  todayBadge: { display:"flex", alignItems:"center", gap:10, padding:"10px 14px", borderRadius:12, border:"1px solid", background:"#ffffff06", marginBottom:16 },
  bigBtns: { display:"flex", gap:12, marginBottom:20 },
  glowBtn: { flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"22px 10px", borderRadius:18, border:"1.5px solid", background:"#0a0a1a", cursor:"pointer", transition:"all 0.2s", minHeight:100 },
  statsRow: { display:"flex", gap:10, marginBottom:20 },
  statCard: { flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:2, padding:"14px 8px", borderRadius:14, background:"#0a0a1a", border:"1px solid #12152a" },
  calendarBtn: { width:"100%", padding:"14px", borderRadius:14, border:"1px solid #2a3060", background:"#0a0a1a", color:"#818cf8", fontSize:15, cursor:"pointer", fontWeight:600 },
  sectionLabel: { color:"#4a5580", fontSize:11, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:10, marginTop:0 },
  statusGrid: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:4 },
  statusChip: { display:"flex", flexDirection:"column", alignItems:"center", padding:"12px 8px", borderRadius:14, border:"1.5px solid", cursor:"pointer", transition:"all 0.15s", fontSize:12 },
  crisisBox: { background:"#12032244", border:"1px solid #a855f755", borderRadius:14, padding:"16px", marginTop:12 },
  textarea: { width:"100%", background:"#0a0a1a", border:"1px solid #12152a", borderRadius:14, color:"#c7d2f0", fontSize:15, padding:"16px", resize:"vertical", lineHeight:1.8, outline:"none", fontFamily:"'Crimson Pro',Georgia,serif", boxSizing:"border-box" },
  summaryCard: { marginTop:16, padding:"16px", borderRadius:14, border:"1px solid", background:"#0a0a1a" },
  calNav: { display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 },
  navBtn: { color:"#818cf8", background:"none", border:"none", cursor:"pointer", fontSize:26, padding:"0 8px" },
  calGrid: { display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:3, marginBottom:18 },
  calHead: { color:"#2a3060", fontSize:10, textAlign:"center", padding:"4px 0", fontWeight:700, textTransform:"uppercase" },
  calCell: { aspectRatio:"1", borderRadius:8, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", transition:"transform 0.1s" },
  legend: { display:"flex", flexDirection:"column", gap:8 },
  rawText: { background:"#0a0a1a", border:"1px solid #12152a", borderRadius:14, padding:"16px", color:"#8898c0", fontSize:14, lineHeight:1.9, fontFamily:"'Crimson Pro',Georgia,serif", whiteSpace:"pre-wrap" },
};
