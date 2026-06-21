/* =========================================================
   Financeiro — lógica do app (schema v2)

   Mudanças desta versão (mantendo a segurança já existente):
   - Competência mensal: cada lançamento pertence a um mês.
     Recorrentes (salário, FIXO, assinaturas) valem de um mês
     inicial em diante; pontuais (VARIAVEL, extras) só no mês.
   - Separação comprometido x já gasto x ainda posso gastar.
   - Parcelas têm início + nº de parcelas: caem fora do cálculo
     quando acabam (não pesam pra sempre).
   - Categorias, reserva (meta), projeção de fim de mês,
     histórico por mês, exportar/importar JSON.

   Mantido intacto (parte sensível): storage namespaced por
   usuário, lógica de updatedAt, CSP estrita (canvas/CSSOM,
   sem libs de CDN), token no fluxo já existente.
   ========================================================= */

const STORAGE_PREFIX = "controle-financeiro:state";
const LEGACY_STORAGE_KEY = "controle-financeiro:state";
const TOKEN_KEY = "controle-financeiro:token";
const USE_BACKEND = true;
const SCHEMA_VERSION = 2;

// Limites defensivos (evitam import gigante / DoS de localStorage e do POST de 100kb do backend)
const MAX_ITEMS = 2000;
const MAX_STR = 200;

const API_BASE = (typeof BACKEND_URL !== "undefined" ? String(BACKEND_URL).trim().replace(/\/+$/, "") : "") || "";
const API_URL = `${API_BASE}/api/state`;
const API_AUTH = `${API_BASE}/api`;

const CATEGORIES = ["Moradia", "Mercado", "Transporte", "Saúde", "Lazer", "Educação", "Outros"];
const CATEGORY_COLORS = {
  fixos: "#6f7ce8",
  variaveis: "#2fd08a",
  assinaturas: "#f2c14e",
  faturas: "#f0625a",
  reserva: "#46b3c9",
};

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    salary: 0,
    savingsTarget: 0,
    incomes: [],
    expenses: [],
    subscriptions: [],
    invoices: [],
    updatedAt: 0,
  };
}

let state = emptyState();
let viewMonth = currentMonthKey(); // mês em foco na UI
let currentUser = null;
let currentToken = "";
let saveQueue = Promise.resolve();

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
function formatMoney(value) { return currency.format(Number.isFinite(value) ? value : 0); }
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function clampStr(v, fallback = "") { const s = String(v ?? fallback); return s.length > MAX_STR ? s.slice(0, MAX_STR) : s; }
function safeNum(v, min = -Infinity) { return typeof v === "number" && Number.isFinite(v) && v >= min ? v : null; }

