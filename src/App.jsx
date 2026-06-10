import { useState, useMemo, useRef, useEffect } from "react";

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTÊNCIA — Supabase + localStorage (fallback offline)
// ═══════════════════════════════════════════════════════════════════════════
const SUPABASE_URL = "https://frprebgyfnbeetuwmrzd.supabase.co";
const SUPABASE_KEY = "sb_publishable_e1Xx9UGhvma2O0LxN0csYw_yM40XJoA";
const SUPABASE_ATIVO = !!SUPABASE_URL && !!SUPABASE_KEY;

let _sb = null;
let _sbReady = null;
let _userId = null;
let _onSyncError = null;
function notifySyncError(msg) { try { _onSyncError && _onSyncError(msg, "erro"); } catch(e) {} }

async function initSupabase() {
  if (!SUPABASE_ATIVO || _sb) return _sb;
  if (_sbReady) return _sbReady;
  _sbReady = (async () => {
    try {
      const mod = await import("https://esm.sh/@supabase/supabase-js@2");
      _sb = mod.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: "mcs.sb.auth" }
      });
      return _sb;
    } catch (e) {
      console.error("Supabase falhou ao iniciar:", e);
      _sb = null;
      return null;
    }
  })();
  return _sbReady;
}
if (SUPABASE_ATIVO) initSupabase();

// ─── Estado global compartilhado (uma linha JSON no Postgres) ───────────────
const _estado = {};
let _estadoCarregado = false;
const _estadoSubs = new Set();
let _debounceTimer = null;

function _normKey(k) { return k.replace(/^mcs\./, ""); }
function _broadcast(key) { _estadoSubs.forEach(fn => { try { fn(key); } catch(e) {} }); }

async function _flush() {
  if (!_userId || !_sb) return;
  try {
    const payload = { user_id: _userId, dados: _estado };
    const { error } = await _sb.from("estado_usuario").upsert(payload, { onConflict: "user_id" });
    if (error) {
      console.error("Erro ao sincronizar com Supabase:", error);
      notifySyncError("Falha ao sincronizar com a nuvem");
    }
  } catch (e) {
    console.error("Erro ao sincronizar:", e);
    notifySyncError("Falha ao sincronizar com a nuvem");
  }
}

function _scheduleFlush() {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => { _debounceTimer = null; _flush(); }, 2000);
}

async function _hidratarDoServidor() {
  if (!_userId || !_sb) return;
  try {
    const { data, error } = await _sb.from("estado_usuario").select("dados").eq("user_id", _userId).maybeSingle();
    if (error) {
      console.error("Erro lendo estado:", error);
      notifySyncError("Falha ao ler dados da nuvem");
      return;
    }
    if (data && data.dados && typeof data.dados === "object") {
      Object.entries(data.dados).forEach(([k, v]) => {
        _estado[k] = v;
        try { window.localStorage.setItem("mcs." + k, JSON.stringify(v)); } catch(e) {}
        _broadcast(k);
      });
    } else {
      const KEYS = ["modo","prazos","tiposCustom","tarefas","feriados","feriadosNomes","clientes","ultimoBackup","email"];
      KEYS.forEach(k => {
        try {
          const raw = window.localStorage.getItem("mcs." + k);
          if (raw !== null) _estado[k] = JSON.parse(raw);
        } catch(e) {}
      });
      _scheduleFlush();
    }
    _estadoCarregado = true;
  } catch (e) {
    console.error("Erro hidratando:", e);
    notifySyncError("Falha ao ler dados da nuvem");
  }
}

let _realtimeChannel = null;
function _conectarRealtime() {
  if (!_userId || !_sb || _realtimeChannel) return;
  try {
    _realtimeChannel = _sb.channel("estado-" + _userId)
      .on("postgres_changes", { event: "*", schema: "public", table: "estado_usuario", filter: "user_id=eq." + _userId },
        payload => {
          const novo = payload && payload.new && payload.new.dados;
          if (!novo || typeof novo !== "object") return;
          Object.entries(novo).forEach(([k, v]) => {
            if (JSON.stringify(_estado[k]) !== JSON.stringify(v)) {
              _estado[k] = v;
              try { window.localStorage.setItem("mcs." + k, JSON.stringify(v)); } catch(e) {}
              _broadcast(k);
            }
          });
        })
      .subscribe();
  } catch (e) { console.error("Realtime falhou:", e); }
}
function _desconectarRealtime() {
  if (_realtimeChannel && _sb) {
    try { _sb.removeChannel(_realtimeChannel); } catch(e) {}
    _realtimeChannel = null;
  }
}

// ─── Hook unificado: lê/escreve no estado global + localStorage ─────────────
function useStorage(fullKey, initial) {
  const key = _normKey(fullKey);
  const [val, setValRaw] = useState(() => {
    if (key in _estado) return _estado[key];
    try {
      const raw = (typeof window !== "undefined" && window.localStorage) ? window.localStorage.getItem(fullKey) : null;
      const parsed = raw !== null ? JSON.parse(raw) : initial;
      _estado[key] = parsed;
      return parsed;
    } catch (e) {
      _estado[key] = initial;
      return initial;
    }
  });

  useEffect(() => {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(fullKey, JSON.stringify(val));
      }
    } catch (e) {}
  }, [fullKey, val]);

  useEffect(() => {
    const handler = (k) => {
      if (k !== key) return;
      const v = _estado[k];
      if (JSON.stringify(v) !== JSON.stringify(val)) setValRaw(v);
    };
    _estadoSubs.add(handler);
    if (_estadoCarregado && key in _estado) {
      if (JSON.stringify(_estado[key]) !== JSON.stringify(val)) setValRaw(_estado[key]);
    }
    return () => { _estadoSubs.delete(handler); };
    // eslint-disable-next-line
  }, [key]);

  const setVal = (next) => {
    setValRaw(prev => {
      const computed = (typeof next === "function") ? next(prev) : next;
      _estado[key] = computed;
      if (_userId && _sb) _scheduleFlush();
      return computed;
    });
  };

  return [val, setVal];
}

// ─── Hook de autenticação (Supabase) ────────────────────────────────────────
function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(SUPABASE_ATIVO);
  useEffect(() => {
    if (!SUPABASE_ATIVO) { setLoading(false); return; }
    let sub = null;
    let alive = true;
    (async () => {
      const sb = await initSupabase();
      if (!alive || !sb) { setLoading(false); return; }
      try {
        const { data: { session } } = await sb.auth.getSession();
        const u = (session && session.user) || null;
        _userId = u ? u.id : null;
        setUser(u);
        setLoading(false);
        if (_userId) {
          await _hidratarDoServidor();
          _conectarRealtime();
        }
      } catch (e) {
        console.error("getSession falhou:", e);
        setLoading(false);
      }
      const { data } = sb.auth.onAuthStateChange(async (event, session) => {
        const u = (session && session.user) || null;
        const prev = _userId;
        _userId = u ? u.id : null;
        setUser(u);
        if (_userId && _userId !== prev) {
          _desconectarRealtime();
          _estadoCarregado = false;
          await _hidratarDoServidor();
          _conectarRealtime();
        } else if (!_userId) {
          _desconectarRealtime();
        }
      });
      sub = data && data.subscription;
    })();
    return () => { alive = false; try { sub && sub.unsubscribe(); } catch(e) {} };
  }, []);
  return { user, loading, ativo: SUPABASE_ATIVO };
}

function _mapAuthError(e) {
  const m = (e && e.message) || "";
  const mk = (code) => { const x = new Error(m); x.code = code; return x; };
  if (/Invalid login credentials/i.test(m)) return mk("auth/wrong-password");
  if (/Email not confirmed/i.test(m)) return mk("auth/user-not-found");
  if (/User already registered/i.test(m)) return mk("auth/email-already-in-use");
  if (/Password should be at least/i.test(m)) return mk("auth/weak-password");
  if (/invalid.*email/i.test(m)) return mk("auth/invalid-email");
  return e || new Error("Erro de autenticação");
}

async function fazerLogin(email, senha) {
  if (!SUPABASE_ATIVO) throw new Error("Supabase não configurado");
  const sb = await initSupabase();
  if (!sb) throw new Error("Supabase indisponível");
  const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
  if (error) throw _mapAuthError(error);
  return data;
}
async function criarConta(email, senha) {
  if (!SUPABASE_ATIVO) throw new Error("Supabase não configurado");
  const sb = await initSupabase();
  if (!sb) throw new Error("Supabase indisponível");
  const { data, error } = await sb.auth.signUp({ email, password: senha });
  if (error) throw _mapAuthError(error);
  return data;
}
async function fazerLogout() {
  if (!SUPABASE_ATIVO) return;
  const sb = await initSupabase();
  if (!sb) return;
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; await _flush(); }
  _desconectarRealtime();
  _userId = null;
  _estadoCarregado = false;
  return sb.auth.signOut();
}


// ─── Tema (claro/escuro) ──────────────────────────────────────────────────────
const TEMA = {
  light: {
    bg:"#f5f7fa", card:"#fff", cardAlt:"#f7fafc", border:"#e2e8f0", borderStrong:"#cbd5e0",
    text:"#1a202c", textSoft:"#4a5568", textMuted:"#a0aec0",
    primary:"#2b6cb0", primaryHover:"#2c5282", primarySoft:"#ebf8ff",
    accent:"#2d3748", overlay:"#00000066",
    danger:"#e53e3e", dangerSoft:"#fff5f5", dangerBorder:"#fed7d7",
    warn:"#dd6b20", warnSoft:"#fffaf0",
    success:"#38a169", successSoft:"#f0fff4",
  },
  dark: {
    bg:"#0f1419", card:"#1a202c", cardAlt:"#2d3748", border:"#2d3748", borderStrong:"#4a5568",
    text:"#f7fafc", textSoft:"#cbd5e0", textMuted:"#718096",
    primary:"#63b3ed", primaryHover:"#90cdf4", primarySoft:"#2a4365",
    accent:"#f7fafc", overlay:"#00000099",
    danger:"#fc8181", dangerSoft:"#742a2a", dangerBorder:"#9b2c2c",
    warn:"#f6ad55", warnSoft:"#7b341e",
    success:"#68d391", successSoft:"#22543d",
  }
};

const STATUS_CFG = {
  vencido:   { label:"Vencido",     light:{ c:"#c53030", bg:"#fff5f5", pill:"#fed7d7", text:"#742a2a" }, dark:{ c:"#fc8181", bg:"#742a2a44", pill:"#9b2c2c", text:"#feb2b2" } },
  urgente:   { label:"Urgente",     light:{ c:"#c05621", bg:"#fffaf0", pill:"#feebc8", text:"#7b341e" }, dark:{ c:"#f6ad55", bg:"#7b341e44", pill:"#9c4221", text:"#fbd38d" } },
  proximo:   { label:"Esta semana", light:{ c:"#b7791f", bg:"#fffff0", pill:"#fefcbf", text:"#744210" }, dark:{ c:"#ecc94b", bg:"#74421044", pill:"#975a16", text:"#faf089" } },
  normal:    { label:"No prazo",    light:{ c:"#2f855a", bg:"#f0fff4", pill:"#c6f6d5", text:"#22543d" }, dark:{ c:"#68d391", bg:"#22543d44", pill:"#2f855a", text:"#9ae6b4" } },
  concluido: { label:"Concluído",   light:{ c:"#718096", bg:"#f7fafc", pill:"#e2e8f0", text:"#4a5568" }, dark:{ c:"#a0aec0", bg:"#2d374844", pill:"#4a5568", text:"#cbd5e0" } },
};

const PRIO_CFG = {
  alta:  { label:"Alta",  light:{ c:"#c53030", bg:"#fff5f5", pill:"#fed7d7" }, dark:{ c:"#fc8181", bg:"#742a2a44", pill:"#9b2c2c" } },
  media: { label:"Média", light:{ c:"#b7791f", bg:"#fffff0", pill:"#fefcbf" }, dark:{ c:"#ecc94b", bg:"#74421044", pill:"#975a16" } },
  baixa: { label:"Baixa", light:{ c:"#2f855a", bg:"#f0fff4", pill:"#c6f6d5" }, dark:{ c:"#68d391", bg:"#22543d44", pill:"#2f855a" } },
};

const TIPOS_DEFAULT = [
  "Acompanhar",
  "Agravo de Instrumento","Agravo Interno","Apelação","Contestação","Contrarrazões",
  "Cumprimento de Sentença","Embargos de Declaração","Impugnação","Manifestação",
  "Memorial","Prazo Geral","Recurso Especial","Recurso Extraordinário","Réplica","Tutela de Urgência"
];

// Identifica o tribunal a partir do número CNJ (NNNNNNN-DD.AAAA.J.TR.OOOO).
// J = segmento (8 Estadual, 4 Federal, 5 Trabalho...); TR = código do tribunal.
// Não armazena nada — deriva do próprio número. Retorna null se não reconhecer.
function tribunalDoCNJ(numero) {
  const d = String(numero || "").replace(/\D/g, "");
  if (d.length !== 20) return null;
  const j = d[13];
  const tr = d.slice(14, 16);
  const ESTADUAL = {
    "01":"TJAC","02":"TJAL","03":"TJAP","04":"TJAM","05":"TJBA","06":"TJCE","07":"TJDFT",
    "08":"TJES","09":"TJGO","10":"TJMA","11":"TJMT","12":"TJMS","13":"TJMG","14":"TJPA",
    "15":"TJPB","16":"TJPR","17":"TJPE","18":"TJPI","19":"TJRJ","20":"TJRN","21":"TJRS",
    "22":"TJRO","23":"TJRR","24":"TJSC","25":"TJSP","26":"TJSE","27":"TJTO"
  };
  const n = parseInt(tr, 10);
  if (j === "8") return ESTADUAL[tr] || null;
  if (j === "4") return (n >= 1 && n <= 6) ? "TRF" + n : "Justiça Federal";
  if (j === "5") return (n >= 1 && n <= 24) ? "TRT" + n : "Justiça do Trabalho";
  if (j === "6") return "TRE";
  if (j === "1") return "STF";
  if (j === "3") return "STJ";
  if (j === "7") return "STM";
  return null;
}

const MESES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const DIAS_SEMANA = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
const ORDENACAO_OPTS = [
  { value:"data_asc",   label:"Data ↑" },
  { value:"data_desc",  label:"Data ↓" },
  { value:"prioridade", label:"Prioridade" },
  { value:"status",     label:"Status" },
  { value:"parte_asc",  label:"Parte A→Z" },
];

// ─── Ícones SVG ───────────────────────────────────────────────────────────────
const Icon = ({ name, size=18, color="currentColor" }) => {
  const icons = {
    scale:    <path d="M12 3v18M3 7h18M5 7l3 9a3 3 0 006 0l3-9M5 7l-2 5a2 2 0 004 0l-2-5zM19 7l-2 5a2 2 0 004 0l-2-5z" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    plus:     <path d="M12 5v14M5 12h14" stroke={color} strokeWidth="2" strokeLinecap="round"/>,
    search:   <><circle cx="11" cy="11" r="7" stroke={color} strokeWidth="1.5" fill="none"/><path d="M21 21l-4.3-4.3" stroke={color} strokeWidth="1.5" strokeLinecap="round"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" stroke={color} strokeWidth="1.5" fill="none"/><path d="M8 3v4M16 3v4M3 10h18" stroke={color} strokeWidth="1.5" strokeLinecap="round"/></>,
    list:     <path d="M3 6h18M3 12h18M3 18h18" stroke={color} strokeWidth="1.5" strokeLinecap="round"/>,
    check:    <path d="M5 12l5 5L20 7" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    edit:     <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    trash:    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    close:    <path d="M18 6L6 18M6 6l12 12" stroke={color} strokeWidth="2" strokeLinecap="round"/>,
    menu:     <path d="M3 12h18M3 6h18M3 18h18" stroke={color} strokeWidth="2" strokeLinecap="round"/>,
    mic:      <><rect x="9" y="3" width="6" height="11" rx="3" stroke={color} strokeWidth="1.5" fill="none"/><path d="M5 11a7 7 0 0014 0M12 18v3M8 21h8" stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none"/></>,
    tag:      <><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" stroke={color} strokeWidth="1.5" fill="none" strokeLinejoin="round"/><circle cx="7" cy="7" r="1.5" fill={color}/></>,
    flag:     <path d="M4 21V4M4 4h13l-3 5 3 5H4" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    sun:      <><circle cx="12" cy="12" r="4" stroke={color} strokeWidth="1.5" fill="none"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke={color} strokeWidth="1.5" strokeLinecap="round"/></>,
    moon:     <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" stroke={color} strokeWidth="1.5" fill="none" strokeLinejoin="round"/>,
    bell:     <><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/><path d="M13.73 21a2 2 0 01-3.46 0" stroke={color} strokeWidth="1.5" strokeLinecap="round"/></>,
    printer:  <><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2" stroke={color} strokeWidth="1.5" fill="none" strokeLinejoin="round"/><rect x="6" y="14" width="12" height="8" stroke={color} strokeWidth="1.5" fill="none"/></>,
    chevL:    <path d="M15 18l-6-6 6-6" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    chevR:    <path d="M9 18l6-6-6-6" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    chevD:    <path d="M6 9l6 6 6-6" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    dots:     <><circle cx="12" cy="5" r="1.5" fill={color}/><circle cx="12" cy="12" r="1.5" fill={color}/><circle cx="12" cy="19" r="1.5" fill={color}/></>,
    user:     <><circle cx="12" cy="8" r="4" stroke={color} strokeWidth="1.5" fill="none"/><path d="M4 21a8 8 0 0116 0" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round"/></>,
    drag:     <><circle cx="9" cy="6" r="1.3" fill={color}/><circle cx="15" cy="6" r="1.3" fill={color}/><circle cx="9" cy="12" r="1.3" fill={color}/><circle cx="15" cy="12" r="1.3" fill={color}/><circle cx="9" cy="18" r="1.3" fill={color}/><circle cx="15" cy="18" r="1.3" fill={color}/></>,
    alert:    <><path d="M12 9v4M12 17h.01" stroke={color} strokeWidth="2" strokeLinecap="round"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke={color} strokeWidth="1.5" fill="none" strokeLinejoin="round"/></>,
    mail:     <><rect x="2" y="4" width="20" height="16" rx="2" stroke={color} strokeWidth="1.5" fill="none"/><path d="M22 6l-10 7L2 6" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></>,
    chat:     <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" stroke={color} strokeWidth="1.5" fill="none" strokeLinejoin="round"/>,
    filter:   <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" stroke={color} strokeWidth="1.5" fill="none" strokeLinejoin="round"/>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display:"inline-block", flexShrink:0, verticalAlign:"middle" }}>
      {icons[name] || null}
    </svg>
  );
};

// ─── Feriados global ──────────────────────────────────────────────────────────
let _feriados = new Set();
function setFeriadosGlobal(arr) { _feriados = new Set(arr); }
function isDiaUtil(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const dow = d.getDay();
  return dow !== 0 && dow !== 6 && !_feriados.has(dateStr);
}

