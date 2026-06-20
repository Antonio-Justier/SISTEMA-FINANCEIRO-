const STORAGE_KEY = "controle-financeiro:state";
const TOKEN_KEY = "controle-financeiro:token";
const USE_BACKEND = true;

const API_BASE = (typeof BACKEND_URL !== "undefined" ? String(BACKEND_URL).trim().replace(/\/+$/, "") : "") || "";
const API_URL = `${API_BASE}/api/state`;
const API_AUTH = `${API_BASE}/api`;

let state = {
  salary: 0,
  expenses: [], // { id, description, amount, type: "FIXO" | "VARIAVEL" }
  invoices: [], // { id, description, total, dueDate, installments }
};

let currentUser = null;
let currentToken = "";

const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

function formatMoney(value) {
  return currency.format(value);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function loadState() {
  const session = await getSession();
  if (session.authenticated) {
    currentUser = session.user;
    const backendState = await loadBackendState();
    if (backendState) return backendState;
  }
  return loadLocalState() || { salary: 0, expenses: [], invoices: [] };
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const validShape =
      parsed &&
      typeof parsed.salary === "number" &&
      Array.isArray(parsed.expenses) &&
      Array.isArray(parsed.invoices);

    return validShape ? parsed : null;
  } catch {
    return null;
  }
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function setToken(token) {
  currentToken = token || "";
  if (currentToken) {
    localStorage.setItem(TOKEN_KEY, currentToken);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

async function getSession() {
  const token = getToken();
  if (!token) return { authenticated: false };

  try {
    const response = await fetch(`${API_AUTH}/session`, {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
      },
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
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) return null;
    const parsed = await response.json();
    if (
      parsed &&
      typeof parsed.salary === "number" &&
      Array.isArray(parsed.expenses) &&
      Array.isArray(parsed.invoices)
    ) {
      return parsed;
    }
  } catch {
    // Servidor não disponível ou falha de rede.
  }
  return null;
}

async function saveState() {
  if (USE_BACKEND && currentUser) {
    saveBackendState().catch(() => saveLocalState());
    return;
  }

  saveLocalState();
}

function saveLocalState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Armazenamento indisponível; os dados continuam funcionando,
    // mas não persistem entre recarregamentos nesse caso.
  }
}

async function saveBackendState() {
  const token = getToken();
  if (!token) return;

  try {
    await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(state),
    });
  } catch {
    // Se o backend falhar, o app continua funcionando localmente.
  }
}

async function authRequest(path, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  try {
    const response = await fetch(`${API_AUTH}${path}`, {
      ...options,
      headers,
    });
    return response;
  } catch {
    return null;
  }
}

function showAuthMessage(message, isError = true) {
  authMessage.textContent = message;
  authMessage.className = isError ? "auth-message auth-message--error" : "auth-message auth-message--success";
}

function setAuthenticated(user) {
  currentUser = user;

  if (!USE_BACKEND) {
    authPanel.style.display = "none";
    appLayout.style.display = "grid";
    authBar.style.display = "none";
    authUser.textContent = "";
    subtitleText.textContent = "Modo local ativo. Seus dados ficam salvos neste aparelho.";
    return;
  }

  if (user) {
    const displayName = user.email || user.username || "usuário";
    authPanel.style.display = "none";
    appLayout.style.display = "grid";
    authBar.style.display = "flex";
    authUser.textContent = `Olá, ${displayName}`;
    subtitleText.textContent = "Seu saldo e gastos são salvos apenas para você.";
  } else {
    authPanel.style.display = "block";
    appLayout.style.display = "none";
    authBar.style.display = "none";
    authUser.textContent = "";
    subtitleText.textContent = "Informe seu salário, lance os gastos do mês e veja na hora o que ainda pode gastar.";
  }
}

// ---------------------------------------------------------
// Referências de elementos
// ---------------------------------------------------------
const authPanel = document.getElementById("auth-panel");
const authForm = document.getElementById("auth-form");
const authEmail = document.getElementById("auth-email");
const authPassword = document.getElementById("auth-password");
const loginButton = document.getElementById("login-button");
const registerButton = document.getElementById("register-button");
const authMessage = document.getElementById("auth-message");
const authBar = document.getElementById("auth-bar");
const authUser = document.getElementById("auth-user");
const logoutButton = document.getElementById("logout-button");
const appLayout = document.getElementById("app-layout");
const subtitleText = document.getElementById("subtitle-text");

const salaryForm = document.getElementById("salary-form");
const salaryInput = document.getElementById("salary-input");

const expenseForm = document.getElementById("expense-form");
const descriptionInput = document.getElementById("expense-description");
const amountInput = document.getElementById("expense-amount");
const typeInput = document.getElementById("expense-type");

