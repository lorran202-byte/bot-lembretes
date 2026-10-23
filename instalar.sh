#!/usr/bin/env bash
# Instala o bot de lembretes num servidor Ubuntu (ex: Oracle Cloud Always Free).
# Uso: curl -fsSL https://raw.githubusercontent.com/lorran202-byte/bot-lembretes/main/instalar.sh | bash
set -euo pipefail

REPO="${REPO:-https://github.com/lorran202-byte/bot-lembretes.git}"
PASTA="$HOME/bot-lembretes"

verde() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

verde "Atualizando o sistema e instalando o básico"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y curl git ca-certificates iptables-persistent netfilter-persistent

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  verde "Instalando o Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# Máquinas pequenas (1 GB) ficam mais estáveis com memória extra em disco
if ! swapon --show | grep -q .; then
  verde "Criando 2 GB de memória extra (swap)"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

if [ -f "./src/server.js" ] && [ -f "./package.json" ]; then
  PASTA="$(pwd)"
elif [ -d "$PASTA/.git" ]; then
  verde "Atualizando o bot"
  git -C "$PASTA" pull --ff-only
else
  verde "Baixando o bot"
  git clone "$REPO" "$PASTA"
fi
cd "$PASTA"

verde "Instalando as dependências (pode levar uns minutos)"
npm install --omit=dev --no-audit --no-fund

if [ ! -f .env ]; then
  verde "Configuração inicial"
  SENHA=""
  while [ ${#SENHA} -lt 6 ]; do
    read -r -s -p "Crie uma senha para o painel (mínimo 6 caracteres): " SENHA < /dev/tty; echo
  done
  IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me || echo SEU-IP)"
  cat > .env <<EOF
SENHA_PAINEL=$SENHA
URL_PUBLICA=http://$IP
PORT=80
FUSO=America/Fortaleza
EOF
  chmod 600 .env
fi

verde "Liberando a porta 80 no firewall do servidor"
sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
sudo netfilter-persistent save >/dev/null 2>&1 || true

# permite o Node usar a porta 80 sem rodar como administrador
sudo setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(command -v node)")"

verde "Deixando o bot ligado 24h (pm2)"
command -v pm2 >/dev/null || sudo npm install -g pm2 --no-audit --no-fund
pm2 delete bot-lembretes >/dev/null 2>&1 || true
pm2 start src/server.js --name bot-lembretes --time
pm2 save
sudo env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$USER" --hp "$HOME" >/dev/null

URL="$(grep '^URL_PUBLICA=' .env | cut -d= -f2-)"
verde "Pronto!"
echo "Abra no celular:  $URL/painel"
echo "Se não abrir, confira a etapa 'Liberar a porta 80' no guia."
echo
echo "Comandos úteis:"
echo "  pm2 logs bot-lembretes     (ver o que o bot está fazendo)"
echo "  pm2 restart bot-lembretes  (reiniciar)"
echo "  bash ~/bot-lembretes/atualizar.sh  (atualizar)"
