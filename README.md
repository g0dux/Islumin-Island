# Islumin Island - Sistema Online

Sistema de jogo online para Islumin Island com salas multiplayer compatível com Railway.

## Funcionalidades

- **Sistema de Salas**: Crie ou entre em salas de jogo
- **Multiplayer em Tempo Real**: Sincronização de jogadores via Socket.IO
- **Chat Online**: Sistema de chat para comunicação entre jogadores
- **Compatível com Railway**: Deploy fácil na plataforma Railway

## Como Executar Localmente

1. **Instalar dependências**:
   ```bash
   npm install
   ```

2. **Executar servidor**:
   ```bash
   npm start
   ```

3. **Acessar o jogo**:
   Abra `http://localhost:3000` no navegador

## Como Fazer Deploy no Railway

1. **Instalar Railway CLI**:
   ```bash
   npm install -g @railway/cli
   ```

2. **Fazer login**:
   ```bash
   railway login
   ```

3. **Inicializar projeto**:
   ```bash
   railway init
   ```

4. **Fazer deploy**:
   ```bash
   railway up
   ```

## Estrutura do Projeto

```
├── server.js          # Servidor Node.js com Socket.IO
├── package.json       # Dependências e scripts
├── railway.json       # Configuração do Railway
├── public/
│   └── index.html     # Jogo HTML com sistema multiplayer
└── README.md          # Este arquivo
```

## Sistema de Salas

- **Criar Sala**: Clique no botão "Criar Sala" e defina nome e número máximo de jogadores
- **Entrar em Sala**: Clique em "Entrar" na lista de salas disponíveis
- **Chat**: Use o sistema de chat para comunicação com outros jogadores

## Tecnologias Utilizadas

- **Backend**: Node.js + Express + Socket.IO
- **Frontend**: HTML5 + JavaScript + Canvas
- **Deploy**: Railway
- **Comunicação**: WebSockets para tempo real

## Configuração de Ambiente

O servidor detecta automaticamente se está rodando localmente ou em produção:
- **Local**: `http://localhost:3000`
- **Produção**: Usa a URL do Railway automaticamente

## Recursos do Multiplayer

- Sincronização de posição dos jogadores
- Sistema de inventário compartilhado
- Chat em tempo real
- Salas com limite de jogadores
- Auto-save para partidas multiplayer