const balanceAmountEl = document.getElementById("balance-amount");
const balanceHintEl = document.getElementById("balance-hint");
const summarySalaryEl = document.getElementById("summary-salary");
const summaryFixedEl = document.getElementById("summary-fixed");
const summaryVariableEl = document.getElementById("summary-variable");
const summaryInvoicesEl = document.getElementById("summary-invoices");
const summaryTotalEl = document.getElementById("summary-total");

const expenseListEl = document.getElementById("expense-list");
const expenseEmptyEl = document.getElementById("expense-empty");
const clearDataButton = document.getElementById("clear-data");
const invoiceListEl = document.getElementById("invoice-list");
const invoiceEmptyEl = document.getElementById("invoice-empty");
const invoiceForm = document.getElementById("invoice-form");
const invoiceDescriptionInput = document.getElementById("invoice-description");
const invoiceTotalInput = document.getElementById("invoice-total");
const invoiceDueDateInput = document.getElementById("invoice-due-date");
const invoiceInstallmentsInput = document.getElementById("invoice-installments");

// ---------------------------------------------------------
// Eventos
// ---------------------------------------------------------
salaryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = parseFloat(salaryInput.value);

  if (Number.isNaN(value) || value < 0) {
    salaryInput.focus();
    return;
  }

  state.salary = value;
  render();
});

expenseForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const description = descriptionInput.value.trim();
  const amount = parseFloat(amountInput.value);
  const type = typeInput.value;

  if (!description || Number.isNaN(amount) || amount <= 0) {
    return;
  }

  state.expenses.push({ id: generateId(), description, amount, type });

  expenseForm.reset();
  typeInput.value = type; // mantém o último tipo selecionado, agiliza lançamentos seguidos
  descriptionInput.focus();

  render();
});

invoiceForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const description = invoiceDescriptionInput.value.trim();
  const total = parseFloat(invoiceTotalInput.value);
  const dueDate = invoiceDueDateInput.value;
  const installments = parseInt(invoiceInstallmentsInput.value, 10);

  if (!description || Number.isNaN(total) || total <= 0 || !dueDate || Number.isNaN(installments) || installments < 1) {
    return;
  }

  state.invoices.push({
    id: generateId(),
    description,
    total,
    dueDate,
    installments,
  });

  invoiceForm.reset();
  invoiceInstallmentsInput.value = "1";

  render();
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await login();
});

registerButton.addEventListener("click", async () => {
  await register();
});

logoutButton.addEventListener("click", async () => {
  await logout();
});

expenseListEl.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-remove-id]");
  if (!removeButton) return;

  const id = removeButton.getAttribute("data-remove-id");
  state.expenses = state.expenses.filter((expense) => expense.id !== id);
  render();
});

clearDataButton.addEventListener("click", () => {
  const confirmed = window.confirm(
    "Isso vai apagar o salário e todos os gastos salvos. Quer continuar?"
  );
  if (!confirmed) return;

  state.salary = 0;
  state.expenses = [];
  state.invoices = [];
  salaryInput.value = "";
  render();
});

invoiceListEl.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-remove-invoice-id]");
  if (!removeButton) return;

  const id = removeButton.getAttribute("data-remove-invoice-id");
  state.invoices = state.invoices.filter((invoice) => invoice.id !== id);
  render();
});

async function login() {
  const email = authEmail.value.trim();
  const password = authPassword.value;
  if (!email || !password) {
    showAuthMessage("Preencha email e senha.");
    return;
  }

  const response = await authRequest("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: email, password }),
  });

  if (!response) {
    showAuthMessage(
      "Não foi possível conectar ao backend. Rode o servidor com npm start e abra a página via localhost.",
      true
    );
    return;
  }

  if (!response.ok) {
    showAuthMessage("Falha ao entrar. Verifique usuário e senha.");
    return;
  }

  const data = await response.json();
  setToken(data.token);
  setAuthenticated(data.user);
  await reloadState();
  showAuthMessage("Entrou com sucesso.", false);
}

async function register() {
  const email = authEmail.value.trim();
  const password = authPassword.value;
  if (!email || !password) {
    showAuthMessage("Preencha email e senha.");
    return;
  }

  const response = await authRequest("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: email, password }),
  });

  if (!response || !response.ok) {
    const error = response ? await response.json().catch(() => null) : null;
    showAuthMessage(error?.error || "Falha ao criar conta.");
    return;
  }

  const data = await response.json();
  setToken(data.token);
  setAuthenticated(data.user);
  await reloadState();
  showAuthMessage("Conta criada com sucesso.", false);
}

async function logout() {
  setToken("");
  setAuthenticated(null);
  state = { salary: 0, expenses: [], invoices: [] };
  render();
}