// ─── Helpers de data ──────────────────────────────────────────────────────────
// Data ISO no fuso LOCAL (toISOString puro converte p/ UTC e vira o dia
// seguinte entre 21h e 0h no Brasil).
function isoLocal(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function diasUteisRestantes(dataStr) {
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const alvo = new Date(dataStr + "T00:00:00");
  if (alvo < hoje) {
    let count = 0;
    const cur = new Date(alvo);
    while (cur < hoje) {
      if (isDiaUtil(isoLocal(cur))) count--;
      cur.setDate(cur.getDate() + 1);
    }
    return count;
  }
  let count = 0;
  const cur = new Date(hoje);
  while (cur < alvo) {
    if (isDiaUtil(isoLocal(cur))) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function calcularDataFinal(dataInicio, qtdDiasUteis) {
  const d = new Date(dataInicio + "T00:00:00");
  let count = 0;
  if (isDiaUtil(dataInicio)) count = 1;
  while (count < qtdDiasUteis) {
    d.setDate(d.getDate() + 1);
    if (isDiaUtil(isoLocal(d))) count++;
  }
  return isoLocal(d);
}

function calcStatus(dataStr, concluido) {
  if (concluido) return "concluido";
  const du = diasUteisRestantes(dataStr);
  if (du < 0) return "vencido";
  if (du <= 2) return "urgente";
  if (du <= 5) return "proximo";
  return "normal";
}

function diasLabel(du, concluido) {
  if (concluido) return "concluído";
  if (du === 0) return "vence hoje";
  if (du > 0) return `${du} ${du===1?"dia útil":"dias úteis"}`;
  return `${Math.abs(du)} ${Math.abs(du)===1?"dia atrasado":"dias atrasado"}`;
}

function fmt(s) { if (!s) return ""; const [y,m,d] = s.split("-"); return `${d}/${m}/${y}`; }
function fmtLong(s) {
  if (!s) return "";
  const [y,m,d] = s.split("-");
  const ms = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
  return `${parseInt(d)} de ${ms[parseInt(m)-1]} de ${y}`;
}

// ─── ICS / WhatsApp ───────────────────────────────────────────────────────────
function gerarICS(prazo) {
  const [y,m,d] = prazo.dataLimite.split("-");
  const dt = `${y}${m}${d}`;
  const fim = new Date(prazo.dataLimite + "T00:00:00");
  fim.setDate(fim.getDate() + 1);
  const dtFim = isoLocal(fim).replace(/-/g, "");
  const uid = `prazo-${prazo.id}-${Date.now()}@mcsadvogados`;
  const ics = [
    "BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//MCS Advogados//Prazos//PT",
    "BEGIN:VEVENT", `UID:${uid}`,
    `SUMMARY:[Prazo] ${prazo.tipo} — ${prazo.parte}`,
    `DESCRIPTION:Processo: ${prazo.processo}\\nResp: ${prazo.responsavel}${prazo.obs?"\\nObs: "+prazo.obs:""}`,
    `DTSTART;VALUE=DATE:${dt}`, `DTEND;VALUE=DATE:${dtFim}`,
    "BEGIN:VALARM","TRIGGER:-P1D","ACTION:DISPLAY","DESCRIPTION:Prazo amanhã!","END:VALARM",
    "END:VEVENT","END:VCALENDAR"
  ].join("\r\n");
  const url = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
  const a = document.createElement("a");
  a.href = url; a.download = `prazo-${prazo.parte.replace(/\s+/g,"-")}.ics`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function whatsappPrazo(prazo) {
  const du = diasUteisRestantes(prazo.dataLimite);
  const texto = [
    "⚖️ *Prazo Processual*", "",
    `*Parte:* ${prazo.parte}`,
    `*Tipo:* ${prazo.tipo}`,
    `*Processo:* ${prazo.processo}`,
    `*Vencimento:* ${fmt(prazo.dataLimite)} (${diasLabel(du, prazo.concluido)})`,
    `*Responsável:* ${prazo.responsavel}`,
    prazo.obs ? `*Obs:* ${prazo.obs}` : "",
    "", "_Martins, Corrêa da Silva Advogados_",
  ].filter(l => l !== "").join("\n");
  window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, "_blank");
}

// ─── Parser de comando ────────────────────────────────────────────────────────
const MESES_VOZ = { janeiro:1,fevereiro:2,marco:3,abril:4,maio:5,junho:6,julho:7,agosto:8,setembro:9,outubro:10,novembro:11,dezembro:12 };
const TIPOS_VOZ_MAP = [
  ["Agravo de Instrumento", ["agravo de instrumento","agravo instrumento"]],
  ["Agravo Interno",        ["agravo interno"]],
  ["Apelação",              ["apelacao","apelo"]],
  ["Contestação",           ["contestacao","contestar"]],
  ["Contrarrazões",         ["contrarrazoes"]],
  ["Cumprimento de Sentença", ["cumprimento de sentenca","cumprimento sentenca"]],
  ["Embargos de Declaração", ["embargos de declaracao","embargos declaracao","embargos"]],
  ["Impugnação",            ["impugnacao"]],
  ["Manifestação",          ["manifestacao"]],
  ["Memorial",              ["memorial"]],
  ["Recurso Especial",      ["recurso especial","resp"]],
  ["Recurso Extraordinário",["recurso extraordinario"]],
  ["Réplica",               ["replica"]],
  ["Tutela de Urgência",    ["tutela de urgencia","tutela urgencia","tutela","liminar"]],
  ["Prazo Geral",           ["prazo geral","prazo"]],
];
function normStr(s) { return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,""); }

function parsearComando(texto) {
  const t = normStr(texto);
  const words = t.split(/\s+/);
  let prioridade = "media";
  if (t.includes("alta") || t.includes("urgente") || t.includes("critico")) prioridade = "alta";
  else if (t.includes("baixa") || t.includes("normal")) prioridade = "baixa";
  let responsavel = "Felipe";
  if (t.includes("janine")) responsavel = "Janine";
  else if (t.includes("equipe")) responsavel = "Equipe";
  let tipo = "Prazo Geral";
  for (const [tf, sins] of TIPOS_VOZ_MAP) {
    if (sins.some(s => t.includes(s))) { tipo = tf; break; }
  }
  let dataLimite = "";
  const hoje = new Date();
  for (let i = 0; i < words.length; i++) {
    const dia = parseInt(words[i]);
    if (!isNaN(dia) && dia >= 1 && dia <= 31) {
      let mi = i + 1;
      if (words[mi] === "de") mi++;
      const mesNum = words[mi] ? MESES_VOZ[words[mi]] : null;
      if (mesNum) {
        let ano = hoje.getFullYear();
        const anoW = words[mi+1];
        if (anoW && /^\d{4}$/.test(anoW)) ano = parseInt(anoW);
        else if (mesNum < hoje.getMonth()+1 || (mesNum === hoje.getMonth()+1 && dia < hoje.getDate())) ano++;
        dataLimite = `${ano}-${String(mesNum).padStart(2,"0")}-${String(dia).padStart(2,"0")}`;
        break;
      }
    }
  }
  if (!dataLimite) {
    for (let i = 0; i < words.length - 1; i++) {
      if ((words[i]==="em"||words[i]==="daqui") && /^\d+$/.test(words[i+1]) && (words[i+2]==="dias"||words[i+2]==="dia")) {
        const qtd = parseInt(words[i+1]);
        const isUtil = words[i+3]==="uteis" || words[i+3]==="util";
        if (isUtil) dataLimite = calcularDataFinal(isoLocal(hoje), qtd);
        else { const d = new Date(hoje); d.setDate(d.getDate()+qtd); dataLimite = isoLocal(d); }
        break;
      }
    }
  }
  let parte = "";
  const gatilhos = ["contra","parte","cliente","caso","reu","autor"];
  const orig = texto.split(/\s+/);
  for (let i = 0; i < orig.length; i++) {
    if (gatilhos.includes(normStr(orig[i])) && orig[i+1]) {
      const caps = [];
      for (let j = i+1; j < Math.min(i+6, orig.length); j++) {
        const pw = normStr(orig[j]);
        if (["tipo","contesta","agravo","apela","prazo","vence","dia","prioridade","felipe","janine","obs","alta","media","baixa"].some(k=>pw.startsWith(k))) break;
        caps.push(orig[j]);
      }
      parte = caps.join(" ").trim();
      break;
    }
  }
  let obs = "";
  const obsMatch = texto.match(/(?:obs[.:\s]|observa[çc][aã]o[.:\s]|nota[.:\s])\s*(.+)/i);
  if (obsMatch) obs = obsMatch[1].trim();
  return { tipo, dataLimite, responsavel, prioridade, parte, obs, processo:"", concluido:false };
}


// ─── Backup / Restore ─────────────────────────────────────────────────────────
function gerarBackup(dados) {
  const blob = {
    versao: "1.0",
    geradoEm: new Date().toISOString(),
    escritorio: "Martins, Corrêa da Silva Advogados",
    dados,
  };
  const json = JSON.stringify(blob, null, 2);
  const url = "data:application/json;charset=utf-8," + encodeURIComponent(json);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mcs-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function restaurarBackup(file, callback) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const blob = JSON.parse(e.target.result);
      if (!blob.dados) throw new Error("Arquivo inválido");
      callback(null, blob.dados);
    } catch (err) { callback(err); }
  };
  reader.readAsText(file);
}

// ─── Validar máscara CNJ: 0000000-00.0000.0.00.0000 ──────────────────────────
function mascararProcesso(v) {
  const n = v.replace(/\D/g, "").slice(0, 20);
  let r = n;
  if (n.length > 7)  r = n.slice(0,7) + "-" + n.slice(7);
  if (n.length > 9)  r = n.slice(0,7) + "-" + n.slice(7,9) + "." + n.slice(9);
  if (n.length > 13) r = n.slice(0,7) + "-" + n.slice(7,9) + "." + n.slice(9,13) + "." + n.slice(13);
  if (n.length > 14) r = n.slice(0,7) + "-" + n.slice(7,9) + "." + n.slice(9,13) + "." + n.slice(13,14) + "." + n.slice(14);
  if (n.length > 16) r = n.slice(0,7) + "-" + n.slice(7,9) + "." + n.slice(9,13) + "." + n.slice(13,14) + "." + n.slice(14,16) + "." + n.slice(16);
  return r;
}

// ─── Recorrência: gera próxima data ──────────────────────────────────────────
function proximaDataRecorrencia(dataAtual, recorrencia) {
  if (!recorrencia || recorrencia === "none") return null;
  const d = new Date(dataAtual + "T00:00:00");
  if (recorrencia === "semanal")    d.setDate(d.getDate() + 7);
  if (recorrencia === "quinzenal")  d.setDate(d.getDate() + 14);
  if (recorrencia === "mensal")     d.setMonth(d.getMonth() + 1);
  if (recorrencia === "bimestral")  d.setMonth(d.getMonth() + 2);
  if (recorrencia === "trimestral") d.setMonth(d.getMonth() + 3);
  if (recorrencia === "anual")      d.setFullYear(d.getFullYear() + 1);
  return isoLocal(d);
}

// ─── Dados iniciais ───────────────────────────────────────────────────────────
const INITIAL = [
  { id:1, processo:"0012345-67.2024.8.21.0001", parte:"Unimed POARS",   tipo:"Agravo de Instrumento", dataLimite:new Date(Date.now()+3*86400000).toISOString().slice(0,10),  responsavel:"Felipe", concluido:false, obs:"Liminar em risco", prioridade:"alta"  },
  { id:2, processo:"0098765-43.2024.8.21.0002", parte:"IPE Saúde",      tipo:"Contestação",            dataLimite:new Date(Date.now()+10*86400000).toISOString().slice(0,10), responsavel:"Janine", concluido:false, obs:"",                 prioridade:"media" },
  { id:3, processo:"0011111-22.2023.4.04.7100", parte:"União Federal",  tipo:"Apelação",               dataLimite:new Date(Date.now()-2*86400000).toISOString().slice(0,10),  responsavel:"Felipe", concluido:false, obs:"Verificar prorrogação", prioridade:"alta" },
  { id:4, processo:"0033333-55.2024.8.21.0003", parte:"Bradesco Saúde", tipo:"Manifestação",           dataLimite:new Date(Date.now()+18*86400000).toISOString().slice(0,10), responsavel:"Janine", concluido:true,  obs:"",                 prioridade:"baixa" },
];

const FERIADOS_2026 = ["2026-01-01","2026-02-16","2026-02-17","2026-04-03","2026-04-21","2026-05-01","2026-06-11","2026-09-07","2026-10-12","2026-11-02","2026-11-15","2026-11-20","2026-12-25"];
const FERIADOS_NOMES = {"2026-01-01":"Ano Novo","2026-02-16":"Carnaval","2026-02-17":"Carnaval","2026-04-03":"Sexta-feira Santa","2026-04-21":"Tiradentes","2026-05-01":"Dia do Trabalho","2026-06-11":"Corpus Christi","2026-09-07":"Independência","2026-10-12":"Nossa Senhora Aparecida","2026-11-02":"Finados","2026-11-15":"Proclamação da República","2026-11-20":"Consciência Negra","2026-12-25":"Natal"};

// ═════════════════════════════════════════════════════════════════════════════
// COMPONENTES UI
// ═════════════════════════════════════════════════════════════════════════════
function Badge({ children, color, bg, size=11 }) {
  return <span style={{ background:bg, color, fontSize:size, fontWeight:700, borderRadius:20, padding:"3px 10px", fontFamily:"Inter,system-ui,sans-serif", whiteSpace:"nowrap" }}>{children}</span>;
}

