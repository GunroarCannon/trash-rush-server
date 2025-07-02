const express = require('express');
const http = require('http');
const socketio = require('socket.io');

class GameServer {
  constructor() {
    this.games = {};
    this.players = {};
    this.publicGames = new Map();
    this.privateGames = new Map();
    this.gameReadyStates = {};
    this.lastActivity = Date.now();
    this.ACTIVITY_TIMEOUT = 300000; // 5 minutes
    this.powerupManager = new PowerupManager();
  }

  initialize() {
    const app = express();
    app.use(express.json());

    // Wake endpoint
    app.post('/wake', (req, res) => {
      console.log('Received wake call from client');
      this.lastActivity = Date.now();
      res.json({
        status: 'awake',
        ping: Date.now() - parseInt(req.body.timestamp),
        message: 'Server is active and responding'
      });
    });

    // Health check
    app.get('/health', (req, res) => {
      res.status(200).send('OK');
    });

    const server = http.createServer(app);
    const io = socketio(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
      },
      transports: ['websocket', 'polling'], // Important for Render
      allowUpgrades: true,
      pingTimeout: 60000,
      pingInterval: 25000
    });

    // Add explicit WebSocket upgrade handler
    server.on('upgrade', (req, socket, head) => {
      console.log('WebSocket upgrade requested');
      io.engine.handleUpgrade(req, socket, head, (ws) => {
        io.engine.onWebSocket(req, ws);
      });
    });

    // Keep-alive (modified for Render)
    setInterval(() => {
      if (Date.now() - this.lastActivity > this.ACTIVITY_TIMEOUT) {
        console.log('Performing self-ping to maintain instance');
        fetch(`http://localhost:${process.env.PORT || 3000}/health`)
          .catch(err => console.error('Keep-alive failed:', err));
      }
    }, 60000);

    // Socket.io events
    io.on('connection', (socket) => {
      console.log(`Player connected: ${socket.id}`);
      this.players[socket.id] = { socket, gameId: null };

      socket.on('disconnect', () => this.handleDisconnect(socket));
      socket.on('quickPlay', (data) => this.handleQuickPlay(socket, data));
      socket.on('createPrivateGame', () => this.createPrivateGame(socket));
      socket.on('joinPrivateGame', (data) => this.joinPrivateGame(socket, data));
      socket.on('playerReady', (data) => this.setPlayerReady(socket, data));
      socket.on('playerAction', (data) => this.handlePlayerAction(socket, data));
      socket.on('roundComplete', () => this.handleRoundComplete(socket));
    });

    server.listen(3000, () => console.log('Server running on port 3000'));
  }

  // Combined game creation logic
  createGame(socket, isPublic = true) {
    const gameId = `game_${Date.now()}`;
    const game = {
      id: gameId,
      players: [socket.id],
      host: socket.id,
      readyStates: {},
      round: 1,
      maxRounds: 3,
      gameState: 'lobby',
      trashType: this.getRandomTrashType(),
      negativeMode: false,
      scores: {},
      powerups: this.powerupManager.generatePowerupPool(gameId),
      isPublic,
      createdAt: Date.now()
    };

    if (isPublic) {
      this.publicGames.set(gameId, game);
    } else {
      this.privateGames.set(gameId, game);
    }

    this.players[socket.id].gameId = gameId;
    socket.emit(isPublic ? 'gameCreated' : 'privateGameCreated', { 
      gameId,
      isHost: true,
      seed: gameId
    });

    return gameId;
  }

  // Enhanced join game with both public/private support
  joinGame(socket, gameId, character, isPublic = true) {
    const game = isPublic ? this.publicGames.get(gameId) : this.privateGames.get(gameId);
    if (!game || game.players.length >= 4) {
      socket.emit('gameError', { message: game ? 'Game is full' : 'Game not found' });
      return false;
    }

    game.players.push(socket.id);
    this.players[socket.id] = { socket, gameId };
    game.scores[socket.id] = 0;

    // Notify all players
    socket.to(gameId).emit('playerJoined', {
      playerId: socket.id,
      position: game.players.length,
      character
    });

    socket.emit('gameJoined', {
      gameId,
      isHost: false,
      seed: gameId,
      currentRound: game.round,
      players: game.players.map(id => ({
        id,
        position: game.players.indexOf(id) + 1,
        character: id === socket.id ? character : this.players[id]?.character
      }))
    });

    // Auto-start if full
    if (game.players.length === 4) {
      this.startGame(gameId, isPublic);
    }

    return true;
  }

  // Combined game management methods
  handleQuickPlay(socket, { character }) {
    this.cleanupOldGames();
    
    // Find available public game
    let gameId;
    for (const [id, game] of this.publicGames) {
      if (!game.gameStarted && game.players.length < 4) {
        gameId = id;
        break;
      }
    }

    if (gameId) {
      this.joinGame(socket, gameId, character, true);
    } else {
      gameId = this.createGame(socket, true);
      this.joinGame(socket, gameId, character, true);
    }
  }

  createPrivateGame(socket) {
    const gameId = this.createGame(socket, false);
    socket.emit('privateGameCreated', { gameId });
  }

  joinPrivateGame(socket, { gameId, character }) {
    this.joinGame(socket, gameId, character, false);
  }

  // All other methods (handlePlayerAction, startRound, endRound, etc.)
  // ... remain the same as in your first implementation ...

  // Cleanup old games
  cleanupOldGames() {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    
    [this.publicGames, this.privateGames].forEach(gameMap => {
      for (const [id, game] of gameMap) {
        if (now - game.createdAt > maxAge || game.players.length === 0) {
          gameMap.delete(id);
        }
      }
    });
  }
}

class PowerupManager {
  constructor() {
    this.powerups = {
      // Your powerup definitions here
    };
  }

}

// Initialize server
const gameServer = new GameServer();
gameServer.initialize();
