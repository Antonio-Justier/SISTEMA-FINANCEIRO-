/* Teste de modelo em Node puro: stuba um DOM mínimo, carrega o
   script.js real e exercita normalizeState/computeTotals/parcelas.
   Foco: integridade de dados (migração) e correção do cálculo. */

const fs = require("fs");
const path = require("path");

// ---- stub de DOM mínimo ----
function fakeEl() {
  const el = {
    _children: [],
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    hidden: false,
    value: "",
    textContent: "",
    innerHTML: "",
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, remove() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    closest() { return null; },
    getContext() {
      return { setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, closePath() {}, fill() {}, stroke() {}, set fillStyle(_) {}, set strokeStyle(_) {}, set lineWidth(_) {} };
    },
    focus() {}, reset() {},
  };
  return el;
}

const elements = {};
const document = {
  getElementById(id) { return (elements[id] = elements[id] || fakeEl()); },
  querySelectorAll() { return []; },
  createElement() { return fakeEl(); },
  addEventListener() {},
  get activeElement() { return null; },
  body: fakeEl(),
  visibilityState: "visible",
};

const localStorageMap = new Map();
const localStorage = {
  getItem: (k) => (localStorageMap.has(k) ? localStorageMap.get(k) : null),
  setItem: (k, v) => localStorageMap.set(k, String(v)),
  removeItem: (k) => localStorageMap.delete(k),
};

const windowObj = {
  addEventListener() {}, removeEventListener() {},
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} }),
  confirm: () => true,
  alert: () => {},
  location: { origin: "https://app.test" },
};

global.window = windowObj;
global.document = document;
global.localStorage = localStorage;
global.navigator = { serviceWorker: undefined };
global.fetch = async () => { throw new Error("offline"); };
global.BACKEND_URL = "";
global.FileReader = function () {};
global.Blob = function () {};
global.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };

// carrega o script real
const code = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");
// remapeia identificadores globais usados no topo (const window/document não existem em node)
const wrapped = `(function(window, document, localStorage, navigator, fetch, BACKEND_URL, FileReader, Blob, URL){\n${code}\n})(global.window, global.document, global.localStorage, global.navigator, global.fetch, global.BACKEND_URL, global.FileReader, global.Blob, global.URL);`;
eval(wrapped);

const F = window.__finance;
let pass = 0, fail = 0;
function eq(name, got, exp) {
  const ok = Math.abs((got || 0) - exp) < 0.005 || got === exp;
  console.log(`${ok ? "✅" : "❌"} ${name}: ${JSON.stringify(got)}${ok ? "" : " (esperado " + JSON.stringify(exp) + ")"}`);
  ok ? pass++ : fail++;
}

const CUR = F.currentMonthKey();
const PREV = F.addMonths(CUR, -1);
const NEXT = F.addMonths(CUR, 1);

console.log("== mês atual:", CUR, "==\n");

// 1) MIGRAÇÃO v1 -> v2: estado antigo sem mês/categoria/startMonth
console.log("-- migração de estado v1 --");
const v1 = {
  salary: 5000,
  incomes: [{ id: "i1", description: "Freela", amount: 800 }],
  expenses: [
    { id: "e1", description: "Aluguel", amount: 1500, type: "FIXO" },
    { id: "e2", description: "Mercado", amount: 600, type: "VARIAVEL" },
  ],
  subscriptions: [{ id: "s1", name: "Netflix", amount: 39.9 }],
  invoices: [{ id: "v1", description: "Geladeira", total: 1200, dueDate: "2026-06-10", installments: 12 }],
  updatedAt: 123,
};
const mig = F.normalizeState(v1);
eq("salário preservado", mig.salary, 5000);
eq("income ganhou mês atual", mig.incomes[0].month === CUR ? 1 : 0, 1);
eq("FIXO ganhou startMonth atual", mig.expenses[0].startMonth === CUR ? 1 : 0, 1);
eq("FIXO ganhou categoria Outros", mig.expenses[0].category === "Outros" ? 1 : 0, 1);
eq("VARIAVEL ganhou month atual", mig.expenses[1].month === CUR ? 1 : 0, 1);
eq("assinatura ganhou startMonth atual", mig.subscriptions[0].startMonth === CUR ? 1 : 0, 1);
eq("fatura startMonth = mês do vencimento", mig.invoices[0].startMonth === "2026-06" ? 1 : 0, 1);
eq("nada foi perdido (contagem)", mig.incomes.length + mig.expenses.length + mig.subscriptions.length + mig.invoices.length, 5);

