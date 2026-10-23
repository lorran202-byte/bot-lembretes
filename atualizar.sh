#!/usr/bin/env bash
# Atualiza o bot para a versão mais nova, sem perder alunos nem a conexão do WhatsApp.
set -euo pipefail
cd "$(dirname "$0")"
git pull --ff-only
npm install --omit=dev --no-audit --no-fund
pm2 restart bot-lembretes
echo "Atualizado!"
