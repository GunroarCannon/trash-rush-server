const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const seedrandom = require('seedrandom');

class GameServer {
  constructor() {
    this.games = {}; // Active game sessions
    this.players = {}; // Connected players
    this.powerupManager = new PowerupManager();
  }

  initialize() {
    const app = express();
    const server = http.createServer(app);
    const io = socketio(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });

    io.on('connection', (socket) => {
      console.log(`Player connected: ${socket.id}`);
      this.players[socket.id] = { socket, gameId: null };

      socket.on('disconnect', () => this.handleDisconnect(socket));
      socket.on('createGame', () => this.createGame(socket));
      socket.on('joinGame', (gameId) => this.joinGame(socket, gameId));
      socket.on('playerReady', (data) => this.setPlayerReady(socket, data));
      socket.on('playerAction', (data) => this.handlePlayerAction(socket, data));
      socket.on('roundComplete', () => this.handleRoundComplete(socket));
    });

    server.listen(3000, () => console.log('Server running on port 3000'));
  }

  // Enhanced Game Creation with Full State
  createGame(socket) {
    const gameId = `game_${Date.now()}`;
    this.games[gameId] = {
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
      powerups: this.powerupManager.generatePowerupPool(gameId)
    };

    this.players[socket.id].gameId = gameId;
    socket.emit('gameCreated', { 
      gameId,
      isHost: true,
      seed: gameId // Using gameId as seed for deterministic randomness
    });
  }

  // Enhanced Player Join with Initialization
  joinGame(socket, gameId) {
    if (!this.games[gameId]) {
      socket.emit('gameError', { message: 'Game not found' });
      return;
    }

    const game = this.games[gameId];
    if (game.players.length >= 4) {
      socket.emit('gameError', { message: 'Game is full' });
      return;
    }

    game.players.push(socket.id);
    this.players[socket.id].gameId = gameId;
    game.scores[socket.id] = 0;

    // Notify all players
    io.to(gameId).emit('playerJoined', {
      playerId: socket.id,
      position: game.players.length // 1-4
    });

    socket.emit('gameJoined', {
      gameId,
      isHost: false,
      seed: gameId,
      currentRound: game.round
    });
  }

  // Full Game State Synchronization
  syncGameState(gameId) {
    const game = this.games[gameId];
    io.to(gameId).emit('gameStateUpdate', {
      round: game.round,
      gameState: game.gameState,
      negativeMode: game.negativeMode,
      scores: game.scores,
      remainingTime: game.timer?.remaining || 0
    });
  }

  // Enhanced Action Handling
  handlePlayerAction(socket, { action, points, powerup }) {
    const playerId = socket.id;
    const game = this.getPlayerGame(playerId);
    if (!game) return;

    switch(action) {
      case 'tapTrash':
        this.handleTrashTap(game, playerId, points);
        break;
      case 'selectPowerup':
        this.handlePowerupSelection(game, playerId, powerup);
        break;
      // Add other actions as needed
    }
  }

  // Trash Tap with Negative Mode Check
  handleTrashTap(game, playerId, points) {
    if (game.negativeMode) {
      // Penalize player in negative mode
      game.scores[playerId] = Math.max(0, game.scores[playerId] - 2);
      io.to(game.id).emit('negativeTap', { playerId });
    } else {
      // Normal scoring with potential multipliers
      game.scores[playerId] += points;
      io.to(game.id).emit('scoreUpdate', { 
        playerId, 
        score: game.scores[playerId],
        points 
      });
    }
  }

  // Powerup Selection with Validation
  handlePowerupSelection(game, playerId, powerupName) {
    if (game.gameState !== 'powerup-selection') return;

    const powerup = this.powerupManager.getPowerup(powerupName);
    if (!powerup) return;

    // Apply powerup logic (could be client-side only)
    io.to(game.id).emit('powerupSelected', {
      playerId,
      powerup: powerupName,
      description: powerup.description
    });

    // Check if all players have selected
    if (Object.keys(game.powerupSelections).length === game.players.length) {
      this.startNextRound(game);
    }
  }

  // Round Management
  startRound(game) {
    game.gameState = 'playing';
    game.roundTimer = setTimeout(() => {
      this.endRound(game);
    }, 30000); // 30 second rounds

    // Random negative mode trigger (30% chance)
    if (Math.random() < 0.3) {
      setTimeout(() => {
        game.negativeMode = true;
        io.to(game.id).emit('negativeModeStart');
        setTimeout(() => {
          game.negativeMode = false;
          io.to(game.id).emit('negativeModeEnd');
        }, 5000); // 5 second negative mode
      }, 15000); // Start at 15 seconds
    }

    this.syncGameState(game.id);
  }

  endRound(game) {
    clearTimeout(game.roundTimer);
    game.gameState = 'powerup-selection';
    game.powerupSelections = {};
    
    // Get 3 random powerups for selection
    const availablePowerups = this.powerupManager.getRoundPowerups(game.id, game.round);
    io.to(game.id).emit('roundComplete', { 
      powerups: availablePowerups,
      scores: game.scores 
    });

    this.syncGameState(game.id);
  }

  startNextRound(game) {
    game.round++;
    game.trashType = this.getRandomTrashType(game.round);
    
    if (game.round > game.maxRounds) {
      this.endGame(game);
    } else {
      io.to(game.id).emit('startNextRound', {
        round: game.round,
        trashType: game.trashType
      });
      this.startRound(game);
    }
  }

  endGame(game) {
    // Determine winner
    const winnerId = Object.entries(game.scores).reduce((a, b) => 
      a[1] > b[1] ? a : b
    )[0];

    io.to(game.id).emit('gameOver', {
      winnerId,
      scores: game.scores,
      players: game.players.map(id => ({
        id,
        score: game.scores[id],
        position: game.players.indexOf(id) + 1
      }))
    });

    delete this.games[game.id];
  }

  // Helper Methods
  getRandomTrashType(round) {
    const types = ['handbag', 'trashcan'];
    if (round === 3) return 'golden'; // Final round always golden
    return types[Math.floor(Math.random() * types.length)];
  }

  getPlayerGame(playerId) {
    const gameId = this.players[playerId]?.gameId;
    return gameId ? this.games[gameId] : null;
  }
}

// Powerup Manager (matches frontend)
class PowerupManager {
  constructor() {
    this.powerups = { /* Same as frontend powerups definition */ };
  }

  getPowerup(name) {
    return this.powerups[name];
  }

  generatePowerupPool(gameId) {
    const rng = seedrandom(gameId);
    const allPowerups = Object.keys(this.powerups);
    const shuffled = [...allPowerups].sort(() => rng() - 0.5);
    return shuffled;
  }

  getRoundPowerups(gameId, round) {
    const pool = this.generatePowerupPool(gameId);
    return pool.slice(0, 3); // Return 3 powerups per round
  }
}
