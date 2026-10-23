# Bot de lembretes de treino (WhatsApp)

Manda um lembrete no WhatsApp para cada aluno particular antes do treino, com um link onde ele toca em **✅ Vou** ou **❌ Não vou**. Você recebe um aviso no seu WhatsApp quando ele responde e acompanha tudo num painel pelo celular.

- Grátis: roda num servidor gratuito da Oracle Cloud.
- Funciona em qualquer celular (Android ou iPhone), o aluno não instala nada.
- O aluno também pode responder **1** (vou) ou **2** (não vou) direto na conversa.

> ⚠️ O bot usa o WhatsApp Web de forma não oficial. Com poucas mensagens por dia o risco é baixo, mas existe. Por isso é recomendado usar **um chip só para o bot**.

---

## Guia de instalação (uns 30 minutos, uma vez só)

Dá pra fazer tudo pelo navegador do celular, mas é bem mais confortável num computador. No celular, ative o **modo desktop** do navegador.

### 1. Criar a conta grátis na Oracle Cloud

1. Acesse **oracle.com/br/cloud/free** e toque em **Comece gratuitamente**.
2. Preencha os dados. Em **Região inicial**, escolha **Brazil East (São Paulo)**.
3. Ela pede um cartão só para verificar a identidade. O plano *Always Free* não cobra nada.

### 2. Criar a chave de acesso (no Cloud Shell)

1. No painel da Oracle, toque no ícone **>_ (Cloud Shell)** no topo.
2. Quando abrir o terminal, cole e dê Enter:
   ```
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 && cat ~/.ssh/id_ed25519.pub
   ```
3. Copie a linha que aparece (começa com `ssh-ed25519`). Ela vai no próximo passo.

### 3. Criar o servidor

1. Menu **☰ › Compute › Instances › Create instance**.
2. Nome: `bot-lembretes`.
3. **Image and shape › Edit**:
   - Imagem: **Ubuntu 24.04** (ou 22.04).
   - Shape: **VM.Standard.E2.1.Micro** (tem o selo *Always Free-eligible*).
4. **Add SSH keys**: escolha **Paste public keys** e cole a linha do passo 2.
5. Toque em **Create** e espere ficar **Running** (verde).
6. Anote o **Public IP address** que aparece na página da instância.

### 4. Liberar a porta 80 (para o link e o painel abrirem)

1. Na página da instância, toque no link da **Subnet**.
2. Toque em **Security Lists › Default Security List**.
3. **Add Ingress Rules**:
   - Source CIDR: `0.0.0.0/0`
   - IP Protocol: `TCP`
   - Destination Port Range: `80`
4. Salve.

### 5. Instalar o bot

1. Volte ao **Cloud Shell** e conecte no servidor (troque pelo seu IP):
   ```
   ssh ubuntu@SEU.IP.AQUI
   ```
   Se perguntar `Are you sure...`, digite `yes`.
2. Cole o instalador:
   ```
   curl -fsSL https://raw.githubusercontent.com/lorran202-byte/bot-lembretes/main/instalar.sh | bash
   ```
3. Quando pedir, crie a **senha do painel**.
4. No fim aparece o endereço do painel, tipo `http://SEU.IP/painel`.

### 6. Conectar o WhatsApp

1. Abra o painel no celular e entre com a senha.
2. Aba **WhatsApp**, digite o número que vai mandar os lembretes e toque em **Gerar código**.
3. No celular desse número: **WhatsApp › Aparelhos conectados › Conectar um aparelho › Conectar com número de telefone**, e digite o código.

> Também dá pra escanear o QR Code, abrindo o painel em outro aparelho.

### 7. Configurar e cadastrar

1. **Ajustes**: seu nome, seu WhatsApp (para receber os avisos) e quanto tempo antes mandar o lembrete (padrão: 2 horas).
2. **Alunos › + Novo aluno**: nome, WhatsApp e horários. Marque vários dias de uma vez se o horário for o mesmo.
3. Na aba **WhatsApp**, mande um teste para o seu número.

Pronto. A aba **Agenda** mostra os treinos de hoje e amanhã e quem confirmou.

---

## Dia a dia

- **Feriado ou férias**: Ajustes › *Pausar todos os lembretes*.
- **Um aluno vai faltar uma semana**: na Agenda, toque no treino › *Não enviar este lembrete*.
- **Aluno parou de treinar por um tempo**: Alunos › desligue *Enviar lembretes para este aluno*.
- **Mensagem**: dá pra mudar em Ajustes. Use `{nome}`, `{dia}`, `{hora}`, `{link}` e `{personal}`.

## Manutenção

Conecte no servidor (`ssh ubuntu@SEU.IP` pelo Cloud Shell) e use:

| Para | Comando |
|---|---|
| Ver o que o bot está fazendo | `pm2 logs bot-lembretes` |
| Reiniciar | `pm2 restart bot-lembretes` |
| Atualizar para a versão nova | `bash ~/bot-lembretes/atualizar.sh` |
| Trocar a senha do painel | `nano ~/bot-lembretes/.env` e depois reiniciar |

Os alunos e a agenda ficam em `~/bot-lembretes/dados/dados.json`.

## Dúvidas comuns

**O painel não abre.** Confira o passo 4 (porta 80) e se o servidor está *Running*.

**O WhatsApp desconectou.** Abra o painel › WhatsApp e conecte de novo. Seus alunos continuam salvos.

**A Oracle pode desligar o servidor?** Ela pode recuperar servidores gratuitos que ficam quase parados por muito tempo. Se acontecer, é só ligar de novo na página da instância. Para evitar de vez, dá pra mudar a conta para *Pay As You Go*: continua grátis dentro dos limites do Always Free.

**O aluno disse que não recebeu.** Veja na Agenda se aparece *Erro no envio*. O mais comum é o número errado ou sem WhatsApp.
