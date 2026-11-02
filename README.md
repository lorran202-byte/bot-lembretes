# Bot de lembretes de treino (WhatsApp oficial)

Antes de cada treino, o aluno recebe no WhatsApp:

> Olá, Maria! 💪
>
> Lembrete do seu treino **hoje às 17:00** com Prof. Lorran.
>
> Você vai?
>
> `[ Sim, vou ]  [ Não vou ]`

Ele toca num botão e você recebe na hora: **"✅ Maria Souza confirmou o treino de hoje às 17:00."**

- **API oficial da Meta**: o número do bot não corre risco de bloqueio.
- **Nada pra deixar ligado**: roda no plano grátis da Cloudflare.
- **O aluno não instala nada**: é o WhatsApp que ele já usa, e funciona em iPhone e Android.
- **Você administra tudo pelo seu WhatsApp**: cadastra alunos, vê quem confirmou, pausa em feriados.

## Quanto custa

A Cloudflare é grátis. A Meta cobra **por lembrete enviado**: cerca de **R$0,04** cada (mensagem "de utilidade" no Brasil).

| Alunos | Treinos/semana cada | Lembretes/mês | Custo/mês |
|---|---|---|---|
| 10 | 3 | ~130 | ~R$5 |
| 20 | 4 | ~350 | ~R$14 |

As respostas do bot ("Presença confirmada!") e os avisos para você são grátis até 1.000 por mês. Os avisos para você só são cobrados quando você passa mais de 24h sem falar com o bot. Nesse caso, eles ficam guardados e chega **uma** mensagem "Você tem X avisos" (R$0,04), no máximo a cada 3 horas.

A cobrança é no cartão de crédito cadastrado na Meta. Você pode pôr um limite de gasto.

---

## O que você precisa

- **Um chip só para o bot** (pode ser pré-pago barato). Esse número **não pode estar no WhatsApp** do celular. Se já estiver, apague a conta do WhatsApp dele antes (WhatsApp › Configurações › Conta › Apagar conta).
- **Um computador** para a parte da Meta: o site de desenvolvedores é ruim de usar no celular.
- Um cartão de crédito.

## Instalação (uns 40 minutos, uma vez só)

### 1. Criar o app na Meta

1. Abra **developers.facebook.com**, entre com o seu Facebook e toque em **Começar** para virar desenvolvedor.
2. Vá em **Meus apps › Criar app**.
3. No caso de uso, escolha **Conectar-se com clientes pelo WhatsApp**.
4. Quando pedir um **portfólio empresarial**, crie um com o seu nome profissional (ex: `Prof. Lorran Amorim`).
5. Termine de criar o app.

### 2. Colocar o número do bot

1. No menu do app, abra **WhatsApp › Configuração da API**.
2. Desça até **Adicionar número de telefone**.
3. Preencha o perfil. O **nome de exibição** é o que os alunos veem, ex: `Prof. Lorran Personal`. A Meta revisa esse nome.
4. Digite o número do chip e confirme com o código que chega por SMS.
5. Volte em **Configuração da API**, escolha o seu número no campo **De** e **anote os dois números** que aparecem:
   - **Identificação do número de telefone** → vai no `WA_PHONE_ID`
   - **Identificação da conta do WhatsApp Business** → vai no `WA_WABA_ID`

> Não use o "número de teste" que a Meta oferece: ele só manda mensagem para 5 pessoas.

### 3. Cadastrar o cartão

1. Abra **business.facebook.com/settings**.
2. Vá em **Contas › Contas do WhatsApp**, escolha a sua e abra **Configurações de pagamento**.
3. Adicione o cartão. Sem cartão, a Meta não deixa enviar os lembretes.

### 4. Gerar o token permanente

Ainda em **business.facebook.com/settings**:

1. **Usuários › Usuários do sistema › Adicionar**. Dê um nome (ex: `bot-lembretes`) e escolha a função **Administrador**.
2. Toque nele e em **Atribuir ativos**:
   - **Apps** › o seu app › **Controle total**
   - **Contas do WhatsApp** › a sua conta › **Controle total**
3. Toque em **Gerar token** e escolha o seu app.
4. Em **Validade**, escolha **Nunca**.
5. Marque as permissões **whatsapp_business_messaging** e **whatsapp_business_management**.
6. **Copie o token e guarde.** Ele vai no `WA_TOKEN`. É a senha do bot, então não mostre para ninguém.

### 5. Pegar o ID e a chave do app

No site de desenvolvedores, abra **Configurações do app › Básico**:

- **ID do app** → vai no `WA_APP_ID`
- **Chave secreta do app** (toque em Mostrar) → vai no `WA_APP_SECRET`

### 6. Colocar tudo na Cloudflare

**Se você já tinha o bot do Telegram instalado:**

1. Em **dash.cloudflare.com**, abra **Workers & Pages › bot-lembretes › Settings › Variables and Secrets**.
2. Adicione os 5 itens como **Secret**: `WA_TOKEN`, `WA_PHONE_ID`, `WA_WABA_ID`, `WA_APP_ID` e `WA_APP_SECRET`.
3. Apague o `BOT_TOKEN`, que era do Telegram.
4. Se o Worker está ligado a este repositório do GitHub, a versão nova sobe sozinha. Se não estiver, use o botão abaixo.

**Se for instalar do zero:**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lorran202-byte/bot-lembretes)

Entre na Cloudflare (a conta é grátis e não pede cartão), conecte o GitHub, preencha os 5 campos e toque em **Deploy**.

### 7. Publicar o app na Meta

Sem esta etapa, a Meta não manda para o bot as respostas dos alunos.

