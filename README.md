# Bot de lembretes de treino (Telegram)

Antes de cada treino, o aluno recebe no Telegram:

> Olá, Maria! 💪
> Lembrete do seu treino **hoje às 17:00**.
> Você vai?
>
> `[ ✅ Vou ]  [ ❌ Não vou ]`

Ele toca num botão e você recebe na hora: **"✅ Maria Souza confirmou o treino de hoje às 17:00."**

- **100% grátis**: roda no plano gratuito da Cloudflare, **sem cartão de crédito**.
- **Nada pra deixar ligado**: não precisa de celular velho nem de servidor.
- **Oficial**: bots são permitidos pelo Telegram, então não há risco de bloqueio.
- **Você administra tudo pelo Telegram**: cadastra alunos, vê quem confirmou, pausa em feriados.

---

## Instalação (uns 15 minutos, uma vez só)

Dá pra fazer tudo pelo celular.

### 1. Criar o bot no Telegram

1. No Telegram, procure por **@BotFather** (tem o selo azul de verificado) e toque em **Iniciar**.
2. Mande `/newbot`.
3. Ele pede um **nome**, que é o que os alunos veem. Ex: `Lembretes Prof. Lorran`
4. Depois pede um **usuário**, que precisa terminar em `bot`. Ex: `LembretesProfLorranBot`
5. Ele responde com um **token**, parecido com `7412345678:AAHk3...`. **Copie e guarde.** É a senha do seu bot, então não mostre pra ninguém.

### 2. Criar a conta na Cloudflare (grátis, sem cartão)

1. Abra **dash.cloudflare.com/sign-up**, coloque e-mail e senha e confirme o e-mail.

### 3. Instalar o bot com um botão

Toque no botão abaixo:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lorran202-byte/bot-lembretes)

1. Entre na sua conta da Cloudflare, se pedir.
2. Em **Git account**, conecte o seu **GitHub**. A Cloudflare cria uma cópia do bot na sua conta.
3. No campo **BOT_TOKEN**, cole o token do passo 1.
4. Deixe o resto como está e toque em **Create and deploy**, ou **Deploy**.
5. Espere 1 a 2 minutos até aparecer que terminou.

### 4. Ativar

1. Ainda na Cloudflare, abra o endereço do bot, que termina em `.workers.dev`. Também dá pra achar em **Workers & Pages › bot-lembretes › Visit**.
2. Vai aparecer **"✅ Bot ativado!"**. Toque em **Abrir no Telegram** e depois em **Iniciar**.
3. Faça isso logo: **quem tocar em Iniciar primeiro vira o administrador.**
4. O bot pergunta como você quer aparecer nas mensagens. Ex: `Prof. Lorran`

Pronto! 🎉

---

## Como usar

### Cadastrar um aluno

1. No bot, toque em **➕ Novo aluno**, ou mande `/novo`.
2. Digite o nome.
3. Digite os dias e horários do jeito que você fala, por exemplo:
   - `seg qua sex 17h`
   - `ter qui 6:30, sab 9h`
   - `segunda a sexta 18h`
4. O bot gera um **convite**. Toque em **📲 Enviar pelo WhatsApp** e mande pro aluno.
5. Quando o aluno tocar no link e em **Iniciar**, você recebe: *"🎉 Maria ativou os lembretes"*.

O aluno precisa ter o Telegram instalado. Ele só faz isso uma vez.

### No dia a dia

| Quero… | Faça |
|---|---|
| Ver quem confirmou hoje | `/hoje` ou **📅 Hoje** |
| Ver amanhã | `/amanha` |
| Mudar os horários de um aluno | **👥 Alunos › nome › 🕒 Mudar horários** |
| Aluno vai faltar só essa semana | **📅 Hoje/Amanhã › toque no treino › 🚫 Não enviar este lembrete** |
| Aluno parou por um tempo | **👥 Alunos › nome › ⏸ Pausar lembretes** |
| Feriado ou férias | **⚙️ Ajustes › ⏸ Pausar todos** |
| Mudar quanto tempo antes chega o lembrete | **⚙️ Ajustes › ⏰ Quanto tempo antes** (padrão: 2 horas) |
| Mandar o lembrete agora | **📅 Hoje › toque no treino › 📤 Enviar agora** |

O bot também te avisa quando:
- um aluno tem treino mas ainda não ativou o Telegram;
- um aluno bloqueou o bot;
- um aluno manda mensagem pro bot. Ela é encaminhada pra você.

---

## Dúvidas comuns

**Quanto custa?** Nada. O plano grátis da Cloudflare permite 100 mil acessos por dia, e o bot usa uns 1.500.

**Preciso deixar algo ligado?** Não. Ele roda nos servidores da Cloudflare.

**Perdi o token / alguém viu o token.** No @BotFather, mande `/revoke`, escolha o bot e copie o token novo. Depois, na Cloudflare: **Workers & Pages › bot-lembretes › Settings › Variables and Secrets ›** edite o `BOT_TOKEN`. Então abra o endereço `.workers.dev` de novo pra reativar.

**Outra pessoa virou administrador por engano.** Na Cloudflare: **Storage & Databases › D1 › bot-lembretes › Console**, rode `DELETE FROM config WHERE k = 'admin';` e toque em **Iniciar** no bot de novo.

**Os lembretes pararam.** Abra o endereço `.workers.dev`. Se aparecer erro, ele diz o que fazer. Confira também se não ficou pausado em **⚙️ Ajustes**.

---

<details>
<summary>Para quem entende de programação</summary>

- Cloudflare Worker (`src/index.js`), sem dependências em produção.
- Banco: Cloudflare D1. As tabelas são criadas automaticamente.
- Cron `* * * * *` envia os lembretes. Webhook do Telegram em `/telegram`, protegido por `secret_token`.
- Testes locais (Node 22+): `npm run teste`. Simulam o D1 com `node:sqlite` e a API do Telegram.
- A versão antiga para WhatsApp (Baileys) está no ramo [`whatsapp`](../../tree/whatsapp).

</details>
