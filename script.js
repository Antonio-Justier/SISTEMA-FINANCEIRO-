/* =========================================================
   Financeiro — lógica do app
   Correção principal: o cache local agora é escopado por
   usuário (controle-financeiro:state:<userId>). Antes a chave
   era global e o estado de um usuário vazava para o próximo —
   e pior, era reenviado ao backend, contaminando a conta nova.
   ========================================================= */

const STORAGE_PREFIX = "controle-financeiro:state";
const LEGACY_STORAGE_KEY = "controle-financeiro:state"; // chave global antiga (causava o vazamento)
const TOKEN_KEY = "controle-financeiro:token";
const USE_BACKEND = true;

const API_BASE = (typeof BACKEND_URL !== "undefined" ? String(BACKEND_URL).trim().replace(/\/+$/, "") : "") || "";
const API_URL = `${API_BASE}/api/state`;
const API_AUTH = `${API_BASE}/api`;

// Cores das categorias no gráfico
const CATEGORY_COLORS = {
  fixos: "#6f7ce8",
  variaveis: "#2fd08a",
  assinaturas: "#f2c14e",
  faturas: "#f0625a",
};

function emptyState() {
  return { salary: 0, incomes: [], expenses: [], subscriptions: [], invoices: [], updatedAt: 0 };
}

let state = emptyState();
let currentUser = null;
let currentToken = "";
let saveQueue = Promise.resolve();

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
function formatMoney(value) { return currency.format(Number.isFinite(value) ? value : 0); }
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ---------------------------------------------------------
// Normalização: garante o formato esperado mesmo vindo de
// versões antigas (sem incomes/subscriptions).
// ---------------------------------------------------------
function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;

  base.salary = typeof raw.salary === "number" && raw.salary >= 0 ? raw.salary : 0;
  base.updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : 0;

  if (Array.isArray(raw.incomes)) {
    base.incomes = raw.incomes
      .filter((i) => i && typeof i.amount === "number")
      .map((i) => ({ id: String(i.id || generateId()), description: String(i.description || "Extra"), amount: i.amount, date: String(i.date || "") }));
  }
  if (Array.isArray(raw.expenses)) {
    base.expenses = raw.expenses
      .filter((e) => e && typeof e.amount === "number")
      .map((e) => ({ id: String(e.id || generateId()), description: String(e.description || ""), amount: e.amount, type: e.type === "FIXO" ? "FIXO" : "VARIAVEL" }));
  }
  if (Array.isArray(raw.subscriptions)) {
    base.subscriptions = raw.subscriptions
      .filter((s) => s && typeof s.amount === "number")
      .map((s) => ({ id: String(s.id || generateId()), name: String(s.name || s.description || ""), amount: s.amount, dueDay: Number.isFinite(s.dueDay) ? s.dueDay : null }));
  }
  if (Array.isArray(raw.invoices)) {
    base.invoices = raw.invoices
      .filter((v) => v && typeof v.total === "number")
      .map((v) => ({ id: String(v.id || generateId()), description: String(v.description || ""), total: v.total, dueDate: String(v.dueDate || ""), installments: Math.max(parseInt(v.installments, 10) || 1, 1) }));
  }
  return base;
}

// ---------------------------------------------------------
// Persistência — chave escopada por usuário
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
  } catch {
    return null;
  }
}

function saveLocalState() {
  state.updatedAt = Date.now();
  try {
    localStorage.setItem(activeStorageKey(), JSON.stringify(state));
  } catch {
    // armazenamento indisponível; segue funcionando em memória
  }
}

function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }
function setToken(token) {
  currentToken = token || "";
  if (currentToken) localStorage.setItem(TOKEN_KEY, currentToken);
  else localStorage.removeItem(TOKEN_KEY);
}

// Remove a chave global antiga: ela é a origem do vazamento entre contas.
// Não dá pra atribuí-la a ninguém com segurança, então descartamos.
function purgeLegacyState() {
  try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch {}
}

