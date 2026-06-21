const fs = require("fs");
const path = require("path");
const { JSDOM } = require("/tmp/node_modules/jsdom");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://app.test/" });
const { window } = dom;

// Stubs de ambiente que o jsdom não implementa
window.fetch = async () => { throw new Error("offline"); };
const ls = new Map();
Object.defineProperty(window, "localStorage", { value: {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
}, configurable: true });
window.HTMLCanvasElement.prototype.getContext = () => ({
  setTransform(){}, clearRect(){}, beginPath(){}, arc(){}, closePath(){}, fill(){}, stroke(){},
  set fillStyle(_){}, set strokeStyle(_){}, set lineWidth(_){},
});
window.confirm = () => true;
window.BACKEND_URL = "";
window.matchMedia = window.matchMedia || (() => ({ matches:false, addListener(){}, removeListener(){} }));

// injeta o BACKEND_URL e o script
const backendCfg = fs.readFileSync(path.join(__dirname,"backend-config.js"),"utf8").replace(/const BACKEND_URL.*/,'window.BACKEND_URL="";');
const code = fs.readFileSync(path.join(__dirname,"script.js"), "utf8");

const errors = [];
window.addEventListener("error", (e) => errors.push(e.message));
const origErr = console.error;

try {
  window.eval(backendCfg);
  window.eval(code);
} catch (e) {
  console.log("ERRO ao carregar script:", e.message);
  process.exit(1);
}

// dá um tick pras promises de initialize() resolverem
setTimeout(() => {
  const doc = window.document;
  const visibleApp = !doc.getElementById("app-layout").hidden;
  const authVisible = !doc.getElementById("auth-panel").hidden;
  console.log("App visível (deslogado):", visibleApp, "| Painel de login visível:", authVisible);

  // simula login manual chamando os fluxos internos via DOM:
  // como não há backend, testamos o motor de cálculo direto manipulando estado pela UI logada.
  // Forçar logado:
  doc.getElementById("app-layout").hidden = false;
  doc.getElementById("auth-panel").hidden = true;

  // lança salário
  doc.getElementById("salary-input").value = "5000";
  doc.getElementById("salary-form").dispatchEvent(new window.Event("submit"));
  // gasto fixo 1500
  doc.getElementById("expense-description").value = "Aluguel";
  doc.getElementById("expense-amount").value = "1500";
  doc.getElementById("expense-type").value = "FIXO";
  doc.getElementById("expense-form").dispatchEvent(new window.Event("submit"));
  // assinatura 39.90
  doc.getElementById("subscription-name").value = "Netflix";
  doc.getElementById("subscription-amount").value = "39.90";
  doc.getElementById("subscription-form").dispatchEvent(new window.Event("submit"));
  // receita extra 800
  doc.getElementById("income-description").value = "Freela";
  doc.getElementById("income-amount").value = "800";
  doc.getElementById("income-form").dispatchEvent(new window.Event("submit"));

  const balance = doc.getElementById("balance-amount").textContent;
  const heroIncome = doc.getElementById("hero-income").textContent;
  const committed = doc.getElementById("hero-committed").textContent;
  const spent = doc.getElementById("hero-spent").textContent;
  const cardClass = doc.getElementById("balance-card").className;
  console.log("Receita:", heroIncome, "| Comprometido:", committed, "| Já gasto:", spent, "| Saldo:", balance, "| Estado cor:", cardClass);

  // esperado: receita 5800; comprometido 1539,90 (fixo+assinatura); já gasto 0; saldo 4260,10; verde (is-ok)
  const okCalc = balance.includes("4.260,10") && heroIncome.includes("5.800,00") && committed.includes("1.539,90") && cardClass.includes("is-ok");

  // testa transição de cor: estoura gasto pra >90%
  doc.getElementById("expense-description").value = "Carro";
  doc.getElementById("expense-amount").value = "4000";
  doc.getElementById("expense-type").value = "VARIAVEL";
  doc.getElementById("expense-form").dispatchEvent(new window.Event("submit"));
  const cardClass2 = doc.getElementById("balance-card").className;
  console.log("Após gasto grande -> Estado cor:", cardClass2, "| Saldo:", doc.getElementById("balance-amount").textContent);
  const okColor = cardClass2.includes("is-danger");

  console.log("Erros capturados:", errors.length ? errors : "nenhum");
  console.log(okCalc && okColor && errors.length===0 ? "\nSMOKE OK ✅" : "\nSMOKE FALHOU ❌");
}, 200);
