const express = require("express");
const helmet = require("helmet");
const fs = require("fs").promises;
const path = require("path");

const app = express();
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

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

const DEFAULT_STATE = {
  salary: 0,
  expenses: [],
};

function isValidState(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.salary === "number" &&
    Array.isArray(value.expenses) &&
    value.expenses.every(
      (expense) =>
        expense &&
        typeof expense.id === "string" &&
        typeof expense.description === "string" &&
        typeof expense.amount === "number" &&
        (expense.type === "FIXO" || expense.type === "VARIAVEL")
    )
  );
}

async function ensureDataDirectory() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    console.error("Falha ao criar diretório de dados:", error);
  }
}

async function readStateFile() {
  try {
    const content = await fs.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(content);
    return isValidState(parsed) ? parsed : DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

async function writeStateFile(state) {
  await ensureDataDirectory();
  const payload = JSON.stringify(state, null, 2);
  await fs.writeFile(STATE_FILE, payload, "utf-8");
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get("/api/state", async (req, res) => {
  const state = await readStateFile();
  res.json(state);
});

app.post("/api/state", async (req, res) => {
  const state = req.body;
  if (!isValidState(state)) {
    return res.status(400).json({ error: "Estado inválido" });
  }

  try {
    await writeStateFile(state);
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
