require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const fs = require("fs").promises;
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const JWT_SECRET = process.env.JWT_SECRET || "troque-para-uma-chave-jwt-segura";
const JWT_EXPIRY = "7d";

const DEFAULT_STATE = {
  salary: 0,
  incomes: [],
  expenses: [],
  subscriptions: [],
  invoices: [],
};

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        "manifest-src": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "frame-ancestors": ["'none'"],
      },
    },
  })
);
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname)));

// --- Validações de cada tipo ---
function isValidExpense(expense) {
  return (
    expense &&
    typeof expense.id === "string" &&
    typeof expense.description === "string" &&
    typeof expense.amount === "number" &&
    (expense.type === "FIXO" || expense.type === "VARIAVEL")
  );
}

function isValidInvoice(invoice) {
  return (
    invoice &&
    typeof invoice.id === "string" &&
    typeof invoice.description === "string" &&
    typeof invoice.total === "number" &&
    typeof invoice.dueDate === "string" &&
    typeof invoice.installments === "number" &&
    invoice.installments >= 1
  );
}

function isValidIncome(income) {
  return (
    income &&
    typeof income.id === "string" &&
    typeof income.description === "string" &&
    typeof income.amount === "number"
  );
}

function isValidSubscription(sub) {
  return (
    sub &&
    typeof sub.id === "string" &&
    typeof sub.name === "string" &&
    typeof sub.amount === "number"
  );
}

function isValidState(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.salary !== "number") return false;
  if (!Array.isArray(value.expenses) || !value.expenses.every(isValidExpense)) return false;
  if (!Array.isArray(value.invoices) || !value.invoices.every(isValidInvoice)) return false;

  // Campos novos são opcionais (compatibilidade com estados antigos),
  // mas se vierem, precisam estar no formato correto.
  if (value.incomes !== undefined) {
    if (!Array.isArray(value.incomes) || !value.incomes.every(isValidIncome)) return false;
  }
  if (value.subscriptions !== undefined) {
    if (!Array.isArray(value.subscriptions) || !value.subscriptions.every(isValidSubscription)) return false;
  }
  // Reserva mensal: opcional, mas se vier precisa ser número não-negativo
  // (evita gravar lixo que quebraria o cálculo de "posso gastar" no cliente).
  if (value.savingsTarget !== undefined) {
    if (typeof value.savingsTarget !== "number" || !Number.isFinite(value.savingsTarget) || value.savingsTarget < 0) {
      return false;
    }
  }
  return true;
}

function isValidUsername(value) {
  return typeof value === "string" && value.trim().length >= 3;
}

function isValidPassword(value) {
  return typeof value === "string" && value.length >= 6;
}

// Login não deve aplicar os mínimos de cadastro: contas antigas podem ter
// credenciais mais curtas. Aqui só validamos presença para não travar o login.
function isPresentUsername(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPresentPassword(value) {
  return typeof value === "string" && value.length > 0;
}

async function ensureDataDirectory() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    console.error("Falha ao criar diretório de dados:", error);
  }
}

async function loadJsonFile(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

async function saveJsonFile(filePath, data) {
  await ensureDataDirectory();
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

async function loadUsersFromFile() {
  return (await loadJsonFile(USERS_FILE, [])).filter(
    (user) => user && user.id && user.username && user.passwordHash
  );
}

async function saveUsersToFile(users) {
  await saveJsonFile(USERS_FILE, users);
}

// Busca um usuário pelo username (case-insensitive). Usa Supabase quando
// configurado (produção/Vercel); cai para arquivo local só em dev sem Supabase.
async function findUserByUsername(username) {
  if (supabase) {
    const { data, error } = await supabase
      .from("users")
      .select("id, username, password_hash")
      .ilike("username", username.trim())
      .maybeSingle();

    if (error) {
      console.error("Falha ao buscar usuário no Supabase:", error);
      return null;
    }
    if (!data) return null;
    return { id: data.id, username: data.username, passwordHash: data.password_hash };
  }

  const users = await loadUsersFromFile();
  return (
    users.find((item) => item.username.toLowerCase() === username.trim().toLowerCase()) || null
  );
}

async function findUserById(userId) {
  if (supabase) {
    const { data, error } = await supabase
      .from("users")
      .select("id, username, password_hash")
      .eq("id", userId)
      .maybeSingle();

    if (error || !data) return null;
    return { id: data.id, username: data.username, passwordHash: data.password_hash };
  }

  const users = await loadUsersFromFile();
  return users.find((user) => user.id === userId) || null;
}

async function createUser(user) {
  if (supabase) {
    const { error } = await supabase.from("users").insert({
      id: user.id,
      username: user.username,
      password_hash: user.passwordHash,
    });

    if (error) {
      // 23505 = violação de unique constraint (username duplicado)
      if (error.code === "23505") {
        throw new Error("DUPLICATE_USERNAME");
      }
      console.error("Falha ao criar usuário no Supabase:", error);
      throw error;
    }
    return;
  }

  const users = await loadUsersFromFile();
  if (users.some((item) => item.username.toLowerCase() === user.username.toLowerCase())) {
    throw new Error("DUPLICATE_USERNAME");
  }
  users.push(user);
  await saveUsersToFile(users);
}

function userStateFile(userId) {
  return path.join(DATA_DIR, `state-${userId}.json`);
}

async function readStateFile(userId) {
  return (await loadJsonFile(userStateFile(userId), DEFAULT_STATE)) ?? DEFAULT_STATE;
}

async function writeStateFile(userId, state) {
  await saveJsonFile(userStateFile(userId), state);
}

function createToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function getUserIdFromRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== "string") {
    return null;
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.userId;
  } catch {
    return null;
  }
}