async function getSession() {
  const token = getToken();
  if (!token) return { authenticated: false };
  try {
    const response = await fetch(`${API_AUTH}/session`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return { authenticated: false };
    return await response.json();
  } catch {
    return { authenticated: false };
  }
}

async function loadBackendState() {
  const token = getToken();
  if (!token) return null;
  try {
    const response = await fetch(API_URL, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const parsed = await response.json();
    if (parsed && typeof parsed.salary === "number") return normalizeState(parsed);
  } catch {
    // backend indisponível
  }
  return null;
}

// Resolve o estado a usar: backend é a fonte da verdade; só usa o
// local se ele for comprovadamente mais novo PARA O MESMO USUÁRIO.
async function loadState() {
  const session = await getSession();
  if (!session.authenticated) {
    return { resolved: emptyState(), needsResync: false };
  }

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
  } catch {
    // já temos cópia local salva antes desta chamada
  }
}

async function authRequest(path, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  try {
    return await fetch(`${API_AUTH}${path}`, { ...options, headers });
  } catch {
    return null;
  }
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

const salaryForm = $("salary-form");
const salaryInput = $("salary-input");

const incomeForm = $("income-form");
const incomeDescription = $("income-description");
const incomeAmount = $("income-amount");
const incomeList = $("income-list");

const expenseForm = $("expense-form");
const expenseDescription = $("expense-description");
const expenseAmount = $("expense-amount");
const expenseType = $("expense-type");
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

const balanceCard = $("balance-card");
const balanceAmountEl = $("balance-amount");
const balanceBarEl = $("balance-bar");
const balanceHintEl = $("balance-hint");
const heroIncomeEl = $("hero-income");
const heroExpensesEl = $("hero-expenses");
const heroRatioEl = $("hero-ratio");

const summarySalaryEl = $("summary-salary");
const summaryExtraEl = $("summary-extra");
const summaryFixedEl = $("summary-fixed");
const summaryVariableEl = $("summary-variable");
const summarySubsEl = $("summary-subs");
const summaryInvoicesEl = $("summary-invoices");
const summaryTotalEl = $("summary-total");

const donutCanvas = $("chart-donut");
const donutLegend = $("donut-legend");
const donutTotalEl = $("donut-total");
const chartEmpty = $("chart-empty");
const meterList = $("meter-list");

// ---------------------------------------------------------
// Cálculos
// ---------------------------------------------------------
function sumExpensesByType(type) {
  return state.expenses.filter((e) => e.type === type).reduce((s, e) => s + e.amount, 0);
}
function sumIncomes() { return state.incomes.reduce((s, i) => s + i.amount, 0); }
function sumSubscriptions() { return state.subscriptions.reduce((s, x) => s + x.amount, 0); }
function sumInvoiceInstallments() {
  return state.invoices.reduce((s, v) => s + v.total / Math.max(v.installments, 1), 0);
}

function computeTotals() {
  const fixed = sumExpensesByType("FIXO");
  const variable = sumExpensesByType("VARIAVEL");
  const subs = sumSubscriptions();
  const invoices = sumInvoiceInstallments();
  const expenses = fixed + variable + subs + invoices;
  const extra = sumIncomes();
  const income = state.salary + extra;
  const balance = income - expenses;
  const ratio = income > 0 ? expenses / income : (expenses > 0 ? Infinity : 0);
  return { fixed, variable, subs, invoices, expenses, extra, income, balance, ratio };
}

function statusFromRatio(ratio, balance) {
  if (balance < 0 || ratio > 0.9) return "danger";
  if (ratio > 0.7) return "warn";
  return "ok";
}

// ---------------------------------------------------------
// Renderização
// ---------------------------------------------------------
function render() {
  const t = computeTotals();

  // Hero
  balanceAmountEl.textContent = formatMoney(t.balance);
  heroIncomeEl.textContent = formatMoney(t.income);
  heroExpensesEl.textContent = formatMoney(t.expenses);

  const pct = t.income > 0 ? Math.min((t.expenses / t.income) * 100, 100) : (t.expenses > 0 ? 100 : 0);
  heroRatioEl.textContent = `${Math.round(t.income > 0 ? (t.expenses / t.income) * 100 : (t.expenses > 0 ? 100 : 0))}%`;
  balanceBarEl.style.width = `${pct}%`;

  const status = statusFromRatio(t.ratio, t.balance);
  balanceCard.classList.remove("is-ok", "is-warn", "is-danger");
  balanceCard.classList.add(`is-${status}`);
  balanceHintEl.textContent = buildHint(t, status);

  // Resumo
  summarySalaryEl.textContent = formatMoney(state.salary);
  summaryExtraEl.textContent = formatMoney(t.extra);
  summaryFixedEl.textContent = formatMoney(t.fixed);
  summaryVariableEl.textContent = formatMoney(t.variable);
  summarySubsEl.textContent = formatMoney(t.subs);
  summaryInvoicesEl.textContent = formatMoney(t.invoices);
  summaryTotalEl.textContent = formatMoney(t.expenses);

  renderIncomeList();
  renderExpenseList();
  renderSubscriptionList();
  renderInvoiceList();

  subsTotal.textContent = formatMoney(t.subs);

  drawDonut(t);
  drawMeters(t);

  saveState().catch(() => {});
}

function buildHint(t, status) {
  if (t.income === 0 && t.expenses === 0) return "Informe seu salário para começar.";
  if (t.balance < 0) return "Seus gastos passaram da receita do mês. Hora de cortar algo.";
  if (status === "warn") return "Atenção: você já comprometeu a maior parte da receita.";
  if (status === "danger") return "No limite. Quase tudo já está comprometido.";
  return "Valor que ainda pode ser gasto neste mês.";
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

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

function renderIncomeList() {
  renderList(incomeList, state.incomes, "Nenhuma entrada extra lançada.", (i) => `
    <div class="item__info">
      <span class="item__desc">${escapeHtml(i.description)}</span>
      <span class="item__tag is-income">recebido</span>
    </div>
    <div class="item__right">
      <span class="item__amount is-income">+ ${formatMoney(i.amount)}</span>
    </div>
    <button type="button" class="item__remove" data-remove-income="${i.id}" aria-label="Remover ${escapeHtml(i.description)}">×</button>
  `);
}

function renderExpenseList() {
  renderList(expenseList, state.expenses, "Nenhum gasto lançado ainda.", (e) => `
    <div class="item__info">
      <span class="item__desc">${escapeHtml(e.description)}</span>
      <span class="item__tag ${e.type === "FIXO" ? "is-fixed" : ""}">${e.type === "FIXO" ? "fixo" : "variável"}</span>
    </div>
    <div class="item__right">
      <span class="item__amount">${formatMoney(e.amount)}</span>
    </div>
    <button type="button" class="item__remove" data-remove-expense="${e.id}" aria-label="Remover ${escapeHtml(e.description)}">×</button>
  `);
}

function renderSubscriptionList() {
  renderList(subscriptionList, state.subscriptions, "Nenhuma assinatura cadastrada.", (s) => `
    <div class="item__info">
      <span class="item__desc">${escapeHtml(s.name)}</span>
      <span class="item__tag">${s.dueDay ? `dia ${s.dueDay}` : "mensal"}</span>
    </div>
    <div class="item__right">
      <span class="item__amount">${formatMoney(s.amount)}<span class="item__small">/mês</span></span>
    </div>
    <button type="button" class="item__remove" data-remove-subscription="${s.id}" aria-label="Remover ${escapeHtml(s.name)}">×</button>
  `);
}

function renderInvoiceList() {
  renderList(invoiceList, state.invoices, "Nenhuma fatura lançada.", (v) => {
    const due = v.dueDate ? new Date(v.dueDate + "T00:00:00") : null;
    const isOverdue = due && due < new Date();
    const dueText = due
      ? new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(due)
      : "—";
    const perMonth = v.total / Math.max(v.installments, 1);
    return `
      <div class="item__info">
        <span class="item__desc">${escapeHtml(v.description)}</span>
        <span class="item__tag ${isOverdue ? "is-overdue" : ""}">${v.installments}x · ${formatMoney(perMonth)}/mês</span>
      </div>
      <div class="item__right">
        <span class="item__amount">${formatMoney(v.total)}</span>
        <span class="item__small">${isOverdue ? "Venceu" : "Vence"} ${dueText}</span>
      </div>
      <button type="button" class="item__remove" data-remove-invoice="${v.id}" aria-label="Remover ${escapeHtml(v.description)}">×</button>
    `;
  });
}

// ---------------------------------------------------------
// Gráficos (canvas + DOM, sem libs externas por causa da CSP)
// ---------------------------------------------------------
function drawDonut(t) {
  if (!donutCanvas || !donutCanvas.getContext) return;

  const segments = [
    { key: "fixos", label: "Fixos", value: t.fixed, color: CATEGORY_COLORS.fixos },
    { key: "variaveis", label: "Variáveis", value: t.variable, color: CATEGORY_COLORS.variaveis },
    { key: "assinaturas", label: "Assinaturas", value: t.subs, color: CATEGORY_COLORS.assinaturas },
    { key: "faturas", label: "Faturas", value: t.invoices, color: CATEGORY_COLORS.faturas },
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

  const cx = cssSize / 2;
  const cy = cssSize / 2;
  const outer = 84;
  const inner = 54;

  if (total === 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, (outer + inner) / 2, 0, Math.PI * 2);
    ctx.lineWidth = outer - inner;
    ctx.strokeStyle = "#18241e";
    ctx.stroke();
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
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    start += angle;
  }

  donutLegend.innerHTML = segments
    .map((seg) => {
      const pct = Math.round((seg.value / total) * 100);
      return `<li>
        <span class="dot" data-color="${seg.color}"></span>
        <span class="legend-name">${seg.label} · ${pct}%</span>
        <span class="legend-value">${formatMoney(seg.value)}</span>
      </li>`;
    })
    .join("");

  // cor via CSSOM (a CSP bloqueia style="" inline, mas permite element.style)
  donutLegend.querySelectorAll(".dot").forEach((dot) => {
    dot.style.backgroundColor = dot.getAttribute("data-color");
  });
}

function drawMeters(t) {
  if (!meterList) return;
  const max = Math.max(t.income, t.expenses, 1);
  const balanceStatus = statusFromRatio(t.ratio, t.balance);

  const rows = [
    { label: "Receita", value: t.income, width: (t.income / max) * 100, cls: "is-income" },
    { label: "Gastos", value: t.expenses, width: (t.expenses / max) * 100, cls: "is-expense" },
    {
      label: "Saldo",
      value: t.balance,
      width: (Math.abs(t.balance) / max) * 100,
      cls: `is-balance-${balanceStatus}`,
    },
  ];

  meterList.innerHTML = rows
    .map(
      (r) => `<div class="meter__row">
        <div class="meter__top"><span>${r.label}</span><span class="meter__val">${formatMoney(r.value)}</span></div>
        <div class="meter__track"><span class="meter__fill ${r.cls}" data-w="${Math.min(r.width, 100)}"></span></div>
      </div>`
    )
    .join("");

  // aplica larguras via CSSOM (CSP bloqueia style="" inline no HTML,
  // mas setar element.style por JS é permitido)
  meterList.querySelectorAll(".meter__fill").forEach((el) => {
    el.style.width = `${el.getAttribute("data-w")}%`;
  });
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

  const response = await authRequest("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!response) {
    showAuthMessage("Não foi possível conectar ao servidor. Tente novamente em instantes.", true);
    return;
  }
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

  const response = await authRequest("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!response || !response.ok) {
    const error = response ? await response.json().catch(() => null) : null;
    showAuthMessage(error?.error || "Falha ao criar conta.");
    return;
  }

  const data = await response.json();
  setToken(data.token);
  // Conta nova começa zerada, sempre. Não herda nada de quem usou antes.
  state = emptyState();
  setAuthenticated(data.user);
  salaryInput.value = "";
  render();
  showAuthMessage("Conta criada com sucesso.", false);
}

async function logout() {
  setToken("");
  setAuthenticated(null);
  state = emptyState();
  salaryInput.value = "";
  render();
}

// ---------------------------------------------------------
// Eventos
// ---------------------------------------------------------
salaryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = parseFloat(salaryInput.value);
  if (Number.isNaN(value) || value < 0) { salaryInput.focus(); return; }
  state.salary = value;
  render();
});

incomeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const description = incomeDescription.value.trim();
  const amount = parseFloat(incomeAmount.value);
  if (!description || Number.isNaN(amount) || amount <= 0) return;
  state.incomes.push({ id: generateId(), description, amount, date: new Date().toISOString().slice(0, 10) });
  incomeForm.reset();
  incomeDescription.focus();
  render();
});

expenseForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const description = expenseDescription.value.trim();
  const amount = parseFloat(expenseAmount.value);
  const type = expenseType.value;
  if (!description || Number.isNaN(amount) || amount <= 0) return;
  state.expenses.push({ id: generateId(), description, amount, type });
  expenseForm.reset();
  expenseType.value = type;
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
  state.subscriptions.push({ id: generateId(), name, amount, dueDay });
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
  state.invoices.push({ id: generateId(), description, total, dueDate, installments });
  invoiceForm.reset();
  invoiceInstallments.value = "1";
  render();
});

authForm.addEventListener("submit", async (event) => { event.preventDefault(); await login(); });
registerButton.addEventListener("click", async () => { await register(); });
logoutButton.addEventListener("click", async () => { await logout(); });

// Remoção delegada por lista
incomeList.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-remove-income]");
  if (!btn) return;
  state.incomes = state.incomes.filter((i) => i.id !== btn.getAttribute("data-remove-income"));
  render();
});
expenseList.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-remove-expense]");
  if (!btn) return;
  state.expenses = state.expenses.filter((e) => e.id !== btn.getAttribute("data-remove-expense"));
  render();
});
subscriptionList.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-remove-subscription]");
  if (!btn) return;
  state.subscriptions = state.subscriptions.filter((s) => s.id !== btn.getAttribute("data-remove-subscription"));
  render();
});
invoiceList.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-remove-invoice]");
  if (!btn) return;
  state.invoices = state.invoices.filter((v) => v.id !== btn.getAttribute("data-remove-invoice"));
  render();
});