1. Em **Configurações do app › Básico**, no campo **URL da Política de Privacidade**, coloque o endereço do seu bot com `/privacidade` no final, ex: `https://bot-lembretes.seunome.workers.dev/privacidade`. Essa página já vem pronta no bot.
2. Escolha uma **categoria** e salve.
3. No topo da página, mude o **Modo do app** para **Ao vivo** (ou toque em **Publicar**).

### 8. Ativar

1. Abra o endereço do bot, o que termina em `.workers.dev`.
2. O bot registra o número, liga o webhook e manda para a Meta aprovar as duas mensagens modelo (o lembrete do aluno e os avisos para você). A página mostra como está cada etapa.
3. Pelo celular, **com o seu WhatsApp pessoal**, toque em **Abrir no WhatsApp** e envie a mensagem que aparecer. **Quem enviar primeiro vira o administrador**, então faça logo.
4. O bot pergunta como você quer aparecer nas mensagens. Ex: `Prof. Lorran`

A Meta costuma aprovar as mensagens modelo em minutos ou poucas horas. Abra o endereço `.workers.dev` de novo para ver se já foram aprovadas. Os lembretes só começam a sair depois disso.

Pronto! 🎉

---

## Como usar

Mande **menu** para o bot a qualquer momento.

### Cadastrar um aluno

1. No menu, toque em **➕ Novo aluno**, ou mande `novo`.
2. Digite o nome.
3. Digite os dias e horários do jeito que você fala, por exemplo:
   - `seg qua sex 17h`
   - `ter qui 6:30, sab 9h`
   - `segunda a sexta 18h`
4. O bot gera um **convite**. Toque em **📲 Enviar ao aluno** e escolha a conversa dele.
5. O aluno toca no link e envia a mensagem que aparece. Aí você recebe: *"🎉 Maria ativou os lembretes"*.

### No dia a dia

| Quero… | Faça |
|---|---|
| Ver quem confirmou hoje | `hoje` ou **📅 Hoje** |
| Ver amanhã | `amanhã` |
| Mudar os horários de um aluno | **👥 Alunos › nome › 🕒 Mudar horários** |
| Aluno vai faltar só essa semana | **📅 Hoje/Amanhã › Ver treinos › escolha o treino › 🚫 Não enviar** |
| Aluno parou por um tempo | **👥 Alunos › nome › ⏸ Pausar lembretes** |
| Feriado ou férias | **⚙️ Ajustes › ⏸ Pausar todos** |
| Mudar quanto tempo antes chega o lembrete | **⚙️ Ajustes › ⏰ Quanto tempo antes** (padrão: 2 horas) |
| Mandar o lembrete agora | **📅 Hoje › Ver treinos › escolha o treino › 📤 Enviar agora** |

O bot também te avisa quando:
- um aluno tem treino mas ainda não ativou os lembretes;
- o WhatsApp não consegue entregar o lembrete (por exemplo, se o aluno bloqueou o número do bot);
- um aluno manda mensagem para o bot. Ela é encaminhada para você, com um link para responder pelo seu WhatsApp.

---

## Dúvidas comuns

**Vim do bot do Telegram. Perdi meus alunos?** Não. Nomes e horários continuam lá. Só que cada aluno precisa ativar de novo pelo WhatsApp: abra **👥 Alunos › nome › 🔗 Link de convite** e mande para ele. Você também precisa virar administrador de novo (passo 8).

**A página diz que a mensagem do lembrete foi rejeitada.** Abra **WhatsApp › Gerenciador do WhatsApp › Modelos de mensagem** na Meta para ver o motivo. Apague o modelo rejeitado e abra o endereço `.workers.dev` de novo, que o bot cria outro.

**O token parou de funcionar.** Gere outro (passo 4) e atualize o `WA_TOKEN` na Cloudflare.

**Outra pessoa virou administrador por engano.** Na Cloudflare: **Storage & Databases › D1 › lembretes-treino › Console**, rode `DELETE FROM config WHERE k = 'admin';` e faça o passo 8 de novo.

**Os lembretes pararam.** Abra o endereço `.workers.dev`. Se tiver algo errado, a página diz o que fazer. Confira também se não ficou pausado em **⚙️ Ajustes** e se o cartão na Meta está em dia.

**"Registrar o número" deu erro de PIN.** Esse número já tinha confirmação em duas etapas. Adicione o segredo `WA_PIN` com esse PIN de 6 dígitos na Cloudflare e abra o endereço de novo.

---

<details>
<summary>Para quem entende de programação</summary>

- Cloudflare Worker (`src/index.js`), sem dependências em produção. Usa a WhatsApp Cloud API (Graph API `v24.0`).
- Banco: Cloudflare D1. As tabelas são criadas e migradas automaticamente, inclusive a partir da versão do Telegram.
- Cron `* * * * *` envia os lembretes com o modelo `lembrete_treino` (UTILITY, pt_BR) e botões de resposta rápida com payload.
- Webhook em `/whatsapp`: `GET` para a verificação da Meta e `POST` conferido com `X-Hub-Signature-256`. Mensagens repetidas são ignoradas pelo id.
- Fora da janela de 24h do administrador, os avisos vão para a tabela `avisos` e é enviado o modelo `avisos_personal`.
- Testes locais (Node 22+): `npm run teste`. Simulam o D1 com `node:sqlite` e a API da Meta, e conferem os limites de botões e listas.
- A versão para Telegram está no ramo [`telegram`](../../tree/telegram). A versão antiga para WhatsApp não oficial (Baileys) está no ramo [`whatsapp`](../../tree/whatsapp).

</details>
