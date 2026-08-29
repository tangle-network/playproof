#!/usr/bin/env node
// Plays the first word the game states, forever: the weakest honest baseline.
//
// It used to emit a hardcoded lowercase word. On ALE Breakout, whose words are
// NOOP, FIRE, RIGHT and LEFT, every one was illegal and substituted, and the
// first decision spent ten seconds reaching a driver timeout. A control that
// cannot name a legal move measures the harness, not the game.
const FALLBACK = 'up'
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const at = buffer.indexOf('\n')
    if (at < 0) break
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    let word = FALLBACK
    try {
      const request = JSON.parse(line)
      if (Array.isArray(request.commands) && request.commands.length > 0) word = request.commands[0]
    } catch {
      // An unreadable request is still a request. Answering keeps the episode
      // gradeable instead of stalling it at a timeout.
    }
    process.stdout.write(`${word}\n`)
  }
})
