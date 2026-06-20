require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const bcrypt = require("bcrypt");
const session = require("express-session");
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

const DEFAULT_STATE = {
  salary: 0,
  expenses: [],
  invoices: [],
};

app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "img-src": ["'self'"],
        "connect-src": ["'self'"],
        "manifest-src": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "frame-ancestors": ["'none'"],
      },
    },
  })
);
app.use(express.json({ limit: "50kb" }));
app.use(
  session({
    secret: "troque-para-uma-chave-segura-local",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
    },
  })
);
app.use(express.static(path.join(__dirname)));

function isValidState(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.salary === "number" &&
    Array.isArray(value.expenses) &&
    Array.isArray(value.invoices) &&
    value.expenses.every(
      (expense) =>
        expense &&
        typeof expense.id === "string" &&
        typeof expense.description === "string" &&
        typeof expense.amount === "number" &&
        (expense.type === "FIXO" || expense.type === "VARIAVEL")
    ) &&
    value.invoices.every(
      (invoice) =>
        invoice &&
        typeof invoice.id === "string" &&
        typeof invoice.description === "string" &&
        typeof invoice.total === "number" &&
        typeof invoice.dueDate === "string" &&
        typeof invoice.installments === "number" &&
        invoice.installments >= 1
    )
  );
}

function isValidUsername(value) {
  return typeof value === "string" && value.trim().length >= 3;
}

function isValidPassword(value) {
  return typeof value === "string" && value.length >= 6;
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

async function loadUsers() {
  return (await loadJsonFile(USERS_FILE, [])).filter(
    (user) => user && user.id && user.username && user.passwordHash
  );
}

async function saveUsers(users) {
  await saveJsonFile(USERS_FILE, users);
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

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  res.status(401).json({ error: "Não autenticado" });
}

async function getUserFromSession(req) {
  if (!req.session || !req.session.userId) return null;
  const users = await loadUsers();
  return users.find((user) => user.id === req.session.userId) || null;
}

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;

  if (!isValidUsername(username) || !isValidPassword(password)) {
    return res.status(400).json({
      error: "Usuário precisa ter pelo menos 3 caracteres e senha pelo menos 6 caracteres.",
    });
  }

  const normalizedUsername = username.trim().toLowerCase();
  const users = await loadUsers();
  if (users.some((user) => user.username.toLowerCase() === normalizedUsername)) {
    return res.status(409).json({ error: "Usuário já existe." });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const userId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const user = {
    id: userId,
    username: username.trim(),
    passwordHash,
  };

  users.push(user);
  await saveUsers(users);
  req.session.userId = userId;

  res.json({ user: { id: user.id, username: user.username } });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  if (!isValidUsername(username) || !isValidPassword(password)) {
    return res.status(400).json({ error: "Usuário e senha inválidos." });
  }

  const users = await loadUsers();
  const user = users.find(
    (item) => item.username.toLowerCase() === username.trim().toLowerCase()
  );

  if (!user) {
    return res.status(401).json({ error: "Usuário ou senha incorretos." });
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    return res.status(401).json({ error: "Usuário ou senha incorretos." });
  }

  req.session.userId = user.id;
  res.json({ user: { id: user.id, username: user.username } });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.sendStatus(204);
  });
});

app.get("/api/session", async (req, res) => {
  const user = await getUserFromSession(req);
  if (!user) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, user: { id: user.id, username: user.username } });
});

app.get("/api/state", requireAuth, async (req, res) => {
  let state = await readStateFile(req.session.userId);
  if (supabase) {
    const supabaseState = await getSupabaseState(req.session.userId);
    if (supabaseState) {
      state = supabaseState;
    }
  }
  res.json(state);
});

app.post("/api/state", requireAuth, async (req, res) => {
  const state = req.body;
  if (!isValidState(state)) {
    return res.status(400).json({ error: "Estado inválido" });
  }

  try {
    await writeStateFile(req.session.userId, state);
    if (supabase) {
      await saveSupabaseState(req.session.userId, state);
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