function StatusBadge({ status, modo }) {
  const cfg = STATUS_CFG[status][modo];
  return <Badge color={cfg.text} bg={cfg.pill}>{STATUS_CFG[status].label}</Badge>;
}
function PrioBadge({ prio, modo }) {
  const cfg = PRIO_CFG[prio||"media"][modo];
  return <Badge color={cfg.c} bg={cfg.bg}>● {PRIO_CFG[prio||"media"].label}</Badge>;
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function ToastContainer({ toasts, T }) {
  return (
    <div style={{ position:"fixed", bottom:80, left:"50%", transform:"translateX(-50%)", zIndex:1000, display:"flex", flexDirection:"column", gap:8, alignItems:"center", pointerEvents:"none", maxWidth:"calc(100vw - 32px)" }}>
      {toasts.map(t => {
        const colors = { success: T.success, info: T.primary, danger: T.danger };
        return (
          <div key={t.id} style={{
            background:T.card, color:T.text, padding:"10px 18px", borderRadius:12,
            boxShadow:"0 8px 24px #00000033", border:`1px solid ${T.border}`,
            display:"flex", alignItems:"center", gap:10, fontSize:14, fontWeight:500,
            animation:"slideIn .2s ease-out", pointerEvents:"all", minWidth:200,
          }}>
            <div style={{ width:6, height:6, borderRadius:"50%", background:colors[t.type]||T.primary }} />
            {t.msg}
          </div>
        );
      })}
    </div>
  );
}

// ─── Menu de ações ────────────────────────────────────────────────────────────
function AcoesMenu({ prazo, onEdit, onDelete, onToast, T }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={ref} style={{ position:"relative", flexShrink:0 }}>
      <button onClick={() => setOpen(o => !o)} style={{ background:"transparent", border:"none", padding:6, cursor:"pointer", color:T.textSoft, borderRadius:8, display:"flex" }}>
        <Icon name="dots" size={18} />
      </button>
      {open && (
        <div style={{ position:"absolute", right:0, top:"110%", background:T.card, border:`1px solid ${T.border}`, borderRadius:12, boxShadow:"0 8px 24px #00000022", minWidth:200, zIndex:60, overflow:"hidden" }}>
          {[
            { ico:"edit",     lbl:"Editar",       fn:() => { onEdit(prazo); setOpen(false); } },
            { ico:"calendar", lbl:"Google Calendar", fn:() => { gerarICS(prazo); onToast("Arquivo .ics baixado","success"); setOpen(false); } },
            { ico:"chat",     lbl:"WhatsApp",     fn:() => { whatsappPrazo(prazo); setOpen(false); } },
            { ico:"trash",    lbl:"Excluir",      fn:() => { onDelete(prazo.id); setOpen(false); }, danger:true },
          ].map(({ ico, lbl, fn, danger }) => (
            <button key={lbl} onClick={fn} style={{
              display:"flex", alignItems:"center", gap:10, width:"100%",
              background:"none", border:"none", padding:"11px 14px", cursor:"pointer",
              fontSize:13, color:danger?T.danger:T.text, fontFamily:"Inter,system-ui,sans-serif", fontWeight:500, textAlign:"left",
              borderBottom:`1px solid ${T.border}`,
            }}>
              <Icon name={ico} size={15} color={danger?T.danger:T.textSoft} />{lbl}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// CALENDÁRIO
// ═════════════════════════════════════════════════════════════════════════════
function Calendario({ prazos, onEdit, onNovoData, feriadosNomes, T, modo, onToast }) {
  const hoje = new Date();
  const [ano, setAno] = useState(hoje.getFullYear());
  const [mes, setMes] = useState(hoje.getMonth());
  const [diaAtivo, setDiaAtivo] = useState(null);

  const navMes = d => { let m = mes+d, a = ano; if (m<0){m=11;a--;} if (m>11){m=0;a++;} setMes(m); setAno(a); setDiaAtivo(null); };

  const porDia = useMemo(() => {
    const map = {};
    prazos.forEach(p => { (map[p.dataLimite] || (map[p.dataLimite] = [])).push(p); });
    return map;
  }, [prazos]);

  const primeiroDia = new Date(ano, mes, 1).getDay();
  const totalDias = new Date(ano, mes+1, 0).getDate();
  const hojeStr = isoLocal(hoje);
  const cells = [
    ...Array(primeiroDia).fill(null),
    ...Array.from({ length:totalDias }, (_,i) => {
      const d = i+1;
      return `${ano}-${String(mes+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    })
  ];

  const corDia = ds => {
    const ps = porDia[ds];
    if (!ps?.length) return null;
    for (const s of ["vencido","urgente","proximo","normal","concluido"])
      if (ps.some(p => p.status === s)) return STATUS_CFG[s][modo].c;
    return null;
  };

  const prazosAtivos = diaAtivo ? (porDia[diaAtivo] || []) : [];
  const todayMonth = mes === hoje.getMonth() && ano === hoje.getFullYear();

  return (
    <div style={{ padding:"16px 16px 80px" }}>
      {/* Nav mês */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16, background:T.card, borderRadius:14, padding:"12px 14px", border:`1px solid ${T.border}` }}>
        <button onClick={() => navMes(-1)} style={{ background:T.cardAlt, border:"none", borderRadius:10, padding:"8px 12px", cursor:"pointer", color:T.text, display:"flex" }}>
          <Icon name="chevL" size={18} color={T.text} />
        </button>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontSize:18, fontWeight:700, color:T.text, fontFamily:"Inter,system-ui,sans-serif" }}>{MESES[mes]}</div>
          <div style={{ fontSize:12, color:T.textMuted }}>{ano}</div>
        </div>
        <div style={{ display:"flex", gap:6 }}>
          {!todayMonth && (
            <button onClick={() => { setAno(hoje.getFullYear()); setMes(hoje.getMonth()); }}
              style={{ background:T.cardAlt, border:"none", borderRadius:10, padding:"8px 12px", cursor:"pointer", color:T.primary, fontSize:12, fontWeight:600 }}>
              Hoje
            </button>
          )}
          <button onClick={() => navMes(1)} style={{ background:T.cardAlt, border:"none", borderRadius:10, padding:"8px 12px", cursor:"pointer", color:T.text, display:"flex" }}>
            <Icon name="chevR" size={18} color={T.text} />
          </button>
        </div>
      </div>

      {/* Grid */}
      <div style={{ background:T.card, borderRadius:14, overflow:"hidden", border:`1px solid ${T.border}` }}>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", borderBottom:`1px solid ${T.border}` }}>
          {DIAS_SEMANA.map((d,i) => (
            <div key={d} style={{ textAlign:"center", padding:"10px 2px", fontSize:10, fontWeight:700, color:i===0||i===6?T.danger:T.textMuted, letterSpacing:1, textTransform:"uppercase" }}>{d}</div>
          ))}
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)" }}>
          {cells.map((ds, i) => {
            if (!ds) return <div key={`e${i}`} style={{ borderRight:`1px solid ${T.border}`, borderBottom:`1px solid ${T.border}`, minHeight:54, background:T.cardAlt+"55" }} />;
            const dNum = parseInt(ds.split("-")[2]);
            const isHoje = ds === hojeStr;
            const isAtivo = ds === diaAtivo;
            const cor = corDia(ds);
            const qtd = porDia[ds]?.length || 0;
            const dow = new Date(ds+"T00:00:00").getDay();
            const isWeekend = dow === 0 || dow === 6;
            const feriadoNome = feriadosNomes && feriadosNomes[ds];
            return (
              <div key={ds} onClick={() => setDiaAtivo(isAtivo ? null : ds)}
                title={feriadoNome ? feriadoNome : ""}
                style={{
                  borderRight:`1px solid ${T.border}`, borderBottom:`1px solid ${T.border}`,
                  minHeight:54, padding:"6px 4px 4px",
                  background: isAtivo ? T.primarySoft : feriadoNome ? T.warnSoft+"33" : isHoje ? T.primarySoft+"55" : isWeekend ? T.cardAlt+"55" : "transparent",
                  cursor:"pointer", position:"relative",
                }}>
                <div style={{ display:"flex", justifyContent:"center", marginBottom:2 }}>
                  <span style={{
                    width:24, height:24, borderRadius:"50%",
                    display:"flex", alignItems:"center", justifyContent:"center",
                    fontSize:12, fontWeight:isHoje?700:feriadoNome?600:400,
                    background: isHoje ? T.primary : "transparent",
                    color: isHoje ? "#fff" : feriadoNome ? T.warn : isWeekend ? T.danger : T.text,
                  }}>{dNum}</span>
                </div>
                {qtd > 0 && (
                  <div style={{ display:"flex", flexWrap:"wrap", gap:2, justifyContent:"center" }}>
                    {(porDia[ds]||[]).slice(0,3).map((p,j) => <div key={j} style={{ width:6, height:6, borderRadius:"50%", background:STATUS_CFG[p.status][modo].c }} />)}
                    {qtd > 3 && <span style={{ fontSize:9, color:T.textMuted }}>+{qtd-3}</span>}
                  </div>
                )}
                {feriadoNome && qtd === 0 && (
                  <div style={{ fontSize:8, color:T.warn, textAlign:"center", lineHeight:1.1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", padding:"0 1px" }}>{feriadoNome}</div>
                )}
                {isAtivo && <div style={{ position:"absolute", inset:0, border:`2px solid ${T.primary}`, pointerEvents:"none" }} />}
              </div>
            );
          })}
        </div>
      </div>

      {/* Legenda */}
      <div style={{ display:"flex", justifyContent:"flex-end", gap:14, marginTop:8, fontSize:11, color:T.textMuted, flexWrap:"wrap" }}>
        <span style={{ display:"flex", alignItems:"center", gap:5 }}><span style={{ width:8, height:8, borderRadius:"50%", background:T.warn }} /> Feriado</span>
        <span style={{ display:"flex", alignItems:"center", gap:5 }}><span style={{ width:8, height:8, borderRadius:"50%", background:T.danger }} /> Fim de semana</span>
      </div>

      {/* Painel do dia */}
      {diaAtivo && (
        <div style={{ marginTop:16, background:T.card, borderRadius:14, overflow:"hidden", border:`1px solid ${T.border}` }}>
          <div style={{ padding:"14px 16px", background:T.primarySoft, borderBottom:`1px solid ${T.border}`, display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
            <div>
              <div style={{ fontSize:14, fontWeight:700, color:T.primary }}>{fmtLong(diaAtivo)}</div>
              <div style={{ fontSize:12, color:T.textSoft }}>{prazosAtivos.length} prazo(s)</div>
            </div>
            <button onClick={() => onNovoData(diaAtivo)}
              style={{ background:T.primary, color:"#fff", border:"none", borderRadius:10, padding:"7px 14px", fontSize:12, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", gap:5 }}>
              <Icon name="plus" size={14} color="#fff" /> Novo
            </button>
          </div>
          {prazosAtivos.length === 0
            ? <div style={{ padding:24, textAlign:"center", color:T.textMuted, fontSize:13 }}>Nenhum prazo neste dia.</div>
            : prazosAtivos.map(p => (
              <div key={p.id} style={{ padding:"12px 16px", borderBottom:`1px solid ${T.border}`, display:"flex", alignItems:"center", gap:10, opacity:p.concluido?0.55:1 }}>
                <div style={{ width:3, alignSelf:"stretch", borderRadius:3, background:STATUS_CFG[p.status][modo].c, flexShrink:0 }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:14, fontWeight:600, color:T.text, marginBottom:2 }}>{p.parte}</div>
                  <div style={{ fontSize:12, color:T.textSoft }}>{p.tipo} · {p.responsavel}</div>
                </div>
                <StatusBadge status={p.status} modo={modo} />
                <button onClick={() => onEdit(p)} style={{ background:"transparent", border:"none", padding:6, cursor:"pointer", color:T.textSoft, display:"flex" }}>
                  <Icon name="edit" size={16} color={T.textSoft} />
                </button>
              </div>
            ))
          }
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// LISTA DE TAREFAS com drag
// ═════════════════════════════════════════════════════════════════════════════
function ListaTarefas({ tarefas, setTarefas, onEdit, onDelete, onToggle, T, modo }) {
  const fromRef = useRef(null);
  const overRef = useRef(null);
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const touchState = useRef({ startY:0, itemH:0 });

  const moveItem = (from, to) => {
    if (from === null || to === null || from === to) return;
    const idFrom = tarefas[from] && tarefas[from].id;
    const idTo = tarefas[to] && tarefas[to].id;
    if (idFrom === undefined || idTo === undefined) return;
    setTarefas(prev => {
      const nova = [...prev];
      const iFrom = nova.findIndex(t => t.id === idFrom);
      const iTo = nova.findIndex(t => t.id === idTo);
      if (iFrom < 0 || iTo < 0) return prev;
      const [m] = nova.splice(iFrom, 1);
      nova.splice(iTo, 0, m);
      return nova;
    });
  };

  if (tarefas.length === 0)
    return <div style={{ textAlign:"center", padding:48, color:T.textMuted, fontSize:14 }}>Nenhuma tarefa.</div>;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      {tarefas.map((t, idx) => {
        const pr = PRIO_CFG[t.prioridade||"media"][modo];
        const isDragging = dragFrom === idx;
        const isOver = dragOver === idx && !isDragging;
        const prazoInfo = t.prazoLimite ? (() => {
          const du = diasUteisRestantes(t.prazoLimite);
          return { du, cor: du<0?T.danger : du<=2?T.warn : du<=5?"#d69e2e" : T.success };
        })() : null;
        return (
          <div key={t.id} draggable
            onDragStart={() => { fromRef.current=idx; overRef.current=idx; setDragFrom(idx); setDragOver(idx); }}
            onDragOver={e => { e.preventDefault(); if (idx !== overRef.current) { overRef.current=idx; setDragOver(idx); } }}
            onDrop={e => { e.preventDefault(); moveItem(fromRef.current, overRef.current); fromRef.current=null; overRef.current=null; setDragFrom(null); setDragOver(null); }}
            onDragEnd={() => { fromRef.current=null; overRef.current=null; setDragFrom(null); setDragOver(null); }}
            onTouchStart={e => { fromRef.current=idx; overRef.current=idx; touchState.current.startY=e.touches[0].clientY; touchState.current.itemH=e.currentTarget.getBoundingClientRect().height+8; setDragFrom(idx); setDragOver(idx); }}
            onTouchMove={e => { e.preventDefault(); const dy=e.touches[0].clientY-touchState.current.startY; const step=Math.round(dy/touchState.current.itemH); const next=Math.max(0,Math.min(tarefas.length-1,fromRef.current+step)); if (next !== overRef.current) { overRef.current=next; setDragOver(next); } }}
            onTouchEnd={() => { moveItem(fromRef.current, overRef.current); fromRef.current=null; overRef.current=null; setDragFrom(null); setDragOver(null); }}
            style={{
              background:T.card,
              border:`1px solid ${isDragging||isOver ? T.primary : T.border}`,
              borderLeft:`4px solid ${pr.c}`,
              borderRadius:12, padding:"12px 14px",
              display:"flex", alignItems:"center", gap:10,
              boxShadow: isDragging ? `0 8px 28px ${T.primary}55` : "0 1px 3px #0000000a",
              opacity: isDragging ? 0.5 : t.concluida ? 0.55 : 1,
              transform: isDragging ? "scale(1.02)" : "scale(1)",
              transition:"box-shadow .12s, opacity .12s, transform .12s",
              touchAction:"none", userSelect:"none",
            }}>
            <div style={{ color:T.textMuted, flexShrink:0, display:"flex" }}>
              <Icon name="drag" size={16} color={T.textMuted} />
            </div>
            <div style={{ width:22, height:22, borderRadius:"50%", background:pr.bg, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
              <span style={{ fontSize:11, fontWeight:800, color:pr.c }}>{idx+1}</span>
            </div>
            <div onClick={() => onToggle(t.id)}
              style={{ width:20, height:20, borderRadius:6, border:`2px solid ${pr.c}`, background:t.concluida?pr.c:"transparent", cursor:"pointer", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
              {t.concluida && <Icon name="check" size={12} color="#fff" />}
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", marginBottom:2 }}>
                <span style={{ fontSize:14, fontWeight:600, color:T.text, textDecoration:t.concluida?"line-through":"none" }}>{t.titulo}</span>
                <Badge color={pr.c} bg={pr.bg} size={10}>{PRIO_CFG[t.prioridade||"media"].label}</Badge>
              </div>
              {t.descricao && <div style={{ fontSize:12, color:T.textSoft, marginBottom:2 }}>{t.descricao}</div>}
              <div style={{ fontSize:11, color:T.textMuted, display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                <span style={{ display:"flex", alignItems:"center", gap:3 }}><Icon name="user" size={11} color={T.textMuted} />{t.responsavel}</span>
                {prazoInfo && (
                  <span style={{ color:prazoInfo.cor, fontWeight:600, display:"flex", alignItems:"center", gap:3 }}>
                    <Icon name="calendar" size={11} color={prazoInfo.cor} />
                    {fmt(t.prazoLimite)} · {diasLabel(prazoInfo.du, t.concluida)}
                  </span>
                )}
              </div>
            </div>
            <div style={{ display:"flex", gap:4, flexShrink:0 }}>
              <button onClick={() => onEdit(t)} style={{ background:"transparent", border:"none", padding:6, cursor:"pointer", color:T.textSoft, display:"flex" }}>
                <Icon name="edit" size={15} color={T.textSoft} />
              </button>
              <button onClick={() => onDelete(t.id)} style={{ background:"transparent", border:"none", padding:6, cursor:"pointer", color:T.danger, display:"flex" }}>
                <Icon name="trash" size={15} color={T.danger} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// APP PRINCIPAL
// ═════════════════════════════════════════════════════════════════════════════
// ─── Tela de Login ────────────────────────────────────────────────────────────
function TelaLogin({ T, modo, onToast }) {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [criando, setCriando] = useState(false);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState("");

  const submeter = async () => {
    setErro(""); setLoading(true);
    try {
      if (criando) await criarConta(email, senha);
      else await fazerLogin(email, senha);
    } catch (e) {
      const msgs = {
        "auth/invalid-email":     "E-mail inválido",
        "auth/user-not-found":    "Usuário não encontrado",
        "auth/wrong-password":    "Senha incorreta",
        "auth/email-already-in-use": "Este e-mail já está cadastrado",
        "auth/weak-password":     "Senha muito fraca (mínimo 6 caracteres)",
        "auth/invalid-credential":"E-mail ou senha incorretos",
      };
      setErro(msgs[e.code] || e.message);
    }
    setLoading(false);
  };

  return (
    <div style={{ minHeight:"100vh", background:T.bg, display:"flex", alignItems:"center", justifyContent:"center", padding:20, fontFamily:"Inter,system-ui,sans-serif" }}>
      <div style={{ background:T.card, borderRadius:20, padding:"32px 28px", maxWidth:400, width:"100%", boxShadow:"0 20px 60px #00000022", border:`1px solid ${T.border}` }}>
        <div style={{ textAlign:"center", marginBottom:24 }}>
          <div style={{ background:T.primary, width:60, height:60, borderRadius:"50%", display:"inline-flex", alignItems:"center", justifyContent:"center", marginBottom:12 }}>
            <img src="/icon-512.png" alt="MCS" style={{ width:54, height:54, borderRadius:"50%", objectFit:"cover" }} />
          </div>
          <h1 style={{ margin:0, fontSize:20, fontWeight:700, color:T.text }}>Controle de Prazos</h1>
          <div style={{ fontSize:12, color:T.textMuted, marginTop:4 }}><img src="/logo-mcs.png" alt="Martins, Corrêa da Silva Advogados" style={{ height:36, display:"block", margin:"4px auto 0", filter: modo==="dark" ? "brightness(0) invert(1)" : "none" }} /></div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <label>
            <span style={{ fontSize:11, color:T.textMuted, letterSpacing:1, textTransform:"uppercase", fontWeight:600, marginBottom:5, display:"block" }}>E-mail</span>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="seu@email.com"
              style={{ background:T.card, border:`1.5px solid ${T.border}`, borderRadius:10, padding:"10px 14px", color:T.text, fontSize:14, width:"100%", boxSizing:"border-box", outline:"none" }} />
          </label>
          <label>
            <span style={{ fontSize:11, color:T.textMuted, letterSpacing:1, textTransform:"uppercase", fontWeight:600, marginBottom:5, display:"block" }}>Senha</span>
            <input type="password" value={senha} onChange={e => setSenha(e.target.value)} placeholder="••••••" onKeyDown={e => e.key === "Enter" && submeter()}
              style={{ background:T.card, border:`1.5px solid ${T.border}`, borderRadius:10, padding:"10px 14px", color:T.text, fontSize:14, width:"100%", boxSizing:"border-box", outline:"none" }} />
          </label>
          {erro && <div style={{ background:T.dangerSoft, border:`1px solid ${T.danger}33`, color:T.danger, borderRadius:8, padding:"8px 12px", fontSize:12 }}>{erro}</div>}
          <button onClick={submeter} disabled={loading || !email || !senha}
            style={{ background:T.primary, color:"#fff", border:"none", borderRadius:10, padding:"12px", fontWeight:700, fontSize:14, cursor:"pointer", opacity:(loading||!email||!senha)?0.5:1, marginTop:4 }}>
            {loading ? "Aguarde..." : criando ? "Criar conta" : "Entrar"}
          </button>
          <button onClick={() => { setCriando(!criando); setErro(""); }}
            style={{ background:"transparent", border:"none", color:T.primary, fontSize:13, cursor:"pointer", marginTop:4 }}>
            {criando ? "Já tenho conta · Entrar" : "Não tenho conta · Criar uma"}
          </button>
        </div>
        <div style={{ marginTop:20, padding:"10px 12px", background:T.cardAlt, borderRadius:8, fontSize:11, color:T.textMuted, lineHeight:1.5 }}>
          🔒 Seus dados ficam armazenados de forma segura no Supabase e sincronizam automaticamente em todos os seus dispositivos.
        </div>
      </div>
    </div>
  );
}

// ── Constantes do painel DJEN ────────────────────────────────────────────────
const STATUS_DJEN = {
  NOVO:        { label:"Novo",          cor:"#2b6cb0", bg:"#ebf8ff" },
  EM_ANALISE:  { label:"Em análise",    cor:"#c9892e", bg:"#fefcbf" },
  CONTATADO:   { label:"Contatado",     cor:"#5c6b3a", bg:"#e6efd9" },
  PROMOVIDO:   { label:"Promovido",     cor:"#2c5282", bg:"#d3ddf0" },
  DESCARTADO:  { label:"Descartado",    cor:"#718096", bg:"#edf2f7" },
};

const COR_GATILHO = {
  G1_TUTELA_DEFERIDA:        { cor:"#5c6b3a", bg:"rgba(92,107,58,0.15)",  label:"G1·Tutela deferida"   },
  G2_INTIMACAO_CUMPRIMENTO:  { cor:"#c9892e", bg:"rgba(201,137,46,0.18)", label:"G2·Intimação"         },
  G3_DESCUMPRIMENTO:         { cor:"#b8412e", bg:"rgba(184,65,46,0.15)",  label:"G3·Descumprimento"    },
  G4_ORCAMENTOS:             { cor:"#b8941f", bg:"rgba(184,148,31,0.18)", label:"G4·Orçamentos"        },
  G5_TUTELA_INDEFERIDA:      { cor:"#6b6b6b", bg:"rgba(107,107,107,0.13)",label:"G5·Tutela indeferida" },
};

// Regex idênticas ao monitor_djen.py — para destacar trechos relevantes
const GATILHOS_REGEX_MCS = {
  G1_TUTELA_DEFERIDA: [
    /\b(defiro|defere|deferiu|deferimos|deferida|deferido|deferir)\b.{0,120}\b(tutela|liminar|antecipa[çc][ãa]o)\b/gis,
    /\b(tutela|liminar|antecipa[çc][ãa]o)\b.{0,80}\b(defiro|defere|deferiu|deferimos|deferida|deferido)\b/gis,
    /\b(concedo|concede|concedeu|concedida|concedido|conceder)\b.{0,80}\b(tutela|liminar)\b/gis,
    /\b(determino|determinou|determine-se)\b.{0,120}\b(fornecimento|forne[cç]a|forne[cç]er|custear|custeio|custeie)\b/gis,
  ],
  G2_INTIMACAO_CUMPRIMENTO: [
    /\bintim[ae].{0,60}cumprimento\b/gis,
    /\bintim[ae].{0,80}\bplano\b/gis,
    /\bintim[ae].{0,80}(estado|munic[íi]pio|uni[aã]o)\b/gis,
    /\bcumpra-se\b/gis,
  ],
  G3_DESCUMPRIMENTO: [
    /\bdescumprimento\b/gi, /\bn[aã]o\s+cumpr[io]\b/gi, /\bdeixou\s+de\s+cumprir\b/gi,
    /\bsisbajud\b/gi, /\bfalta\s+do\s+medicamento\b/gi, /\bn[aã]o\s+disponibilizou\b/gi,
  ],
  G4_ORCAMENTOS: [
    /\bor[çc]amento[s]?\b.{0,80}\b(medicament|f[áa]rmac|f[óo]rmul|forneciment|aquisi[çc][ãa]o|compra|menor\s+pre[çc]o)\b/gis,
    /\btr[êe]s\s+or[çc]amentos\b/gi,
  ],
  G5_TUTELA_INDEFERIDA: [
    /\b(indefiro|indefere|indeferiu|indeferida|indeferido|indeferir)\b.{0,80}\b(tutela|liminar|antecipa[çc][ãa]o)\b/gis,
  ],
};


// ── Hook que sincroniza a tabela publicacoes_djen com o Supabase ─────────────
function usePublicacoesDjen() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  // Carregar inicial + assinar realtime
  useEffect(() => {
    let alive = true;
    let channel = null;

    (async () => {
      const sb = await initSupabase();
      if (!alive || !sb || !_userId) { setLoading(false); return; }
      
      const { data, error } = await sb
        .from("publicacoes_djen")
        .select("*")
        .eq("user_id", _userId)
        .order("data_publicacao", { ascending:false })
        .order("enviado_em", { ascending:false });
      
      if (!alive) return;
      if (error) { console.error("Erro carregando DJEN:", error); setLoading(false); return; }
      setItems(data || []);
      setLoading(false);

      // Realtime: atualiza automaticamente quando o dashboard envia
      channel = sb.channel("djen-" + _userId)
        .on("postgres_changes",
            { event:"*", schema:"public", table:"publicacoes_djen", filter:"user_id=eq."+_userId },
            payload => {
              if (!alive) return;
              setItems(prev => {
                if (payload.eventType === "INSERT") {
                  if (prev.some(p => p.id === payload.new.id)) return prev;
                  return [payload.new, ...prev];
                }
                if (payload.eventType === "UPDATE") {
                  return prev.map(p => p.id === payload.new.id ? payload.new : p);
                }
                if (payload.eventType === "DELETE") {
                  return prev.filter(p => p.id !== payload.old.id);
                }
                return prev;
              });
            })
        .subscribe();
    })();

    return () => {
      alive = false;
      if (channel && _sb) { try { _sb.removeChannel(channel); } catch(e) {} }
    };
  }, []);

  const atualizarStatus = async (id, novoStatus, observacao) => {
    const sb = _sb;
    if (!sb) return;
    const patch = { status: novoStatus };
    if (observacao !== undefined) patch.observacao = observacao;
    const { error } = await sb.from("publicacoes_djen").update(patch).eq("id", id);
    if (error) console.error("Erro atualizando status:", error);
    // optimistic update — realtime confirma depois
    setItems(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  };

  const atualizarAcompanhar = async (id, valor) => {
    const sb = _sb;
    if (!sb) return;
    const { error } = await sb.from("publicacoes_djen").update({ acompanhar: valor }).eq("id", id);
    if (error) console.error("Erro atualizando acompanhar:", error);
    setItems(prev => prev.map(p => p.id === id ? { ...p, acompanhar: valor } : p));
  };

  const atualizarObservacao = async (id, observacao) => {
    const sb = _sb;
    if (!sb) return { error: "Nao autenticado" };
    const valor = observacao && observacao.trim() ? observacao.trim() : null;
    const { error } = await sb.from("publicacoes_djen").update({ observacao: valor }).eq("id", id);
    if (error) { console.error("Erro atualizando observacao:", error); return { error }; }
    setItems(prev => prev.map(p => p.id === id ? { ...p, observacao: valor } : p));
    return { error: null };
  };

  const remover = async (id) => {
    const sb = _sb;
    if (!sb) return;
    const { error } = await sb.from("publicacoes_djen").delete().eq("id", id);
    if (error) console.error("Erro removendo:", error);
    setItems(prev => prev.filter(p => p.id !== id));
  };

  const adicionarProcessoManual = async ({ numero_processo, tribunal, observacao }) => {
    const sb = _sb;
    if (!sb || !_userId) return { error: "Nao autenticado" };
    const id_djen = "manual_" + Date.now();
    const payload = {
      user_id: _userId, id_djen,
      numero_processo: numero_processo.trim(),
      tribunal: tribunal ? tribunal.trim() : null,
      observacao: observacao ? observacao.trim() : null,
      acompanhar: true, status: "NOVO", prioridade: 5,
      data_publicacao: isoLocal(),
      gatilhos: "", medicamentos: "",
      texto_publicacao: "Processo adicionado manualmente para acompanhamento no DJEN.",
    };
    const { data, error } = await sb.from("publicacoes_djen").insert(payload).select().single();
    if (error) { console.error("Erro inserindo:", error); return { error }; }
    setItems(prev => prev.some(p => p.id === data.id) ? prev : [data, ...prev]);
    return { data };
  };

  return { items, loading, atualizarStatus, atualizarAcompanhar, atualizarObservacao, remover, adicionarProcessoManual };
}


// ── Renderiza texto com destaque dos gatilhos (mesma lógica do dashboard) ────
function renderTextoDjen(texto, gatilhosStr, medicamentosStr) {
  if (!texto) return null;
  const ranges = [];
  const gats = (gatilhosStr || "").split(";").map(s => s.trim()).filter(Boolean);

  gats.forEach(g => {
    const conf = COR_GATILHO[g];
    if (!conf) return;
    const regexes = GATILHOS_REGEX_MCS[g] || [];
    regexes.forEach(re => {
      const r = new RegExp(re.source, re.flags);
      let m;
      while ((m = r.exec(texto)) !== null) {
        ranges.push({ start: m.index, end: m.index + m[0].length, ...conf });
        if (m.index === r.lastIndex) r.lastIndex++;
      }
    });
  });

  const meds = (medicamentosStr || "").split(";")
    .map(s => s.trim().replace(/\([^)]*\)/g,"").trim())
    .filter(s => s.length >= 4);
  meds.forEach(med => {
    const escaped = med.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("\\b" + escaped + "\\b", "gi");
    let m;
    while ((m = re.exec(texto)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length,
                    cor:"#1b2a4a", bg:"rgba(27,42,74,0.10)", label:"Medicamento" });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  });

  if (ranges.length === 0) return <span>{texto}</span>;
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) {
      if (r.end > last.end) last.end = r.end;
    } else merged.push({ ...r });
  }

  const parts = [];
  let cursor = 0;
  merged.forEach((r, i) => {
    if (cursor < r.start) parts.push(<span key={"p"+i}>{texto.substring(cursor, r.start)}</span>);
    parts.push(
      <mark key={"m"+i} title={r.label}
            style={{ background:r.bg, color:r.cor, padding:"1px 3px", borderRadius:2,
                     borderBottom:`2px solid ${r.cor}`, fontWeight:500 }}>
        {texto.substring(r.start, r.end)}
      </mark>
    );
    cursor = r.end;
  });
  if (cursor < texto.length) parts.push(<span key="end">{texto.substring(cursor)}</span>);
  return <>{parts}</>;
}


// ── Painel principal da aba DJEN ─────────────────────────────────────────────
function PainelDJEN({ T, modo, setPrazos, prazos, setAba, setForm, setModal, toast, irParaPrazo, processoAlvo, onProcessoAlvoConsumido }) {
  const { items, loading, atualizarStatus, atualizarAcompanhar, atualizarObservacao, remover, adicionarProcessoManual } = usePublicacoesDjen();
  const [detalhe, setDetalhe] = useState(null);
  const [obsEdit, setObsEdit] = useState("");
  const [salvandoObs, setSalvandoObs] = useState(false);
  const [filtroStatus, setFiltroStatus] = useState("");
  const [filtroTribunal, setFiltroTribunal] = useState("");
  const [filtroPrio, setFiltroPrio] = useState("");
  const [busca, setBusca] = useState("");
  const [modalNovoProcesso, setModalNovoProcesso] = useState(false);
  const [formNovoProcesso, setFormNovoProcesso] = useState({ numero_processo:"", tribunal:"", observacao:"" });
  const [salvandoNovoProcesso, setSalvandoNovoProcesso] = useState(false);
  const [confirmApagar, setConfirmApagar] = useState(null); // { pub, vinculados }

  // Prazos da aba Prazos que pertencem ao mesmo processo (casa por digitos, ignora mascara CNJ)
  const soDig = s => (s || "").replace(/\D/g, "");
  const prazosDoProcesso = (numero) => {
    const alvo = soDig(numero);
    if (!alvo) return [];
    return (prazos || []).filter(p => soDig(p.processo) === alvo);
  };

  // Carrega a observação atual no editor sempre que o modal de detalhe abre/troca
  useEffect(() => {
    setObsEdit(detalhe?.observacao || "");
    setSalvandoObs(false);
  }, [detalhe?.id]);

  // Navegação cruzada Prazos→DJEN: ao chegar com um processo-alvo, busca por ele
  // e limpa os filtros para garantir que o card apareça. Depois zera o alvo no App
  // (permite clicar de novo no mesmo processo).
  useEffect(() => {
    if (!processoAlvo) return;
    setBusca(processoAlvo);
    setFiltroStatus("");
    setFiltroTribunal("");
    setFiltroPrio("");
    onProcessoAlvoConsumido && onProcessoAlvoConsumido();
  }, [processoAlvo]);

  const salvarObservacao = async () => {
    if (!detalhe) return;
    setSalvandoObs(true);
    const { error } = await atualizarObservacao(detalhe.id, obsEdit);
    setSalvandoObs(false);
    if (error) { toast("Erro ao salvar observação. Tente novamente.", "danger"); return; }
    const valor = obsEdit && obsEdit.trim() ? obsEdit.trim() : null;
    setDetalhe(d => d ? { ...d, observacao: valor } : d);
    toast("Observação salva", "success");
  };

  const tribunaisUnicos = useMemo(() => {
    return [...new Set(items.map(i => i.tribunal).filter(Boolean))].sort();
  }, [items]);

  const filtrados = useMemo(() => {
    return items.filter(i => {
      if (filtroStatus && i.status !== filtroStatus) return false;
      if (filtroTribunal && i.tribunal !== filtroTribunal) return false;
      if (filtroPrio && String(i.prioridade) !== filtroPrio) return false;
      if (busca) {
        const b = busca.toLowerCase();
        const hay = [i.numero_processo, i.medicamentos, i.gatilhos, i.observacao, i.tribunal, i.texto_publicacao]
          .filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(b)) return false;
      }
      return true;
    });
  }, [items, filtroStatus, filtroTribunal, filtroPrio, busca]);

  // Contadores por status (para os cards)
  const counts = useMemo(() => {
    const c = { NOVO:0, EM_ANALISE:0, CONTATADO:0, PROMOVIDO:0, DESCARTADO:0 };
    items.forEach(i => { c[i.status] = (c[i.status]||0) + 1; });
    return c;
  }, [items]);

  // Promover a Prazo: abre o formulário de novo prazo já preenchido
  const promoverPrazo = (pub) => {
    const dataLimite = isoLocal(new Date(Date.now() + 5*86400000));
    setForm({
      processo: pub.numero_processo || "",
      parte: "",  // você preenche
      tipo: "Acompanhar",
      dataLimite,
      responsavel: "Felipe",
      obs: `📡 Captado do DJEN — ${pub.data_publicacao || ""}\nGatilhos: ${pub.gatilhos || ""}\nMedicamentos: ${pub.medicamentos || ""}\n${pub.observacao || ""}`.trim(),
      concluido: false,
      prioridade: pub.prioridade === 1 ? "alta" : (pub.prioridade === 2 ? "media" : "baixa"),
      modoData: "final",
      djenId: pub.id,
      djenAcompanhar: !!pub.acompanhar,
    });
    setModal("novo");
    setAba("lista");
    setDetalhe(null);
    toast("Publicação promovida — confira o formulário","success");
  };

  // Estilos base
  const INP = { background:T.bg, color:T.text, border:`1px solid ${T.border}`, borderRadius:6, padding:"7px 10px", fontSize:13, outline:"none" };
  const BTN = { padding:"6px 12px", borderRadius:6, fontSize:12, fontWeight:600, border:"none", cursor:"pointer" };
  const BTN_GHOST = { ...BTN, background:"transparent", color:T.text, border:`1px solid ${T.border}` };

  if (loading) {
    return (
      <div style={{ padding:40, textAlign:"center", color:T.textMuted, fontSize:14 }}>
        Carregando publicações DJEN...
      </div>
    );
  }

  return (
    <>
      {/* Cards de status */}
      <div style={{ padding:"14px 16px 0", overflowX:"auto", display:"flex", gap:8, scrollbarWidth:"none" }}>
        {[
          { key:"",          label:"Todos",       cor:T.primary, n: items.length },
          { key:"NOVO",      label:"Novo",        cor:STATUS_DJEN.NOVO.cor,       n: counts.NOVO },
          { key:"EM_ANALISE",label:"Em análise",  cor:STATUS_DJEN.EM_ANALISE.cor, n: counts.EM_ANALISE },
          { key:"CONTATADO", label:"Contatado",   cor:STATUS_DJEN.CONTATADO.cor,  n: counts.CONTATADO },
          { key:"PROMOVIDO", label:"Promovido",   cor:STATUS_DJEN.PROMOVIDO.cor,  n: counts.PROMOVIDO },
          { key:"DESCARTADO",label:"Descartado",  cor:STATUS_DJEN.DESCARTADO.cor, n: counts.DESCARTADO },
        ].map(({ key, label, cor, n }) => (
          <button key={key||"all"} onClick={() => setFiltroStatus(key)}
            style={{
              flex:"0 0 auto", background: filtroStatus===key ? cor : T.card,
              color: filtroStatus===key ? "#fff" : T.text,
              border:`1px solid ${filtroStatus===key ? cor : T.border}`,
              borderRadius:8, padding:"8px 14px", cursor:"pointer",
              display:"flex", flexDirection:"column", alignItems:"flex-start", gap:2,
              minWidth:80,
            }}>
            <span style={{ fontSize:10, fontWeight:500, opacity:0.85, letterSpacing:"0.06em", textTransform:"uppercase" }}>{label}</span>
            <span style={{ fontSize:18, fontWeight:700 }}>{n}</span>
          </button>
        ))}
      </div>

      {/* Filtros */}
      <div style={{ padding:"14px 16px", display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
        <input value={busca} onChange={e => setBusca(e.target.value)}
          placeholder="Buscar processo, medicamento, texto..."
          style={{ ...INP, flex:"1 1 200px", minWidth:160 }} />
        <select value={filtroTribunal} onChange={e => setFiltroTribunal(e.target.value)} style={{ ...INP, flex:"0 0 130px" }}>
          <option value="">Todos tribunais</option>
          {tribunaisUnicos.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={filtroPrio} onChange={e => setFiltroPrio(e.target.value)} style={{ ...INP, flex:"0 0 110px" }}>
          <option value="">Todas prio.</option>
          <option value="1">P1 Alta</option>
          <option value="2">P2 Média</option>
          <option value="5">P5 Manual</option>
          <option value="9">P9 Baixa</option>
        </select>
        <button onClick={() => { setFormNovoProcesso({ numero_processo:"", tribunal:"", observacao:"" }); setModalNovoProcesso(true); }}
          style={{ background:T.primary, color:"#fff", border:"none", borderRadius:6, padding:"7px 13px", fontSize:12, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", gap:5, flexShrink:0 }}>
          + Adicionar processo
        </button>
      </div>

      {/* Lista */}
      {filtrados.length === 0 ? (
        <div style={{ padding:60, textAlign:"center", color:T.textMuted, fontSize:13 }}>
          {items.length === 0
            ? "Nenhuma publicação enviada do dashboard ainda."
            : "Nenhuma publicação corresponde aos filtros."}
          {items.length === 0 && (
            <div style={{ marginTop:14, fontSize:11, color:T.textMuted }}>
              Use o botão "Enviar para MCS Prazos" no dashboard local para começar.
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding:"0 16px 80px", display:"flex", flexDirection:"column", gap:8 }}>
          {filtrados.map(p => {
            const stCfg = STATUS_DJEN[p.status] || STATUS_DJEN.NOVO;
            const gatList = (p.gatilhos||"").split(";").map(g=>g.trim()).filter(Boolean);
            return (
              <div key={p.id}
                onClick={() => setDetalhe(p)}
                style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:8,
                         padding:"12px 14px", cursor:"pointer", display:"flex",
                         flexDirection:"column", gap:6,
                         borderLeft:`4px solid ${stCfg.cor}` }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                  <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                    {p.acompanhar && (
                      <span title="Processo sob acompanhamento contínuo no DJEN"
                        style={{ background:"#5c6b3a", color:"#fff", padding:"2px 7px", borderRadius:3,
                                 fontSize:10, fontWeight:600, letterSpacing:"0.04em" }}>
                        🔔 ACOMP
                      </span>
                    )}
                    {(p.id_djen||"").startsWith("manual_") && (
                      <span title="Processo adicionado manualmente"
                        style={{ background:"#744210", color:"#fefcbf", padding:"2px 7px", borderRadius:3, fontSize:10, fontWeight:600, letterSpacing:"0.04em" }}>
                        MANUAL
                      </span>
                    )}
                    <span
                      onClick={e => { e.stopPropagation(); if (p.numero_processo && irParaPrazo) irParaPrazo(p.numero_processo); }}
                      title={p.numero_processo ? "Ver na aba Prazos" : ""}
                      style={{ fontFamily:"monospace", fontSize:12, fontWeight:600, color: p.numero_processo && irParaPrazo ? T.primary : T.text, cursor: p.numero_processo && irParaPrazo ? "pointer" : "default", textDecoration: p.numero_processo && irParaPrazo ? "underline" : "none", textUnderlineOffset:2 }}>
                      {p.numero_processo || "—"}
                    </span>
                    <span style={{ background:T.text, color:T.card, padding:"2px 7px", borderRadius:3,
                                   fontFamily:"monospace", fontSize:10, fontWeight:600, letterSpacing:"0.06em" }}>
                      {p.tribunal || "—"}
                    </span>
                    <span style={{ border:`1px solid ${p.prioridade===1?"#b8412e":p.prioridade===2?"#c9892e":"#6b6b6b"}`,
                                   color:p.prioridade===1?"#b8412e":p.prioridade===2?"#c9892e":"#6b6b6b",
                                   padding:"1px 7px", borderRadius:3, fontFamily:"monospace", fontSize:10, fontWeight:600 }}>
                      P{p.prioridade}
                    </span>
                  </div>
                  <span style={{ background:stCfg.bg, color:stCfg.cor, padding:"2px 8px",
                                 borderRadius:10, fontSize:10, fontWeight:600, letterSpacing:"0.04em",
                                 textTransform:"uppercase" }}>
                    {stCfg.label}
                  </span>
                </div>
                <div style={{ fontSize:12, color:T.textSoft }}>
                  {p.medicamentos || "—"}
                </div>
                <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                  {gatList.slice(0,3).map(g => {
                    const c = COR_GATILHO[g];
                    if (!c) return null;
                    return (
                      <span key={g} style={{ background:c.bg, color:c.cor, padding:"1px 6px",
                                              borderRadius:3, fontFamily:"monospace", fontSize:9.5, fontWeight:600 }}>
                        {c.label}
                      </span>
                    );
                  })}
                  <span style={{ marginLeft:"auto", color:T.textMuted, fontFamily:"monospace", fontSize:10 }}>
                    {p.data_publicacao ? p.data_publicacao.split("-").reverse().join("/") : ""}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal de detalhes */}
      {detalhe && (
        <div onClick={() => setDetalhe(null)}
          style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:200,
                   display:"flex", justifyContent:"center", alignItems:"flex-start",
                   padding:"40px 12px 12px", overflowY:"auto" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:T.bg, color:T.text, borderRadius:10, maxWidth:760, width:"100%",
                     boxShadow:"0 20px 60px rgba(0,0,0,0.4)", border:`1px solid ${T.border}` }}>
            <div style={{ padding:"18px 22px", borderBottom:`1px solid ${T.border}`,
                          display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:14 }}>
              <div>
                <div style={{ fontSize:11, color:T.textMuted, marginBottom:4, fontFamily:"monospace", letterSpacing:"0.1em" }}>
                  PUBLICAÇÃO DJEN
                </div>
                <div style={{ fontSize:16, fontWeight:600, fontFamily:"monospace" }}>
                  {detalhe.numero_processo || "—"}
                </div>
              </div>
              <button onClick={() => setDetalhe(null)}
                style={{ background:"none", border:"none", color:T.textMuted, fontSize:24, cursor:"pointer", padding:0, lineHeight:1 }}>
                ×
              </button>
            </div>

            <div style={{ padding:"18px 22px" }}>
              {/* Metadados em grid */}
              <div style={{ display:"grid", gridTemplateColumns:"110px 1fr", gap:"8px 14px", fontSize:13, marginBottom:18 }}>
                <span style={{ color:T.textMuted, fontFamily:"monospace", fontSize:10, letterSpacing:"0.08em", textTransform:"uppercase" }}>Tribunal</span>
                <span>{detalhe.tribunal || "—"}</span>
                <span style={{ color:T.textMuted, fontFamily:"monospace", fontSize:10, letterSpacing:"0.08em", textTransform:"uppercase" }}>Data pub.</span>
                <span style={{ fontFamily:"monospace" }}>{detalhe.data_publicacao ? detalhe.data_publicacao.split("-").reverse().join("/") : "—"}</span>
                <span style={{ color:T.textMuted, fontFamily:"monospace", fontSize:10, letterSpacing:"0.08em", textTransform:"uppercase" }}>Gatilhos</span>
                <span>{(detalhe.gatilhos||"").split(";").map(g => COR_GATILHO[g.trim()]?.label || g.trim()).filter(Boolean).join(" · ") || "—"}</span>
                <span style={{ color:T.textMuted, fontFamily:"monospace", fontSize:10, letterSpacing:"0.08em", textTransform:"uppercase" }}>Medicamentos</span>
                <span>{detalhe.medicamentos || "—"}</span>
              </div>

              {/* Observação editável */}
              <div style={{ marginBottom:18 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                  <div style={{ fontSize:10, color:T.textMuted, fontFamily:"monospace", letterSpacing:"0.1em", textTransform:"uppercase" }}>
                    Observação
                  </div>
                  <button onClick={salvarObservacao}
                    disabled={salvandoObs || (obsEdit || "") === (detalhe.observacao || "")}
                    style={{
                      ...BTN,
                      fontSize:11, padding:"5px 12px",
                      background: (salvandoObs || (obsEdit || "") === (detalhe.observacao || "")) ? "transparent" : T.primary,
                      color: (salvandoObs || (obsEdit || "") === (detalhe.observacao || "")) ? T.textMuted : "#fff",
                      borderColor: (salvandoObs || (obsEdit || "") === (detalhe.observacao || "")) ? T.border : T.primary,
                      cursor: (salvandoObs || (obsEdit || "") === (detalhe.observacao || "")) ? "default" : "pointer",
                    }}>
                    {salvandoObs ? "Salvando…" : "Salvar"}
                  </button>
                </div>
                <textarea
                  value={obsEdit}
                  onChange={e => setObsEdit(e.target.value)}
                  placeholder="Anotação livre — ex.: inicial protocolada em 31/05/2026, aguardando contestação…"
                  rows={3}
                  style={{ width:"100%", boxSizing:"border-box", background:T.card,
                           padding:"10px 12px", borderRadius:6, border:`1px solid ${T.border}`,
                           color:T.text, fontSize:13, lineHeight:1.6, fontFamily:"inherit",
                           resize:"vertical" }} />
              </div>

              {/* Texto destacado */}
              {detalhe.texto_publicacao && (
                <div style={{ marginBottom:18 }}>
                  <div style={{ fontSize:10, color:T.textMuted, marginBottom:8, fontFamily:"monospace", letterSpacing:"0.1em", textTransform:"uppercase" }}>
                    Texto da publicação
                  </div>
                  <div style={{ background:T.card, padding:"14px 16px", borderRadius:6,
                                border:`1px solid ${T.border}`, maxHeight:280, overflowY:"auto",
                                fontFamily:"Georgia, serif", fontSize:13, lineHeight:1.7,
                                whiteSpace:"pre-wrap", textAlign:"justify" }}>
                    {renderTextoDjen(detalhe.texto_publicacao, detalhe.gatilhos, detalhe.medicamentos)}
                  </div>
                </div>
              )}

              {/* Acompanhamento contínuo no DJEN */}
              <div style={{ background:T.card, padding:"12px 14px", borderRadius:6,
                            border:`1px solid ${T.border}`, marginBottom:14 }}>
                <label style={{ display:"flex", alignItems:"flex-start", gap:10, cursor:"pointer" }}>
                  <input type="checkbox"
                    checked={!!detalhe.acompanhar}
                    onChange={(e) => atualizarAcompanhar(detalhe.id, e.target.checked)}
                    style={{ marginTop:3, accentColor:T.primary, cursor:"pointer" }} />
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:600, color:T.text }}>
                      Acompanhar este processo no DJEN
                    </div>
                    <div style={{ fontSize:11, color:T.textMuted, marginTop:3, lineHeight:1.5 }}>
                      O monitor passa a buscar TODAS as movimentações deste processo, mesmo as não-oncológicas.
                      Você recebe alerta no e-mail quando houver novidade.
                    </div>
                  </div>
                </label>
              </div>

              {/* Ações: mudar status */}
              <div style={{ borderTop:`1px solid ${T.border}`, paddingTop:14 }}>
                <div style={{ fontSize:10, color:T.textMuted, marginBottom:8, fontFamily:"monospace", letterSpacing:"0.1em", textTransform:"uppercase" }}>
                  Workflow
                </div>
                <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                  {Object.entries(STATUS_DJEN).map(([k, v]) => (
                    <button key={k} onClick={() => atualizarStatus(detalhe.id, k)}
                      disabled={detalhe.status === k}
                      style={{
                        ...BTN,
                        background: detalhe.status === k ? v.cor : "transparent",
                        color: detalhe.status === k ? "#fff" : v.cor,
                        border: `1px solid ${v.cor}`,
                        cursor: detalhe.status === k ? "default" : "pointer",
                        opacity: detalhe.status === k ? 1 : 0.85,
                      }}>
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Ações finais */}
              <div style={{ marginTop:18, display:"flex", gap:8, flexWrap:"wrap", justifyContent:"flex-end" }}>
                <button onClick={() => {
                    const vinculados = prazosDoProcesso(detalhe.numero_processo);
                    setConfirmApagar({ pub: detalhe, vinculados });
                  }}
                  style={{ ...BTN_GHOST, color:"#b8412e", borderColor:"#b8412e" }}>
                  Apagar
                </button>
                <button onClick={() => navigator.clipboard.writeText(detalhe.numero_processo || "")}
                  style={BTN_GHOST}>
                  Copiar nº
                </button>
                <button onClick={() => promoverPrazo(detalhe)}
                  style={{ ...BTN, background:T.primary, color:"#fff" }}>
                  Promover a Prazo →
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {modalNovoProcesso && (
        <div onClick={() => setModalNovoProcesso(false)}
          style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:300, display:"flex", justifyContent:"center", alignItems:"center", padding:16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:T.bg, color:T.text, borderRadius:12, maxWidth:480, width:"100%", boxShadow:"0 20px 60px rgba(0,0,0,0.4)", border:`1px solid ${T.border}` }}>
            <div style={{ padding:"16px 20px", borderBottom:`1px solid ${T.border}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <div style={{ fontSize:15, fontWeight:700, color:T.text }}>Adicionar processo para acompanhamento</div>
                <div style={{ fontSize:11, color:T.textMuted, marginTop:3 }}>O monitor passa a monitorar este processo na 2a passada diaria.</div>
              </div>
              <button onClick={() => setModalNovoProcesso(false)} style={{ background:"none", border:"none", color:T.textMuted, fontSize:22, cursor:"pointer", padding:0 }}>x</button>
            </div>
            <div style={{ padding:"18px 20px", display:"flex", flexDirection:"column", gap:12 }}>
              <label>
                <span style={{ fontSize:11, color:T.textMuted, textTransform:"uppercase", fontWeight:600, marginBottom:5, display:"block" }}>Numero do processo *</span>
                <input autoFocus value={formNovoProcesso.numero_processo}
                  onChange={e => setFormNovoProcesso(f => ({ ...f, numero_processo: mascararProcesso(e.target.value) }))}
                  placeholder="0000000-00.0000.0.00.0000"
                  style={{ background:T.bg, border:`1.5px solid ${T.border}`, borderRadius:10, padding:"10px 14px", color:T.text, fontSize:14, fontFamily:"monospace", outline:"none", width:"100%", boxSizing:"border-box" }} />
              </label>
              <label>
                <span style={{ fontSize:11, color:T.textMuted, textTransform:"uppercase", fontWeight:600, marginBottom:5, display:"block" }}>Tribunal (opcional)</span>
                <select value={formNovoProcesso.tribunal} onChange={e => setFormNovoProcesso(f => ({ ...f, tribunal: e.target.value }))}
                  style={{ background:T.bg, border:`1.5px solid ${T.border}`, borderRadius:10, padding:"10px 14px", color:T.text, fontSize:14, outline:"none", width:"100%", boxSizing:"border-box" }}>
                  <option value="">Qualquer tribunal</option>
                  {["TJAL","TJAM","TJCE","TJES","TJGO","TJMA","TJMG","TJMT","TJPA","TJRS","TJSP"].map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label>
                <span style={{ fontSize:11, color:T.textMuted, textTransform:"uppercase", fontWeight:600, marginBottom:5, display:"block" }}>Observacao (opcional)</span>
                <textarea value={formNovoProcesso.observacao} onChange={e => setFormNovoProcesso(f => ({ ...f, observacao: e.target.value }))}
                  rows={2} placeholder="Ex: Cliente atual..."
                  style={{ background:T.bg, border:`1.5px solid ${T.border}`, borderRadius:10, padding:"10px 14px", color:T.text, fontSize:14, outline:"none", width:"100%", boxSizing:"border-box", resize:"vertical" }} />
              </label>
            </div>
            <div style={{ padding:"14px 20px", borderTop:`1px solid ${T.border}`, display:"flex", gap:8, justifyContent:"flex-end" }}>
              <button onClick={() => setModalNovoProcesso(false)} style={{ background:"transparent", border:`1px solid ${T.border}`, borderRadius:8, padding:"9px 16px", color:T.textSoft, cursor:"pointer", fontSize:13 }}>Cancelar</button>
              <button disabled={!formNovoProcesso.numero_processo.trim() || salvandoNovoProcesso}
                onClick={async () => {
                  if (!formNovoProcesso.numero_processo.trim()) return;
                  setSalvandoNovoProcesso(true);
                  const result = await adicionarProcessoManual(formNovoProcesso);
                  setSalvandoNovoProcesso(false);
                  if (result.error) { toast("Erro ao salvar. Tente novamente.","danger"); }
                  else { setModalNovoProcesso(false); toast("Processo adicionado para acompanhamento","success"); }
                }}
                style={{ background:T.primary, color:"#fff", border:"none", borderRadius:8, padding:"9px 18px", fontSize:13, fontWeight:700, cursor:"pointer", opacity:(!formNovoProcesso.numero_processo.trim()||salvandoNovoProcesso)?0.5:1 }}>
                {salvandoNovoProcesso ? "Salvando..." : "Adicionar e acompanhar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmApagar && (() => {
        const { pub, vinculados } = confirmApagar;
        const temPrazo = vinculados.length > 0;
        const fechar = () => setConfirmApagar(null);
        const apagarPublicacao = () => { remover(pub.id); setDetalhe(null); setConfirmApagar(null); toast("Publicação apagada","danger"); };
        const apagarTudo = () => {
          const ids = new Set(vinculados.map(p => p.id));
          remover(pub.id);
          setPrazos(prev => prev.filter(p => !ids.has(p.id)));
          setDetalhe(null);
          setConfirmApagar(null);
          toast(`Publicação + ${vinculados.length} prazo(s) apagados`,"danger");
        };
        return (
          <div onClick={fechar}
            style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:320, display:"flex", justifyContent:"center", alignItems:"center", padding:16 }}>
            <div onClick={e => e.stopPropagation()}
              style={{ background:T.bg, color:T.text, borderRadius:12, maxWidth:520, width:"100%", boxShadow:"0 20px 60px rgba(0,0,0,0.4)", border:`1px solid ${T.border}` }}>
              <div style={{ padding:"16px 20px", borderBottom:`1px solid ${T.border}` }}>
                <div style={{ fontSize:15, fontWeight:700, color:T.text }}>Apagar publicação do DJEN</div>
                <div style={{ fontSize:12, color:T.textMuted, marginTop:4, fontFamily:"monospace" }}>{pub.numero_processo || "—"}</div>
              </div>

              <div style={{ padding:"16px 20px" }}>
                {!temPrazo ? (
                  <div style={{ fontSize:13.5, color:T.textSoft }}>
                    Esta publicação será apagada permanentemente do DJEN. Nenhum prazo deste processo foi encontrado na aba Prazos.
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize:13.5, color:T.textSoft, marginBottom:12 }}>
                      Este processo tem <strong>{vinculados.length} prazo(s)</strong> na aba Prazos. O que deseja apagar?
                    </div>
                    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                      {vinculados.map(p => (
                        <div key={p.id}
                          style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, padding:"8px 12px", borderRadius:8, border:`1px solid ${T.border}`, background:T.bgSoft || "transparent" }}>
                          <div style={{ minWidth:0 }}>
                            <div style={{ fontSize:13, fontWeight:600, color:T.text }}>{p.tipo || "Prazo"}</div>
                            <div style={{ fontSize:11.5, color:T.textMuted }}>{p.parte || "—"} · venc. {fmt(p.dataLimite)}</div>
                          </div>
                          <span style={{ fontSize:10.5, fontWeight:700, textTransform:"uppercase", padding:"3px 8px", borderRadius:6,
                            color: p.concluido ? "#3a7d44" : "#b8412e",
                            border: `1px solid ${p.concluido ? "#3a7d44" : "#b8412e"}` }}>
                            {p.concluido ? "Concluído" : "Ativo"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>

              <div style={{ padding:"14px 20px", borderTop:`1px solid ${T.border}`, display:"flex", gap:8, justifyContent:"flex-end", flexWrap:"wrap" }}>
                <button onClick={fechar}
                  style={{ background:"transparent", border:`1px solid ${T.border}`, borderRadius:8, padding:"9px 16px", color:T.textSoft, cursor:"pointer", fontSize:13 }}>
                  Cancelar
                </button>
                <button onClick={apagarPublicacao}
                  style={{ background:"transparent", border:"1px solid #b8412e", borderRadius:8, padding:"9px 16px", color:"#b8412e", cursor:"pointer", fontSize:13, fontWeight:600 }}>
                  {temPrazo ? "Apagar só a publicação" : "Apagar"}
                </button>
                {temPrazo && (
                  <button onClick={apagarTudo}
                    style={{ background:"#b8412e", border:"none", borderRadius:8, padding:"9px 18px", color:"#fff", cursor:"pointer", fontSize:13, fontWeight:700 }}>
                    Apagar publicação + {vinculados.length} prazo(s)
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );
}


export default function App() {
  // Tema
  const [modo, setModo] = useStorage("mcs.modo", "light");
  const T = TEMA[modo];

  // Auth (só ativa quando Firebase configurado)
  const { user, loading: authLoading, ativo: authAtivo } = useAuth();
  const _carregandoAuth = authAtivo && authLoading; if (false) {
    return (
      <div style={{ minHeight:"100vh", background:TEMA[modo].bg, display:"flex", alignItems:"center", justifyContent:"center", color:TEMA[modo].textMuted, fontFamily:"Inter,system-ui,sans-serif" }}>
        Carregando...
      </div>
    );
  }
  const _precisaLogin = authAtivo && !user;

  // Estados de dados (com persistência)
  const [prazos, setPrazos]             = useStorage("mcs.prazos", INITIAL);
  const [tiposCustom, setTiposCustom]   = useStorage("mcs.tiposCustom", []);
  const [tarefas, setTarefas]           = useStorage("mcs.tarefas", [
    { id:1, titulo:"Revisar petição IPE Saúde", descricao:"Conferir citações e pedidos", prioridade:"alta", concluida:false, responsavel:"Felipe", prazoLimite:"" },
    { id:2, titulo:"Atualizar blog — Oncotype DX", descricao:"Publicar artigo novo", prioridade:"media", concluida:false, responsavel:"Janine", prazoLimite:"" },
    { id:3, titulo:"Enviar proposta cliente novo", descricao:"", prioridade:"baixa", concluida:false, responsavel:"Felipe", prazoLimite:"" },
  ]);
  const [feriados, setFeriados]         = useStorage("mcs.feriados", FERIADOS_2026);
  const [feriadosNomes, setFeriadosNomes] = useStorage("mcs.feriadosNomes", FERIADOS_NOMES);
  const [clientes, setClientes]         = useStorage("mcs.clientes", [
    { id:1, nome:"Unimed POARS",   tipo:"PJ", obs:"Cooperativa de saúde" },
    { id:2, nome:"IPE Saúde",      tipo:"PJ", obs:"Autarquia estadual" },
    { id:3, nome:"Bradesco Saúde", tipo:"PJ", obs:"" },
  ]);
  const [ultimoBackup, setUltimoBackup] = useStorage("mcs.ultimoBackup", null);

  // Estados UI
  const [filtro, setFiltro]             = useState("todos");
  const [busca, setBusca]               = useState("");
  const [buscaPrazos, setBuscaPrazos]   = useState(""); // navegação cruzada DJEN→Prazos
  const [processoAlvoDjen, setProcessoAlvoDjen] = useState(""); // navegação cruzada Prazos→DJEN
  const [ordenacao, setOrdenacao]       = useState("data_asc");
  const [filtroPrioridade, setFiltroPrioridade] = useState("todas");
  const [filtroResp, setFiltroResp]     = useState("todos");
  const [filtroTarefa, setFiltroTarefa] = useState("todas");
  const [aba, setAba]                   = useState("lista");
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const [menuMobile, setMenuMobile]     = useState(false);

  // Modais
  const [modal, setModal]               = useState(null);
  const [form, setForm]                 = useState({});
  const [confirmDel, setConfirmDel]     = useState(null);
  const [resumoAberto, setResumoAberto] = useState(false);
  const [gerirTipos, setGerirTipos]     = useState(false);
  const [novoTipoInput, setNovoTipoInput] = useState("");
  const [emailDest, setEmailDest]       = useStorage("mcs.email", "contato@martinscorreadasilva.com.br");
  const [cmdModal, setCmdModal]         = useState(false);
  const [cmdTexto, setCmdTexto]         = useState("");
  const [cmdParsed, setCmdParsed]       = useState(null);
  const [tarefaModal, setTarefaModal]   = useState(false);
  const [tarefaForm, setTarefaForm]     = useState({});
  const [tarefaEditId, setTarefaEditId] = useState(null);
  const [exportModal, setExportModal]   = useState(null);
  const [feriadoModal, setFeriadoModal] = useState(false);
  const [clienteModal, setClienteModal] = useState(false);
  const [clienteForm, setClienteForm]   = useState({ nome:"", tipo:"PJ", obs:"" });
  const [clienteEditId, setClienteEditId] = useState(null);
  const [backupModal, setBackupModal]   = useState(false);
  const fileInputRef = useRef(null);
  const [novoFeriado, setNovoFeriado]   = useState({ data:"", nome:"" });

  // Toasts
  const [toasts, setToasts] = useState([]);
  const toast = (msg, type="info") => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 2500);
  };
  _onSyncError = toast;

  const shown = useRef(false);
  useEffect(() => { if (!shown.current) { shown.current = true; setResumoAberto(true); } }, []);
  useEffect(() => { setFeriadosGlobal(feriados); }, [feriados]);

  const hoje = isoLocal();
  const todosOsTipos = [...TIPOS_DEFAULT, ...tiposCustom].sort((a,b) => a.localeCompare(b,"pt"));
  const prazosComStatus = useMemo(() => prazos.map(p => ({ ...p, status: calcStatus(p.dataLimite, p.concluido) })), [prazos]);

  const resumoData = useMemo(() => {
    const ativos = prazosComStatus.filter(p => !p.concluido);
    const srt = arr => [...arr].sort((a,b) => new Date(a.dataLimite)-new Date(b.dataLimite));
    return {
      vencidos: srt(ativos.filter(p => p.status==="vencido")),
      urgentes: srt(ativos.filter(p => p.status==="urgente")),
      proximos: srt(ativos.filter(p => p.status==="proximo")),
    };
  }, [prazosComStatus]);

  const lista = useMemo(() => {
    const prOrd = { alta:0, media:1, baixa:2 };
    const stOrd = { vencido:0, urgente:1, proximo:2, normal:3, concluido:4 };
    return prazosComStatus
      .filter(p => {
        if (filtro !== "todos" && p.status !== filtro) return false;
        if (filtroPrioridade !== "todas" && (p.prioridade||"media") !== filtroPrioridade) return false;
        if (filtroResp !== "todos" && p.responsavel !== filtroResp) return false;
        if (busca) { const b = busca.toLowerCase(); return p.processo.includes(b) || p.parte.toLowerCase().includes(b) || p.tipo.toLowerCase().includes(b); }
        return true;
      })
      .sort((a,b) => {
        switch (ordenacao) {
          case "data_asc":   return new Date(a.dataLimite)-new Date(b.dataLimite);
          case "data_desc":  return new Date(b.dataLimite)-new Date(a.dataLimite);
          case "prioridade": return (prOrd[a.prioridade||"media"]-prOrd[b.prioridade||"media"]) || new Date(a.dataLimite)-new Date(b.dataLimite);
          case "status":     return (stOrd[a.status]-stOrd[b.status]) || new Date(a.dataLimite)-new Date(b.dataLimite);
          case "parte_asc":  return a.parte.localeCompare(b.parte,"pt");
          default:           return 0;
        }
      });
  }, [prazosComStatus, filtro, filtroPrioridade, filtroResp, busca, ordenacao]);

  const contadores = useMemo(() => {
    const c = { vencido:0, urgente:0, proximo:0, normal:0, concluido:0, todos:prazos.length };
    prazos.forEach(p => { c[calcStatus(p.dataLimite, p.concluido)]++; });
    return c;
  }, [prazos]);

  const openNovo = (dataLimite="") => {
    setForm({ processo:"", parte:"", tipo:"Acompanhar", dataLimite, responsavel:"Felipe", obs:"", concluido:false, prioridade:"media", modoData:"final" });
    setModal("novo");
  };
  const openEdit = p => { setForm({...p}); setModal(p.id); };
  const salvar = () => {
    if (!form.processo || !form.dataLimite) return;
    if (modal === "novo") {
      setPrazos(prev => [...prev, {...form, id:Date.now()}]);
      if (form.djenId && _sb) { _sb.from("publicacoes_djen").update({ status: "PROMOVIDO" }).eq("id", form.djenId).then(() => {}); }
      toast("Prazo criado","success");
    }
    else { setPrazos(prev => prev.map(p => p.id === modal ? {...form, id:modal} : p)); toast("Prazo atualizado","success"); }
    setModal(null);
  };

  const toggleConcluidoComRecorrencia = id => {
    const p = prazos.find(x => x.id === id);
    if (!p) return;
    if (!p.concluido && p.recorrencia && p.recorrencia !== "none") {
      const novaData = proximaDataRecorrencia(p.dataLimite, p.recorrencia);
      if (novaData) {
        setPrazos(prev => [
          ...prev.map(x => x.id === id ? {...x, concluido:true} : x),
          {...p, id:Date.now(), concluido:false, dataLimite:novaData, obs:(p.obs||"") + " [recorrência]"}
        ]);
        toast("Concluído + próximo prazo criado","success");
        return;
      }
    }
    setPrazos(prev => prev.map(x => x.id === id ? {...x, concluido:!x.concluido} : x));
    toast(p.concluido ? "Prazo reaberto" : "Prazo concluído","success");
  };
  const deletar = id => { setPrazos(prev => prev.filter(p => p.id !== id)); setConfirmDel(null); toast("Prazo excluído","danger"); };
  const toggleConcluido = id => {
    setPrazos(prev => prev.map(p => p.id === id ? {...p, concluido:!p.concluido} : p));
    const p = prazos.find(x => x.id === id);
    toast(p.concluido ? "Prazo reaberto" : "Prazo concluído","success");
  };
  const toggleOrcamento = id => {
    const p = prazos.find(x => x.id === id);
    setPrazos(prev => prev.map(x => x.id === id ? {...x, orcamentoEnviado: !x.orcamentoEnviado} : x));
    toast(p && p.orcamentoEnviado ? "Marca de orçamento removida" : "Orçamento marcado como enviado","success");
  };
  const setDataEntrada = (id, valor) => {
    setPrazos(prev => prev.map(x => x.id === id ? {...x, dataEntrada: valor || null} : x));
  };

  const gerarDadosExport = (l) => {
    const hojeStr = new Date().toLocaleDateString("pt-BR");
    return {
      hoje: hojeStr,
      rows: l.map(p => {
        const pr = PRIO_CFG[p.prioridade||"media"].light;
        const st = STATUS_CFG[p.status].light;
        const du = diasUteisRestantes(p.dataLimite);
        return { parte:p.parte, tipo:p.tipo, processo:p.processo, data:fmt(p.dataLimite), duLabel:diasLabel(du,p.concluido),
          stLabel:STATUS_CFG[p.status].label, stColor:st.c, stPill:st.pill, stText:st.text,
          prLabel:PRIO_CFG[p.prioridade||"media"].label, prColor:pr.c, prBg:pr.bg, prPill:pr.pill,
          responsavel:p.responsavel, obs:p.obs||"" };
      })
    };
  };

  const gerarEmail = () => {
    const linhas = [`RESUMO DE PRAZOS — ${fmtLong(hoje).toUpperCase()}`, "Martins, Corrêa da Silva Advogados", "─".repeat(50)];
    [{titulo:"VENCIDOS", items:resumoData.vencidos}, {titulo:"URGENTES", items:resumoData.urgentes}, {titulo:"PRÓXIMOS", items:resumoData.proximos}]
      .forEach(({titulo, items}) => {
        if (!items.length) return;
        linhas.push("", titulo);
        items.forEach(p => {
          const du = diasUteisRestantes(p.dataLimite);
          linhas.push(`• ${p.parte} | ${p.tipo} | ${fmt(p.dataLimite)} (${diasLabel(du,p.concluido)}) | ${p.responsavel}`);
          linhas.push(`  Proc: ${p.processo}${p.obs?" | "+p.obs:""}`);
        });
      });
    window.location.href = `mailto:${emailDest}?subject=${encodeURIComponent("[Prazos] Resumo "+fmtLong(hoje))}&body=${encodeURIComponent(linhas.join("\n"))}`;
  };

  const totalAtencao = resumoData.vencidos.length + resumoData.urgentes.length + resumoData.proximos.length;
  const hasOverlay = resumoAberto || gerirTipos || modal !== null || !!confirmDel || cmdModal || tarefaModal || !!exportModal || feriadoModal || menuMobile || clienteModal || backupModal;

  // Estilos reutilizáveis (memo do tema)
  const INP = { background:T.card, border:`1.5px solid ${T.border}`, borderRadius:10, padding:"10px 14px", color:T.text, fontSize:14, fontFamily:"Inter,system-ui,sans-serif", outline:"none", width:"100%", boxSizing:"border-box" };
  const LBL = { fontSize:11, color:T.textMuted, letterSpacing:1.2, textTransform:"uppercase", fontWeight:600, marginBottom:5, display:"block" };
  const BTN_GHOST = { background:T.cardAlt, border:`1px solid ${T.border}`, borderRadius:10, padding:"8px 14px", color:T.textSoft, cursor:"pointer", fontSize:13, fontWeight:500 };
  const BTN_PRIMARY = { background:T.primary, border:"none", borderRadius:10, padding:"10px 18px", color:"#fff", fontWeight:600, cursor:"pointer", fontSize:14, display:"inline-flex", alignItems:"center", gap:6 };

  const adicionarTipo = () => {
    const t = novoTipoInput.trim();
    if (!t || todosOsTipos.includes(t)) return;
    setTiposCustom(prev => [...prev, t]);
    setNovoTipoInput("");
    toast("Tipo adicionado","success");
  };

  const processarComando = () => {
    if (!cmdTexto.trim()) return;
    setCmdParsed({ ...parsearComando(cmdTexto) });
  };
  const confirmarComando = () => {
    if (!cmdParsed) return;
    setForm({ ...cmdParsed, modoData:"final" });
    setModal("novo"); setCmdModal(false); setCmdTexto(""); setCmdParsed(null);
  };

  return (
    _carregandoAuth ? <div style={{minHeight:"100vh",background:TEMA[modo].bg,display:"flex",alignItems:"center",justifyContent:"center",color:TEMA[modo].textMuted,fontFamily:"Inter,system-ui,sans-serif"}}>Carregando...</div> : _precisaLogin ? <TelaLogin T={T} modo={modo} onToast={()=>{}} /> : <div style={{ fontFamily:"Inter,system-ui,-apple-system,sans-serif", minHeight:"100vh", background:T.bg, color:T.text, paddingBottom:80 }}>
      <style>{`
        @keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes pulse { 0%,100%{ transform:scale(1); } 50%{ transform:scale(1.05); } }
        * { box-sizing: border-box; }
        button:active { transform: scale(0.97); }
        button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid #3182ce; outline-offset: 2px; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: #cbd5e0; border-radius: 4px; }
        input, select, textarea { font-family: inherit; }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: ${modo==="dark"?"invert(1)":"none"}; }
      `}</style>

      {/* ── HEADER COMPACTO ── */}
      <header style={{
        background: modo==="dark" ? "linear-gradient(135deg,#1a202c,#2d3748)" : "linear-gradient(135deg,#1a365d,#2b6cb0)",
        padding:"calc(14px + env(safe-area-inset-top, 0px)) calc(16px + env(safe-area-inset-right, 0px)) 14px calc(16px + env(safe-area-inset-left, 0px))", position:"sticky", top:0, zIndex:50,
        boxShadow:"0 2px 8px #00000022",
      }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, minWidth:0 }}>
            <img src="/icon-512.png" alt="MCS" style={{ width:32, height:32, borderRadius:"50%", objectFit:"cover", flexShrink:0 }} />
            <div style={{ minWidth:0 }}>
              <h1 style={{ fontSize:16, fontWeight:700, margin:0, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>Controle de Prazos</h1>
              <div style={{ fontSize:10, color:"#bee3f8cc", marginTop:1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}><img src="/logo-mcs.png" alt="Martins, Corrêa da Silva Advogados" style={{ height:28, display:"block", marginTop:0, filter:"brightness(0) invert(1)", opacity:0.9 }} /></div>
            </div>
          </div>
          <div style={{ display:"flex", gap:6, alignItems:"center" }}>
            <button onClick={() => setModo(modo==="light"?"dark":"light")}
              style={{ background:"rgba(255,255,255,0.15)", border:"none", borderRadius:8, padding:8, color:"#fff", cursor:"pointer", display:"flex" }}
              title="Alternar tema" aria-label={modo==="light"?"Ativar tema escuro":"Ativar tema claro"}>
              <Icon name={modo==="light"?"moon":"sun"} size={18} color="#fff" />
            </button>
            <button onClick={() => setResumoAberto(true)} aria-label={`Abrir resumo do dia${totalAtencao>0?": "+totalAtencao+" prazos de atenção":""}`} style={{
              background: totalAtencao>0 ? "#fff" : "rgba(255,255,255,0.15)",
              border:"none", borderRadius:8, padding:8, cursor:"pointer", display:"flex", alignItems:"center", gap:4,
              color: totalAtencao>0 ? T.primary : "#fff", position:"relative",
            }}>
              <Icon name="bell" size={18} color={totalAtencao>0?T.primary:"#fff"} />
              {totalAtencao>0 && (
                <span style={{ position:"absolute", top:-3, right:-3, background:T.danger, color:"#fff", borderRadius:10, padding:"0 5px", fontSize:10, fontWeight:700, minWidth:16, textAlign:"center" }}>{totalAtencao}</span>
              )}
            </button>
            <button onClick={() => setMenuMobile(true)} style={{ background:"rgba(255,255,255,0.15)", border:"none", borderRadius:8, padding:8, color:"#fff", cursor:"pointer", display:"flex", position:"relative" }} aria-label="Abrir menu">
              <Icon name="menu" size={18} color="#fff" />
              {(() => {
                if (!ultimoBackup) return <span style={{ position:"absolute", top:4, right:4, width:8, height:8, background:T.danger, borderRadius:"50%", border:"2px solid #fff" }} />;
                const dias = Math.floor((Date.now() - new Date(ultimoBackup).getTime()) / 86400000);
                if (dias >= 7) return <span style={{ position:"absolute", top:4, right:4, width:8, height:8, background:T.danger, borderRadius:"50%", border:"2px solid #fff" }} />;
                return null;
              })()}
            </button>
          </div>
        </div>
      </header>

      {/* ── ABAS ── */}
      <div style={{ background:T.card, borderBottom:`1px solid ${T.border}`, display:"flex", overflowX:"auto", position:"sticky", top:64, zIndex:40 }}>
        {[
          { key:"lista",      label:"Prazos",     ico:"list" },
          { key:"calendario", label:"Calendário", ico:"calendar" },
          { key:"tarefas",    label:"Tarefas",    ico:"check" },
          { key:"djen",       label:"DJEN",       ico:"flag" },
        ].map(({ key, label, ico }) => (
          <button key={key} onClick={() => setAba(key)}
            style={{
              background:"transparent", border:"none",
              borderBottom:`2px solid ${aba===key?T.primary:"transparent"}`,
              color: aba===key ? T.primary : T.textMuted,
              cursor:"pointer", padding:"12px 18px", fontSize:13,
              fontWeight: aba===key ? 700 : 500,
              display:"flex", alignItems:"center", gap:6, whiteSpace:"nowrap",
            }}>
            <Icon name={ico} size={15} color={aba===key?T.primary:T.textMuted} />
            {label}
          </button>
        ))}
      </div>

      {/* ══ ABA LISTA ══ */}
      {aba === "lista" && (
        <>
          {/* Cards compactos com scroll horizontal */}
          <div style={{ padding:"14px 16px 0", overflowX:"auto", display:"flex", gap:8, scrollbarWidth:"none" }}>
            {[
              { key:"todos",    label:"Total",    cor:T.primary },
              { key:"vencido",  label:"Vencidos", cor:STATUS_CFG.vencido[modo].c },
              { key:"urgente",  label:"Urgentes", cor:STATUS_CFG.urgente[modo].c },
              { key:"proximo",  label:"Semana",   cor:STATUS_CFG.proximo[modo].c },
              { key:"normal",   label:"No prazo", cor:STATUS_CFG.normal[modo].c },
              { key:"concluido",label:"Feitos",   cor:STATUS_CFG.concluido[modo].c },
            ].map(({ key, label, cor }) => (
              <button key={key} onClick={() => setFiltro(key)}
                style={{
                  background: filtro===key ? cor+"22" : T.card,
                  border: `1.5px solid ${filtro===key ? cor : T.border}`,
                  borderRadius:12, padding:"10px 14px", cursor:"pointer", textAlign:"left",
                  minWidth:88, flexShrink:0,
                }}>
                <div style={{ fontSize:10, color:T.textMuted, fontWeight:600, marginBottom:2, textTransform:"uppercase", letterSpacing:0.5 }}>{label}</div>
                <div style={{ fontSize:22, fontWeight:800, color:cor, lineHeight:1 }}>{contadores[key]}</div>
              </button>
            ))}
          </div>

          {/* Busca + botão filtros */}
          <div style={{ padding:"12px 16px", display:"flex", gap:8 }}>
            <div style={{ position:"relative", flex:1 }}>
              <div style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:T.textMuted, display:"flex" }}>
                <Icon name="search" size={16} color={T.textMuted} />
              </div>
              <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar..." style={{ ...INP, paddingLeft:38, fontSize:13 }} />
            </div>
            <button onClick={() => setFiltrosAbertos(o => !o)}
              style={{ ...BTN_GHOST, padding:"10px 12px", display:"flex", alignItems:"center", gap:5, background: (filtroPrioridade!=="todas"||filtroResp!=="todos") ? T.primarySoft : T.cardAlt }}>
              <Icon name="filter" size={15} color={T.textSoft} />
            </button>
          </div>

          {/* Filtros expansíveis */}
          {filtrosAbertos && (
            <div style={{ padding:"0 16px 12px", display:"flex", gap:8, flexWrap:"wrap" }}>
              <select value={ordenacao} onChange={e => setOrdenacao(e.target.value)} style={{ ...INP, fontSize:12, padding:"8px 10px", flex:"1 1 140px", width:"auto" }}>
                {ORDENACAO_OPTS.map(o => <option key={o.value} value={o.value}>↕ {o.label}</option>)}
              </select>
              <select value={filtroPrioridade} onChange={e => setFiltroPrioridade(e.target.value)} style={{ ...INP, fontSize:12, padding:"8px 10px", flex:"1 1 120px", width:"auto" }}>
                <option value="todas">● Todas prioridades</option>
                <option value="alta">● Alta</option>
                <option value="media">● Média</option>
                <option value="baixa">● Baixa</option>
              </select>
              <select value={filtroResp} onChange={e => setFiltroResp(e.target.value)} style={{ ...INP, fontSize:12, padding:"8px 10px", flex:"1 1 120px", width:"auto" }}>
                <option value="todos">Todos resp.</option>
                <option>Felipe</option><option>Janine</option><option>Equipe</option>
              </select>
              <button onClick={() => setExportModal(gerarDadosExport(lista))}
                style={{ ...BTN_PRIMARY, padding:"8px 14px", fontSize:12 }}>
                <Icon name="printer" size={14} color="#fff" /> Exportar
              </button>
            </div>
          )}

          {/* Contagem + limpar */}
          {(filtro!=="todos" || filtroPrioridade!=="todas" || filtroResp!=="todos" || busca) && (
            <div style={{ padding:"0 16px 8px", fontSize:11, color:T.textMuted, display:"flex", alignItems:"center", gap:6 }}>
              {lista.length} resultado(s)
              <button onClick={() => { setFiltro("todos"); setFiltroPrioridade("todas"); setFiltroResp("todos"); setBusca(""); }}
                style={{ background:"none", border:"none", color:T.primary, cursor:"pointer", fontSize:11 }}>
                Limpar
              </button>
            </div>
          )}

          {/* Lista */}
          <div style={{ padding:"0 16px", display:"flex", flexDirection:"column", gap:8 }}>
            {lista.length===0 && <div style={{ textAlign:"center", padding:48, color:T.textMuted, fontSize:14 }}>Nenhum prazo encontrado.</div>}
            {lista.map(p => {
              const st = STATUS_CFG[p.status][modo];
              const du = diasUteisRestantes(p.dataLimite);
              const tribunal = tribunalDoCNJ(p.processo);
              // Extrair info DJEN da obs quando captado do monitor
              const isDjen = p.djenId || (p.obs && p.obs.includes("Captado do DJEN"));
              const djenInfoMatch = isDjen && p.obs ? p.obs.match(/Captado do DJEN[^—\n]*[—\-]\s*([\d-]+)/) : null;
              const djenGatilho = isDjen && p.obs ? (p.obs.match(/Gatilhos:\s*([^\n]+)/) || [])[1] : null;
              const djenMed = isDjen && p.obs ? (p.obs.match(/Medicamentos:\s*([^\n]+)/) || [])[1] : null;
              return (
                <div key={p.id} style={{
                  background:T.card, border:`1px solid ${T.border}`,
                  borderLeft:`4px solid ${st.c}`,
                  borderRadius:12, padding:"12px 14px", display:"flex", alignItems:"center", gap:10,
                  opacity:p.concluido?0.6:1,
                  boxShadow:"0 1px 3px #0000000a",
                }}>
                  <div onClick={() => toggleConcluidoComRecorrencia(p.id)}
                    style={{ width:22, height:22, borderRadius:6, border:`2px solid ${st.c}`, background:p.concluido?st.c:"transparent", cursor:"pointer", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                    {p.concluido && <Icon name="check" size={14} color="#fff" />}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
                      <span style={{ fontWeight:600, fontSize:14, color:T.text, textDecoration:p.concluido?"line-through":"none", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.parte}</span>
                    </div>
                    <div style={{ fontSize:11, color:T.textMuted, marginBottom:4 }}>{p.tipo} · {p.processo ? (
                      <span onClick={() => { setProcessoAlvoDjen(p.processo); setAba("djen"); }}
                        title="Ver no DJEN"
                        style={{ fontFamily:"monospace", color:T.primary, cursor:"pointer", textDecoration:"underline", textDecorationStyle:"dotted", textUnderlineOffset:2 }}>{p.processo}</span>
                    ) : <span style={{fontFamily:"monospace"}}>{p.processo}</span>}{tribunal && (
                      <span title={`Tribunal: ${tribunal}`}
                        style={{ marginLeft:6, fontSize:9.5, fontWeight:700, letterSpacing:0.3, color:T.primary, background:T.cardAlt, border:`1px solid ${T.border}`, padding:"1px 6px", borderRadius:4, verticalAlign:"middle", whiteSpace:"nowrap" }}>{tribunal}</span>
                    )}</div>
                    <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                      <StatusBadge status={p.status} modo={modo} />
                      <span style={{ fontSize:11, color:st.c, fontWeight:600 }}>{fmt(p.dataLimite)} · {diasLabel(du, p.concluido)}</span>
                      <span onClick={(e) => { e.stopPropagation(); toggleOrcamento(p.id); }}
                        title={p.orcamentoEnviado ? "Orçamento enviado — clique para desmarcar" : "Marcar orçamento como enviado"}
                        style={{
                          fontSize:10.5, fontWeight:700, cursor:"pointer", userSelect:"none",
                          padding:"2px 9px", borderRadius:999, display:"inline-flex", alignItems:"center", gap:4,
                          color: p.orcamentoEnviado ? "#fff" : "#2f855a",
                          background: p.orcamentoEnviado ? "#2f855a" : "transparent",
                          border: `1px solid ${p.orcamentoEnviado ? "#2f855a" : "#9ae6b4"}`,
                        }}>
                        {p.orcamentoEnviado ? "✓ Orçamento enviado" : "＋ Orçamento enviado?"}
                      </span>
                      <span style={{ display:"inline-flex", alignItems:"center", gap:3 }}>
                        <span style={{ position:"relative", display:"inline-flex" }}>
                        <input type="date" value={p.dataEntrada || ""}
                          onClick={(e) => { e.stopPropagation(); try { e.currentTarget.showPicker(); } catch(_){} }}
                          onChange={(e) => setDataEntrada(p.id, e.target.value)}
                          aria-label="Data de entrada no processo"
                          style={{ position:"absolute", inset:0, width:"100%", height:"100%", opacity:0, cursor:"pointer", border:"none", padding:0, margin:0 }} />
                        <span style={{
                          fontSize:10.5, fontWeight:700, userSelect:"none", pointerEvents:"none",
                          padding:"2px 9px", borderRadius:999, display:"inline-flex", alignItems:"center", gap:4,
                          color: p.dataEntrada ? "#fff" : T.primary,
                          background: p.dataEntrada ? T.primary : "transparent",
                          border: `1px solid ${T.primary}`,
                        }}>
                          {p.dataEntrada ? `📌 Entrei ${fmt(p.dataEntrada)}` : "📌 Data de entrada"}
                        </span>
                        </span>
                        {p.dataEntrada && (
                          <span onClick={(e) => { e.stopPropagation(); setDataEntrada(p.id, null); }}
                            title="Remover data de entrada" role="button" aria-label="Remover data de entrada"
                            style={{ cursor:"pointer", userSelect:"none", lineHeight:1, fontSize:13, fontWeight:700, color:T.textMuted, width:18, height:18, display:"inline-flex", alignItems:"center", justifyContent:"center", borderRadius:999 }}>×</span>
                        )}
                      </span>
                    </div>
                    {/* Info DJEN compacta */}
                    {isDjen && (djenGatilho || djenMed) && (
                      <div style={{ marginTop:5, display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                        <span style={{ fontSize:10, color:"#5c6b3a", background:"rgba(92,107,58,0.12)", padding:"1px 7px", borderRadius:3, fontWeight:600 }}>📡 DJEN</span>
                        {djenGatilho && <span style={{ fontSize:10, color:T.textMuted, fontFamily:"monospace" }}>{djenGatilho.replace(/G[0-9]_/g, "")}</span>}
                        {djenMed && <span style={{ fontSize:10, color:T.textMuted }}>{djenMed}</span>}
                      </div>
                    )}
                    {/* Toggle Monitorar no DJEN — aparece para qualquer prazo captado do DJEN */}
                    {isDjen && (
                      <div style={{ marginTop:5, display:"flex", alignItems:"center", gap:6 }}>
                        <label style={{ display:"flex", alignItems:"center", gap:5, cursor:"pointer" }}
                          onClick={e => e.stopPropagation()}>
                          <input type="checkbox"
                            checked={!!p.djenAcompanhar}
                            onChange={async (e) => {
                              const novoVal = e.target.checked;
                              setPrazos(prev => prev.map(x => x.id === p.id ? {...x, djenAcompanhar: novoVal} : x));
                              const sb = _sb;
                              if (sb && _userId) {
                                if (p.djenId) {
                                  // prazo novo: tem id direto
                                  await sb.from("publicacoes_djen").update({ acompanhar: novoVal }).eq("id", p.djenId);
                                } else if (p.processo) {
                                  // prazo antigo: busca pelo número do processo
                                  await sb.from("publicacoes_djen").update({ acompanhar: novoVal }).eq("user_id", _userId).eq("numero_processo", p.processo);
                                }
                              }
                              toast(novoVal ? "Monitoramento ativado" : "Monitoramento desativado", "success");
                            }}
                            style={{ accentColor:"#5c6b3a", cursor:"pointer", width:13, height:13 }} />
                          <span style={{ fontSize:10, color:"#5c6b3a", fontWeight:600 }}>Monitorar no DJEN</span>
                        </label>
                      </div>
                    )}
                    {p.obs && !isDjen && <div style={{ fontSize:11, color:T.textSoft, marginTop:4, fontStyle:"italic" }}>{p.obs}</div>}
                  </div>
                  <AcoesMenu prazo={p} onEdit={openEdit} onDelete={setConfirmDel} onToast={toast} T={T} />
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ══ ABA CALENDÁRIO ══ */}
      {aba === "calendario" && <Calendario prazos={prazosComStatus} onEdit={openEdit} onNovoData={openNovo} feriadosNomes={feriadosNomes} T={T} modo={modo} onToast={toast} />}

      {/* ══ ABA TAREFAS ══ */}
      {aba === "tarefas" && (() => {
        const contTar = {
          todas:      tarefas.length,
          alta:       tarefas.filter(t => (t.prioridade||"media") === "alta" && !t.concluida).length,
          media:      tarefas.filter(t => (t.prioridade||"media") === "media" && !t.concluida).length,
          baixa:      tarefas.filter(t => (t.prioridade||"media") === "baixa" && !t.concluida).length,
          concluidas: tarefas.filter(t => t.concluida).length,
        };
        const tarefasFiltradas = tarefas.filter(t => {
          if (filtroTarefa === "todas")      return true;
          if (filtroTarefa === "concluidas") return t.concluida;
          return (t.prioridade||"media") === filtroTarefa && !t.concluida;
        });
        return (
          <div style={{ padding:"16px 16px 80px" }}>
            <div style={{ marginBottom:14 }}>
              <h2 style={{ margin:0, fontSize:18, fontWeight:700, color:T.text, letterSpacing:"-0.01em" }}>Tarefas</h2>
              <div style={{ fontSize:11, color:T.textMuted, marginTop:3 }}>{tarefas.filter(t=>!t.concluida).length} pendente(s) · arraste para reordenar</div>
            </div>
            {/* Cards de contadores */}
            <div style={{ overflowX:"auto", display:"flex", gap:10, marginBottom:14, paddingBottom:4 }} className="hide-scrollbar">
              {[
                { key:"todas",      label:"Total",  cor:T.primary },
                { key:"alta",       label:"Alta",   cor:PRIO_CFG.alta[modo].c },
                { key:"media",      label:"Média",  cor:PRIO_CFG.media[modo].c },
                { key:"baixa",      label:"Baixa",  cor:PRIO_CFG.baixa[modo].c },
                { key:"concluidas", label:"Feitas", cor:STATUS_CFG.concluido[modo].c },
              ].map(({ key, label, cor }) => {
                const ativo = filtroTarefa === key;
                return (
                  <button key={key} onClick={() => setFiltroTarefa(key)}
                    style={{
                      background: ativo ? cor+"15" : T.card,
                      border: "1.5px solid " + (ativo ? cor : T.border),
                      borderRadius:14, padding:"12px 16px", cursor:"pointer", textAlign:"left",
                      minWidth:92, flexShrink:0,
                      boxShadow: ativo ? "0 4px 16px " + cor + "22" : T.shadowSm,
                      transition:"all 0.15s",
                      transform: ativo ? "translateY(-2px)" : "translateY(0)",
                    }}>
                    <div style={{ fontSize:10, color:T.textMuted, fontWeight:600, marginBottom:4, textTransform:"uppercase", letterSpacing:0.5 }}>{label}</div>
                    <div style={{ fontSize:24, fontWeight:800, color:cor, lineHeight:1, letterSpacing:"-0.02em" }}>{contTar[key]}</div>
                  </button>
                );
              })}
            </div>
            {filtroTarefa !== "todas" && (
              <div style={{ fontSize:11, color:T.textMuted, display:"flex", alignItems:"center", gap:6, marginBottom:8 }}>
                {tarefasFiltradas.length} resultado(s)
                <button onClick={() => setFiltroTarefa("todas")}
                  style={{ background:"none", border:"none", color:T.primary, cursor:"pointer", fontSize:11, fontWeight:600 }}>
                  Limpar
                </button>
              </div>
            )}
            <ListaTarefas tarefas={tarefasFiltradas} setTarefas={setTarefas} T={T} modo={modo}
              onEdit={t => { setTarefaForm({...t}); setTarefaEditId(t.id); setTarefaModal(true); }}
              onDelete={id => { setTarefas(prev => prev.filter(x => x.id !== id)); toast("Tarefa excluída","danger"); }}
              onToggle={id => { setTarefas(prev => prev.map(x => x.id===id?{...x,concluida:!x.concluida}:x)); toast("Tarefa atualizada","success"); }}
            />
          </div>
        );
      })()}

            {aba === "djen" && (
        <PainelDJEN T={T} modo={modo} setPrazos={setPrazos} prazos={prazos} setAba={setAba}
                    setForm={setForm} setModal={setModal} toast={toast}
                    processoAlvo={processoAlvoDjen} onProcessoAlvoConsumido={() => setProcessoAlvoDjen("")}
                    irParaPrazo={(numProcesso) => { setBuscaPrazos(numProcesso); setBusca(numProcesso); setAba("lista"); }} />
      )}

      <button onClick={() => aba==="tarefas" ? (setTarefaForm({titulo:"",descricao:"",prioridade:"media",responsavel:"Felipe",concluida:false,prazoLimite:""}), setTarefaEditId(null), setTarefaModal(true)) : openNovo()}
        aria-label={aba==="tarefas"?"Nova tarefa":"Novo prazo"}
        style={{
          position:"fixed", bottom:20, right:20, zIndex:45,
          width:56, height:56, borderRadius:"50%",
          background:T.primary, border:"none", cursor:"pointer",
          boxShadow:`0 8px 24px ${T.primary}66`,
          display:"flex", alignItems:"center", justifyContent:"center",
        }}>
        <Icon name="plus" size={28} color="#fff" />
      </button>

      {/* ── OVERLAY ── */}
      {hasOverlay && <div onClick={() => setMenuMobile(false)} style={{ position:"fixed", inset:0, background:T.overlay, backdropFilter:"blur(2px)", zIndex:100 }} />}

      {/* ── MENU LATERAL ── */}
      {menuMobile && (
        <div style={{ position:"fixed", top:0, right:0, bottom:0, width:"min(280px, 80vw)", background:T.card, zIndex:200, boxShadow:"-4px 0 20px #00000033", display:"flex", flexDirection:"column" }}>
          <div style={{ padding:"16px", borderBottom:`1px solid ${T.border}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <span style={{ fontSize:15, fontWeight:700, color:T.text }}>Menu</span>
            <button onClick={() => setMenuMobile(false)} style={{ background:"transparent", border:"none", padding:6, cursor:"pointer", color:T.text, display:"flex" }}>
              <Icon name="close" size={20} color={T.text} />
            </button>
          </div>
          <div style={{ padding:8 }}>
            {[
              { ico:"mic",      lbl:"Comando rápido",   fn:() => { setCmdTexto(""); setCmdParsed(null); setCmdModal(true); setMenuMobile(false); } },
              { ico:"tag",      lbl:"Tipos de prazo",   fn:() => { setGerirTipos(true); setMenuMobile(false); } },
              { ico:"user",     lbl:"Clientes",         fn:() => { setClienteModal(true); setMenuMobile(false); } },
              { ico:"flag",     lbl:"Feriados",         fn:() => { setFeriadoModal(true); setMenuMobile(false); } },
              { ico:"calendar", lbl:"Backup / Restore", fn:() => { setBackupModal(true); setMenuMobile(false); } },
              ...(authAtivo && user ? [{ ico:"close", lbl:"Sair (" + (user.email||"") + ")", fn:() => { fazerLogout(); setMenuMobile(false); } }] : []),
              { ico:"bell",     lbl:"Resumo do dia",    fn:() => { setResumoAberto(true); setMenuMobile(false); } },
              { ico:"printer",  lbl:"Exportar lista",   fn:() => { setExportModal(gerarDadosExport(lista)); setMenuMobile(false); } },
            ].map(({ ico, lbl, fn }) => (
              <button key={lbl} onClick={fn} style={{
                width:"100%", background:"transparent", border:"none",
                padding:"12px 14px", cursor:"pointer", textAlign:"left",
                display:"flex", alignItems:"center", gap:12, fontSize:14, color:T.text,
                borderRadius:10,
              }}>
                <Icon name={ico} size={18} color={T.textSoft} />{lbl}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ══ MODAL RESUMO ══ */}
      {resumoAberto && (
        <div style={{ position:"fixed", inset:0, display:"flex", alignItems:"center", justifyContent:"center", zIndex:200, padding:16, pointerEvents:"none" }}>
          <div style={{ background:T.card, borderRadius:16, width:"100%", maxWidth:540, maxHeight:"86vh", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px #00000033", pointerEvents:"all", border:`1px solid ${T.border}` }}>
            <div style={{ padding:"16px 18px", borderBottom:`1px solid ${T.border}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <div style={{ fontSize:10, color:T.textMuted, textTransform:"uppercase", letterSpacing:1, marginBottom:2 }}>{fmtLong(hoje)}</div>
                <h2 style={{ margin:0, fontSize:17, color:T.primary, fontWeight:700 }}>Resumo do dia</h2>
              </div>
              <button onClick={() => setResumoAberto(false)} style={{ background:"transparent", border:"none", padding:6, cursor:"pointer", color:T.textSoft, display:"flex" }}>
                <Icon name="close" size={20} color={T.textSoft} />
              </button>
            </div>
            <div style={{ padding:"16px 18px", overflowY:"auto", flex:1 }}>
              {totalAtencao===0
                ? <div style={{ textAlign:"center", padding:"24px 0", color:T.textMuted }}>
                    <Icon name="check" size={36} color={T.success} />
                    <div style={{ fontSize:14, fontWeight:600, color:T.success, marginTop:8 }}>Tudo em dia!</div>
                  </div>
                : [
                    { titulo:"Vencidos", color:STATUS_CFG.vencido[modo].c, items:resumoData.vencidos },
                    { titulo:"Urgentes (até 2 du)", color:STATUS_CFG.urgente[modo].c, items:resumoData.urgentes },
                    { titulo:"Próximos (até 5 du)", color:STATUS_CFG.proximo[modo].c, items:resumoData.proximos },
                  ].map(({titulo, color, items}) => items.length > 0 && (
                    <div key={titulo} style={{ marginBottom:14 }}>
                      <div style={{ fontSize:11, color, fontWeight:700, letterSpacing:1, textTransform:"uppercase", marginBottom:8 }}>{titulo} · {items.length}</div>
                      {items.map(p => {
                        const du = diasUteisRestantes(p.dataLimite);
                        return (
                          <div key={p.id} style={{ background:T.cardAlt, border:`1px solid ${T.border}`, borderLeft:`3px solid ${color}`, borderRadius:8, padding:"10px 12px", marginBottom:6 }}>
                            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
                              <div style={{ minWidth:0, flex:1 }}>
                                <div style={{ fontSize:13, fontWeight:600, color:T.text, marginBottom:2 }}>{p.parte}</div>
                                <div style={{ fontSize:11, color:T.textSoft }}>{p.tipo} · {p.responsavel}</div>
                                {p.obs && <div style={{ fontSize:11, color:T.textMuted, fontStyle:"italic", marginTop:3 }}>{p.obs}</div>}
                              </div>
                              <div style={{ textAlign:"right", flexShrink:0 }}>
                                <div style={{ fontSize:13, fontWeight:700, color }}>{fmt(p.dataLimite)}</div>
                                <div style={{ fontSize:10, color:T.textMuted, marginTop:1 }}>{diasLabel(du, p.concluido)}</div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))
              }
              <div style={{ borderTop:`1px solid ${T.border}`, paddingTop:12, marginTop:8 }}>
                <div style={{ ...LBL, marginBottom:6 }}>Enviar por e-mail</div>
                <div style={{ display:"flex", gap:6 }}>
                  <input value={emailDest} onChange={e => setEmailDest(e.target.value)} style={{ ...INP, flex:1, fontSize:12 }} />
                  <button onClick={gerarEmail} style={{ ...BTN_PRIMARY, padding:"9px 14px", fontSize:12 }}>
                    <Icon name="mail" size={14} color="#fff" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══ MODAL COMANDO ══ */}
      {cmdModal && (
        <div style={{ position:"fixed", inset:0, display:"flex", alignItems:"center", justifyContent:"center", zIndex:200, padding:16, pointerEvents:"none" }}>
          <div style={{ background:T.card, borderRadius:16, padding:"20px", width:"100%", maxWidth:500, boxShadow:"0 20px 60px #00000033", pointerEvents:"all", border:`1px solid ${T.border}`, maxHeight:"86vh", overflowY:"auto" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <Icon name="mic" size={20} color={T.primary} />
                <h2 style={{ margin:0, fontSize:16, color:T.text, fontWeight:700 }}>Comando Rápido</h2>
              </div>
              <button onClick={() => { setCmdModal(false); setCmdParsed(null); setCmdTexto(""); }} style={{ background:"transparent", border:"none", padding:6, cursor:"pointer", color:T.textSoft, display:"flex" }}>
                <Icon name="close" size={18} color={T.textSoft} />
              </button>
            </div>
            <p style={{ fontSize:12, color:T.textMuted, margin:"0 0 10px" }}>Toque em um exemplo para experimentar:</p>
            <div style={{ display:"flex", flexDirection:"column", gap:5, marginBottom:12 }}>
              {[
                "Contestação contra Unimed, 20 de junho, Felipe, alta",
                "Agravo IPE Saúde, daqui 15 dias úteis, Janine",
                "Tutela Bradesco, 15 julho, obs liminar em risco",
              ].map(ex => (
                <div key={ex} onClick={() => { setCmdTexto(ex); setCmdParsed({ ...parsearComando(ex) }); }}
                  style={{ background:T.cardAlt, border:`1px solid ${T.border}`, borderRadius:8, padding:"7px 10px", fontSize:12, color:T.textSoft, cursor:"pointer", fontStyle:"italic" }}>
                  "{ex}"
                </div>
              ))}
            </div>
            <div style={{ display:"flex", gap:6, marginBottom:12 }}>
              <input autoFocus value={cmdTexto}
                onChange={e => { setCmdTexto(e.target.value); setCmdParsed(null); }}
                onKeyDown={e => e.key === "Enter" && processarComando()}
                placeholder="Descreva o prazo..." style={{ ...INP, flex:1 }} />
              <button onClick={processarComando} style={{ ...BTN_PRIMARY, padding:"10px 14px" }}>→</button>
            </div>
            {cmdParsed && (
              <div style={{ background:T.successSoft, border:`1px solid ${T.success}33`, borderRadius:10, padding:"12px", marginBottom:12 }}>
                <div style={{ fontSize:10, color:T.success, fontWeight:700, letterSpacing:1, textTransform:"uppercase", marginBottom:8 }}>Interpretado</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
                  {[
                    { label:"Parte",       val:cmdParsed.parte || "—",       warn:!cmdParsed.parte },
                    { label:"Tipo",        val:cmdParsed.tipo },
                    { label:"Vencimento",  val:cmdParsed.dataLimite?fmt(cmdParsed.dataLimite):"—", warn:!cmdParsed.dataLimite },
                    { label:"Resp.",       val:cmdParsed.responsavel },
                    { label:"Prioridade",  val:PRIO_CFG[cmdParsed.prioridade].label },
                    { label:"Obs",         val:cmdParsed.obs || "—" },
                  ].map(({ label, val, warn }) => (
                    <div key={label} style={{ background:T.card, borderRadius:6, padding:"6px 9px" }}>
                      <div style={{ fontSize:9, color:T.textMuted, fontWeight:700, textTransform:"uppercase", letterSpacing:0.5 }}>{label}</div>
                      <div style={{ fontSize:12, color:warn?T.danger:T.text, fontWeight:500 }}>{val}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
              <button onClick={() => { setCmdModal(false); setCmdParsed(null); setCmdTexto(""); }} style={BTN_GHOST}>Cancelar</button>
              <button onClick={confirmarComando} disabled={!cmdParsed} style={{ ...BTN_PRIMARY, opacity:cmdParsed?1:0.4 }}>
                <Icon name="check" size={14} color="#fff" /> Abrir formulário
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ MODAL TIPOS ══ */}
      {gerirTipos && (
        <div style={{ position:"fixed", inset:0, display:"flex", alignItems:"center", justifyContent:"center", zIndex:200, padding:16, pointerEvents:"none" }}>
          <div style={{ background:T.card, borderRadius:16, width:"100%", maxWidth:440, maxHeight:"86vh", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px #00000033", pointerEvents:"all", border:`1px solid ${T.border}` }}>
            <div style={{ padding:"16px 18px", borderBottom:`1px solid ${T.border}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <h2 style={{ margin:0, fontSize:16, color:T.text, fontWeight:700 }}>Tipos de prazo</h2>
              <button onClick={() => setGerirTipos(false)} style={{ background:"transparent", border:"none", padding:6, cursor:"pointer", color:T.textSoft, display:"flex" }}>
                <Icon name="close" size={18} color={T.textSoft} />
              </button>
            </div>
            <div style={{ padding:"16px 18px", overflowY:"auto", flex:1 }}>
              <label style={LBL}>Novo tipo</label>
              <div style={{ display:"flex", gap:6, marginBottom:14 }}>
                <input value={novoTipoInput} onChange={e => setNovoTipoInput(e.target.value)} onKeyDown={e => e.key==="Enter"&&adicionarTipo()} placeholder="Ex: Impugnação..." style={{ ...INP, flex:1 }} />
                <button onClick={adicionarTipo} style={{ ...BTN_PRIMARY, padding:"10px 14px" }}>
                  <Icon name="plus" size={16} color="#fff" />
                </button>
              </div>
              {tiposCustom.length > 0 && (
                <div style={{ marginBottom:14 }}>
                  <div style={{ ...LBL, color:T.primary }}>Personalizados</div>
                  {tiposCustom.map(t => (
                    <div key={t} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", background:T.primarySoft, borderRadius:8, padding:"8px 12px", marginBottom:4 }}>
                      <span style={{ fontSize:13, color:T.primary, fontWeight:500 }}>{t}</span>
                      <button onClick={() => { setTiposCustom(prev => prev.filter(x => x !== t)); toast("Tipo removido","danger"); }} style={{ background:"transparent", border:"none", padding:4, cursor:"pointer", color:T.danger, display:"flex" }}>
                        <Icon name="close" size={14} color={T.danger} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div style={LBL}>Padrão</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
                {TIPOS_DEFAULT.map(t => <span key={t} style={{ background:T.cardAlt, borderRadius:16, padding:"4px 10px", fontSize:11, color:T.textSoft }}>{t}</span>)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══ MODAL FERIADOS ══ */}
      {feriadoModal && (
        <div style={{ position:"fixed", inset:0, display:"flex", alignItems:"center", justifyContent:"center", zIndex:200, padding:16, pointerEvents:"none" }}>
          <div style={{ background:T.card, borderRadius:16, width:"100%", maxWidth:440, maxHeight:"86vh", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px #00000033", pointerEvents:"all", border:`1px solid ${T.border}` }}>
            <div style={{ padding:"16px 18px", borderBottom:`1px solid ${T.border}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <h2 style={{ margin:0, fontSize:16, color:T.text, fontWeight:700 }}>Feriados</h2>
                <div style={{ fontSize:11, color:T.textMuted, marginTop:2 }}>Excluídos da contagem</div>
              </div>
              <button onClick={() => setFeriadoModal(false)} style={{ background:"transparent", border:"none", padding:6, cursor:"pointer", color:T.textSoft, display:"flex" }}>
                <Icon name="close" size={18} color={T.textSoft} />
              </button>
            </div>
            <div style={{ padding:"16px 18px", overflowY:"auto", flex:1 }}>
              <div style={{ display:"flex", gap:6, marginBottom:8 }}>
                <input type="date" value={novoFeriado.data} onChange={e => setNovoFeriado(f => ({...f, data:e.target.value}))} style={{ ...INP, flex:"0 0 145px", fontSize:13 }} />
                <input value={novoFeriado.nome} onChange={e => setNovoFeriado(f => ({...f, nome:e.target.value}))} placeholder="Nome" style={{ ...INP, flex:1 }} />
              </div>
              <button onClick={() => {
                if (!novoFeriado.data) return;
                if (!feriados.includes(novoFeriado.data)) {
                  setFeriados(prev => [...prev, novoFeriado.data].sort());
                  setFeriadosNomes(prev => ({...prev, [novoFeriado.data]: novoFeriado.nome||novoFeriado.data}));
                  toast("Feriado adicionado","success");
                }
                setNovoFeriado({ data:"", nome:"" });
              }} style={{ ...BTN_PRIMARY, padding:"9px 14px", width:"100%", justifyContent:"center", marginBottom:14 }}>
                <Icon name="plus" size={14} color="#fff" /> Adicionar
              </button>
              <div style={{ ...LBL, marginBottom:8 }}>{feriados.length} cadastrados</div>
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                {feriados.map(d => (
                  <div key={d} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", background:T.warnSoft+"55", border:`1px solid ${T.warn}33`, borderRadius:8, padding:"8px 12px" }}>
                    <div>
                      <div style={{ fontSize:13, fontWeight:600, color:T.text }}>{fmt(d)}</div>
                      <div style={{ fontSize:11, color:T.textSoft }}>{feriadosNomes[d] || "—"}</div>
                    </div>
                    <button onClick={() => {
                      setFeriados(prev => prev.filter(x => x !== d));
                      setFeriadosNomes(prev => { const n = {...prev}; delete n[d]; return n; });
                      toast("Feriado removido","danger");
                    }} style={{ background:"transparent", border:"none", padding:4, cursor:"pointer", color:T.danger, display:"flex" }}>
                      <Icon name="close" size={14} color={T.danger} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══ MODAL EXPORTAR ══ */}
      {exportModal && (
        <div style={{ position:"fixed", inset:0, display:"flex", alignItems:"center", justifyContent:"center", zIndex:200, padding:12, pointerEvents:"none" }}>
          <div style={{ background:T.card, borderRadius:16, width:"100%", maxWidth:760, maxHeight:"92vh", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px #00000033", pointerEvents:"all", border:`1px solid ${T.border}` }}>
            <div style={{ padding:"14px 18px", borderBottom:`1px solid ${T.border}`, display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:6 }}>
              <div>
                <div style={{ fontSize:16, fontWeight:700, color:T.primary }}>Relatório</div>
                <div style={{ fontSize:11, color:T.textMuted, marginTop:1 }}>{exportModal.hoje} · {exportModal.rows.length} prazo(s)</div>
              </div>
              <div style={{ display:"flex", gap:6 }}>
                <button onClick={() => window.print()} style={{ ...BTN_PRIMARY, padding:"8px 14px", fontSize:13 }}>
                  <Icon name="printer" size={14} color="#fff" /> Imprimir / PDF
                </button>
                <button onClick={() => setExportModal(null)} style={{ ...BTN_GHOST, padding:"8px 10px" }}>
                  <Icon name="close" size={16} color={T.textSoft} />
                </button>
              </div>
            </div>
            <div style={{ overflowY:"auto", overflowX:"auto", flex:1, padding:"14px 18px" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                <thead>
                  <tr style={{ background:T.primary }}>
                    {["Parte","Tipo","Processo","Venc.","Dias","Status","Prior.","Resp.","Obs"].map(h => (
                      <th key={h} style={{ padding:"8px 10px", textAlign:"left", color:"#fff", fontSize:10, letterSpacing:0.5, textTransform:"uppercase", whiteSpace:"nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {exportModal.rows.map((r, i) => (
                    <tr key={i} style={{ background: i%2===0?T.card:T.cardAlt }}>
                      <td style={{ padding:"7px 10px", fontWeight:600, color:T.text, borderBottom:`1px solid ${T.border}` }}>{r.parte}</td>
                      <td style={{ padding:"7px 10px", color:T.textSoft, borderBottom:`1px solid ${T.border}`, whiteSpace:"nowrap" }}>{r.tipo}</td>
                      <td style={{ padding:"7px 10px", fontFamily:"monospace", fontSize:10, color:T.textMuted, borderBottom:`1px solid ${T.border}` }}>{r.processo}</td>
                      <td style={{ padding:"7px 10px", fontWeight:600, color:r.stColor, borderBottom:`1px solid ${T.border}`, whiteSpace:"nowrap" }}>{r.data}</td>
                      <td style={{ padding:"7px 10px", color:T.textSoft, borderBottom:`1px solid ${T.border}`, whiteSpace:"nowrap" }}>{r.duLabel}</td>
                      <td style={{ padding:"7px 10px", borderBottom:`1px solid ${T.border}` }}><span style={{ background:r.stPill, color:r.stText, borderRadius:12, padding:"2px 8px", fontSize:10, fontWeight:700 }}>{r.stLabel}</span></td>
                      <td style={{ padding:"7px 10px", borderBottom:`1px solid ${T.border}` }}><span style={{ background:r.prBg, color:r.prColor, borderRadius:12, padding:"2px 8px", fontSize:10, fontWeight:700 }}>{r.prLabel}</span></td>
                      <td style={{ padding:"7px 10px", color:T.textSoft, borderBottom:`1px solid ${T.border}` }}>{r.responsavel}</td>
                      <td style={{ padding:"7px 10px", color:T.textMuted, fontSize:10, borderBottom:`1px solid ${T.border}` }}>{r.obs||"—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══ MODAL CLIENTES ══ */}
      {clienteModal && (
        <div style={{ position:"fixed", inset:0, display:"flex", alignItems:"center", justifyContent:"center", zIndex:200, padding:16, pointerEvents:"none" }}>
          <div style={{ background:T.card, borderRadius:16, width:"100%", maxWidth:480, maxHeight:"86vh", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px #00000033", pointerEvents:"all", border:`1px solid ${T.border}` }}>
            <div style={{ padding:"16px 18px", borderBottom:`1px solid ${T.border}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <h2 style={{ margin:0, fontSize:16, color:T.text, fontWeight:700 }}>Clientes</h2>
                <div style={{ fontSize:11, color:T.textMuted, marginTop:2 }}>{clientes.length} cadastrado(s)</div>
              </div>
              <button onClick={() => { setClienteModal(false); setClienteEditId(null); setClienteForm({ nome:"", tipo:"PJ", obs:"" }); }}
                style={{ background:"transparent", border:"none", padding:6, cursor:"pointer", color:T.textSoft, display:"flex" }}>
                <Icon name="close" size={18} color={T.textSoft} />
              </button>
            </div>
            <div style={{ padding:"16px 18px", overflowY:"auto", flex:1 }}>
              {/* Form add/edit */}
              <div style={{ background:T.cardAlt, borderRadius:10, padding:12, marginBottom:14, border:`1px solid ${T.border}` }}>
                <div style={{ ...LBL, marginBottom:6 }}>{clienteEditId ? "Editar cliente" : "Novo cliente"}</div>
                <input value={clienteForm.nome} onChange={e => setClienteForm(f => ({...f, nome:e.target.value}))} placeholder="Nome do cliente" style={{ ...INP, marginBottom:6 }} />
                <div style={{ display:"flex", gap:6, marginBottom:6 }}>
                  <select value={clienteForm.tipo} onChange={e => setClienteForm(f => ({...f, tipo:e.target.value}))} style={{ ...INP, fontSize:13, flex:"0 0 100px" }}>
                    <option value="PF">PF</option>
                    <option value="PJ">PJ</option>
                  </select>
                  <input value={clienteForm.obs} onChange={e => setClienteForm(f => ({...f, obs:e.target.value}))} placeholder="Observações (opcional)" style={{ ...INP, flex:1 }} />
                </div>
                <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
                  {clienteEditId && (
                    <button onClick={() => { setClienteEditId(null); setClienteForm({ nome:"", tipo:"PJ", obs:"" }); }} style={{ ...BTN_GHOST, padding:"7px 12px", fontSize:12 }}>Cancelar</button>
                  )}
                  <button onClick={() => {
                    if (!clienteForm.nome.trim()) return;
                    if (clienteEditId) {
                      setClientes(prev => prev.map(c => c.id === clienteEditId ? { ...clienteForm, id:clienteEditId } : c));
                      toast("Cliente atualizado","success");
                    } else {
                      setClientes(prev => [...prev, { ...clienteForm, id:Date.now() }]);
                      toast("Cliente adicionado","success");
                    }
                    setClienteForm({ nome:"", tipo:"PJ", obs:"" });
                    setClienteEditId(null);
                  }} disabled={!clienteForm.nome.trim()} style={{ ...BTN_PRIMARY, padding:"7px 14px", fontSize:12, opacity:clienteForm.nome.trim()?1:0.4 }}>
                    <Icon name={clienteEditId?"check":"plus"} size={13} color="#fff" />
                    {clienteEditId ? "Salvar" : "Adicionar"}
                  </button>
                </div>
              </div>

              {/* Lista */}
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {clientes.length === 0 && <div style={{ textAlign:"center", padding:20, color:T.textMuted, fontSize:13 }}>Nenhum cliente cadastrado.</div>}
                {clientes.map(c => {
                  const qtdPrazos = prazos.filter(p => p.parte === c.nome && !p.concluido).length;
                  return (
                    <div key={c.id} style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:10, padding:"10px 12px", display:"flex", alignItems:"center", gap:10 }}>
                      <div style={{ width:36, height:36, borderRadius:"50%", background:T.primarySoft, color:T.primary, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:700, flexShrink:0 }}>
                        {c.nome.split(" ").slice(0,2).map(s => s[0]).join("").toUpperCase()}
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                          <span style={{ fontSize:13, fontWeight:600, color:T.text }}>{c.nome}</span>
                          <span style={{ fontSize:9, background:T.cardAlt, color:T.textSoft, borderRadius:8, padding:"1px 6px", fontWeight:700 }}>{c.tipo}</span>
                        </div>
                        {c.obs && <div style={{ fontSize:11, color:T.textMuted, marginTop:2 }}>{c.obs}</div>}
                        <div style={{ fontSize:10, color:T.textMuted, marginTop:2 }}>{qtdPrazos} prazo(s) ativo(s)</div>
                      </div>
                      <button onClick={() => { setClienteForm({ nome:c.nome, tipo:c.tipo, obs:c.obs||"" }); setClienteEditId(c.id); }}
                        style={{ background:"transparent", border:"none", padding:5, cursor:"pointer", color:T.textSoft, display:"flex" }}>
                        <Icon name="edit" size={14} color={T.textSoft} />
                      </button>
                      <button onClick={() => {
                        if (qtdPrazos > 0) { toast("Cliente com prazos ativos","danger"); return; }
                        setClientes(prev => prev.filter(x => x.id !== c.id));
                        toast("Cliente removido","danger");
                      }} style={{ background:"transparent", border:"none", padding:5, cursor:"pointer", color:T.danger, display:"flex" }}>
                        <Icon name="trash" size={14} color={T.danger} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══ MODAL BACKUP / RESTORE ══ */}
      {backupModal && (
        <div style={{ position:"fixed", inset:0, display:"flex", alignItems:"center", justifyContent:"center", zIndex:200, padding:16, pointerEvents:"none" }}>
          <div style={{ background:T.card, borderRadius:16, width:"100%", maxWidth:480, boxShadow:"0 20px 60px #00000033", pointerEvents:"all", border:`1px solid ${T.border}` }}>
            <div style={{ padding:"16px 18px", borderBottom:`1px solid ${T.border}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <h2 style={{ margin:0, fontSize:16, color:T.text, fontWeight:700 }}>Backup e Restauração</h2>
              <button onClick={() => setBackupModal(false)} style={{ background:"transparent", border:"none", padding:6, cursor:"pointer", color:T.textSoft, display:"flex" }}>
                <Icon name="close" size={18} color={T.textSoft} />
              </button>
            </div>
            <div style={{ padding:"18px", display:"flex", flexDirection:"column", gap:14 }}>
              {/* Aviso */}
              <div style={{ background:T.warnSoft+"55", border:`1px solid ${T.warn}33`, borderRadius:10, padding:"12px 14px", display:"flex", gap:10 }}>
                <Icon name="alert" size={18} color={T.warn} />
                <div style={{ fontSize:12, color:T.textSoft, lineHeight:1.5 }}>
                  <strong style={{ color:T.text }}>Importante:</strong> os dados sincronizam com a nuvem (Supabase) entre seus dispositivos, mas o backup local é a segunda camada de proteção. <strong>Faça backups regularmente</strong>.
                </div>
              </div>

              {/* Status */}
              {ultimoBackup ? (
                <div style={{ fontSize:12, color:T.textMuted, textAlign:"center" }}>
                  Último backup: <strong style={{ color:T.text }}>{new Date(ultimoBackup).toLocaleString("pt-BR")}</strong>
                  {(() => {
                    const dias = Math.floor((Date.now() - new Date(ultimoBackup).getTime()) / 86400000);
                    if (dias >= 7) return <span style={{ color:T.danger, fontWeight:700, display:"block", marginTop:3 }}>⚠ Há {dias} dias sem backup</span>;
                    return null;
                  })()}
                </div>
              ) : (
                <div style={{ fontSize:12, color:T.danger, textAlign:"center", fontWeight:600 }}>⚠ Nenhum backup feito ainda</div>
              )}

              {/* Estatísticas dos dados */}
              <div style={{ background:T.cardAlt, borderRadius:10, padding:12, display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:6, textAlign:"center" }}>
                {[
                  { label:"Prazos",    val:prazos.length },
                  { label:"Tarefas",   val:tarefas.length },
                  { label:"Clientes",  val:clientes.length },
                  { label:"Feriados",  val:feriados.length },
                ].map(({label,val}) => (
                  <div key={label}>
                    <div style={{ fontSize:18, fontWeight:800, color:T.primary }}>{val}</div>
                    <div style={{ fontSize:10, color:T.textMuted, textTransform:"uppercase", letterSpacing:0.5 }}>{label}</div>
                  </div>
                ))}
              </div>

              {/* Botão Exportar */}
              <button onClick={() => {
                gerarBackup({ prazos, tarefas, clientes, tiposCustom, feriados, feriadosNomes });
                setUltimoBackup(new Date().toISOString());
                toast("Backup baixado","success");
              }} style={{ ...BTN_PRIMARY, padding:"12px", width:"100%", justifyContent:"center", fontSize:14 }}>
                <Icon name="printer" size={16} color="#fff" /> Baixar backup (JSON)
              </button>

              {/* Botão Importar */}
              <input type="file" accept="application/json" ref={fileInputRef} style={{ display:"none" }}
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (!window.confirm("Restaurar substituirá TODOS os dados atuais. Deseja continuar?")) {
                    e.target.value = ""; return;
                  }
                  restaurarBackup(file, (err, dados) => {
                    if (err) { toast("Arquivo inválido","danger"); return; }
                    if (dados.prazos) setPrazos(dados.prazos);
                    if (dados.tarefas) setTarefas(dados.tarefas);
                    if (dados.clientes) setClientes(dados.clientes);
                    if (dados.tiposCustom) setTiposCustom(dados.tiposCustom);
                    if (dados.feriados) setFeriados(dados.feriados);
                    if (dados.feriadosNomes) setFeriadosNomes(dados.feriadosNomes);
                    toast("Backup restaurado com sucesso","success");
                    setBackupModal(false);
                  });
                  e.target.value = "";
                }} />
              <button onClick={() => fileInputRef.current?.click()}
                style={{ ...BTN_GHOST, padding:"12px", width:"100%", justifyContent:"center", display:"flex", alignItems:"center", gap:6, fontSize:14 }}>
                <Icon name="calendar" size={16} color={T.textSoft} /> Restaurar de arquivo
              </button>

              <div style={{ fontSize:11, color:T.textMuted, lineHeight:1.6, padding:"10px 12px", background:T.cardAlt, borderRadius:8 }}>
                <strong>💡 Dica:</strong> salve o arquivo no Google Drive, iCloud ou Dropbox. Faça backup pelo menos 1x por semana, ou após adicionar muitos prazos.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══ MODAL NOVO/EDITAR PRAZO ══ */}
      {modal !== null && (
        <div style={{ position:"fixed", inset:0, display:"flex", alignItems:"center", justifyContent:"center", zIndex:200, padding:16, pointerEvents:"none" }}>
          <div style={{ background:T.card, borderRadius:16, padding:"20px", width:"100%", maxWidth:520, maxHeight:"90vh", overflowY:"auto", boxShadow:"0 20px 60px #00000033", pointerEvents:"all", border:`1px solid ${T.border}` }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
              <h2 style={{ margin:0, fontSize:17, color:T.text, fontWeight:700 }}>{modal==="novo"?"Novo Prazo":"Editar Prazo"}</h2>
              <button onClick={() => setModal(null)} style={{ background:"transparent", border:"none", padding:6, cursor:"pointer", color:T.textSoft, display:"flex" }}>
                <Icon name="close" size={18} color={T.textSoft} />
              </button>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              <label>
                <span style={LBL}>Nº do Processo (CNJ)</span>
                <input value={form.processo||""} onChange={e => setForm(f => ({...f, processo: mascararProcesso(e.target.value)}))} placeholder="0000000-00.0000.0.00.0000" style={{...INP, fontFamily:"monospace"}} maxLength={25} />
              </label>
              <label>
                <span style={LBL}>Parte / Cliente</span>
                <input list="lista-clientes" value={form.parte||""} onChange={e => setForm(f => ({...f, parte:e.target.value}))} placeholder="Digite ou selecione um cliente" style={INP} />
                <datalist id="lista-clientes">
                  {clientes.map(c => <option key={c.id} value={c.nome}>{c.tipo}{c.obs?" — "+c.obs:""}</option>)}
                </datalist>
              </label>
              <label>
                <span style={LBL}>Tipo</span>
                <select value={form.tipo||TIPOS_DEFAULT[0]} onChange={e => setForm(f => ({...f,tipo:e.target.value}))} style={INP}>
                  <optgroup label="Padrão">{TIPOS_DEFAULT.map(t => <option key={t}>{t}</option>)}</optgroup>
                  {tiposCustom.length > 0 && <optgroup label="Personalizados">{tiposCustom.map(t => <option key={t}>{t}</option>)}</optgroup>}
                </select>
              </label>
              <div style={{ background:T.cardAlt, borderRadius:10, padding:"12px 14px", border:`1px solid ${T.border}` }}>
                <div style={{ display:"flex", gap:0, marginBottom:10, background:T.border, borderRadius:8, padding:2 }}>
                  {[{ key:"final", label:"Data final" }, { key:"inicio", label:"Início + dias úteis" }].map(({ key, label }) => (
                    <button key={key} type="button"
                      onClick={() => setForm(f => ({ ...f, modoData: key, dataInicio:"", diasUteis:"", dataLimite: key==="final" ? f.dataLimite : "" }))}
                      style={{ flex:1, background:(form.modoData||"final")===key?T.card:"transparent", border:"none", borderRadius:6, padding:"6px 8px", fontSize:12, fontWeight:(form.modoData||"final")===key?700:500, color:(form.modoData||"final")===key?T.primary:T.textSoft, cursor:"pointer" }}>
                      {label}
                    </button>
                  ))}
                </div>
                {(form.modoData||"final") === "final" ? (
                  <label>
                    <span style={LBL}>Data limite</span>
                    <input type="date" value={form.dataLimite||""} onChange={e => setForm(f => ({...f, dataLimite:e.target.value}))} style={INP} />
                  </label>
                ) : (
                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                      <label>
                        <span style={LBL}>Data início</span>
                        <input type="date" value={form.dataInicio||""} onChange={e => {
                          const di = e.target.value;
                          const du = parseInt(form.diasUteis||0);
                          const dl = di && du > 0 ? calcularDataFinal(di, du) : "";
                          setForm(f => ({ ...f, dataInicio:di, dataLimite:dl }));
                        }} style={INP} />
                      </label>
                      <label>
                        <span style={LBL}>Dias úteis</span>
                        <input type="number" min="1" max="360" value={form.diasUteis||""} onChange={e => {
                          const du = parseInt(e.target.value||0);
                          const di = form.dataInicio||"";
                          const dl = di && du > 0 ? calcularDataFinal(di, du) : "";
                          setForm(f => ({ ...f, diasUteis:e.target.value, dataLimite:dl }));
                        }} placeholder="15" style={INP} />
                      </label>
                    </div>
                    {form.dataLimite && (
                      <div style={{ background:T.primarySoft, borderRadius:8, padding:"8px 12px", display:"flex", alignItems:"center", gap:8 }}>
                        <Icon name="calendar" size={18} color={T.primary} />
                        <div>
                          <div style={{ fontSize:10, color:T.textMuted, fontWeight:600, textTransform:"uppercase" }}>Calculado</div>
                          <div style={{ fontSize:15, fontWeight:700, color:T.primary }}>{fmt(form.dataLimite)}</div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <label>
                  <span style={LBL}>Responsável</span>
                  <select value={form.responsavel||"Felipe"} onChange={e => setForm(f => ({...f,responsavel:e.target.value}))} style={INP}>
                    <option>Felipe</option><option>Janine</option><option>Equipe</option>
                  </select>
                </label>
                <label>
                  <span style={LBL}>Prioridade</span>
                  <select value={form.prioridade||"media"} onChange={e => setForm(f => ({...f,prioridade:e.target.value}))} style={INP}>
                    <option value="alta">Alta</option>
                    <option value="media">Média</option>
                    <option value="baixa">Baixa</option>
                  </select>
                </label>
              </div>
              <label>
                <span style={LBL}>Recorrência</span>
                <select value={form.recorrencia||"none"} onChange={e => setForm(f => ({...f, recorrencia:e.target.value}))} style={INP}>
                  <option value="none">Não se repete</option>
                  <option value="semanal">Semanal</option>
                  <option value="quinzenal">Quinzenal</option>
                  <option value="mensal">Mensal</option>
                  <option value="bimestral">Bimestral</option>
                  <option value="trimestral">Trimestral</option>
                  <option value="anual">Anual</option>
                </select>
                {form.recorrencia && form.recorrencia !== "none" && (
                  <div style={{ fontSize:11, color:T.textMuted, marginTop:4, fontStyle:"italic" }}>Ao concluir, será criado automaticamente um novo prazo na próxima data.</div>
                )}
              </label>
              <label>
                <span style={LBL}>Observações</span>
                <textarea value={form.obs||""} onChange={e => setForm(f => ({...f,obs:e.target.value}))} rows={2} placeholder="Notas..." style={{ ...INP, resize:"vertical" }} />
              </label>
              {modal !== "novo" && (
                <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", background:T.successSoft, borderRadius:10, padding:"10px 14px" }}>
                  <input type="checkbox" checked={form.concluido||false} onChange={e => setForm(f => ({...f,concluido:e.target.checked}))} style={{ width:18, height:18, accentColor:T.success }} />
                  <span style={{ fontSize:13, color:T.success, fontWeight:600 }}>Marcar como concluído</span>
                </label>
              )}
            </div>
            <div style={{ display:"flex", gap:8, marginTop:16, justifyContent:"flex-end" }}>
              <button onClick={() => setModal(null)} style={BTN_GHOST}>Cancelar</button>
              <button onClick={salvar} disabled={!form.processo||!form.dataLimite} style={{ ...BTN_PRIMARY, opacity:(!form.processo||!form.dataLimite)?0.4:1 }}>
                <Icon name="check" size={14} color="#fff" /> Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ MODAL TAREFA ══ */}
      {tarefaModal && (
        <div style={{ position:"fixed", inset:0, display:"flex", alignItems:"center", justifyContent:"center", zIndex:200, padding:16, pointerEvents:"none" }}>
          <div style={{ background:T.card, borderRadius:16, padding:"20px", width:"100%", maxWidth:460, boxShadow:"0 20px 60px #00000033", pointerEvents:"all", border:`1px solid ${T.border}` }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
              <h2 style={{ margin:0, fontSize:17, color:T.text, fontWeight:700 }}>{tarefaEditId?"Editar Tarefa":"Nova Tarefa"}</h2>
              <button onClick={() => { setTarefaModal(false); setTarefaForm({}); setTarefaEditId(null); }} style={{ background:"transparent", border:"none", padding:6, cursor:"pointer", color:T.textSoft, display:"flex" }}>
                <Icon name="close" size={18} color={T.textSoft} />
              </button>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              <label>
                <span style={LBL}>Título *</span>
                <input value={tarefaForm.titulo||""} onChange={e => setTarefaForm(f => ({...f,titulo:e.target.value}))} placeholder="Ex: Revisar petição..." style={INP} autoFocus />
              </label>
              <label>
                <span style={LBL}>Descrição</span>
                <textarea value={tarefaForm.descricao||""} onChange={e => setTarefaForm(f => ({...f,descricao:e.target.value}))} rows={2} style={{ ...INP, resize:"vertical" }} />
              </label>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <label>
                  <span style={LBL}>Prioridade</span>
                  <select value={tarefaForm.prioridade||"media"} onChange={e => setTarefaForm(f => ({...f,prioridade:e.target.value}))} style={INP}>
                    <option value="alta">Alta</option>
                    <option value="media">Média</option>
                    <option value="baixa">Baixa</option>
                  </select>
                </label>
                <label>
                  <span style={LBL}>Responsável</span>
                  <select value={tarefaForm.responsavel||"Felipe"} onChange={e => setTarefaForm(f => ({...f,responsavel:e.target.value}))} style={INP}>
                    <option>Felipe</option><option>Janine</option><option>Equipe</option>
                  </select>
                </label>
              </div>
              <label>
                <span style={LBL}>Prazo (opcional)</span>
                <input type="date" value={tarefaForm.prazoLimite||""} onChange={e => setTarefaForm(f => ({...f,prazoLimite:e.target.value}))} style={INP} />
              </label>
              {tarefaEditId && (
                <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", background:T.successSoft, borderRadius:10, padding:"10px 14px" }}>
                  <input type="checkbox" checked={tarefaForm.concluida||false} onChange={e => setTarefaForm(f => ({...f,concluida:e.target.checked}))} style={{ width:18, height:18, accentColor:T.success }} />
                  <span style={{ fontSize:13, color:T.success, fontWeight:600 }}>Concluída</span>
                </label>
              )}
            </div>
            <div style={{ display:"flex", gap:8, marginTop:14, justifyContent:"flex-end" }}>
              <button onClick={() => { setTarefaModal(false); setTarefaForm({}); setTarefaEditId(null); }} style={BTN_GHOST}>Cancelar</button>
              <button onClick={() => {
                if (!tarefaForm.titulo?.trim()) return;
                if (tarefaEditId) { setTarefas(prev => prev.map(t => t.id===tarefaEditId?{...tarefaForm,id:tarefaEditId}:t)); toast("Tarefa atualizada","success"); }
                else { setTarefas(prev => [...prev,{...tarefaForm,id:Date.now()}]); toast("Tarefa criada","success"); }
                setTarefaModal(false); setTarefaForm({}); setTarefaEditId(null);
              }} disabled={!tarefaForm.titulo?.trim()} style={{ ...BTN_PRIMARY, opacity:tarefaForm.titulo?.trim()?1:0.4 }}>
                <Icon name="check" size={14} color="#fff" /> Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ CONFIRMAR EXCLUSÃO ══ */}
      {confirmDel && (
        <div style={{ position:"fixed", inset:0, display:"flex", alignItems:"center", justifyContent:"center", zIndex:200, padding:16, pointerEvents:"none" }}>
          <div style={{ background:T.card, borderRadius:16, padding:22, maxWidth:340, width:"100%", textAlign:"center", boxShadow:"0 20px 60px #00000033", pointerEvents:"all", border:`1px solid ${T.border}` }}>
            <div style={{ display:"flex", justifyContent:"center", marginBottom:10 }}>
              <div style={{ background:T.dangerSoft, borderRadius:"50%", padding:14, display:"flex" }}>
                <Icon name="alert" size={28} color={T.danger} />
              </div>
            </div>
            <div style={{ fontSize:15, fontWeight:700, color:T.text, marginBottom:5 }}>Excluir este prazo?</div>
            <div style={{ fontSize:12, color:T.textMuted, marginBottom:18 }}>Esta ação não pode ser desfeita.</div>
            <div style={{ display:"flex", gap:8, justifyContent:"center" }}>
              <button onClick={() => setConfirmDel(null)} style={BTN_GHOST}>Cancelar</button>
              <button onClick={() => deletar(confirmDel)} style={{ background:T.danger, border:"none", borderRadius:10, padding:"10px 18px", color:"#fff", fontWeight:600, cursor:"pointer", fontSize:14, display:"flex", alignItems:"center", gap:6 }}>
                <Icon name="trash" size={14} color="#fff" /> Excluir
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── TOASTS ── */}
      <ToastContainer toasts={toasts} T={T} />
    </div>
  );
}
