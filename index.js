const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*', 
  }
});

app.get("/", (req, res) => {
  res.send("Mancala WebSocket Server is running!");
});

const waitingPlayers = [];
const games = {}; // { gameId: { board, players } }

function createStartingBoard() {
  // 6 pockets per side + 2 stores, standard Mancala (12 pockets total)
  // Each pocket starts with 4 stones
  return Array(14).fill(4).map((stones, index) => (index === 6 || index === 13 ? 0 : stones));
}

io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);

  socket.on('joinGame', () => {
    console.log(`Player ${socket.id} wants to join a game`);

    if (waitingPlayers.length > 0) {
      const opponent = waitingPlayers.pop();
      const gameId = `${opponent.id}#${socket.id}`;

      socket.join(gameId);
      opponent.join(gameId);

      const startingBoard = createStartingBoard();
      games[gameId] = {
        board: startingBoard,
        players: [opponent.id, socket.id],
        currentPlayer: "player1",
      };

      io.to(socket.id).emit('matched', { gameId, player: "player2" });
      io.to(opponent.id).emit('matched', { gameId, player: "player1" });

      console.log(`Match found: ${opponent.id} vs ${socket.id}`);
    } else {
      waitingPlayers.push(socket);
      console.log(`Player ${socket.id} is waiting for a match`);
    }
  });

  socket.on('makeMove', (data) => {
    console.log(`Move made in game ${data.gameId}:`, data);

    const game = games[data.gameId];
    if (!game) {
      console.error(`No game found with ID: ${data.gameId}`);
      return;
    }

    // NOTE: Right now we don't validate moves. Assume frontend sends valid moves.
    const nextPlayer = data.player === "player1" ? "player2" : "player1";

    io.to(data.gameId).emit('gameState', {
      gameId: data.gameId,
      board: game.board, // you could update board here later
      currentPlayer: nextPlayer,
      lastMove: {
        player: data.player,
        pocket: data.pocket,
        description: `Player ${data.player} picked pocket ${data.pocket}`,
      },
    });
  });

  socket.on('leaveGame', (gameId) => {
    console.log(`Player ${socket.id} left game ${gameId}`);
    socket.leave(gameId);

    if (games[gameId]) {
      delete games[gameId];
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);

    // If disconnecting while waiting
    const index = waitingPlayers.findIndex((player) => player.id === socket.id);
    if (index !== -1) {
      waitingPlayers.splice(index, 1);
      console.log(`Player ${socket.id} removed from waiting list`);
      return;
    }

    // If disconnecting during a game
    for (const gameId in games) {
      const { players } = games[gameId];
      if (players.includes(socket.id)) {
        console.log(`Player ${socket.id} disconnected from game ${gameId}`);
        const otherPlayer = players.find((p) => p !== socket.id);
        if (otherPlayer) {
          io.to(otherPlayer).emit('opponentDisconnected', {
            gameId,
            message: "Your opponent disconnected.",
          });
        }
        delete games[gameId];
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`WebSocket server running on port ${PORT}`);
});