// ---------------------------------------------------------
// Renderização
// ---------------------------------------------------------
function render() {
  const totalFixed = sumByType("FIXO");
  const totalVariable = sumByType("VARIAVEL");
  const totalInvoices = sumInvoiceInstallments();
  const totalExpenses = totalFixed + totalVariable + totalInvoices;
  const balance = state.salary - totalExpenses;

  summarySalaryEl.textContent = formatMoney(state.salary);
  summaryFixedEl.textContent = formatMoney(totalFixed);
  summaryVariableEl.textContent = formatMoney(totalVariable);
  summaryInvoicesEl.textContent = formatMoney(totalInvoices);
  summaryTotalEl.textContent = formatMoney(totalExpenses);

  balanceAmountEl.textContent = formatMoney(balance);
  balanceAmountEl.classList.toggle("is-negative", balance < 0);

  balanceHintEl.textContent = buildHint(balance);

  renderExpenseList();
  renderInvoiceList();
  saveState().catch(() => {});
}

function sumByType(type) {
  return state.expenses
    .filter((expense) => expense.type === type)
    .reduce((sum, expense) => sum + expense.amount, 0);
}

function sumInvoiceInstallments() {
  return state.invoices
    .reduce((sum, invoice) => sum + invoice.total / Math.max(invoice.installments, 1), 0);
}

function buildHint(balance) {
  if (state.salary === 0) {
    return "Informe seu salário para começar.";
  }
  if (balance < 0) {
    return "Seus gastos já passaram do salário deste mês.";
  }
  if (balance === state.salary) {
    return "Nenhum gasto lançado ainda — esse é o total disponível.";
  }
  return "Valor que ainda pode ser gasto neste mês, considerando o que já foi lançado.";
}

function renderExpenseList() {
  expenseListEl.innerHTML = "";

  if (state.expenses.length === 0) {
    expenseListEl.appendChild(document.createElement("li")).textContent = "Nenhum gasto lançado ainda.";
    expenseListEl.firstChild.className = "receipt__empty";
    return;
  }

  // Mais recentes primeiro, para o usuário ver de cara o que acabou de lançar.
  const sorted = [...state.expenses].reverse();

  for (const expense of sorted) {
    const item = document.createElement("li");
    item.className = "receipt__item";

    item.innerHTML = `
      <div class="receipt__item-info">
        <span class="receipt__item-desc">${escapeHtml(expense.description)}</span>
        <span class="receipt__item-tag ${expense.type === "FIXO" ? "is-fixed" : ""}">
          ${expense.type === "FIXO" ? "fixo" : "variável"}
        </span>
      </div>
      <div class="receipt__item-right">
        <span class="receipt__item-amount">${formatMoney(expense.amount)}</span>
        <button
          type="button"
          class="receipt__item-remove"
          data-remove-id="${expense.id}"
          aria-label="Remover ${escapeHtml(expense.description)}"
        >×</button>
      </div>
    `;

    expenseListEl.appendChild(item);
  }
}

function renderInvoiceList() {
  invoiceListEl.innerHTML = "";

  if (state.invoices.length === 0) {
    invoiceListEl.appendChild(document.createElement("li")).textContent = "Nenhuma fatura lançada.";
    invoiceListEl.firstChild.className = "receipt__empty";
    return;
  }

  const sorted = [...state.invoices].reverse();

  for (const invoice of sorted) {
    const due = new Date(invoice.dueDate);
    const now = new Date();
    const isOverdue = due < now && invoice.installments >= 1;
    const dueText = new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(due);

    const item = document.createElement("li");
    item.className = "receipt__item";

    item.innerHTML = `
      <div class="receipt__item-info">
        <span class="receipt__item-desc">${escapeHtml(invoice.description)}</span>
        <span class="receipt__item-tag ${isOverdue ? "is-overdue" : ""}">
          ${invoice.installments} ${invoice.installments === 1 ? "parcela" : "parcelas"}
        </span>
      </div>
      <div class="receipt__item-right">
        <span class="receipt__item-amount">${formatMoney(invoice.total)}</span>
        <span class="receipt__item-small">Vence em ${dueText}</span>
        <button
          type="button"
          class="receipt__item-remove"
          data-remove-invoice-id="${invoice.id}"
          aria-label="Remover ${escapeHtml(invoice.description)}"
        >×</button>
      </div>
    `;

    invoiceListEl.appendChild(item);
  }
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

async function initialize() {
  const session = await getSession();
  setAuthenticated(session.authenticated ? session.user : null);

  const loaded = await loadState();
  if (loaded) {
    state = loaded;
  }

  if (state.salary > 0) {
    salaryInput.value = state.salary;
  }

  render();
}

async function reloadState() {
  const loaded = await loadState();
  if (loaded) {
    state = loaded;
  } else {
    state = { salary: 0, expenses: [], invoices: [] };
  }

  if (state.salary > 0) {
    salaryInput.value = state.salary;
  }

  render();
}

initialize();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