clearDataButton.addEventListener("click", () => {
  const ok = window.confirm("Isso apaga salário, receitas, gastos, assinaturas e faturas desta conta. Continuar?");
  if (!ok) return;
  state = emptyState();
  salaryInput.value = "";
  render();
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
  if (name === "resumo") drawDonut(computeTotals()); // canvas precisa estar visível para medir
}
tabButtons.forEach((btn) => btn.addEventListener("click", () => activateTab(btn.dataset.tab)));

// Redesenha o donut ao redimensionar (densidade de pixels pode mudar)
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const resumoVisible = !$("panel-resumo").hidden;
    if (resumoVisible) drawDonut(computeTotals());
  }, 150);
});

// ---------------------------------------------------------
// Inicialização
// ---------------------------------------------------------
async function applyResolvedState() {
  const { resolved, needsResync } = await loadState();
  state = resolved;
  if (needsResync) saveBackendState().catch(() => {});
  salaryInput.value = state.salary > 0 ? state.salary : "";
  render();
}

async function initialize() {
  purgeLegacyState();
  const session = await getSession();
  setAuthenticated(session.authenticated ? session.user : null);
  if (session.authenticated) {
    await applyResolvedState();
  } else {
    render();
  }
}

async function reloadState() {
  await applyResolvedState();
}

initialize();

// Salvamento extra ao sair de foco (mobile costuma matar a aba)
function flushStateOnExit() {
  if (document.visibilityState === "hidden") saveState().catch(() => {});
}
document.addEventListener("visibilitychange", flushStateOnExit);
window.addEventListener("pagehide", flushStateOnExit);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