async function saveSupabaseState(userId, state) {
  if (!supabase) {
    return;
  }

  const { data, error } = await supabase
    .from("finance_state")
    .upsert({ user_id: userId, state }, { onConflict: ["user_id"] });

  if (error) {
    console.error("Falha ao salvar estado no Supabase:", error);
  }

  return data;
}

async function getSupabaseState(userId) {
  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from("finance_state")
    .select("state")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    return null;
  }

  return data.state;
}

async function requireAuth(req, res, next) {
  const userId = getUserIdFromRequest(req);
  if (!userId) {
    return res.status(401).json({ error: "Não autenticado" });
  }

  const user = await findUserById(userId);
  if (!user) {
    return res.status(401).json({ error: "Não autenticado" });
  }

  req.user = user;
  next();
}

async function getUserFromToken(req) {
  const userId = getUserIdFromRequest(req);
  if (!userId) return null;
  return findUserById(userId);
}

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;

  if (!isValidUsername(username) || !isValidPassword(password)) {
    return res.status(400).json({
      error: "Usuário precisa ter pelo menos 3 caracteres e senha pelo menos 6 caracteres.",
    });
  }

  const existing = await findUserByUsername(username);
  if (existing) {
    return res.status(409).json({ error: "Usuário já existe." });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const userId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const user = {
    id: userId,
    username: username.trim(),
    passwordHash,
  };

  try {
    await createUser(user);
  } catch (error) {
    if (error.message === "DUPLICATE_USERNAME") {
      return res.status(409).json({ error: "Usuário já existe." });
    }
    console.error("Falha ao registrar usuário:", error);
    return res.status(500).json({ error: "Falha ao criar conta." });
  }

  // Garante que a conta nova começa com estado limpo no backend.
  try {
    await writeStateFile(user.id, DEFAULT_STATE);
    if (supabase) await saveSupabaseState(user.id, DEFAULT_STATE);
  } catch (error) {
    console.error("Falha ao inicializar estado do novo usuário:", error);
  }

  const token = createToken(user.id);

  res.json({
    user: { id: user.id, username: user.username },
    token,
  });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  if (!isPresentUsername(username) || !isPresentPassword(password)) {
    return res.status(400).json({ error: "Usuário e senha inválidos." });
  }

  const user = await findUserByUsername(username);

  if (!user) {
    return res.status(401).json({ error: "Usuário ou senha incorretos." });
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    return res.status(401).json({ error: "Usuário ou senha incorretos." });
  }

  const token = createToken(user.id);
  res.json({
    user: { id: user.id, username: user.username },
    token,
  });
});

app.post("/api/logout", (req, res) => {
  res.sendStatus(204);
});

app.get("/api/session", async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, user: { id: user.id, username: user.username } });
});

app.get("/api/state", requireAuth, async (req, res) => {
  let state = await readStateFile(req.user.id);
  if (supabase) {
    const supabaseState = await getSupabaseState(req.user.id);
    if (supabaseState) {
      state = supabaseState;
    }
  }
  // Sempre devolve com os campos esperados preenchidos.
  res.json({ ...DEFAULT_STATE, ...state });
});

app.post("/api/state", requireAuth, async (req, res) => {
  const state = req.body;
  if (!isValidState(state)) {
    return res.status(400).json({ error: "Estado inválido" });
  }

  try {
    await writeStateFile(req.user.id, state);
    if (supabase) {
      await saveSupabaseState(req.user.id, state);
    }
    res.sendStatus(204);
  } catch (error) {
    console.error("Erro ao gravar estado:", error);
    res.status(500).json({ error: "Falha ao salvar estado" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor iniciado em http://localhost:${port}`);
});
