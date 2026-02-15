const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

let usernames = {};
let rooms = {};

function code() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function newRoom(host, pub) {
    const c = code();
    rooms[c] = { code: c, public: pub, players: [host], game: null };
    return rooms[c];
}

function newGame(p1, p2) {
    return {
        players: [p1, p2],
        state: "TOSS_CALL",
        tossCaller: p1,
        tossWinner: null,
        ball: null,
        passCount: 0,
        moves: {},
        scores: { [p1]: 0, [p2]: 0 },
        msg: ""
    };
}

function publicRooms() {
    return Object.values(rooms)
        .filter(r => r.public && r.players.length === 1)
        .map(r => ({ code: r.code, host: usernames[r.players[0]] }));
}

io.on("connection", socket => {

    socket.on("set_name", n => {
        usernames[socket.id] = n || "Player";
        socket.emit("room_list", publicRooms());
    });

    socket.on("create_room", pub => {
        const r = newRoom(socket.id, pub);
        socket.join(r.code);
        socket.emit("room_created", r.code);
        io.emit("room_list", publicRooms());
    });

    socket.on("join_room", c => {
        const r = rooms[c];
        if (!r || r.players.length >= 2) {
            socket.emit("join_error", "Room unavailable");
            return;
        }

        r.players.push(socket.id);
        socket.join(c);
        r.game = newGame(r.players[0], r.players[1]);

        io.to(c).emit("room_ready", {
            players: r.players.map(id => usernames[id]),
            caller: usernames[r.game.tossCaller],
            callerId: r.game.tossCaller
        });

        io.emit("room_list", publicRooms());
    });

    // ---------- TOSS CALL ----------

    socket.on("toss_call", pick => {
        const r = findRoom(socket.id);
        if (!r) return;
        const g = r.game;
        if (socket.id !== g.tossCaller) return;

        const tossNum = Math.floor(Math.random() * 10) + 1;
        const even = tossNum % 2 === 0;

        const callerWins =
            (pick === "even" && even) ||
            (pick === "odd" && !even);

        g.tossWinner = callerWins
            ? g.tossCaller
            : other(g, g.tossCaller);

        // 🔹 WAIT STATE ADDED
        g.state = "TOSS_WAIT_PROCEED";
        g.msg = usernames[g.tossWinner] + " won the toss";

        io.to(r.code).emit("toss_result", {
            number: tossNum,
            winner: usernames[g.tossWinner]
        });

        io.to(r.code).emit("game_update", view(g));
    });

    // ---------- PROCEED AFTER TOSS ----------

    socket.on("toss_proceed", () => {
        const r = findRoom(socket.id);
        if (!r) return;
        const g = r.game;
        if (socket.id !== g.tossWinner) return;

        g.state = "TOSS_DECIDE";
        g.msg = "";

        io.to(r.code).emit("game_update", view(g));
    });

    // ---------- TOSS DECISION ----------

    socket.on("toss_decide", choice => {
        const r = findRoom(socket.id);
        if (!r) return;
        const g = r.game;
        if (socket.id !== g.tossWinner) return;

        g.ball = choice === "center"
            ? socket.id
            : other(g, socket.id);

        g.msg = usernames[socket.id] + " chose " + choice;
        g.state = "PASS";

        io.to(r.code).emit("game_update", view(g));
    });

    // ---------- PLAY MOVE ----------

    socket.on("play", num => {
        const r = findRoom(socket.id);
        if (!r) return;
        const g = r.game;
        if (!g || g.state === "GAME_OVER") return;

        g.moves[socket.id] = num;

        if (Object.keys(g.moves).length === 2)
            resolveRound(r);
    });

});

// ---------- ROUND RESOLUTION ----------

function resolveRound(r) {
    const g = r.game;
    const [p1, p2] = g.players;
    const m1 = g.moves[p1];
    const m2 = g.moves[p2];

    if (g.state === "PASS") {
        if (m1 === m2) {
            g.ball = other(g, g.ball);
            g.passCount = 0;
            g.msg = "Ball stolen";
        } else {
            g.passCount++;
            g.msg = "Pass ok";
            if (g.passCount >= 3) g.state = "GOAL";
        }
    }

    else if (g.state === "GOAL") {
        if (m1 === m2) {
            g.ball = other(g, g.ball);
            g.msg = "Saved";
        } else {
            g.scores[g.ball]++;
            g.msg = "GOAL";

            if (g.scores[g.ball] >= 3) {
                g.state = "GAME_OVER";
            } else {
                g.ball = other(g, g.ball);
                g.state = "PASS";
            }
        }
        g.passCount = 0;
    }

    g.moves = {};
    io.to(r.code).emit("game_update", view(g));
}

// ---------- HELPERS ----------

function other(g, id) {
    return g.players.find(p => p !== id);
}

function findRoom(id) {
    return Object.values(rooms)
        .find(r => r.players.includes(id));
}

function view(g) {
    return {
        players: g.players.map(id => usernames[id]),
        ball: usernames[g.ball],
        passCount: g.passCount,
        state: g.state,
        scores: Object.fromEntries(
            Object.entries(g.scores)
                .map(([id, s]) => [usernames[id], s])
        ),
        msg: g.msg || "",
        tossWinner: usernames[g.tossWinner]
    };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT);
