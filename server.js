const express = require("express");
const http = require("http");
const socketio = require("socket.io");

class GameServer {
    constructor() {
        this.games = {};
        this.players = {};
        this.publicGames = new Map();
        this.privateGames = new Map();
        this.gameReadyStates = {};
        this.lastActivity = Date.now();
        this.ACTIVITY_TIMEOUT = 300000; // 5 minutes
    }

    initialize() {
        const app = express();
        app.use(express.json());

        // Enhanced CORS middleware for all routes
        app.use((req, res, next) => {
            res.header("Access-Control-Allow-Origin", "*");
            res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.header(
                "Access-Control-Allow-Headers",
                "Content-Type, Authorization, x-wake-up",
            );
            if (req.method === "OPTIONS") {
                return res.status(200).end();
            }
            next();
        });

        // Wake endpoint
        app.post("/wake", (req, res) => {
            console.log("Received wake call from client");
            this.lastActivity = Date.now();
            res.json({
                status: "awake",
                ping: Date.now() - parseInt(req.body.timestamp),
                message: "Server is active and responding",
            });
        });

        app.options("/wake", (req, res) => {
            res.header("Access-Control-Allow-Headers", "x-wake-up");
            res.status(200).end();
        });

        // Health check
        app.get("/health", (req, res) => {
            res.status(200).send("OK");
        });

        const server = http.createServer(app);
        this.io = socketio(server, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"],
                allowedHeaders: ["x-wake-up"],
                credentials: true,
            },
            transports: ["websocket", "polling"],
            allowUpgrades: true,
            pingTimeout: 60000,
            pingInterval: 25000,
        });

        // Keep-alive using Render's environment
        setInterval(() => {
            if (Date.now() - this.lastActivity > this.ACTIVITY_TIMEOUT) {
                console.log("Performing keep-alive ping");
                fetch(`https://trash-rush-server.onrender.com/health`)
                    .then(() => console.log("Keep-alive successful"))
                    .catch((err) => console.error("Keep-alive failed:", err));
            }
        }, 60000);

        // Socket.io events
        this.io.on("connection", (socket) => {
            console.log(`Player connected: ${socket.id}`);
            this.players[socket.id] = { socket, gameId: null };

            socket.on("disconnect", () => this.handleDisconnect(socket));
            socket.on("quickPlay", (data) =>
                this.handleQuickPlay(socket, data),
            );
            socket.on("createPrivateGame", () =>
                this.createPrivateGame(socket),
            );
            socket.on("joinPrivateGame", (data) =>
                this.joinPrivateGame(socket, data),
            );
            socket.on("playerReady", (data) =>
                this.setPlayerReady(socket, data),
            );
            socket.on("playerAction", (data) =>
                this.handlePlayerAction(socket, data),
            );
            socket.on("roundComplete", () => this.handleRoundComplete(socket));
            socket.on("startGameForReal", (data) =>
                this.startGameForReal(socket, data),
            );
        });

        this.io.of("/").adapter.on("join-room", (room, id) => {
            console.log(`[${id}] joined room ${room}`);
        });

        this.io.of("/").adapter.on("leave-room", (room, id) => {
            console.log(`[${id}] left room ${room}`);
        });

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, "0.0.0.0", () => {
            console.log(`Server running on port ${PORT}`);
        });
    }

    // Game management methods
    createGame(socket, isPublic = true) {
        const gameId = `game_${Date.now()}`;
        console.log("New game created, everybodyyy.");
        const game = {
            id: gameId,
            players: [socket.id],
            host: socket.id,
            readyStates: {},
            round: 1,
            maxRounds: 3,
            gameState: "lobby",
            trashType: this.getRandomTrashType(),
            negativeMode: false,
            scores: {},
            isPublic,
            createdAt: Date.now(),
        };

        if (isPublic) {
            this.publicGames.set(gameId, game);
        } else {
            this.privateGames.set(gameId, game);
        }


        console.log('CREATING NEW GAME');
        this.players[socket.id].gameId = gameId;
        socket.join(gameId);
        socket.emit(isPublic ? "gameCreated" : "privateGameCreated", {
            gameId,
            isHost: true,
            seed: gameId,
        });

        return gameId;
    }

    joinGame(socket, gameId, character, isPublic = true) {
        const game = isPublic
            ? this.publicGames.get(gameId)
            : this.privateGames.get(gameId);
        if (!game || game.players.length >= 4) {
            socket.emit("gameError", {
                message: game ? "Game is full" : "Game not found",
            });
            return false;
        }
        console.log("PLAYER JOINING");
        game.players.push(socket.id);
        this.players[socket.id] = { socket, gameId, character };
        game.scores[socket.id] = 0;
        socket.join(gameId);

        socket.to(gameId).emit("playerJoined", {
            playerId: socket.id,
            position: game.players.length,
            character,
        });

        socket.emit("gameJoined", {
            gameId,
            isHost: false,
            seed: gameId,
            currentRound: game.round,
            playerId: game.players.length-1,
            players: game.players.map((id) => ({
                id,
                position: game.players.indexOf(id) + 1,
                character: this.players[id]?.character || "goblin",
            })),
        });

        if (game.players.length === 4) {
            this.startGame(gameId, isPublic);
        }

        return true;
    }

    handleQuickPlay(socket, { character }) {
        this.cleanupOldGames();

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

    // Player management
    handleDisconnect(socket) {
        const player = this.players[socket.id];
        console.log("Disconnecting a player0", socket.id);
        if (!player) return;

        const gameId = player.gameId;
        if (gameId) {
            console.log("Removing from game");
            const game =
                this.publicGames.get(gameId) || this.privateGames.get(gameId);
            if (game) {
                // Remove player from game
                game.players = game.players.filter((id) => id !== socket.id);
                delete game.scores[socket.id];
                delete game.readyStates[socket.id];

                console.log("Notified all players");

                // Notify remaining players
                socket
                    .to(gameId)
                    .emit("playerDisconnected", { playerId: socket.id });

                // Clean up empty games
                if (game.players.length === 0) {
                    console.log("Game is empty, delete");
                    if (game.isPublic) {
                        this.publicGames.delete(gameId);
                    } else {
                        this.privateGames.delete(gameId);
                    }
                } else if (socket.id === game.host) {
                    // Assign new host
                    console.log("New host assigned");
                    game.host = game.players[0];
                    this.players[game.host].socket.emit("promoteToHost");
                }
            }
        }

        delete this.players[socket.id];
        console.log(`Player disconnected: ${socket.id}`);
    }

    // Game state methods
    startGame(gameId, isPublic) {
        const game = isPublic
            ? this.publicGames.get(gameId)
            : this.privateGames.get(gameId);
        if (!game) return;

        console.log('STARTING GAME');

        game.gameStarted = true;
        game.trashType = this.getRandomTrashType();

        game.players.forEach((playerId) => {
            this.players[playerId].socket.emit("gameStart", {
                trashType: game.trashType,
                players: game.players.map((id) => ({
                    id,
                    character: this.players[id]?.character || "goblin",
                    position: game.players.indexOf(id) + 1,
                })),
            });
        });
    }

    endGame(gameId, isPublic) {
        const game = isPublic
            ? this.publicGames.get(gameId)
            : this.privateGames.get(gameId);
        if (!game) return;

        console.log('ENDING GAME');

        let maxScore = -1;
        let winnerId = null;

        Object.entries(game.scores).forEach(([playerId, score]) => {
            if (score > maxScore) {
                maxScore = score;
                winnerId = playerId;
            }
        });

        game.players.forEach((playerId) => {
            this.players[playerId].socket.emit("gameOver", {
                scores: game.scores,
                winnerId,
                players: game.players.map((id) => ({
                    id,
                    character: this.players[id]?.character || "goblin",
                    position: game.players.indexOf(id) + 1,
                    score: game.scores[id] || 0,
                })),
            });
        });

        if (isPublic) {
            this.publicGames.delete(gameId);
        } else {
            this.privateGames.delete(gameId);
        }
    }

    // Utility methods
    getRandomTrashType() {
        const types = ["golden", "handbag", "trashcan"];
        return types[Math.floor(Math.random() * types.length)];
    }

    cleanupOldGames() {
        const now = Date.now();
        const maxAge = 30 * 60 * 1000; // 30 minutes

        [this.publicGames, this.privateGames].forEach((gameMap) => {
            for (const [id, game] of gameMap) {
                if (
                    now - game.createdAt > maxAge ||
                    game.players.length === 0
                ) {
                    gameMap.delete(id);
                }
            }
        });
    }

    broadcastPlayers(gameId) {
        const game =
            this.publicGames.get(gameId) || this.privateGames.get(gameId);
        if (!game) return;
        const players = game.players.map((id) => ({
            id,
            character: this.players[id]?.character || "goblin",
        }));
        game.players.forEach((id) =>
            this.players[id].socket.emit("playersUpdated", { players }),
        );
    }

    broadcastReadyStates(gameId) {
        const game =
            this.publicGames.get(gameId) || this.privateGames.get(gameId);
        if (!game) return;
        const readyStates = game.readyStates;
        game.players.forEach((id) =>
            this.players[id].socket.emit("readyStatesUpdated", readyStates),
        );
    }

    setPlayerReady(socket, { gameId, character, ready }) {
        const game =
            this.publicGames.get(gameId) || this.privateGames.get(gameId);

        console.log("tryin toready");
        if (!game || !game.players.includes(socket.id)) return;
        console.log("moving on");

        // Only proceed if ready state actually changed
        if (game.readyStates[socket.id] !== ready) {
            game.readyStates[socket.id] = ready;
            this.players[socket.id].character = character;
            this.broadcastReadyStates(gameId);

            // Only check ready states if this was a "ready" action
            if (ready) {
                console.log("another player ready!!");
                const allReady = game.players.every(
                    (id) => game.readyStates[id],
                );
                if (allReady && game.players.length > 1 && !game.gameStarted) {
                    console.log("allready, count downnn");
                    this.io.to(gameId).emit("startGameCountDown", {
                        round: game.round,
                        trashType: game.trashType,
                    });

                    //game.gameStarted = true; // Mark as started to prevent duplicate triggers
                    //this.startGame(gameId, !!this.publicGames.get(gameId));
                }
            } else {
                socket.to(gameId).emit("cancelGameCountDown", {});
            }
        }
    }

    startGameForReal(socket, { gameId }) {
        if (gameId) {
            const game =
                this.publicGames.get(gameId) || this.privateGames.get(gameId);

            if (game && !game.gameStarted) {
                game.gameStarted = true; // Mark as started to prevent duplicate triggers
                this.startGame(gameId, !!this.publicGames.get(gameId));
            }
        }
    }

    joinPrivateGame(socket, data) {
        const { gameId, character } = data;
        this.joinGame(socket, gameId, character, false);
    }

    handlePlayerAction(socket, { gameId, action, points, powerup }) {
        const game =
            this.publicGames.get(gameId) || this.privateGames.get(gameId);
        if (!game || !game.players.includes(socket.id)) return;
        console.log('HAANDLING ACTION', action);

        socket.to(gameId).emit("playerAction", {
            playerId: socket.id,
            action,
            points,
            powerup,
        });

        if (action === "tapTrash") {
            game.scores[socket.id] = (game.scores[socket.id] || 0) + points;
        }
    }

    handleRoundComplete(socket) {
        const gameId = this.players[socket.id]?.gameId;
        const game =
            this.publicGames.get(gameId) || this.privateGames.get(gameId);
        if (!game || socket.id !== game.host) return;

        game.round++;
        if (game.round > game.maxRounds) {
            this.endGame(gameId, !!this.publicGames.get(gameId));
        } else {
            game.trashType = this.getRandomTrashType();
            socket.to(gameId).emit("startNextRound", {
                round: game.round,
                trashType: game.trashType,
            });
        }
    }
}

const gameServer = new GameServer();
gameServer.initialize();