// ---------------------------------------------------------
// Helpers de mês (competência "YYYY-MM" — comparável como string)
// ---------------------------------------------------------
function pad2(n) { return String(n).padStart(2, "0"); }
function monthKeyOf(date) { return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`; }
function currentMonthKey() { return monthKeyOf(new Date()); }
function validMonth(s) { return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : null; }
function addMonths(key, n) {
  const [y, m] = key.split("-").map(Number);
  return monthKeyOf(new Date(y, m - 1 + n, 1));
}
function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  const label = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(new Date(y, m - 1, 1));
  return label.charAt(0).toUpperCase() + label.slice(1);
}
function monthLabelShort(key) {
  const [y, m] = key.split("-").map(Number);
  const label = new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(new Date(y, m - 1, 1)).replace(".", "");
  return `${label}/${String(y).slice(2)}`;
}
function isRecurringActive(item, key) {
  const start = item.startMonth || "0000-00";
  if (key < start) return false;
  if (item.endMonth && key > item.endMonth) return false;
  return true;
}
function invoiceInstallmentFor(inv, key) {
  const start = inv.startMonth || (inv.dueDate ? inv.dueDate.slice(0, 7) : currentMonthKey());
  const installments = Math.max(inv.installments, 1);
  const endKey = addMonths(start, installments - 1);
  if (key < start || key > endKey) return 0;
  return inv.total / installments;
}

// ---------------------------------------------------------
// Normalização / migração v1 -> v2 (NUNCA descarta dado: o que
// não tem mês recebe o mês atual; recorrentes começam no mês atual)
// ---------------------------------------------------------
function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  const cur = currentMonthKey();

  base.salary = safeNum(raw.salary, 0) ?? 0;
  base.savingsTarget = safeNum(raw.savingsTarget, 0) ?? 0;
  base.updatedAt = safeNum(raw.updatedAt, 0) ?? 0;

  if (Array.isArray(raw.incomes)) {
    base.incomes = raw.incomes.slice(0, MAX_ITEMS)
      .filter((i) => i && safeNum(i.amount) !== null)
      .map((i) => ({
        id: clampStr(i.id || generateId()),
        description: clampStr(i.description || "Extra"),
        amount: i.amount,
        date: clampStr(i.date || ""),
        month: validMonth(i.month) || validMonth(String(i.date || "").slice(0, 7)) || cur,
      }));
  }
  if (Array.isArray(raw.expenses)) {
    base.expenses = raw.expenses.slice(0, MAX_ITEMS)
      .filter((e) => e && safeNum(e.amount) !== null)
      .map((e) => {
        const type = e.type === "FIXO" ? "FIXO" : "VARIAVEL";
        const category = CATEGORIES.includes(e.category) ? e.category : "Outros";
        const item = { id: clampStr(e.id || generateId()), description: clampStr(e.description || ""), amount: e.amount, type, category };
        if (type === "FIXO") {
          item.startMonth = validMonth(e.startMonth) || validMonth(e.month) || cur;
          item.endMonth = validMonth(e.endMonth) || null;
        } else {
          item.month = validMonth(e.month) || cur;
        }
        return item;
      });
  }
  if (Array.isArray(raw.subscriptions)) {
    base.subscriptions = raw.subscriptions.slice(0, MAX_ITEMS)
      .filter((s) => s && safeNum(s.amount) !== null)
      .map((s) => ({
        id: clampStr(s.id || generateId()),
        name: clampStr(s.name || s.description || ""),
        amount: s.amount,
        dueDay: Number.isFinite(s.dueDay) ? Math.min(Math.max(s.dueDay, 1), 31) : null,
        startMonth: validMonth(s.startMonth) || cur,
        endMonth: validMonth(s.endMonth) || null,
      }));
  }
  if (Array.isArray(raw.invoices)) {
    base.invoices = raw.invoices.slice(0, MAX_ITEMS)
      .filter((v) => v && safeNum(v.total) !== null)
      .map((v) => {
        const dueDate = clampStr(v.dueDate || "");
        return {
          id: clampStr(v.id || generateId()),
          description: clampStr(v.description || ""),
          total: v.total,
          dueDate,
          installments: Math.max(parseInt(v.installments, 10) || 1, 1),
          startMonth: validMonth(v.startMonth) || validMonth(dueDate.slice(0, 7)) || cur,
        };
      });
  }
  base.schemaVersion = SCHEMA_VERSION;
  return base;
}

// ---------------------------------------------------------
// Persistência — chave escopada por usuário (inalterada)
// ---------------------------------------------------------
function activeStorageKey() {
  return currentUser && currentUser.id ? `${STORAGE_PREFIX}:${currentUser.id}` : STORAGE_PREFIX;
}
function loadLocalState(userId) {
  try {
    const key = userId ? `${STORAGE_PREFIX}:${userId}` : STORAGE_PREFIX;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.salary === "number") return normalizeState(parsed);
    return null;
  } catch { return null; }
}
function saveLocalState() {
  state.updatedAt = Date.now();
  try { localStorage.setItem(activeStorageKey(), JSON.stringify(state)); } catch {}
}
function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }
function setToken(token) {
  currentToken = token || "";
  if (currentToken) localStorage.setItem(TOKEN_KEY, currentToken);
  else localStorage.removeItem(TOKEN_KEY);
}
function purgeLegacyState() { try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch {} }

async function getSession() {
  const token = getToken();
  if (!token) return { authenticated: false };
  try {
    const response = await fetch(`${API_AUTH}/session`, { cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return { authenticated: false };
    return await response.json();
  } catch { return { authenticated: false }; }
}
async function loadBackendState() {
  const token = getToken();
  if (!token) return null;
  try {
    const response = await fetch(API_URL, { cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return null;
    const parsed = await response.json();
    if (parsed && typeof parsed.salary === "number") return normalizeState(parsed);
  } catch {}
  return null;
}
async function loadState() {
  const session = await getSession();
  if (!session.authenticated) return { resolved: emptyState(), needsResync: false };
  currentUser = session.user;
  const local = loadLocalState(currentUser.id);
  const backendState = await loadBackendState();
  const localIsNewer = local && backendState && (local.updatedAt || 0) > (backendState.updatedAt || 0);
  if (localIsNewer) return { resolved: local, needsResync: true };
  if (backendState) return { resolved: backendState, needsResync: false };
  return { resolved: local || emptyState(), needsResync: false };
}
async function saveState() {
  saveLocalState();
  if (USE_BACKEND && currentUser) {
    saveQueue = saveQueue.then(() => saveBackendState());
    await saveQueue;
  }
}
async function saveBackendState() {
  const token = getToken();
  if (!token) return;
  try {
    await fetch(API_URL, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(state),
    });
  } catch {}
}
async function authRequest(path, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  try { return await fetch(`${API_AUTH}${path}`, { ...options, headers }); } catch { return null; }
}

// ---------------------------------------------------------
// Referências de elementos
// ---------------------------------------------------------
const $ = (id) => document.getElementById(id);

const authPanel = $("auth-panel");
const authForm = $("auth-form");
const authEmail = $("auth-email");
const authPassword = $("auth-password");
const registerButton = $("register-button");
const authMessage = $("auth-message");
const authBar = $("auth-bar");
const authUser = $("auth-user");
const logoutButton = $("logout-button");
const appLayout = $("app-layout");
const subtitleText = $("subtitle-text");

const monthLabelEl = $("month-label");
const monthPrev = $("month-prev");
const monthNext = $("month-next");

const salaryForm = $("salary-form");
const salaryInput = $("salary-input");

const savingsForm = $("savings-form");
const savingsInput = $("savings-input");

const incomeForm = $("income-form");
const incomeDescription = $("income-description");
const incomeAmount = $("income-amount");
const incomeList = $("income-list");

const expenseForm = $("expense-form");
const expenseDescription = $("expense-description");
const expenseAmount = $("expense-amount");
const expenseType = $("expense-type");
const expenseCategory = $("expense-category");
const expenseList = $("expense-list");

const subscriptionForm = $("subscription-form");
const subscriptionName = $("subscription-name");
const subscriptionAmount = $("subscription-amount");
const subscriptionDay = $("subscription-day");
const subscriptionList = $("subscription-list");
const subsTotal = $("subs-total");

const invoiceForm = $("invoice-form");
const invoiceDescription = $("invoice-description");
const invoiceTotal = $("invoice-total");
const invoiceDueDate = $("invoice-due-date");
const invoiceInstallments = $("invoice-installments");
const invoiceList = $("invoice-list");

const clearDataButton = $("clear-data");
const exportButton = $("export-button");
const importButton = $("import-button");
const importFile = $("import-file");

const balanceCard = $("balance-card");
const balanceAmountEl = $("balance-amount");
const balanceBarEl = $("balance-bar");
const balanceHintEl = $("balance-hint");
const heroIncomeEl = $("hero-income");
const heroCommittedEl = $("hero-committed");
const heroSpentEl = $("hero-spent");
const projHintEl = $("proj-hint");

const summarySalaryEl = $("summary-salary");
const summaryExtraEl = $("summary-extra");
const summaryFixedEl = $("summary-fixed");
const summaryVariableEl = $("summary-variable");
const summarySubsEl = $("summary-subs");
const summaryInvoicesEl = $("summary-invoices");
const summarySavingsEl = $("summary-savings");
const summaryTotalEl = $("summary-total");
const categoryBreakdownEl = $("category-breakdown");

const donutCanvas = $("chart-donut");
const donutLegend = $("donut-legend");
const donutTotalEl = $("donut-total");
const chartEmpty = $("chart-empty");
const meterList = $("meter-list");
const historyList = $("history-list");

// ---------------------------------------------------------
// Cálculo central
// ---------------------------------------------------------
function computeTotals(key = viewMonth) {
  const salary = state.salary; // salário tratado como mensal recorrente (flat)
  const extra = state.incomes.filter((i) => i.month === key).reduce((s, i) => s + i.amount, 0);
  const income = salary + extra;

  const fixed = state.expenses
    .filter((e) => e.type === "FIXO" && isRecurringActive(e, key))
    .reduce((s, e) => s + e.amount, 0);
  const variable = state.expenses
    .filter((e) => e.type === "VARIAVEL" && e.month === key)
    .reduce((s, e) => s + e.amount, 0);
  const subs = state.subscriptions
    .filter((x) => isRecurringActive(x, key))
    .reduce((s, x) => s + x.amount, 0);
  const invoices = state.invoices.reduce((s, v) => s + invoiceInstallmentFor(v, key), 0);
  const savings = state.savingsTarget || 0;

  const committed = fixed + subs + invoices + savings; // já decidido: sai do mês
  const spent = variable;                              // discricionário já gasto
  const out = committed + spent;
  const canSpend = income - out;                       // "ainda posso gastar"
  const usedRatio = income > 0 ? out / income : (out > 0 ? Infinity : 0);

  return { key, salary, extra, income, fixed, variable, subs, invoices, savings, committed, spent, out, canSpend, balance: canSpend, usedRatio };
}

function projection(key) {
  if (key !== currentMonthKey()) return null;
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const day = now.getDate();
  const t = computeTotals(key);
  const pacedVariable = day > 0 ? (t.variable / day) * daysInMonth : t.variable;
  const projectedOut = t.committed + pacedVariable;
  const projectedCanSpend = t.income - projectedOut;
  return { daysInMonth, day, pacedVariable, projectedCanSpend, hasVariable: t.variable > 0 };
}

function statusFromRatio(ratio, balance) {
  if (balance < 0 || ratio > 0.9) return "danger";
  if (ratio > 0.7) return "warn";
  return "ok";
}

function categoryBreakdown(key) {
  const map = {};
  for (const e of state.expenses) {
    const active = e.type === "FIXO" ? isRecurringActive(e, key) : e.month === key;
    if (!active) continue;
    map[e.category] = (map[e.category] || 0) + e.amount;
  }
  return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

// meses com algum dado, do mais antigo registrado até o mês atual (máx 12)
function historyMonths() {
  const months = new Set([currentMonthKey(), viewMonth]);
  for (const i of state.incomes) if (i.month) months.add(i.month);
  for (const e of state.expenses) { if (e.month) months.add(e.month); if (e.startMonth) months.add(e.startMonth); }
  for (const s of state.subscriptions) if (s.startMonth) months.add(s.startMonth);
  for (const v of state.invoices) if (v.startMonth) months.add(v.startMonth);
  const sorted = Array.from(months).filter(Boolean).sort();
  const cur = currentMonthKey();
  let cursor = sorted[0] || cur;
  const out = [];
  while (cursor <= cur && out.length < 24) { out.push(cursor); cursor = addMonths(cursor, 1); }
  return out.slice(-12);
}

// ---------------------------------------------------------
// Renderização
// ---------------------------------------------------------
function render() {
  const t = computeTotals();

  monthLabelEl.textContent = monthLabel(viewMonth);

  balanceAmountEl.textContent = formatMoney(t.canSpend);
  heroIncomeEl.textContent = formatMoney(t.income);
  heroCommittedEl.textContent = formatMoney(t.committed);
  heroSpentEl.textContent = formatMoney(t.spent);

  const pct = t.income > 0 ? Math.min((t.out / t.income) * 100, 100) : (t.out > 0 ? 100 : 0);
  balanceBarEl.style.width = `${pct}%`;

  const status = statusFromRatio(t.usedRatio, t.canSpend);
  balanceCard.classList.remove("is-ok", "is-warn", "is-danger");
  balanceCard.classList.add(`is-${status}`);
  balanceHintEl.textContent = buildHint(t, status);

  // projeção
  const proj = projection(viewMonth);
  if (proj && proj.hasVariable && proj.day < proj.daysInMonth) {
    const sign = proj.projectedCanSpend < 0 ? "no vermelho" : "de folga";
    projHintEl.textContent = `No ritmo atual, o mês fecha com ${formatMoney(proj.projectedCanSpend)} ${sign}.`;
    projHintEl.hidden = false;
  } else {
    projHintEl.hidden = true;
  }

  // resumo
  summarySalaryEl.textContent = formatMoney(state.salary);
  summaryExtraEl.textContent = formatMoney(t.extra);
  summaryFixedEl.textContent = formatMoney(t.fixed);
  summaryVariableEl.textContent = formatMoney(t.variable);
  summarySubsEl.textContent = formatMoney(t.subs);
  summaryInvoicesEl.textContent = formatMoney(t.invoices);
  summarySavingsEl.textContent = formatMoney(t.savings);
  summaryTotalEl.textContent = formatMoney(t.out);
  if (savingsInput && document.activeElement !== savingsInput) savingsInput.value = state.savingsTarget > 0 ? state.savingsTarget : "";

  renderCategoryBreakdown();
  renderIncomeList();
  renderExpenseList();
  renderSubscriptionList();
  renderInvoiceList();
  subsTotal.textContent = formatMoney(t.subs);

  drawDonut(t);
  drawMeters(t);
  renderHistory();

  saveState().catch(() => {});
}

function buildHint(t, status) {
  if (t.income === 0 && t.out === 0) return "Informe seu salário para começar.";
  if (t.canSpend < 0) return "Você já comprometeu mais do que entrou neste mês.";
  if (status === "danger") return "No limite. Quase tudo já está comprometido ou gasto.";
  if (status === "warn") return "Atenção: a maior parte da receita já foi.";
  return "Valor que ainda pode ser gasto neste mês (já descontada a reserva).";
}

function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }

function renderList(listEl, items, emptyText, buildItemHtml) {
  listEl.innerHTML = "";
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = emptyText;
    listEl.appendChild(li);
    return;
  }
  for (const it of [...items].reverse()) {
    const li = document.createElement("li");
    li.className = "item item--row";
    li.innerHTML = buildItemHtml(it);
    listEl.appendChild(li);
  }
}

function renderCategoryBreakdown() {
  if (!categoryBreakdownEl) return;
  const rows = categoryBreakdown(viewMonth);
  if (rows.length === 0) { categoryBreakdownEl.innerHTML = `<li class="empty">Sem gastos categorizados neste mês.</li>`; return; }
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  categoryBreakdownEl.innerHTML = rows.map((r) => {
    const pct = Math.round((r.value / total) * 100);
    return `<li><span class="legend-name">${escapeHtml(r.name)} · ${pct}%</span><span class="legend-value">${formatMoney(r.value)}</span></li>`;
  }).join("");
}

function renderIncomeList() {
  const items = state.incomes.filter((i) => i.month === viewMonth);
  renderList(incomeList, items, "Nenhuma entrada extra neste mês.", (i) => `
    <div class="item__info">
      <span class="item__desc">${escapeHtml(i.description)}</span>
      <span class="item__tag is-income">recebido</span>
    </div>
    <div class="item__right"><span class="item__amount is-income">+ ${formatMoney(i.amount)}</span></div>
    <button type="button" class="item__remove" data-remove-income="${i.id}" aria-label="Remover ${escapeHtml(i.description)}">×</button>
  `);
}

function renderExpenseList() {
  const items = state.expenses.filter((e) => (e.type === "FIXO" ? isRecurringActive(e, viewMonth) : e.month === viewMonth));
  renderList(expenseList, items, "Nenhum gasto neste mês.", (e) => {
    const isFixo = e.type === "FIXO";
    const endBtn = isFixo
      ? `<button type="button" class="item__end" data-end-expense="${e.id}" aria-label="Encerrar ${escapeHtml(e.description)}">encerrar</button>`
      : "";
    return `
    <div class="item__info">
      <span class="item__desc">${escapeHtml(e.description)}</span>
      <span class="item__tag ${isFixo ? "is-fixed" : ""}">${isFixo ? "fixo" : "variável"} · ${escapeHtml(e.category)}</span>
    </div>
    <div class="item__right"><span class="item__amount">${formatMoney(e.amount)}</span>${isFixo ? '<span class="item__small">/mês</span>' : ""}</div>
    ${endBtn}
    <button type="button" class="item__remove" data-remove-expense="${e.id}" aria-label="Remover ${escapeHtml(e.description)}">×</button>
  `;
  });
}

function renderSubscriptionList() {
  const items = state.subscriptions.filter((s) => isRecurringActive(s, viewMonth));
  renderList(subscriptionList, items, "Nenhuma assinatura ativa neste mês.", (s) => `
    <div class="item__info">
      <span class="item__desc">${escapeHtml(s.name)}</span>
      <span class="item__tag">${s.dueDay ? `dia ${s.dueDay}` : "mensal"}</span>
    </div>
    <div class="item__right"><span class="item__amount">${formatMoney(s.amount)}<span class="item__small">/mês</span></span></div>
    <button type="button" class="item__end" data-end-subscription="${s.id}" aria-label="Encerrar ${escapeHtml(s.name)}">encerrar</button>
    <button type="button" class="item__remove" data-remove-subscription="${s.id}" aria-label="Remover ${escapeHtml(s.name)}">×</button>
  `);
}

function renderInvoiceList() {
  renderList(invoiceList, state.invoices, "Nenhuma fatura lançada.", (v) => {
    const due = v.dueDate ? new Date(v.dueDate + "T00:00:00") : null;
    const start = v.startMonth;
    const n = Math.max(v.installments, 1);
    const endKey = addMonths(start, n - 1);
    const active = viewMonth >= start && viewMonth <= endKey;
    const finished = viewMonth > endKey;
    const dueText = due ? new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(due) : "";
    const perMonth = v.total / n;
    let statusTag;
    if (finished) statusTag = "quitada";
    else if (!active) statusTag = `começa ${monthLabelShort(start)}`;
    else if (n > 1) statusTag = `${n}× · ${formatMoney(perMonth)}/mês`;
    else statusTag = "à vista";
    const periodLine = n > 1 ? `<span class="item__small">${monthLabelShort(start)}→${monthLabelShort(endKey)}</span>` : "";
    const dueLine = due ? `<span class="item__small">vence ${dueText}</span>` : "";
    return `
      <div class="item__info">
        <span class="item__desc">${escapeHtml(v.description)}</span>
        <span class="item__tag ${finished ? "is-overdue" : ""}">${statusTag}</span>
      </div>
      <div class="item__right">
        <span class="item__amount">${formatMoney(v.total)}</span>
        ${periodLine}
        ${dueLine}
      </div>
      <button type="button" class="item__remove" data-remove-invoice="${v.id}" aria-label="Remover ${escapeHtml(v.description)}">×</button>
    `;
  });
}

// ---------------------------------------------------------
// Gráficos (canvas + CSSOM; sem libs por causa da CSP)
// ---------------------------------------------------------
function drawDonut(t) {
  if (!donutCanvas || !donutCanvas.getContext) return;
  const segments = [
    { label: "Fixos", value: t.fixed, color: CATEGORY_COLORS.fixos },
    { label: "Variáveis", value: t.variable, color: CATEGORY_COLORS.variaveis },
    { label: "Assinaturas", value: t.subs, color: CATEGORY_COLORS.assinaturas },
    { label: "Faturas", value: t.invoices, color: CATEGORY_COLORS.faturas },
    { label: "Reserva", value: t.savings, color: CATEGORY_COLORS.reserva },
  ].filter((s) => s.value > 0);

  const total = segments.reduce((s, seg) => s + seg.value, 0);
  donutTotalEl.textContent = formatMoney(total);

  const cssSize = 180;
  const dpr = window.devicePixelRatio || 1;
  donutCanvas.width = cssSize * dpr;
  donutCanvas.height = cssSize * dpr;
  const ctx = donutCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);

  const cx = cssSize / 2, cy = cssSize / 2, outer = 84, inner = 54;
  if (total === 0) {
    ctx.beginPath(); ctx.arc(cx, cy, (outer + inner) / 2, 0, Math.PI * 2);
    ctx.lineWidth = outer - inner; ctx.strokeStyle = "#18241e"; ctx.stroke();
    donutLegend.innerHTML = "";
    if (chartEmpty) chartEmpty.style.display = "block";
    return;
  }
  if (chartEmpty) chartEmpty.style.display = "none";

  let start = -Math.PI / 2;
  for (const seg of segments) {
    const angle = (seg.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, start, start + angle);
    ctx.arc(cx, cy, inner, start + angle, start, true);
    ctx.closePath(); ctx.fillStyle = seg.color; ctx.fill();
    start += angle;
  }
  donutLegend.innerHTML = segments.map((seg) => {
    const pct = Math.round((seg.value / total) * 100);
    return `<li><span class="dot" data-color="${seg.color}"></span><span class="legend-name">${seg.label} · ${pct}%</span><span class="legend-value">${formatMoney(seg.value)}</span></li>`;
  }).join("");
  donutLegend.querySelectorAll(".dot").forEach((dot) => { dot.style.backgroundColor = dot.getAttribute("data-color"); });
}

function drawMeters(t) {
  if (!meterList) return;
  const max = Math.max(t.income, t.out, 1);
  const balanceStatus = statusFromRatio(t.usedRatio, t.canSpend);
  const rows = [
    { label: "Receita", value: t.income, width: (t.income / max) * 100, cls: "is-income" },
    { label: "Saiu / vai sair", value: t.out, width: (t.out / max) * 100, cls: "is-expense" },
    { label: "Ainda posso gastar", value: t.canSpend, width: (Math.abs(t.canSpend) / max) * 100, cls: `is-balance-${balanceStatus}` },
  ];
  meterList.innerHTML = rows.map((r) => `<div class="meter__row">
      <div class="meter__top"><span>${r.label}</span><span class="meter__val">${formatMoney(r.value)}</span></div>
      <div class="meter__track"><span class="meter__fill ${r.cls}" data-w="${Math.min(r.width, 100)}"></span></div>
    </div>`).join("");
  meterList.querySelectorAll(".meter__fill").forEach((el) => { el.style.width = `${el.getAttribute("data-w")}%`; });
}

function renderHistory() {
  if (!historyList) return;
  const months = historyMonths();
  const data = months.map((m) => ({ m, t: computeTotals(m) }));
  const max = Math.max(1, ...data.map((d) => Math.max(d.t.income, d.t.out)));
  historyList.innerHTML = data.reverse().map(({ m, t }) => {
    const st = statusFromRatio(t.usedRatio, t.canSpend);
    const isView = m === viewMonth;
    return `<button type="button" class="hist-row ${isView ? "is-current" : ""}" data-goto-month="${m}">
      <div class="hist-top"><span class="hist-month">${monthLabel(m)}</span><span class="hist-balance is-${st}">${formatMoney(t.canSpend)}</span></div>
      <div class="hist-bars">
        <span class="hist-bar hist-bar--in" data-w="${(t.income / max) * 100}"></span>
        <span class="hist-bar hist-bar--out" data-w="${(t.out / max) * 100}"></span>
      </div>
      <div class="hist-legend"><span>entrou ${formatMoney(t.income)}</span><span>saiu ${formatMoney(t.out)}</span></div>
    </button>`;
  }).join("");
  historyList.querySelectorAll(".hist-bar").forEach((el) => { el.style.width = `${el.getAttribute("data-w")}%`; });
}

// ---------------------------------------------------------
// Exportar / Importar (JSON)
// ---------------------------------------------------------
async function exportData() {
  const payload = { ...state, exportedAt: new Date().toISOString(), app: "financeiro", schemaVersion: SCHEMA_VERSION };
  const json = JSON.stringify(payload, null, 2);
  const who = (currentUser && currentUser.username) ? currentUser.username : "dados";
  const filename = `financeiro-${who}-${currentMonthKey()}.json`;

  // Mobile (toque): usa a Web Share API com arquivo. No iOS isso abre o
  // "Salvar em Arquivos" — o <a download> simplesmente não funciona lá
  // (o Safari abre o JSON na própria aba em vez de baixar).
  const isTouch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  if (isTouch && typeof File === "function" && navigator.canShare) {
    try {
      const file = new File([json], filename, { type: "application/json" });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return; // usuário cancelou de propósito
      // qualquer outra falha cai no fallback de download abaixo
    }
  }

  // Desktop / Android com download: <a download> + blob.
  try {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    // Último recurso: mostra o JSON para o usuário copiar manualmente.
    window.prompt("Não foi possível baixar. Copie o backup abaixo e salve num arquivo .json:", json);
  }
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try { parsed = JSON.parse(String(reader.result)); }
    catch { window.alert("Arquivo inválido: não é um JSON válido."); return; }
    if (!parsed || typeof parsed !== "object") { window.alert("Arquivo inválido."); return; }
    const incoming = normalizeState(parsed); // mesma validação defensiva do resto do app
    const count = incoming.incomes.length + incoming.expenses.length + incoming.subscriptions.length + incoming.invoices.length;
    const ok = window.confirm(`Importar ${count} lançamento(s) e substituir TODOS os dados atuais desta conta? Esta ação não tem desfazer.`);
    if (!ok) return;
    state = incoming;
    salaryInput.value = state.salary > 0 ? state.salary : "";
    render();
  };
  reader.onerror = () => window.alert("Não foi possível ler o arquivo.");
  reader.readAsText(file);
}

// ---------------------------------------------------------
// Autenticação / sessão
// ---------------------------------------------------------
function showAuthMessage(message, isError = true) {
  authMessage.textContent = message;
  authMessage.className = isError ? "auth-message auth-message--error" : "auth-message auth-message--success";
}
function setAuthenticated(user) {
  currentUser = user || null;
  const loggedIn = USE_BACKEND ? Boolean(user) : true;
  authPanel.hidden = loggedIn;
  appLayout.hidden = !loggedIn;
  authBar.hidden = !loggedIn;
  if (loggedIn) {
    const displayName = (user && (user.email || user.username)) || "usuário";
    authUser.textContent = `Olá, ${displayName}`;
    subtitleText.textContent = "Seu saldo e gastos são salvos apenas para você.";
  } else {
    authUser.textContent = "";
    subtitleText.textContent = "Informe seu salário, lance os gastos do mês e veja na hora o que ainda pode gastar.";
  }
}
async function login() {
  const username = authEmail.value.trim();
  const password = authPassword.value;
  if (!username || !password) { showAuthMessage("Preencha usuário e senha."); return; }
  const response = await authRequest("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  if (!response) { showAuthMessage("Não foi possível conectar ao servidor. Tente novamente em instantes.", true); return; }
  if (!response.ok) { showAuthMessage("Falha ao entrar. Verifique usuário e senha."); return; }
  const data = await response.json();
  setToken(data.token);
  setAuthenticated(data.user);
  await reloadState();
  showAuthMessage("Entrou com sucesso.", false);
}
async function register() {
  const username = authEmail.value.trim();
  const password = authPassword.value;
  if (!username || !password) { showAuthMessage("Preencha usuário e senha."); return; }
  const response = await authRequest("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  if (!response || !response.ok) {
    const error = response ? await response.json().catch(() => null) : null;
    showAuthMessage(error?.error || "Falha ao criar conta.");
    return;
  }
  const data = await response.json();
  setToken(data.token);
  state = emptyState();
  viewMonth = currentMonthKey();
  setAuthenticated(data.user);
  salaryInput.value = "";
  render();
  showAuthMessage("Conta criada com sucesso.", false);
}
async function logout() {
  setToken("");
  setAuthenticated(null);
  state = emptyState();
  viewMonth = currentMonthKey();
  salaryInput.value = "";
  render();
}

// ---------------------------------------------------------
// Eventos
// ---------------------------------------------------------
monthPrev.addEventListener("click", () => { viewMonth = addMonths(viewMonth, -1); render(); });
monthNext.addEventListener("click", () => { viewMonth = addMonths(viewMonth, 1); render(); });

salaryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = parseFloat(salaryInput.value);
  if (Number.isNaN(value) || value < 0) { salaryInput.focus(); return; }
  state.salary = value;
  render();
});

savingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = parseFloat(savingsInput.value);
  state.savingsTarget = Number.isNaN(value) || value < 0 ? 0 : value;
  render();
});

incomeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const description = incomeDescription.value.trim();
  const amount = parseFloat(incomeAmount.value);
  if (!description || Number.isNaN(amount) || amount <= 0) return;
  state.incomes.push({ id: generateId(), description: clampStr(description), amount, date: new Date().toISOString().slice(0, 10), month: viewMonth });
  incomeForm.reset();
  incomeDescription.focus();
  render();
});

expenseForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const description = expenseDescription.value.trim();
  const amount = parseFloat(expenseAmount.value);
  const type = expenseType.value === "FIXO" ? "FIXO" : "VARIAVEL";
  const category = CATEGORIES.includes(expenseCategory.value) ? expenseCategory.value : "Outros";
  if (!description || Number.isNaN(amount) || amount <= 0) return;
  const item = { id: generateId(), description: clampStr(description), amount, type, category };
  if (type === "FIXO") { item.startMonth = viewMonth; item.endMonth = null; }
  else { item.month = viewMonth; }
  state.expenses.push(item);
  expenseForm.reset();
  expenseType.value = type;
  expenseCategory.value = category;
  expenseDescription.focus();
  render();
});

subscriptionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = subscriptionName.value.trim();
  const amount = parseFloat(subscriptionAmount.value);
  const dayRaw = parseInt(subscriptionDay.value, 10);
  const dueDay = Number.isNaN(dayRaw) ? null : Math.min(Math.max(dayRaw, 1), 31);
  if (!name || Number.isNaN(amount) || amount <= 0) return;
  state.subscriptions.push({ id: generateId(), name: clampStr(name), amount, dueDay, startMonth: viewMonth, endMonth: null });
  subscriptionForm.reset();
  subscriptionName.focus();
  render();
});

invoiceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const description = invoiceDescription.value.trim();
  const total = parseFloat(invoiceTotal.value);
  const dueDate = invoiceDueDate.value;
  const installments = parseInt(invoiceInstallments.value, 10);
  if (!description || Number.isNaN(total) || total <= 0 || !dueDate || Number.isNaN(installments) || installments < 1) return;
  state.invoices.push({ id: generateId(), description: clampStr(description), total, dueDate, installments, startMonth: validMonth(dueDate.slice(0, 7)) || viewMonth });
  invoiceForm.reset();
  invoiceInstallments.value = "1";
  render();
});

authForm.addEventListener("submit", async (event) => { event.preventDefault(); await login(); });
registerButton.addEventListener("click", async () => { await register(); });
logoutButton.addEventListener("click", async () => { await logout(); });

// Remoção / encerramento delegados
incomeList.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-remove-income]");
  if (!btn) return;
  state.incomes = state.incomes.filter((i) => i.id !== btn.getAttribute("data-remove-income"));
  render();
});
expenseList.addEventListener("click", (event) => {
  const rm = event.target.closest("[data-remove-expense]");
  if (rm) { state.expenses = state.expenses.filter((e) => e.id !== rm.getAttribute("data-remove-expense")); render(); return; }
  const end = event.target.closest("[data-end-expense]");
  if (end) {
    const e = state.expenses.find((x) => x.id === end.getAttribute("data-end-expense"));
    if (e && e.type === "FIXO") { e.endMonth = addMonths(viewMonth, -1); render(); }
  }
});
subscriptionList.addEventListener("click", (event) => {
  const rm = event.target.closest("[data-remove-subscription]");
  if (rm) { state.subscriptions = state.subscriptions.filter((s) => s.id !== rm.getAttribute("data-remove-subscription")); render(); return; }
  const end = event.target.closest("[data-end-subscription]");
  if (end) {
    const s = state.subscriptions.find((x) => x.id === end.getAttribute("data-end-subscription"));
    if (s) { s.endMonth = addMonths(viewMonth, -1); render(); }
  }
});
invoiceList.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-remove-invoice]");
  if (!btn) return;
  state.invoices = state.invoices.filter((v) => v.id !== btn.getAttribute("data-remove-invoice"));
  render();
});

clearDataButton.addEventListener("click", () => {
  const ok = window.confirm("Isso apaga salário, reserva, receitas, gastos, assinaturas e faturas desta conta — de todos os meses. Continuar?");
  if (!ok) return;
  state = emptyState();
  viewMonth = currentMonthKey();
  salaryInput.value = "";
  render();
});

if (exportButton) exportButton.addEventListener("click", exportData);
if (importButton) importButton.addEventListener("click", () => importFile && importFile.click());
if (importFile) importFile.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) importData(file);
  event.target.value = "";
});

// Abas
const tabButtons = Array.from(document.querySelectorAll(".tab"));
const panels = Array.from(document.querySelectorAll(".panel-view"));
function activateTab(name) {
  tabButtons.forEach((btn) => {
    const on = btn.dataset.tab === name;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  panels.forEach((p) => { p.hidden = p.dataset.panel !== name; p.classList.toggle("is-active", p.dataset.panel === name); });
  if (name === "resumo") drawDonut(computeTotals());
}
tabButtons.forEach((btn) => btn.addEventListener("click", () => activateTab(btn.dataset.tab)));

// histórico: clicar num mês foca nele
if (historyList) historyList.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-goto-month]");
  if (!btn) return;
  viewMonth = btn.getAttribute("data-goto-month");
  render();
  activateTab("resumo");
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!$("panel-resumo").hidden) drawDonut(computeTotals()); }, 150);
});

// ---------------------------------------------------------
// Inicialização
// ---------------------------------------------------------
function populateCategorySelect() {
  if (!expenseCategory) return;
  expenseCategory.innerHTML = CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join("");
}

async function applyResolvedState() {
  const { resolved, needsResync } = await loadState();
  state = resolved;
  viewMonth = currentMonthKey();
  if (needsResync) saveBackendState().catch(() => {});
  salaryInput.value = state.salary > 0 ? state.salary : "";
  render();
}
async function initialize() {
  purgeLegacyState();
  populateCategorySelect();
  const session = await getSession();
  setAuthenticated(session.authenticated ? session.user : null);
  if (session.authenticated) await applyResolvedState();
  else render();
}
async function reloadState() { await applyResolvedState(); }

initialize();

function flushStateOnExit() { if (document.visibilityState === "hidden") saveState().catch(() => {}); }
document.addEventListener("visibilitychange", flushStateOnExit);
window.addEventListener("pagehide", flushStateOnExit);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("service-worker.js").catch(() => {}); });
}

// Hooks só para teste em Node (inofensivo em produção)
if (typeof window !== "undefined") {
  window.__finance = {
    emptyState, normalizeState, computeTotals, projection, categoryBreakdown,
    monthKeyOf, currentMonthKey, addMonths, validMonth, isRecurringActive, invoiceInstallmentFor,
    setState: (s) => { state = s; }, getState: () => state, setViewMonth: (m) => { viewMonth = m; },
    CATEGORIES,
  };
}
