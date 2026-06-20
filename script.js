const STORAGE_KEY = "controle-financeiro:state";
const USE_BACKEND = window.location.protocol.startsWith("http");
const API_URL = "/api/state";

let state = {
  salary: 0,
  expenses: [], // { id, description, amount, type: "FIXO" | "VARIAVEL" }
};

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
  if (USE_BACKEND) {
    const backendState = await loadBackendState();
    if (backendState) return backendState;
  }
  return loadLocalState();
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const validShape =
      parsed &&
      typeof parsed.salary === "number" &&
      Array.isArray(parsed.expenses);

    return validShape ? parsed : null;
  } catch {
    return null;
  }
}

async function loadBackendState() {
  try {
    const response = await fetch(API_URL, { cache: "no-store" });
    if (!response.ok) return null;
    const parsed = await response.json();
    if (
      parsed &&
      typeof parsed.salary === "number" &&
      Array.isArray(parsed.expenses)
    ) {
      return parsed;
    }
  } catch {
    // Servidor não disponível ou falha de rede.
  }
  return null;
}

function saveState() {
  if (USE_BACKEND) {
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
  try {
    await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
  } catch {
    // Se o backend falhar, o app continua funcionando localmente.
  }
}

// ---------------------------------------------------------
// Referências de elementos
// ---------------------------------------------------------
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
const summaryTotalEl = document.getElementById("summary-total");

const expenseListEl = document.getElementById("expense-list");
const expenseEmptyEl = document.getElementById("expense-empty");
const clearDataButton = document.getElementById("clear-data");

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
  salaryInput.value = "";
  render();
});

// ---------------------------------------------------------
// Renderização
// ---------------------------------------------------------
function render() {
  const totalFixed = sumByType("FIXO");
  const totalVariable = sumByType("VARIAVEL");
  const totalExpenses = totalFixed + totalVariable;
  const balance = state.salary - totalExpenses;

  summarySalaryEl.textContent = formatMoney(state.salary);
  summaryFixedEl.textContent = formatMoney(totalFixed);
  summaryVariableEl.textContent = formatMoney(totalVariable);
  summaryTotalEl.textContent = formatMoney(totalExpenses);

  balanceAmountEl.textContent = formatMoney(balance);
  balanceAmountEl.classList.toggle("is-negative", balance < 0);

  balanceHintEl.textContent = buildHint(balance);

  renderExpenseList();
  saveState();
}

function sumByType(type) {
  return state.expenses
    .filter((expense) => expense.type === type)
    .reduce((sum, expense) => sum + expense.amount, 0);
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
    expenseListEl.appendChild(expenseEmptyEl);
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

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

async function initialize() {
  const loaded = await loadState();
  if (loaded) {
    state = loaded;
  }

  if (state.salary > 0) {
    salaryInput.value = state.salary;
  }

  render();
}

initialize();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}
