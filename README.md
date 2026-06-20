# Financeiro — Quanto posso gastar?

PWA de controle financeiro pessoal. Você lança salário, recebimentos extras, gastos
fixos/variáveis, assinaturas de streaming e faturas parceladas; o app mostra o saldo
disponível e quanto da sua receita já foi comprometida — com o saldo mudando de cor
(verde → amarelo → vermelho) conforme você aperta o orçamento.

Frontend estático (HTML/CSS/JS puro, sem framework) + backend Node/Express com
autenticação JWT e persistência em arquivo local ou Supabase.

---

## O bug que foi corrigido (importante)

**Sintoma relatado:** ao criar um usuário novo e entrar, ele via o salário/dados do
usuário anterior.

**Causa real:** o cache local (`localStorage`) usava **uma única chave global**
(`controle-financeiro:state`) compartilhada por todos os usuários do mesmo dispositivo.
Quando o usuário B entrava, sobrava o estado do usuário A no cache. Na hora de decidir
"o que está mais novo, o cache ou o servidor?", o app comparava o `updatedAt` recente do
A contra o estado zerado do B (recém-criado, `updatedAt: 0`), concluía que o **cache do A
era mais novo** e — pior — disparava um *resync* que **gravava o salário do A dentro da
conta do B no backend**. Ou seja: não era só um problema visual, estava **corrompendo
dado no servidor entre contas**.

**Correção:**
- O cache passou a ser **namespaced por usuário**: `controle-financeiro:state:<userId>`.
- O app **nunca** trata o cache de outro usuário como válido.
- A chave global antiga é **purgada** no carregamento (`purgeLegacyState`).
- No registro, o estado é **resetado para vazio** (`emptyState`), tanto no front quanto no
  backend (o `/api/register` agora inicializa o estado zerado da nova conta).

Há um teste de fumaça (`smoke.js`) que simula esse fluxo com jsdom e confirma a correção
do cálculo e da troca de cores.

---

## Funcionalidades

- **Resumo:** saldo disponível em destaque, com cor e barra de progresso por % de receita
  comprometida; gráfico de rosca (donut) com a distribuição dos gastos; medidores por
  categoria; quadro de totais (salário, extras, fixos, variáveis, assinaturas, faturas).
- **Gastos:** lançamento de despesas `FIXO`/`VARIAVEL` e dos **recebimentos extras**
  ("valor recebido por fora").
- **Assinaturas:** aba dedicada para streamings/serviços recorrentes, com dia de
  vencimento e total mensal.
- **Faturas:** aba dedicada para compras parceladas; o app divide o total pelas parcelas e
  considera só a parcela do mês no cálculo do saldo.
- **Saldo colorido:** verde (folga), amarelo (acima de ~70% da receita usada), vermelho
  (acima de ~90% ou saldo negativo).
- **PWA:** instalável, com service worker (offline para a casca do app; nunca cacheia
  `/api/`).

### Modelo de dados (estado por usuário)

```js
state = {
  salary: number,
  incomes:       [{ id, description, amount, date }],
  expenses:      [{ id, description, amount, type: "FIXO" | "VARIAVEL" }],
  subscriptions: [{ id, name, amount, dueDay }],
  invoices:      [{ id, description, total, dueDate, installments }],
  updatedAt: number
}
```

Cálculo:
```
receita  = salary + Σ incomes.amount
gastos   = Σ fixos + Σ variáveis + Σ subscriptions.amount + Σ (invoice.total / installments)
saldo    = receita - gastos
usado(%) = gastos / receita
```

---

## Rodando localmente

```bash
npm install
npm start          # sobe em http://localhost:3000 (serve o front + a API)
```

Sem variáveis de ambiente, o backend cai no modo **arquivo local** (pasta `data/`),
suficiente para desenvolvimento.

### Variáveis de ambiente

| Variável                    | Obrigatória | Para quê                                           |
|-----------------------------|-------------|----------------------------------------------------|
| `JWT_SECRET`                | **Sim** (prod) | Assinar os tokens. **Troque** o valor padrão.   |
| `SUPABASE_URL`              | Não         | Ativa persistência no Supabase.                    |
| `SUPABASE_SERVICE_ROLE_KEY` | Não         | Chave de serviço do Supabase.                      |
| `PORT`                      | Não         | Porta (padrão 3000).                               |

> Se `SUPABASE_URL` **e** `SUPABASE_SERVICE_ROLE_KEY` estiverem setadas, usa Supabase;
> senão, usa arquivos em `data/`.

### Tabelas no Supabase

```sql
-- usuários
create table users (
  id            text primary key,
  username      text unique not null,
  password_hash text not null
);

-- estado financeiro por usuário
create table finance_state (
  user_id text primary key references users(id),
  state   jsonb not null
);
```

### Deploy (Vercel)

O backend serve tanto a API quanto os arquivos estáticos. Configure as variáveis de
ambiente no painel da Vercel. O `backend-config.js` do front aponta para a URL pública do
backend — ajuste se hospedar separado.

---

## Limitações e riscos de segurança (leia antes de usar pra valer)

Sendo direto, porque isso importa mais que o resto:

1. **Token JWT no `localStorage`.** É prático, mas fica **exposto a XSS**: qualquer script
   malicioso injetado na página consegue ler o token e se passar por você. O padrão mais
   seguro é cookie `httpOnly` + `SameSite`. Enquanto for `localStorage`, a CSP estrita
   (sem `unsafe-inline`, sem CDN) é a sua principal linha de defesa — **não afrouxe ela**.
2. **CORS permissivo.** `origin: true` + `credentials: true` reflete **qualquer origem**.
   Para produção, troque por uma lista branca dos domínios que você realmente usa.
3. **Validação de senha é fraca.** Foi corrigida a incoerência (a mensagem prometia
   mínimo de 3/6 caracteres mas o código aceitava qualquer coisa não-vazia); agora o
   **cadastro** exige usuário ≥3 e senha ≥6. Mas isso ainda é o mínimo do mínimo: não há
   exigência de complexidade, rate limiting nem proteção contra força bruta no login.
4. **Sem rate limiting.** O endpoint de login aceita tentativas ilimitadas. Para algo
   sério, coloque um `express-rate-limit` na frente de `/api/login` e `/api/register`.
5. **Gráficos feitos na mão.** Por causa da CSP estrita, **não dá pra usar Chart.js nem
   nenhuma lib de CDN**. O donut é desenhado direto no canvas. É de propósito — só esteja
   ciente de que adicionar libs externas exigiria afrouxar a CSP (não recomendado).
6. **`JWT_SECRET` tem valor padrão.** Se você esquecer de setar em produção, os tokens
   ficam assináveis por qualquer um que conheça o padrão do código. **Sempre** defina um
   segredo forte em produção.

Nada disso impede o uso pessoal, mas se um dia isso virar multiusuário "de verdade",
os itens 1, 2 e 4 são os que eu resolveria primeiro.

---

## Estrutura

```
index.html            # UI com abas (Resumo / Gastos / Assinaturas / Faturas)
style.css             # tema preto + verde derivado da logo
script.js             # lógica do front, cálculos, donut em canvas, sync
server.js             # API Express + JWT + bcrypt + Supabase/arquivo
service-worker.js     # PWA offline (nunca cacheia /api/)
manifest.webmanifest  # manifesto do PWA
backend-config.js     # URL pública do backend
smoke.js              # teste de fumaça (jsdom) do fluxo principal
icon-*.png / icon.svg # ícones
```
