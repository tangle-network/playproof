#!/usr/bin/env python3
"""Deterministic native-process 2048 worker for Playproof.

Line-delimited JSON-RPC over a FIFO pair supplied as argv[1:3]. The game is a
real 4x4 2048 implementation, not a counter fixture: legal moves compact and
merge rows, score merged tiles, and deterministically spawn a 2/4 tile from a
seeded RNG. No third-party packages are required.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import sys
from dataclasses import dataclass, field
from typing import Any

SIZE = 4
INPUTS = {"up", "down", "left", "right", "noop", "tick"}


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def transpose(board: list[list[int]]) -> list[list[int]]:
    return [list(row) for row in zip(*board)]


def reverse_rows(board: list[list[int]]) -> list[list[int]]:
    return [list(reversed(row)) for row in board]


def merge_left(row: list[int]) -> tuple[list[int], int]:
    compact = [v for v in row if v]
    out: list[int] = []
    score = 0
    i = 0
    while i < len(compact):
        if i + 1 < len(compact) and compact[i] == compact[i + 1]:
            value = compact[i] * 2
            out.append(value)
            score += value
            i += 2
        else:
            out.append(compact[i])
            i += 1
    return out + [0] * (SIZE - len(out)), score


@dataclass
class Game2048:
    seed: int = 0
    board: list[list[int]] = field(default_factory=lambda: [[0] * SIZE for _ in range(SIZE)])
    score: int = 0
    moves: int = 0
    events: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.rng = random.Random(self.seed)
        self._spawn()
        self._spawn()
        self._record_tiles()

    def _spawn(self) -> None:
        empty = [(r, c) for r in range(SIZE) for c in range(SIZE) if self.board[r][c] == 0]
        if not empty:
            return
        r, c = empty[self.rng.randrange(len(empty))]
        self.board[r][c] = 4 if self.rng.random() < 0.1 else 2

    def _record_tiles(self) -> None:
        maximum = max(max(row) for row in self.board)
        value = 4
        while value <= maximum:
            event = f"tile-{value}"
            if event not in self.events:
                self.events.append(event)
            value *= 2

    def _move_left(self, board: list[list[int]]) -> tuple[list[list[int]], int]:
        out: list[list[int]] = []
        gained = 0
        for row in board:
            merged, score = merge_left(row)
            out.append(merged)
            gained += score
        return out, gained

    def _oriented(self, direction: str) -> list[list[int]]:
        if direction == "left":
            return [row[:] for row in self.board]
        if direction == "right":
            return reverse_rows(self.board)
        if direction == "up":
            return transpose(self.board)
        if direction == "down":
            return reverse_rows(transpose(self.board))
        return [row[:] for row in self.board]

    def _restore_orientation(self, board: list[list[int]], direction: str) -> list[list[int]]:
        if direction == "left":
            return board
        if direction == "right":
            return reverse_rows(board)
        if direction == "up":
            return transpose(board)
        if direction == "down":
            return transpose(reverse_rows(board))
        return board

    def step(self, word: str) -> None:
        if word not in INPUTS or word in {"noop", "tick"}:
            return
        before = [row[:] for row in self.board]
        oriented = self._oriented(word)
        moved, gained = self._move_left(oriented)
        self.board = self._restore_orientation(moved, word)
        if self.board == before:
            return
        self.score += gained
        self.moves += 1
        self._spawn()
        self._record_tiles()

    def can_move(self) -> bool:
        if any(0 in row for row in self.board):
            return True
        for r in range(SIZE):
            for c in range(SIZE):
                if r + 1 < SIZE and self.board[r][c] == self.board[r + 1][c]:
                    return True
                if c + 1 < SIZE and self.board[r][c] == self.board[r][c + 1]:
                    return True
        return False

    def frame_text(self) -> str:
        rows = ["+------+------+------+------+"]
        for row in self.board:
            rows.append("|" + "|".join(f"{v or '':^6}" for v in row) + "|")
            rows.append("+------+------+------+------+")
        return f"2048 score={self.score} moves={self.moves}\n" + "\n".join(rows)

    def _frame_features(self, frame: str) -> dict[str, int]:
        header, *rows = frame.splitlines()
        fields = {part.split("=", 1)[0]: int(part.split("=", 1)[1]) for part in header.split()[1:]}
        tiles: list[int] = []
        for row in rows:
            if not row.startswith("|"):
                continue
            for cell in row.strip("|").split("|"):
                cell = cell.strip()
                tiles.append(int(cell) if cell else 0)
        return {
            "score": fields["score"],
            "moves": fields["moves"],
            "maxTile": max(tiles, default=0),
        }

    def evidence(self) -> dict[str, Any]:
        frame = self.frame_text()
        state = {
            "board": self.board,
            "score": self.score,
            "moves": self.moves,
            "events": self.events,
            "rng": repr(self.rng.getstate()),
        }
        maximum = max(max(row) for row in self.board)
        return {
            "engineState": {
                "score": self.score,
                "maxTile": maximum,
                "moves": self.moves,
                "emptyCells": sum(v == 0 for row in self.board for v in row),
                "gameOver": 0 if self.can_move() else 1,
                **{f"cell{r}{c}": self.board[r][c] for r in range(SIZE) for c in range(SIZE)},
            },
            "saveBlobHash": hashlib.sha256(canonical(state).encode()).hexdigest(),
            "saveState": {"score": self.score, "moves": self.moves, "maxTile": maximum},
            "logEvents": list(self.events),
            "frameHash": hashlib.sha256(frame.encode()).hexdigest(),
            "frameState": self._frame_features(frame),
        }


class Worker:
    def __init__(self) -> None:
        self.seed = 0
        self.game = Game2048(0)
        self.generation = 0

    def boot(self, seed: int = 0) -> dict[str, int]:
        self.seed = int(seed)
        return self.reset()

    def reset(self) -> dict[str, int]:
        self.game = Game2048(self.seed)
        self.generation += 1
        return {"gen": self.generation, "frame": self.game.moves}

    def step(self, word: str) -> dict[str, Any]:
        self.game.step(word)
        return {
            "frame": self.game.moves,
            "evidence": self.game.evidence(),
            "frameText": self.game.frame_text(),
        }

    def checkpoint(self) -> dict[str, Any]:
        return {
            "seed": self.seed,
            "board": self.game.board,
            "score": self.game.score,
            "moves": self.game.moves,
            "events": self.game.events,
            "rng": self.game.rng.getstate(),
        }

    def restore(self, state: dict[str, Any]) -> dict[str, int]:
        game = Game2048.__new__(Game2048)
        game.seed = int(state["seed"])
        game.board = [list(map(int, row)) for row in state["board"]]
        game.score = int(state["score"])
        game.moves = int(state["moves"])
        game.events = list(state["events"])
        game.rng = random.Random()
        game.rng.setstate(_tuple_tree(state["rng"]))
        self.seed = game.seed
        self.game = game
        return {"gen": self.generation, "frame": self.game.moves}


def _tuple_tree(value: Any) -> Any:
    if isinstance(value, list):
        return tuple(_tuple_tree(x) for x in value)
    return value


def dispatch(worker: Worker, method: str, params: dict[str, Any]) -> Any:
    if method == "boot":
        return worker.boot(params.get("seed", 0))
    if method == "reset":
        return worker.reset()
    if method == "step":
        return worker.step(str(params["input"]))
    if method == "evidence":
        return worker.game.evidence()
    if method == "frame":
        return {"text": worker.game.frame_text()}
    if method == "checkpoint":
        return worker.checkpoint()
    if method == "restore":
        return worker.restore(params["state"])
    if method == "shutdown":
        return {"bye": True}
    raise ValueError(f"unknown method {method}")


def serve(fin: Any, fout: Any) -> None:
    worker = Worker()
    for raw in fin:
        raw = raw.strip()
        if not raw:
            continue
        req: dict[str, Any] = {}
        try:
            req = json.loads(raw)
            result = dispatch(worker, req["method"], req.get("params") or {})
            fout.write(canonical({"id": req.get("id"), "ok": True, "result": result}) + "\n")
            fout.flush()
            if req["method"] == "shutdown":
                return
        except Exception as exc:
            fout.write(canonical({
                "id": req.get("id", -1),
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            }) + "\n")
            fout.flush()


def main() -> None:
    if len(sys.argv) >= 3:
        fifo_in, fifo_out = sys.argv[1], sys.argv[2]
        os.mkfifo(fifo_in)
        os.mkfifo(fifo_out)
        with open(os.path.join(os.path.dirname(fifo_in), "ready"), "w"):
            pass
        with open(fifo_in, "r", encoding="utf-8") as fin, open(fifo_out, "w", encoding="utf-8") as fout:
            serve(fin, fout)
    else:
        serve(sys.stdin, sys.stdout)


if __name__ == "__main__":
    main()