// 2) CÁLCULO comprometido x gasto x posso gastar (mês atual)
console.log("\n-- cálculo do mês atual --");
F.setState(mig);
F.setViewMonth(CUR);
const t = F.computeTotals(CUR);
// receita = 5000 + 800 = 5800
eq("receita", t.income, 5800);
// comprometido = fixo 1500 + subs 39.9 + parcela 1200/12=100 + reserva 0 = 1639.9
eq("comprometido", t.committed, 1639.9);
eq("já gasto (variável)", t.spent, 600);
// ainda posso gastar = 5800 - 1639.9 - 600 = 3560.1
eq("ainda posso gastar", t.canSpend, 3560.1);

// 3) PARCELA expira: a geladeira (12x a partir de 2026-06) não pode mais incidir 12 meses depois
console.log("\n-- ciclo de parcela --");
const startInv = "2026-06";
const monthIn = startInv;                       // mês 1: incide
const monthLast = F.addMonths(startInv, 11);    // mês 12: incide
const monthAfter = F.addMonths(startInv, 12);   // mês 13: NÃO incide
eq("parcela incide no mês 1", F.invoiceInstallmentFor(mig.invoices[0], monthIn), 100);
eq("parcela incide no mês 12", F.invoiceInstallmentFor(mig.invoices[0], monthLast), 100);
eq("parcela NÃO incide no mês 13", F.invoiceInstallmentFor(mig.invoices[0], monthAfter), 0);

// 4) RECORRÊNCIA: FIXO/assinatura não contam ANTES do startMonth nem DEPOIS do endMonth
console.log("\n-- recorrência (start/end) --");
const fixo = { startMonth: "2026-06", endMonth: null };
eq("FIXO não conta antes do início", F.isRecurringActive(fixo, "2026-05") ? 1 : 0, 0);
eq("FIXO conta no início", F.isRecurringActive(fixo, "2026-06") ? 1 : 0, 1);
const encerrado = { startMonth: "2026-06", endMonth: "2026-08" };
eq("encerrado conta em ago", F.isRecurringActive(encerrado, "2026-08") ? 1 : 0, 1);
eq("encerrado NÃO conta em set", F.isRecurringActive(encerrado, "2026-09") ? 1 : 0, 0);

// 5) RESERVA reduz o "posso gastar"
console.log("\n-- reserva (pay yourself first) --");
const st2 = F.normalizeState({ salary: 3000, savingsTarget: 500, expenses: [], incomes: [], subscriptions: [], invoices: [] });
F.setState(st2);
const t2 = F.computeTotals(CUR);
eq("reserva entra no comprometido", t2.committed, 500);
eq("posso gastar já desconta reserva", t2.canSpend, 2500);

// 6) IMPORT defensivo: lixo não vira estado válido
console.log("\n-- import defensivo --");
const junk = F.normalizeState({ salary: "abc", expenses: [{ amount: "x" }, null, { id: "ok", amount: 50, type: "VARIAVEL" }] });
eq("salário inválido vira 0", junk.salary, 0);
eq("itens inválidos filtrados (sobra 1)", junk.expenses.length, 1);

// 7) campos novos não quebram um mês sem dados
console.log("\n-- mês vazio --");
F.setState(F.emptyState());
const t0 = F.computeTotals(CUR);
eq("mês vazio: posso gastar 0", t0.canSpend, 0);
eq("mês vazio: ratio 0", t0.usedRatio, 0);

console.log(`\n${fail === 0 ? "TODOS OS TESTES PASSARAM ✅" : fail + " TESTE(S) FALHARAM ❌"} (${pass} ok, ${fail} falhas)`);
process.exit(fail === 0 ? 0 : 1);
